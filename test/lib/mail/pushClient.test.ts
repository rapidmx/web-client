// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureApiBaseUrl } from "../../../lib/util/api.js";
import {
    PUSH_BACKOFF_BASE_MS,
    PUSH_BACKOFF_MAX_MS,
    PUSH_MAX_CHANNELS,
    PushClient,
    PushEvent,
    PushSocket,
    getPushClient,
    pushUrl,
    resetPushClient,
} from "../../../lib/mail/pushClient.js";

/** A stand-in for the browser's WebSocket that a test drives by hand. */
class FakeSocket implements PushSocket {
    static instances: FakeSocket[] = [];
    readyState = 1;
    sent: any[] = [];
    closedWith: { code?: number; reason?: string } | undefined;
    onopen: PushSocket["onopen"] = null;
    onmessage: PushSocket["onmessage"] = null;
    onclose: PushSocket["onclose"] = null;
    onerror: PushSocket["onerror"] = null;

    constructor(public url: string) {
        FakeSocket.instances.push(this);
    }

    send(data: string) {
        this.sent.push(JSON.parse(data));
    }

    close(code?: number, reason?: string) {
        this.closedWith = { code, reason };
    }

    /** The server delivering a frame. */
    receive(frame: unknown) {
        this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
    }

    /** The server's greeting on connect: `id: 0`, with the channels the socket is already on. */
    greet(channels: string[] = ["user-1"]) {
        this.receive({ id: 0, type: "SUBSCRIBED", success: true, data: channels });
    }

    /** The socket dropping. */
    drop() {
        this.onclose?.({});
    }
}

function latest(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1];
}

function newClient(random = () => 0.5) {
    return new PushClient({ url: () => "wss://mail.example.com/push", createSocket: (url) => new FakeSocket(url), random });
}

beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    configureApiBaseUrl("");
    resetPushClient();
});

describe("pushUrl", () => {
    it("is the page's own origin's /push route, on ws: for http: ...", () => {
        expect(pushUrl()).toBe(`${window.location.origin.replace(/^http/, "ws")}/push`);
        expect(pushUrl()).toMatch(/^ws:\/\/[^/]+\/push$/);
    });

    it("... and on wss: for a configured https: API origin", () => {
        configureApiBaseUrl("https://mail.example.com/");
        expect(pushUrl()).toBe("wss://mail.example.com/push");
    });

    it("is undefined where there is no window and no configured origin", () => {
        vi.stubGlobal("window", undefined);
        expect(pushUrl()).toBeUndefined();
    });
});

describe("PushClient connecting", () => {
    it("connects once, however often it is started, and reports the greeting as open", () => {
        const client = newClient();
        const statuses: string[] = [];
        client.onStatus((s) => statuses.push(s));
        expect(client.status).toBe("idle");

        client.start();
        client.start();
        expect(FakeSocket.instances).toHaveLength(1);
        expect(latest().url).toBe("wss://mail.example.com/push");
        expect(client.status).toBe("connecting");

        latest().greet();
        expect(client.status).toBe("open");
        expect(statuses).toEqual(["connecting", "open"]);
    });

    it("subscribes to the wanted channels the greeting does not already cover, once the greeting arrives", () => {
        const client = newClient();
        client.setChannels(["f1", "f2", "f1", "mb1"]);
        client.start();
        // Nothing is sent before the server has set the socket up.
        expect(latest().sent).toEqual([]);

        latest().greet(["user-1", "f2"]);
        expect(latest().sent).toEqual([{ id: 1, type: "SUBSCRIBE", data: ["f1", "mb1"] }]);
    });

    it("sends no subscribe when everything wanted is already subscribed", () => {
        const client = newClient();
        client.setChannels(["f2"]);
        client.start();
        latest().greet(["user-1", "f2"]);
        expect(latest().sent).toEqual([]);
    });

    it("subscribes and unsubscribes the difference on an open socket, unsubscribing only what it asked for", () => {
        const client = newClient();
        client.setChannels(["f1"]);
        client.start();
        latest().greet(["user-1", "other-tab"]);
        latest().receive({ id: 1, type: "SUBSCRIBED", data: ["f1"] });

        client.setChannels(["f1", "f2"]);
        expect(latest().sent.slice(1)).toEqual([{ id: 2, type: "SUBSCRIBE", data: ["f2"] }]);
        latest().receive({ id: 2, type: "SUBSCRIBED", data: ["f2"] });

        client.setChannels(["f2"]);
        expect(latest().sent.slice(2)).toEqual([{ id: 3, type: "UNSUBSCRIBE", data: ["f1"] }]);
        latest().receive({ id: 3, type: "UNSUBSCRIBED", data: ["f1"] });

        // A channel the greeting gave it (another tab's) is never dropped, and neither is the user's own.
        client.setChannels([]);
        expect(latest().sent.slice(3)).toEqual([{ id: 4, type: "UNSUBSCRIBE", data: ["f2"] }]);
        // Once dropped it is wanted again from scratch.
        latest().receive({ id: 4, type: "UNSUBSCRIBED", data: ["f2"] });
        client.setChannels(["f2"]);
        expect(latest().sent.slice(4)).toEqual([{ id: 5, type: "SUBSCRIBE", data: ["f2"] }]);
    });

    it("keeps only PUSH_MAX_CHANNELS channels, the first ones", () => {
        const client = newClient();
        const many = Array.from({ length: PUSH_MAX_CHANNELS + 10 }, (_, i) => `c${i}`);
        client.setChannels(many);
        client.start();
        latest().greet();
        expect(latest().sent[0].data).toEqual(many.slice(0, PUSH_MAX_CHANNELS));
    });

    it("does nothing where there is nothing to connect with", () => {
        const noUrl = new PushClient({ url: () => undefined, createSocket: (url) => new FakeSocket(url) });
        noUrl.start();
        const noSocket = new PushClient({ url: () => "wss://x/push" });
        vi.stubGlobal("WebSocket", undefined);
        noSocket.start();
        expect(FakeSocket.instances).toHaveLength(0);
        expect(noUrl.status).toBe("idle");
        expect(noSocket.status).toBe("idle");
    });

    it("connects through the browser's WebSocket by default", () => {
        const created: string[] = [];
        class BrowserSocket extends FakeSocket {
            constructor(url: string) {
                super(url);
                created.push(url);
            }
        }
        vi.stubGlobal("WebSocket", BrowserSocket);
        configureApiBaseUrl("https://mail.example.com");
        new PushClient().start();
        expect(created).toEqual(["wss://mail.example.com/push"]);
    });

    it("keeps trying, with backoff, when the socket can't even be created", () => {
        let calls = 0;
        const client = new PushClient({
            url: () => "wss://x/push",
            createSocket: (url) => {
                calls += 1;
                if (calls === 1) throw new Error("blocked by CSP");
                return new FakeSocket(url);
            },
            random: () => 0,
        });
        client.start();
        expect(client.status).toBe("reconnecting");
        vi.advanceTimersByTime(PUSH_BACKOFF_BASE_MS / 2);
        expect(calls).toBe(2);
    });
});

describe("PushClient events", () => {
    function collect(client: PushClient) {
        const events: PushEvent[] = [];
        client.onEvent((e) => events.push(e));
        return events;
    }

    it("delivers an event as the server published it ({ type, action, data })", () => {
        const client = newClient();
        const events = collect(client);
        client.start();
        latest().greet();

        const message = { uid: "m1", folderUid: "f1" };
        latest().receive({ type: "MessageMongo", action: "create", data: message });
        expect(events).toEqual([{ type: "MessageMongo", action: "create", data: message }]);
    });

    it("unwraps an event that carries its channel ({ type: MESSAGE, channel, data: { type, action, data } })", () => {
        const client = newClient();
        const events = collect(client);
        client.start();
        latest().receive({ type: "MESSAGE", channel: "f1", data: { type: "MessageSQL", action: "update", data: { uid: "m1" } } });
        expect(events).toEqual([{ type: "MessageSQL", action: "update", data: { uid: "m1" }, channel: "f1" }]);
    });

    it("passes an unstructured MESSAGE payload through, and tolerates a non-string action or channel", () => {
        const client = newClient();
        const events = collect(client);
        client.start();
        latest().receive({ type: "MESSAGE", channel: "f1", data: "hello" });
        latest().receive({ type: "MESSAGE", data: null });
        latest().receive({ type: "Folder", action: 7, data: { uid: "f1" } });
        latest().receive({ type: "MESSAGE", channel: 5, data: { type: "Message", action: 1 } });
        expect(events).toEqual([
            { type: "MESSAGE", data: "hello", channel: "f1" },
            { type: "MESSAGE", data: null, channel: undefined },
            { type: "Folder", action: undefined, data: { uid: "f1" } },
            { type: "Message", action: undefined, data: undefined, channel: undefined },
        ]);
    });

    it("ignores frames that are not events: binary, not JSON, not an object, typeless, or control replies", () => {
        const client = newClient();
        const events = collect(client);
        client.start();
        latest().onmessage?.({ data: new ArrayBuffer(4) });
        latest().receive("not json");
        latest().receive("null");
        latest().receive("42");
        latest().receive({ noType: true });
        latest().receive({ type: 5 });
        latest().receive({ id: 3, type: "LOGIN_RESPONSE", success: true });
        latest().receive({ id: 99, type: "SUBSCRIBED", data: ["x"] });
        latest().receive({ id: 0, type: "SUBSCRIBED", data: "not an array" });
        expect(events).toEqual([]);
    });

    it("takes the greeting once, and ignores a later id-0 SUBSCRIBED", () => {
        const client = newClient();
        client.setChannels(["f1"]);
        client.start();
        latest().greet();
        latest().greet();
        expect(latest().sent).toHaveLength(1);
    });

    it("stops delivering to a listener that unsubscribed, and one listener's failure never stops another", () => {
        const client = newClient();
        const heard: string[] = [];
        client.onEvent(() => {
            throw new Error("bad listener");
        });
        const off = client.onEvent((e) => heard.push(`a:${e.type}`));
        client.onEvent((e) => heard.push(`b:${e.type}`));
        client.start();

        latest().receive({ type: "T1", data: {} });
        off();
        latest().receive({ type: "T2", data: {} });
        expect(heard).toEqual(["a:T1", "b:T1", "b:T2"]);
    });

    it("stops calling a status listener that unsubscribed", () => {
        const client = newClient();
        const seen: string[] = [];
        const off = client.onStatus((s) => seen.push(s));
        client.start();
        off();
        latest().greet();
        expect(seen).toEqual(["connecting"]);
    });
});

describe("PushClient reconnecting", () => {
    it("reconnects after a drop, waiting half the ceiling plus jitter, and re-subscribes everything", () => {
        const client = newClient(() => 0.5);
        client.setChannels(["f1", "f2"]);
        client.start();
        latest().greet();
        latest().receive({ id: 1, type: "SUBSCRIBED", data: ["f1", "f2"] });

        latest().drop();
        expect(client.status).toBe("reconnecting");
        // The first wait: ceiling 1000ms -> 500 + 0.5 * 500 = 750ms.
        vi.advanceTimersByTime(749);
        expect(FakeSocket.instances).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(FakeSocket.instances).toHaveLength(2);

        latest().greet();
        expect(client.status).toBe("open");
        expect(latest().sent).toEqual([{ id: 2, type: "SUBSCRIBE", data: ["f1", "f2"] }]);
    });

    it("doubles the wait for each failure up to the cap, with jitter between half and the whole of it", () => {
        const client = newClient(() => 0);
        client.start();
        const waits: number[] = [];
        for (let i = 0; i < 9; i++) {
            const before = FakeSocket.instances.length;
            latest().drop();
            // With no jitter the wait is exactly half the ceiling; step until the next socket appears.
            let waited = 0;
            while (FakeSocket.instances.length === before) {
                vi.advanceTimersByTime(1);
                waited += 1;
            }
            waits.push(waited);
        }
        expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
        expect(PUSH_BACKOFF_MAX_MS / 2).toBe(30000);

        // With jitter 0.9 the first wait is 500 + 0.9 * 500 = 950ms.
        const jittered = newClient(() => 0.9);
        jittered.start();
        const before = FakeSocket.instances.length;
        latest().drop();
        vi.advanceTimersByTime(949);
        expect(FakeSocket.instances).toHaveLength(before);
        vi.advanceTimersByTime(1);
        expect(FakeSocket.instances).toHaveLength(before + 1);
    });

    it("uses Math.random for jitter by default", () => {
        const random = vi.spyOn(Math, "random").mockReturnValue(0);
        const client = new PushClient({ url: () => "wss://x/push", createSocket: (url) => new FakeSocket(url) });
        client.start();
        latest().drop();
        expect(random).toHaveBeenCalled();
        random.mockRestore();
    });

    it("starts the backoff over once a socket is greeted, but not on a mere open (a socket the server closes at once)", () => {
        const client = newClient(() => 0);
        client.start();
        latest().drop();
        vi.advanceTimersByTime(500);
        latest().onopen?.({});
        latest().drop();
        // Second failure in a row: the wait doubled.
        vi.advanceTimersByTime(999);
        expect(FakeSocket.instances).toHaveLength(2);
        vi.advanceTimersByTime(1);
        expect(FakeSocket.instances).toHaveLength(3);

        latest().greet();
        latest().drop();
        vi.advanceTimersByTime(500);
        expect(FakeSocket.instances).toHaveLength(4);
    });

    it("reconnects at once when told the browser is back online, and does nothing otherwise", () => {
        const client = newClient(() => 0.5);
        client.reconnectNow();
        expect(FakeSocket.instances).toHaveLength(0);

        client.start();
        client.reconnectNow();
        expect(FakeSocket.instances).toHaveLength(1);

        latest().drop();
        client.reconnectNow();
        expect(FakeSocket.instances).toHaveLength(2);
        // The pending timer was cancelled: no third socket appears.
        vi.advanceTimersByTime(PUSH_BACKOFF_MAX_MS);
        expect(FakeSocket.instances).toHaveLength(2);

        client.close();
        client.reconnectNow();
        expect(FakeSocket.instances).toHaveLength(2);
    });

    it("does not schedule a second reconnect when the same socket reports its close twice", () => {
        const client = newClient(() => 0);
        client.start();
        const socket = latest();
        socket.drop();
        socket.drop();
        vi.advanceTimersByTime(500);
        expect(FakeSocket.instances).toHaveLength(2);
    });

    it("ignores a socket error - the close that follows is what reconnects", () => {
        const client = newClient(() => 0);
        client.start();
        latest().onerror?.({});
        expect(FakeSocket.instances).toHaveLength(1);
        expect(client.status).toBe("connecting");
    });
});

describe("PushClient closing", () => {
    it("closes the socket, never reconnects, and cannot be started again", () => {
        const client = newClient(() => 0);
        client.start();
        const socket = latest();
        socket.greet();

        client.close();
        expect(socket.closedWith).toEqual({ code: 1000, reason: "closing" });
        expect(client.status).toBe("closed");
        // The old socket's late close event is ignored.
        expect(socket.onclose).toBeNull();
        vi.advanceTimersByTime(PUSH_BACKOFF_MAX_MS * 2);
        expect(FakeSocket.instances).toHaveLength(1);

        client.start();
        expect(FakeSocket.instances).toHaveLength(1);
        // Idempotent, and setChannels is harmless afterwards.
        client.close();
        client.setChannels(["f1"]);
        expect(socket.sent).toEqual([]);
    });

    it("cancels a pending reconnect", () => {
        const client = newClient(() => 0);
        client.start();
        latest().drop();
        client.close();
        vi.advanceTimersByTime(PUSH_BACKOFF_MAX_MS);
        expect(FakeSocket.instances).toHaveLength(1);
    });

    it("closes cleanly when there is no socket yet, or the socket's close throws", () => {
        const idle = newClient();
        expect(() => idle.close()).not.toThrow();

        const client = newClient();
        client.start();
        latest().close = () => {
            throw new Error("already closing");
        };
        expect(() => client.close()).not.toThrow();
        expect(client.status).toBe("closed");
    });

    it("ignores the late close event of a socket that has been replaced", () => {
        const client = newClient(() => 0);
        client.start();
        const first = latest();
        first.drop();
        vi.advanceTimersByTime(500);
        const second = latest();
        // The first socket reports its close again after the second is up: it is not the current one.
        first.drop();
        vi.advanceTimersByTime(PUSH_BACKOFF_MAX_MS);
        expect(FakeSocket.instances).toHaveLength(2);
        expect(client.status).toBe("reconnecting");
        expect(second.onclose).not.toBeNull();
    });
});

describe("PushClient sending", () => {
    it("sends nothing over a socket that is not open, and survives a socket whose send throws", () => {
        const client = newClient();
        client.setChannels(["f1"]);
        client.start();
        latest().readyState = 3;
        latest().greet();
        expect(latest().sent).toEqual([]);

        latest().readyState = 1;
        latest().send = () => {
            throw new Error("closed");
        };
        expect(() => client.setChannels(["f1", "f2"])).not.toThrow();
    });
});

describe("getPushClient", () => {
    it("is one client for the tab, until reset", () => {
        const first = getPushClient();
        expect(getPushClient()).toBe(first);
        resetPushClient();
        expect(first.status).toBe("closed");
        expect(getPushClient()).not.toBe(first);
    });

    it("resets harmlessly when there is no client", () => {
        resetPushClient();
        expect(() => resetPushClient()).not.toThrow();
    });
});
