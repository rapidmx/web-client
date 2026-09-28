///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * A client for the server's real-time push channel (`@rapidmx/restapi`'s `MailPushRoute`, `@rapidrest/service-core`'s
 * `BasePushRoute`), which the webmail uses to learn of new mail without a page reload.
 *
 * The protocol, as `BasePushRoute` implements it:
 *
 * - The WebSocket is `wss://<origin>/push` - the route's own base path, **not** under `/api` and with no `/connect`
 * suffix. It authenticates from the `jwt` cookie the browser sends with the upgrade (a script can't read that
 * cookie, so there is no token to send). One user may hold at most 10 sockets, and be subscribed to at most 50 channels
 * in total *across all of them* - see `PUSH_MAX_CHANNELS`.
 * - Right after connecting the server sends `{ id: 0, type: "SUBSCRIBED", data: [<channels this socket is already on>] }`.
 * - A client subscribes with `{ id, type: "SUBSCRIBE", data: [channel, ...] }` and gets `{ id, type: "SUBSCRIBED", data:
 * [<the channels it was allowed>] }`; `UNSUBSCRIBE`/`UNSUBSCRIBED` mirror that. A channel is a bare `Folder.uid` or
 * `Mailbox.uid`, permission-checked (read) per channel; a channel that is refused is simply left out of the reply.
 * - An event arrives as the JSON `NotificationUtils.sendMessage()` published: `{ type, action, data }`, where `type` is
 * the model class name (`MessageMongo`, `MessageSQL`, ...), `action` is `create`/`update`/`delete` and `data` the
 * entity - for a message, the whole `Message`, including its `folderUid`. The frame does **not** say which channel it
 * came over. (A message sent through the route's `POST /push/:id` is instead wrapped `{ type: "MESSAGE", channel, data:
 * { type, action, data } }`; both shapes are accepted and normalised to a `PushEvent`.)
 * - Delivery is fire-and-forget over Redis pub/sub: an event published while the socket was down is never replayed. A UI
 * must therefore also poll (see `MailShell`) and refetch after a reconnect.
 *
 * One `PushClient` is shared by the whole tab (`getPushClient()`), since the per-user socket cap is small. It reconnects by
 * itself with exponential backoff and jitter, and re-subscribes each time. Everything is a no-op where there is no
 * `WebSocket` (server-side rendering, an old browser), so a caller need not check.
 */
import { apiOrigin } from "../util/api.js";

/** The subset of the browser's `WebSocket` this client uses - what a test's fake implements. */
export interface PushSocket {
    readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;
}

export type PushSocketFactory = (url: string) => PushSocket;

/** An event delivered over the push channel, normalised - see this module's doc comment. */
export interface PushEvent {
    /** The published `type`: the model class name (`MessageMongo`), or `"MESSAGE"` for an unstructured payload. */
    type: string;
    action?: string;
    data?: unknown;
    /** Only present when the server wrapped the event with its channel. */
    channel?: string;
}

/** `"open"`: connected and subscribed. `"closed"`: shut down for good by `close()` - it will not reconnect. */
export type PushStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/** The `WebSocket.OPEN` readyState. */
const SOCKET_OPEN = 1;

/**
 * How many channels one tab asks for. The server allows a user 50 in total, shared by every tab and duplicates counting
 * again, so a tab stays well under it and leaves room for a second one. `setChannels()` keeps the first this many, so a
 * caller orders its channels most important first.
 */
export const PUSH_MAX_CHANNELS = 40;

/** The first reconnect waits about this long, and each further failure doubles it ... */
export const PUSH_BACKOFF_BASE_MS = 1_000;
/** ... up to this. */
export const PUSH_BACKOFF_MAX_MS = 60_000;

/** The push WebSocket's URL: the configured API origin (`configureApiBaseUrl()`), else this page's own, on `ws:`/`wss:`
 * to match. `undefined` where there is no origin to use (server-side rendering). */
export function pushUrl(): string | undefined {
    const origin = apiOrigin() || (typeof window !== "undefined" ? window.location.origin : "");
    return origin ? `${origin.replace(/^http/i, "ws")}/push` : undefined;
}

function defaultSocketFactory(): PushSocketFactory | undefined {
    return typeof WebSocket === "undefined" ? undefined : (url) => new WebSocket(url) as unknown as PushSocket;
}

export interface PushClientOptions {
    /** The URL to connect to. Defaults to `pushUrl()`. */
    url?: () => string | undefined;
    /** Creates the socket. Defaults to the browser's `WebSocket`, if there is one. */
    createSocket?: PushSocketFactory;
    /** A `Math.random()` stand-in, for the backoff's jitter. */
    random?: () => number;
}

export class PushClient {
    private socket: PushSocket | undefined;
    private closed = false;
    private started = false;
    private ready = false;
    private attempt = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private nextRequestId = 1;
    private current: PushStatus = "idle";
    /** What the caller wants to hear about, most important first. */
    private desired: string[] = [];
    /** What this socket is subscribed to (including whatever the server put it on at connect). */
    private subscribed = new Set<string>();
    /** The channels this client itself asked for and was granted - the only ones it may unsubscribe. */
    private granted = new Set<string>();
    /** Requests awaiting their reply, by id: the channels asked for. */
    private pending = new Map<number, string[]>();
    private readonly eventListeners = new Set<(event: PushEvent) => void>();
    private readonly statusListeners = new Set<(status: PushStatus) => void>();

    constructor(private readonly options: PushClientOptions = {}) {}

    get status(): PushStatus {
        return this.current;
    }

    /** Connects (once - a second call does nothing) and keeps reconnecting until `close()`. */
    start(): void {
        if (this.started || this.closed) {
            return;
        }
        this.started = true;
        this.connect();
    }

    /**
     * Shuts the client down for good: closes the socket, stops reconnecting and drops nothing else. For sign-out, when
     * the session behind the socket has ended. A closed client cannot be started again.
     */
    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        clearTimeout(this.timer);
        this.timer = undefined;
        const socket = this.socket;
        this.socket = undefined;
        this.ready = false;
        if (socket) {
            socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
            try {
                socket.close(1000, "closing");
            } catch {
                // Already gone.
            }
        }
        this.setStatus("closed");
    }

    /**
     * Sets the channels (folder and mailbox uids) to receive events for. Deduplicated and cut to `PUSH_MAX_CHANNELS`; on
     * an open socket the difference is subscribed/unsubscribed at once, otherwise it is sent when the socket opens.
     */
    setChannels(channels: readonly string[]): void {
        this.desired = [...new Set(channels)].slice(0, PUSH_MAX_CHANNELS);
        if (this.ready) {
            this.syncSubscriptions();
        }
    }

    /** Calls `listener` with every event; returns the function that stops it. */
    onEvent(listener: (event: PushEvent) => void): () => void {
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
    }

    /** Calls `listener` whenever `status` changes; returns the function that stops it. */
    onStatus(listener: (status: PushStatus) => void): () => void {
        this.statusListeners.add(listener);
        return () => this.statusListeners.delete(listener);
    }

    /** Reconnects now, without waiting out the backoff - for the browser coming back online. A no-op unless the client is
     * between attempts. */
    reconnectNow(): void {
        if (this.closed || !this.started || this.socket) {
            return;
        }
        clearTimeout(this.timer);
        this.timer = undefined;
        this.attempt = 0;
        this.connect();
    }

    private setStatus(status: PushStatus): void {
        if (status === this.current) {
            return;
        }
        this.current = status;
        for (const listener of [...this.statusListeners]) {
            listener(status);
        }
    }

    private connect(): void {
        const url = (this.options.url ?? pushUrl)();
        const createSocket = this.options.createSocket ?? defaultSocketFactory();
        if (!url || !createSocket) {
            // Nothing to connect with (server-side rendering, or no WebSocket): the caller's polling is all there is.
            return;
        }
        let socket: PushSocket;
        try {
            socket = createSocket(url);
        } catch {
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
        socket.onmessage = (event) => this.handleFrame(event.data);
        socket.onclose = () => {
            if (this.socket !== socket) {
                return;
            }
            this.socket = undefined;
            this.ready = false;
            this.subscribed.clear();
            this.granted.clear();
            this.pending.clear();
            this.scheduleReconnect();
        };
        // A failed connection is followed by a close, which is what triggers the retry.
        socket.onerror = () => undefined;
    }

    /**
     * Waits out an exponentially growing, jittered delay ("equal jitter": half of it fixed, half random) and reconnects.
     * Only ever reached with no timer pending and the client open: a socket's close is ignored once it is replaced or
     * `close()` has detached it, and `close()`/`reconnectNow()` clear the timer before anything else can run.
     */
    private scheduleReconnect(): void {
        const ceiling = Math.min(PUSH_BACKOFF_MAX_MS, PUSH_BACKOFF_BASE_MS * 2 ** Math.min(this.attempt, 30));
        const delay = ceiling / 2 + ((this.options.random ?? Math.random)() * ceiling) / 2;
        this.attempt += 1;
        this.setStatus("reconnecting");
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.connect();
        }, delay);
    }

    private handleFrame(raw: unknown): void {
        if (typeof raw !== "string") {
            return;
        }
        let frame: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object") {
                return;
            }
            frame = parsed as Record<string, unknown>;
        } catch {
            return;
        }
        switch (frame.type) {
            case "SUBSCRIBED":
                this.handleSubscribed(frame);
                return;
            case "UNSUBSCRIBED":
                for (const channel of channelsOf(frame.data)) {
                    this.subscribed.delete(channel);
                    this.granted.delete(channel);
                }
                return;
            case "LOGIN_RESPONSE":
                return;
            case "MESSAGE":
                this.emit(unwrap(frame));
                return;
            default:
                if (typeof frame.type === "string") {
                    this.emit({ type: frame.type, action: asString(frame.action), data: frame.data });
                }
        }
    }

    private handleSubscribed(frame: Record<string, unknown>): void {
        const channels = channelsOf(frame.data);
        for (const channel of channels) {
            this.subscribed.add(channel);
        }
        if (typeof frame.id === "number" && this.pending.delete(frame.id)) {
            // The reply to one of our own SUBSCRIBE requests: those are the channels we were granted.
            for (const channel of channels) {
                this.granted.add(channel);
            }
            return;
        }
        if (frame.id === 0 && !this.ready) {
            // The greeting sent as soon as the server has set the socket up: connected. Only now is a reconnect
            // delay forgotten - a socket the server closes at once (over the cap, not signed in) never gets here.
            this.ready = true;
            this.attempt = 0;
            this.setStatus("open");
            this.syncSubscriptions();
        }
    }

    /** Asks for the wanted channels the socket isn't on yet, and drops the ones this client asked for and no longer wants. */
    private syncSubscriptions(): void {
        const wanted = new Set(this.desired);
        const add = this.desired.filter((channel) => !this.subscribed.has(channel));
        const remove = [...this.granted].filter((channel) => !wanted.has(channel));
        if (add.length > 0) {
            const id = this.nextRequestId++;
            this.pending.set(id, add);
            this.send({ id, type: "SUBSCRIBE", data: add });
        }
        if (remove.length > 0) {
            this.send({ id: this.nextRequestId++, type: "UNSUBSCRIBE", data: remove });
        }
    }

    private send(message: object): void {
        const socket = this.socket;
        if (!socket || socket.readyState !== SOCKET_OPEN) {
            return;
        }
        try {
            socket.send(JSON.stringify(message));
        } catch {
            // The close that follows a dead socket reconnects and re-subscribes.
        }
    }

    private emit(event: PushEvent): void {
        for (const listener of [...this.eventListeners]) {
            try {
                listener(event);
            } catch {
                // One listener's failure never stops another hearing the event.
            }
        }
    }
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function channelsOf(data: unknown): string[] {
    return Array.isArray(data) ? data.filter((channel): channel is string => typeof channel === "string") : [];
}

/** A `{ type: "MESSAGE", channel, data: { type, action, data } }` frame as the event it wraps. */
function unwrap(frame: Record<string, unknown>): PushEvent {
    const channel = asString(frame.channel);
    const inner = frame.data;
    if (inner && typeof inner === "object" && typeof (inner as { type?: unknown }).type === "string") {
        const { type, action, data } = inner as { type: string; action?: unknown; data?: unknown };
        return { type, action: asString(action), data, channel };
    }
    return { type: "MESSAGE", data: inner, channel };
}

let shared: PushClient | undefined;

/** The tab's one push client (created on first use). Sharing it is what keeps a tab to one socket. */
export function getPushClient(): PushClient {
    shared ??= new PushClient();
    return shared;
}

/** Closes the tab's push client and forgets it, so the next `getPushClient()` makes a fresh one. For a test, or a page
 * that stays open after its session ended and might sign in again; ordinary sign-out just navigates away. */
export function resetPushClient(): void {
    shared?.close();
    shared = undefined;
}
