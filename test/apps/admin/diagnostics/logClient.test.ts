// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureApiBaseUrl } from "@rapidmx/react-shared/util/api.js";
import {
    LOG_BACKOFF_BASE_MS,
    LOG_BACKOFF_MAX_MS,
    LOG_CLOSE_REFUSED,
    LogClient,
    LogSocket,
    logsUrl,
    LogStreamStatus,
    refusedMessage,
} from "../../../../apps/shared/components/admin/diagnostics/logClient.js";
import type { LogEntry } from "../../../../apps/shared/components/admin/diagnostics/logLines.js";

class FakeSocket implements LogSocket {
    static instances: FakeSocket[] = [];
    readyState = 0;
    onopen: LogSocket["onopen"] = null;
    onmessage: LogSocket["onmessage"] = null;
    onclose: LogSocket["onclose"] = null;
    onerror: LogSocket["onerror"] = null;
    closed: { code?: number; reason?: string } | undefined;
    constructor(readonly url: string) {
        FakeSocket.instances.push(this);
    }
    close(code?: number, reason?: string) {
        this.closed = { code, reason };
    }
    receive(data: unknown) {
        this.onmessage?.({ data });
    }
    serverClose(code?: number, reason?: string) {
        this.onclose?.({ code, reason });
    }
}

const GREETING = '{"id":0,"type":"SUBSCRIBED","success":true,"data":"logs"}';

function setup(options: { random?: () => number; url?: () => string | undefined } = {}) {
    FakeSocket.instances = [];
    const client = new LogClient({
        createSocket: (url) => new FakeSocket(url),
        random: options.random ?? (() => 0),
        now: () => 500,
        url: options.url ?? (() => "wss://mail.example.com/api/admin/logs"),
    });
    const statuses: [LogStreamStatus, string | undefined][] = [];
    const entries: LogEntry[] = [];
    client.onStatus((status, error) => statuses.push([status, error]));
    client.onEntry((entry) => entries.push(entry));
    return { client, statuses, entries, socket: () => FakeSocket.instances[FakeSocket.instances.length - 1] };
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    configureApiBaseUrl("");
});

describe("logsUrl", () => {
    it("is the /api/admin/logs route on this page's origin, on ws: or wss: to match", () => {
        expect(logsUrl()).toBe(`${window.location.origin.replace(/^http/, "ws")}/api/admin/logs`);
    });

    it("follows a configured API origin", () => {
        configureApiBaseUrl("https://mail.example.com");
        expect(logsUrl()).toBe("wss://mail.example.com/api/admin/logs");
        configureApiBaseUrl("http://localhost:3000");
        expect(logsUrl()).toBe("ws://localhost:3000/api/admin/logs");
    });

    it("is undefined where there is no page origin", () => {
        vi.stubGlobal("window", undefined);
        expect(logsUrl()).toBeUndefined();
    });
});

describe("LogClient", () => {
    it("connects, goes live on the greeting, and delivers lines but not the greeting", () => {
        const { client, statuses, entries, socket } = setup();
        expect(client.status).toBe("closed");
        client.start();
        client.start();
        expect(FakeSocket.instances).toHaveLength(1);
        expect(socket().url).toBe("wss://mail.example.com/api/admin/logs");
        expect(client.status).toBe("connecting");

        socket().receive(GREETING);
        expect(client.status).toBe("live");
        expect(entries).toEqual([]);

        socket().receive('{"level":"info","message":"hello","timestamp":"T"}');
        socket().receive("not json");
        socket().receive(new ArrayBuffer(2));
        expect(entries.map((entry) => [entry.id, entry.message, entry.receivedAt])).toEqual([
            [1, "hello", 500],
            [2, "not json", 500],
        ]);
        expect(statuses.map(([status]) => status)).toEqual(["connecting", "live"]);
    });

    it("goes live on a first line that has no greeting before it", () => {
        const { client, socket } = setup();
        client.start();
        socket().receive('{"level":"info","message":"early"}');
        expect(client.status).toBe("live");
    });

    it("reconnects with a growing backoff after a close, and is live again after the greeting", () => {
        vi.useFakeTimers();
        const { client, statuses, socket } = setup({ random: () => 1 });
        client.start();
        socket().receive(GREETING);

        socket().serverClose(1006);
        expect(client.status).toBe("reconnecting");
        // With the jitter at its highest the wait is the whole ceiling: 1 s, then 2 s.
        vi.advanceTimersByTime(LOG_BACKOFF_BASE_MS - 1);
        expect(FakeSocket.instances).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(FakeSocket.instances).toHaveLength(2);
        expect(client.status).toBe("reconnecting");

        socket().serverClose(1006, "");
        vi.advanceTimersByTime(2 * LOG_BACKOFF_BASE_MS);
        expect(FakeSocket.instances).toHaveLength(3);

        socket().receive(GREETING);
        expect(client.status).toBe("live");
        // The greeting forgot the earlier failures: the next wait is the shortest again.
        socket().serverClose(1001);
        vi.advanceTimersByTime(LOG_BACKOFF_BASE_MS);
        expect(FakeSocket.instances).toHaveLength(4);
        expect(statuses.map(([status]) => status)).toEqual([
            "connecting",
            "live",
            "reconnecting",
            "live",
            "reconnecting",
        ]);
    });

    it("caps the backoff", () => {
        vi.useFakeTimers();
        const { client, socket } = setup({ random: () => 1 });
        client.start();
        for (let attempt = 0; attempt < 12; attempt++) {
            socket().serverClose(1006);
            vi.advanceTimersByTime(LOG_BACKOFF_MAX_MS);
        }
        const count = FakeSocket.instances.length;
        expect(count).toBe(13);
        socket().serverClose(1006);
        vi.advanceTimersByTime(LOG_BACKOFF_MAX_MS - 1);
        expect(FakeSocket.instances).toHaveLength(count);
        vi.advanceTimersByTime(1);
        expect(FakeSocket.instances).toHaveLength(count + 1);
    });

    it("uses half the ceiling at least, and jitters the rest", () => {
        vi.useFakeTimers();
        const { client, socket } = setup({ random: () => 0 });
        client.start();
        socket().serverClose(1006);
        vi.advanceTimersByTime(LOG_BACKOFF_BASE_MS / 2);
        expect(FakeSocket.instances).toHaveLength(2);
    });

    it("draws its own jitter from Math.random when it is not given one", () => {
        vi.useFakeTimers();
        const random = vi.spyOn(Math, "random").mockReturnValue(0);
        FakeSocket.instances = [];
        const client = new LogClient({ createSocket: (url) => new FakeSocket(url), url: () => "ws://x" });
        client.start();
        FakeSocket.instances[0].serverClose(1006);
        expect(random).toHaveBeenCalled();
        random.mockRestore();
        client.stop();
    });

    it("shows a refusal (close code 1002) as an error and never reconnects", () => {
        vi.useFakeTimers();
        const { client, statuses, socket } = setup();
        client.start();
        socket().serverClose(LOG_CLOSE_REFUSED, "api-103");
        expect(client.status).toBe("error");
        expect(client.error).toBe(refusedMessage("api-103"));
        expect(client.error).toContain("api-103");
        vi.advanceTimersByTime(10 * LOG_BACKOFF_MAX_MS);
        expect(FakeSocket.instances).toHaveLength(1);
        expect(statuses[statuses.length - 1]).toEqual(["error", refusedMessage("api-103")]);

        // Start tries again, and clears the error.
        client.start();
        expect(FakeSocket.instances).toHaveLength(2);
        expect(client.status).toBe("connecting");
        expect(client.error).toBeUndefined();
    });

    it("words a refusal that comes with no reason", () => {
        const { client, socket } = setup();
        client.start();
        socket().serverClose(LOG_CLOSE_REFUSED);
        expect(client.error).toBe(refusedMessage(undefined));
        expect(refusedMessage("")).toBe(refusedMessage(undefined));
    });

    it("stops on a greeting that says the subscription failed", () => {
        const { client, socket } = setup();
        client.start();
        const first = socket();
        first.receive('{"id":0,"type":"SUBSCRIBED","success":false}');
        expect(client.status).toBe("error");
        expect(client.error).toBe(refusedMessage(undefined));
        expect(first.closed).toEqual({ code: 1000, reason: "closing" });
    });

    it("stop() closes the socket, cancels a pending reconnect and can be started again", () => {
        vi.useFakeTimers();
        const { client, statuses, socket } = setup();
        client.start();
        const first = socket();
        first.receive(GREETING);
        client.stop();
        expect(client.status).toBe("closed");
        expect(first.closed).toEqual({ code: 1000, reason: "closing" });
        // A close the client stopped listening to is ignored, as is a late frame.
        first.onclose?.({ code: 1006 });
        first.onmessage?.({ data: "late" });
        vi.advanceTimersByTime(LOG_BACKOFF_MAX_MS);
        expect(FakeSocket.instances).toHaveLength(1);

        client.start();
        socket().serverClose(1006);
        client.stop();
        vi.advanceTimersByTime(LOG_BACKOFF_MAX_MS);
        expect(FakeSocket.instances).toHaveLength(2);
        expect(statuses[statuses.length - 1][0]).toBe("closed");
        client.stop();
    });

    it("ignores the close of a socket it has replaced", () => {
        vi.useFakeTimers();
        const { client, socket } = setup();
        client.start();
        const first = socket();
        first.serverClose(1006);
        vi.advanceTimersByTime(LOG_BACKOFF_MAX_MS);
        expect(FakeSocket.instances).toHaveLength(2);
        // The old socket closing again must not start another reconnect.
        first.onclose?.({ code: 1006 });
        vi.advanceTimersByTime(LOG_BACKOFF_MAX_MS);
        expect(FakeSocket.instances).toHaveLength(2);
    });

    it("tolerates a socket that throws when closed, and an error event", () => {
        const { client, socket } = setup();
        client.start();
        socket().close = () => {
            throw new Error("gone");
        };
        expect(socket().onerror?.({})).toBeUndefined();
        expect(() => client.stop()).not.toThrow();
    });

    it("retries when the socket cannot be created", () => {
        vi.useFakeTimers();
        let attempts = 0;
        const client = new LogClient({
            createSocket: (url) => {
                attempts += 1;
                if (attempts === 1) {
                    throw new Error("blocked");
                }
                return new FakeSocket(url);
            },
            random: () => 0,
            url: () => "ws://x",
        });
        client.start();
        expect(client.status).toBe("reconnecting");
        vi.advanceTimersByTime(LOG_BACKOFF_BASE_MS);
        expect(attempts).toBe(2);
        client.stop();
    });

    it("says so, and does not retry, when there is no URL or no WebSocket", () => {
        const noUrl = setup({ url: () => undefined });
        noUrl.client.start();
        expect(noUrl.client.status).toBe("error");
        expect(noUrl.client.error).toMatch(/cannot open a WebSocket/);

        vi.stubGlobal("WebSocket", undefined);
        const client = new LogClient({ url: () => "ws://x" });
        client.start();
        expect(client.status).toBe("error");
    });

    it("opens a browser WebSocket by default, at the logs URL", () => {
        const created: string[] = [];
        class BrowserSocket extends FakeSocket {
            constructor(url: string) {
                super(url);
                created.push(url);
            }
        }
        vi.stubGlobal("WebSocket", BrowserSocket);
        const client = new LogClient();
        client.start();
        expect(created).toEqual([logsUrl()]);
        client.stop();
    });

    it("stops calling a listener that unsubscribed", () => {
        const { client, statuses, entries, socket } = setup();
        const stop = client.onEntry(() => entries.push({} as LogEntry));
        stop();
        const stopStatus = client.onStatus(() => statuses.push(["closed", "unsubscribed"]));
        stopStatus();
        client.start();
        socket().receive('{"level":"info","message":"x"}');
        expect(entries).toHaveLength(1);
        expect(statuses.some(([, error]) => error === "unsubscribed")).toBe(false);
    });
});
