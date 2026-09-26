// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogSocket } from "../../../../apps/shared/components/admin/diagnostics/logClient.js";
import { LOG_BUFFER_LIMIT } from "../../../../apps/shared/components/admin/diagnostics/LogStore.js";
import { LOG_FLUSH_MS, useLogStream } from "../../../../apps/shared/components/admin/diagnostics/useLogStream.js";

class FakeSocket implements LogSocket {
    static instances: FakeSocket[] = [];
    readyState = 1;
    onopen: LogSocket["onopen"] = null;
    onmessage: LogSocket["onmessage"] = null;
    onclose: LogSocket["onclose"] = null;
    onerror: LogSocket["onerror"] = null;
    closed = false;
    constructor(readonly url: string) {
        FakeSocket.instances.push(this);
    }
    close() {
        this.closed = true;
    }
}

const socket = () => FakeSocket.instances[FakeSocket.instances.length - 1];
const send = (data: string) => act(() => socket().onmessage?.({ data }));
const line = (message: string, level = "info") => JSON.stringify({ level, message });

function setup() {
    FakeSocket.instances = [];
    return renderHook(() => useLogStream({ createSocket: (url) => new FakeSocket(url), url: () => "wss://x/api/admin/logs" }));
}

afterEach(() => {
    vi.useRealTimers();
});

describe("useLogStream", () => {
    it("does not connect until started, and is stopped", () => {
        const { result } = setup();
        expect(FakeSocket.instances).toHaveLength(0);
        expect(result.current).toMatchObject({ status: "closed", running: false, entries: [], dropped: 0, capture: undefined });
    });

    it("follows the connection: connecting, live, and stopped again", () => {
        const { result } = setup();
        act(() => result.current.start());
        expect(result.current.status).toBe("connecting");
        expect(result.current.running).toBe(true);
        send('{"id":0,"type":"SUBSCRIBED","success":true,"data":"logs"}');
        expect(result.current.status).toBe("live");
        act(() => socket().onclose?.({ code: 1006 }));
        expect(result.current.status).toBe("reconnecting");
        expect(result.current.running).toBe(true);
        act(() => result.current.stop());
        expect(result.current.status).toBe("closed");
        expect(result.current.running).toBe(false);
    });

    it("reports a refusal as an error that is not running", () => {
        const { result } = setup();
        act(() => result.current.start());
        act(() => socket().onclose?.({ code: 1002, reason: "api-103" }));
        expect(result.current.status).toBe("error");
        expect(result.current.running).toBe(false);
        expect(result.current.error).toContain("api-103");
    });

    it("draws the lines that came in a burst once, after the flush delay", () => {
        vi.useFakeTimers();
        const { result } = setup();
        act(() => result.current.start());
        send(line("one"));
        send(line("two", "warn"));
        expect(result.current.entries).toHaveLength(0);
        act(() => void vi.advanceTimersByTime(LOG_FLUSH_MS));
        expect(result.current.entries.map((entry) => entry.message)).toEqual(["one", "two"]);
        // The next burst starts a new delay.
        send(line("three"));
        act(() => void vi.advanceTimersByTime(LOG_FLUSH_MS));
        expect(result.current.entries).toHaveLength(3);
    });

    it("keeps the last 5,000 lines and says how many it dropped", () => {
        vi.useFakeTimers();
        const { result } = setup();
        act(() => result.current.start());
        act(() => {
            for (let index = 1; index <= LOG_BUFFER_LIMIT + 25; index++) {
                socket().onmessage?.({ data: line(`line ${index}`) });
            }
            vi.advanceTimersByTime(LOG_FLUSH_MS);
        });
        expect(result.current.entries).toHaveLength(LOG_BUFFER_LIMIT);
        expect(result.current.dropped).toBe(25);
        expect(result.current.entries[0].message).toBe("line 26");
    });

    it("clears the display buffer at once", () => {
        vi.useFakeTimers();
        const { result } = setup();
        act(() => result.current.start());
        send(line("one"));
        act(() => void vi.advanceTimersByTime(LOG_FLUSH_MS));
        act(() => result.current.clear());
        expect(result.current.entries).toEqual([]);
        expect(result.current.dropped).toBe(0);
    });

    it("captures every line while it runs, and keeps them after it stops", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-09-26T10:00:00.000Z"));
        const { result } = setup();
        act(() => result.current.start());
        send(line("before"));
        act(() => result.current.startCapture());
        expect(result.current.capture).toEqual({
            active: true,
            startedAt: Date.parse("2026-09-26T10:00:00.000Z"),
            stoppedAt: undefined,
            count: 0,
            missed: 0,
        });
        send(line("during 1"));
        // A clear of the display buffer does not touch the capture.
        act(() => result.current.clear());
        send(line("during 2"));
        vi.setSystemTime(new Date("2026-09-26T10:00:30.000Z"));
        act(() => result.current.stopCapture());
        send(line("after"));
        act(() => void vi.advanceTimersByTime(LOG_FLUSH_MS));
        expect(result.current.capture).toMatchObject({ active: false, count: 2, stoppedAt: Date.parse("2026-09-26T10:00:30.000Z") });
        expect(result.current.captureEntries().map((entry) => entry.message)).toEqual(["during 1", "during 2"]);
    });

    it("has no capture entries before one has been started", () => {
        const { result } = setup();
        expect(result.current.captureEntries()).toEqual([]);
    });

    it("closes the socket and cancels the redraw when it unmounts", () => {
        vi.useFakeTimers();
        const { result, unmount } = setup();
        act(() => result.current.start());
        send(line("pending"));
        const opened = socket();
        unmount();
        expect(opened.closed).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("closes the socket when it unmounts with nothing pending", () => {
        const { result, unmount } = setup();
        act(() => result.current.start());
        const opened = socket();
        unmount();
        expect(opened.closed).toBe(true);
    });
});
