// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { LogEntry } from "../../../../apps/shared/components/admin/diagnostics/logLines.js";
import { LOG_BUFFER_LIMIT, LOG_CAPTURE_LIMIT, LogStore } from "../../../../apps/shared/components/admin/diagnostics/LogStore.js";

const line = (id: number): LogEntry => ({ id, receivedAt: id, level: "info", message: `line ${id}`, extra: {}, json: "{}", structured: true });

describe("LogStore", () => {
    it("has the documented limits", () => {
        expect(LOG_BUFFER_LIMIT).toBe(5000);
        expect(LOG_CAPTURE_LIMIT).toBe(50_000);
    });

    it("keeps the last lines of its buffer and counts the ones it dropped", () => {
        const store = new LogStore(3);
        for (let id = 1; id <= 5; id++) {
            store.add(line(id));
        }
        expect(store.entries.map((entry) => entry.id)).toEqual([3, 4, 5]);
        expect(store.dropped).toBe(2);
        store.clear();
        expect(store.entries).toEqual([]);
        expect(store.dropped).toBe(0);
    });

    it("records nothing without a capture, or once it is stopped", () => {
        const store = new LogStore();
        store.add(line(1));
        expect(store.capture).toBeUndefined();
        store.stopCapture(5);
        expect(store.capture).toBeUndefined();
        store.startCapture(10);
        store.add(line(2));
        store.stopCapture(20);
        store.add(line(3));
        store.stopCapture(30);
        expect(store.capture).toMatchObject({ active: false, startedAt: 10, stoppedAt: 20, missed: 0 });
        expect(store.capture?.entries.map((entry) => entry.id)).toEqual([2]);
    });

    it("records every line while it runs, past what the buffer keeps and through a clear", () => {
        const store = new LogStore(2, 100);
        store.startCapture(0);
        for (let id = 1; id <= 6; id++) {
            store.add(line(id));
        }
        store.clear();
        store.add(line(7));
        expect(store.entries.map((entry) => entry.id)).toEqual([7]);
        expect(store.capture?.entries.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it("stops recording at its limit and counts the lines it missed", () => {
        const store = new LogStore(10, 3);
        store.startCapture(0);
        for (let id = 1; id <= 5; id++) {
            store.add(line(id));
        }
        expect(store.capture?.entries).toHaveLength(3);
        expect(store.capture?.missed).toBe(2);
    });

    it("replaces an earlier capture when a new one starts", () => {
        const store = new LogStore();
        store.startCapture(0);
        store.add(line(1));
        store.startCapture(5);
        expect(store.capture).toMatchObject({ active: true, startedAt: 5, entries: [], missed: 0 });
    });
});
