///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { apiUrl } from "@rapidmx/react-shared/util/api.js";
import { isControlFrame, LogEntry, parseLogFrame } from "./logLines.js";

/**
 * A client for the server's live log stream: the WebSocket of the `/admin` route's `logs` endpoint (`<origin>/api/admin/logs`).
 * It follows the shape of `@rapidmx/react-shared`'s `PushClient`, and differs where the protocol does.
 *
 * - It authenticates from the `jwt` cookie the browser sends with the upgrade. The server closes the socket with code 1002 when
 * the caller may not read the logs, or the stream is not set up on the server, with an error code as the close reason. That is
 * final: retrying would be refused the same way, so the client stops with an error and does not reconnect.
 * - The first frame is a control message, `{"id":0,"type":"SUBSCRIBED","success":true,"data":"<channel>"}`, which says the stream
 * is live. It is not a log line. Every later frame is the JSON of one Winston `info` object (see `parseLogFrame()`).
 * - Delivery is fire-and-forget: lines logged while the socket was down are not replayed.
 * - Any other close is retried with exponential backoff and jitter until `stop()`.
 */

/** The subset of the browser's `WebSocket` this client uses - what a test's fake implements. */
export interface LogSocket {
    readyState: number;
    close(code?: number, reason?: string): void;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: { code?: number; reason?: string }) => void) | null;
    onerror: ((event: unknown) => void) | null;
}

export type LogSocketFactory = (url: string) => LogSocket;

/**
 * `connecting`: opening the first connection. `live`: subscribed. `reconnecting`: the connection was lost, or a reconnect is
 * being tried. `closed`: stopped (or never started). `error`: refused for good, with `error()` saying why.
 */
export type LogStreamStatus = "connecting" | "live" | "reconnecting" | "closed" | "error";

/** The close code the server uses when it refuses the stream (a permission or configuration failure). */
export const LOG_CLOSE_REFUSED = 1002;

/** The first reconnect waits about this long, and each further failure doubles it ... */
export const LOG_BACKOFF_BASE_MS = 1_000;
/** ... up to this. */
export const LOG_BACKOFF_MAX_MS = 30_000;

/** The log stream's URL: `apiUrl("/admin/logs")` made absolute (a relative one takes this page's origin) on `ws:`/`wss:` to
 * match. `undefined` where there is no origin to use (server-side rendering). */
export function logsUrl(): string | undefined {
    const url = apiUrl("/admin/logs");
    let absolute: string | undefined = url;
    if (!/^https?:\/\//i.test(url)) {
        absolute = typeof window === "undefined" ? undefined : `${window.location.origin}${url}`;
    }
    return absolute?.replace(/^http/i, "ws");
}

function defaultSocketFactory(): LogSocketFactory | undefined {
    return typeof WebSocket === "undefined" ? undefined : (url) => new WebSocket(url) as unknown as LogSocket;
}

/** What the error for a refused stream says: the server's reason is an error code, so it is shown as one. */
export function refusedMessage(reason: string | undefined): string {
    return reason
        ? `The server refused the log stream (${reason}). Check that you are an administrator and that log streaming is enabled.`
        : "The server refused the log stream. Check that you are an administrator and that log streaming is enabled.";
}

export interface LogClientOptions {
    /** The URL to connect to. Defaults to `logsUrl()`. */
    url?: () => string | undefined;
    /** Creates the socket. Defaults to the browser's `WebSocket`, if there is one. */
    createSocket?: LogSocketFactory;
    /** A `Math.random()` stand-in, for the backoff's jitter. */
    random?: () => number;
    /** A clock, for the time lines are received at. */
    now?: () => number;
}

export class LogClient {
    private socket: LogSocket | undefined;
    private running = false;
    private attempt = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private nextId = 1;
    private current: LogStreamStatus = "closed";
    private failure: string | undefined;
    private readonly entryListeners = new Set<(entry: LogEntry) => void>();
    private readonly statusListeners = new Set<(status: LogStreamStatus, error: string | undefined) => void>();

    constructor(private readonly options: LogClientOptions = {}) {}

    get status(): LogStreamStatus {
        return this.current;
    }

    /** Why the stream is in the `error` state. */
    get error(): string | undefined {
        return this.failure;
    }

    /** Connects, and keeps reconnecting until `stop()`, or until the server refuses the stream. A no-op while it already runs. */
    start(): void {
        if (this.running) {
            return;
        }
        this.running = true;
        this.attempt = 0;
        this.connect();
    }

    /** Closes the socket and stops reconnecting. The client can be started again. */
    stop(): void {
        this.running = false;
        clearTimeout(this.timer);
        this.timer = undefined;
        this.detach();
        this.setStatus("closed");
    }

    /** Calls `listener` with every log line; returns the function that stops it. */
    onEntry(listener: (entry: LogEntry) => void): () => void {
        this.entryListeners.add(listener);
        return () => this.entryListeners.delete(listener);
    }

    /** Calls `listener` whenever the status changes; returns the function that stops it. */
    onStatus(listener: (status: LogStreamStatus, error: string | undefined) => void): () => void {
        this.statusListeners.add(listener);
        return () => this.statusListeners.delete(listener);
    }

    private setStatus(status: LogStreamStatus, error?: string): void {
        if (status === this.current && error === this.failure) {
            return;
        }
        this.current = status;
        this.failure = error;
        for (const listener of [...this.statusListeners]) {
            listener(status, error);
        }
    }

    /** Lets go of the socket without hearing about it any more, and closes it. */
    private detach(): void {
        const socket = this.socket;
        this.socket = undefined;
        if (socket) {
            socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
            try {
                socket.close(1000, "closing");
            } catch {
                // Already gone.
            }
        }
    }

    private connect(): void {
        const url = (this.options.url ?? logsUrl)();
        const createSocket = this.options.createSocket ?? defaultSocketFactory();
        if (!url || !createSocket) {
            this.running = false;
            this.setStatus("error", "This browser cannot open a WebSocket to the server.");
            return;
        }
        let socket: LogSocket;
        try {
            socket = createSocket(url);
        } catch {
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
        socket.onmessage = (event) => this.handleFrame(event.data);
        socket.onclose = (event) => {
            if (this.socket !== socket) {
                return;
            }
            this.socket = undefined;
            if (event.code === LOG_CLOSE_REFUSED) {
                this.running = false;
                this.setStatus("error", refusedMessage(event.reason));
                return;
            }
            this.scheduleReconnect();
        };
        // A failed connection is followed by a close, which is what triggers the retry.
        socket.onerror = () => undefined;
    }

    /** Waits out an exponentially growing, jittered delay ("equal jitter": half fixed, half random), then reconnects. */
    private scheduleReconnect(): void {
        const ceiling = Math.min(LOG_BACKOFF_MAX_MS, LOG_BACKOFF_BASE_MS * 2 ** Math.min(this.attempt, 30));
        const delay = ceiling / 2 + ((this.options.random ?? Math.random)() * ceiling) / 2;
        this.attempt += 1;
        this.setStatus("reconnecting");
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.connect();
        }, delay);
    }

    private handleFrame(data: unknown): void {
        if (typeof data !== "string") {
            return;
        }
        const frame = parseLogFrame(data, this.nextId, (this.options.now ?? Date.now)());
        if (isControlFrame(frame)) {
            if (frame.success) {
                this.attempt = 0;
                this.setStatus("live");
            } else {
                // The server accepted the socket and refused the subscription: nothing will ever be sent.
                this.running = false;
                this.detach();
                this.setStatus("error", refusedMessage(undefined));
            }
            return;
        }
        this.nextId += 1;
        if (this.current !== "live") {
            // A line before the greeting means the stream is flowing.
            this.attempt = 0;
            this.setStatus("live");
        }
        for (const listener of [...this.entryListeners]) {
            listener(frame);
        }
    }
}
