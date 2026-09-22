///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    DEFAULT_TIMEOUT_MS,
    HISTORY_LIMIT,
    HISTORY_STORAGE_KEY,
    MAX_DETAIL_LINES,
    MAX_DETAIL_LINE_LENGTH,
    MAX_QUEUED,
    MAX_VISIBLE,
    QUEUE_STALE_MS,
    clearHistory,
    dismiss,
    dismissAll,
    getNotificationsSnapshot,
    getServerNotificationsSnapshot,
    markHistorySeen,
    notify,
    resetNotifications,
    setAllPaused,
    setPaused,
    subscribeNotifications,
    update,
} from "../../../apps/shared/notifications/store.js";

const visible = () => getNotificationsSnapshot().visible;
const titles = () => visible().map((item) => item.title);

beforeEach(() => {
    vi.useFakeTimers();
    resetNotifications();
});

afterEach(() => {
    resetNotifications();
    vi.useRealTimers();
});

describe("notify", () => {
    it("shows a notification and returns its id, taking a given one", () => {
        expect(notify({ kind: "info", title: "One" })).toBe("notification-1");
        expect(notify({ id: "mine", kind: "info", title: "Two" })).toBe("mine");
        expect(titles()).toEqual(["One", "Two"]);
        expect(visible()[0]).toMatchObject({ kind: "info", count: 1, sticky: false, details: [], actions: [] });
    });

    it("goes by itself after its kind's default time, or timeoutMs", () => {
        notify({ kind: "info", title: "Info" });
        notify({ kind: "success", title: "Success" });
        notify({ kind: "info", title: "Quick", timeoutMs: 1000 });
        vi.advanceTimersByTime(1000);
        expect(titles()).toEqual(["Info", "Success"]);
        vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS.success - 1000);
        expect(titles()).toEqual(["Info"]);
        vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS.info);
        expect(titles()).toEqual([]);
    });

    it("keeps errors and anything with actions until dismissed; sticky overrides both ways", () => {
        notify({ kind: "error", title: "Error" });
        notify({ kind: "info", title: "With action", actions: [{ label: "Do it" }] });
        notify({ kind: "warning", title: "Forced sticky", sticky: true });
        vi.advanceTimersByTime(10 * 60_000);
        expect(titles()).toEqual(["Error", "With action", "Forced sticky"]);
        expect(visible().map((item) => item.sticky)).toEqual([true, true, true]);
        dismissAll();
        notify({ kind: "error", title: "Timed error", sticky: false, timeoutMs: 500 });
        notify({ kind: "mail", title: "Mail with offer", actions: [{ label: "Yes" }], sticky: false, timeoutMs: 700 });
        vi.advanceTimersByTime(700);
        expect(titles()).toEqual([]);
    });

    it("shows at most three and queues the rest, promoting one as room is made", () => {
        for (const name of ["A", "B", "C", "D", "E"]) {
            notify({ id: name, kind: "info", title: name });
        }
        expect(titles()).toEqual(["A", "B", "C"]);
        expect(getNotificationsSnapshot().queued).toBe(2);
        dismiss("A");
        expect(titles()).toEqual(["B", "C", "D"]);
        expect(getNotificationsSnapshot().queued).toBe(1);
        vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS.info);
        expect(titles()).toEqual(["E"]);
        expect(MAX_VISIBLE).toBe(3);
    });

    it("lets a sticky notification push out the oldest one that would have gone by itself, and waits when everything showing is sticky", () => {
        notify({ id: "a", kind: "info", title: "A" });
        notify({ id: "b", kind: "info", title: "B" });
        notify({ id: "c", kind: "info", title: "C" });
        notify({ id: "err", kind: "error", title: "Error" });
        expect(titles()).toEqual(["B", "C", "Error"]);
        notify({ id: "err2", kind: "error", title: "Error 2" });
        notify({ id: "err3", kind: "error", title: "Error 3" });
        expect(titles()).toEqual(["Error", "Error 2", "Error 3"]);
        notify({ id: "err4", kind: "error", title: "Error 4" });
        expect(titles()).toEqual(["Error", "Error 2", "Error 3"]);
        expect(getNotificationsSnapshot().queued).toBe(1);
        dismiss("err");
        expect(titles()).toEqual(["Error 2", "Error 3", "Error 4"]);
    });

    it("drops what has waited too long in the queue (it is news from the past) but never a sticky one, and bounds the queue", () => {
        for (const name of ["A", "B", "C"]) {
            notify({ id: name, kind: "error", title: name });
        }
        notify({ id: "old", kind: "info", title: "Old" });
        notify({ id: "sticky-waiting", kind: "warning", title: "Waiting", sticky: true });
        vi.advanceTimersByTime(QUEUE_STALE_MS + 1);
        dismiss("A");
        expect(titles()).toEqual(["B", "C", "Waiting"]);
        expect(getNotificationsSnapshot().queued).toBe(0);

        resetNotifications();
        for (let index = 0; index < 3; index++) {
            notify({ id: `s${index}`, kind: "error", title: `S${index}` });
        }
        for (let index = 0; index < MAX_QUEUED + 3; index++) {
            notify({ id: `q${index}`, kind: "info", title: `Q${index}` });
        }
        expect(getNotificationsSnapshot().queued).toBe(MAX_QUEUED);
        // Only sticky ones waiting: the oldest of them is the one to go.
        resetNotifications();
        for (let index = 0; index < 3; index++) {
            notify({ id: `s${index}`, kind: "error", title: `S${index}` });
        }
        for (let index = 0; index < MAX_QUEUED + 1; index++) {
            notify({ id: `w${index}`, kind: "error", title: `W${index}` });
        }
        expect(getNotificationsSnapshot().queued).toBe(MAX_QUEUED);
    });

    it("counts a repeated dedupe key up instead of stacking, replacing its content and restarting its clock", () => {
        const first = notify({ kind: "info", title: "Flapping", message: "first", dedupeKey: "flap" });
        vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS.info - 100);
        const second = notify({ kind: "info", title: "Flapping", message: "second", dedupeKey: "flap" });
        expect(second).toBe(first);
        expect(visible()).toHaveLength(1);
        expect(visible()[0]).toMatchObject({ count: 2, message: "second" });
        vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS.info - 100);
        expect(visible()).toHaveLength(1);
        notify({ kind: "info", title: "Flapping", dedupeKey: "flap" });
        expect(visible()[0].count).toBe(3);
        // A key that has left the screen starts over.
        dismiss(first);
        notify({ kind: "info", title: "Flapping", dedupeKey: "flap" });
        expect(visible()[0].count).toBe(1);
    });

    it("dedupes against a queued one too", () => {
        for (const name of ["A", "B", "C"]) {
            notify({ id: name, kind: "error", title: name });
        }
        notify({ id: "q", kind: "info", title: "Queued", dedupeKey: "k" });
        expect(notify({ kind: "info", title: "Queued again", dedupeKey: "k" })).toBe("q");
        expect(getNotificationsSnapshot().queued).toBe(1);
    });

    it("replaces a notification given the same id without counting it", () => {
        notify({ id: "same", kind: "info", title: "Before" });
        notify({ id: "same", kind: "success", title: "After" });
        expect(visible()).toHaveLength(1);
        expect(visible()[0]).toMatchObject({ title: "After", kind: "success", count: 1 });
    });

    it("keeps details as lines, splitting a block of text, dropping empty lines and capping how much is kept", () => {
        notify({ kind: "error", title: "Text", details: "one\r\n\r\ntwo\nthree" });
        expect(visible()[0].details).toEqual(["one", "two", "three"]);
        dismissAll();
        notify({ kind: "error", title: "Big", details: Array.from({ length: MAX_DETAIL_LINES + 10 }, (_, index) => "x".repeat(index === 0 ? MAX_DETAIL_LINE_LENGTH + 20 : 3)) });
        const lines = visible()[0].details;
        expect(lines).toHaveLength(MAX_DETAIL_LINES);
        expect(lines[0]).toBe(`${"x".repeat(MAX_DETAIL_LINE_LENGTH)}...`);
    });

    it("does nothing where there is no window (the server): the state is shared between requests there", () => {
        const window = globalThis.window;
        // @ts-expect-error - simulate server-side rendering
        delete globalThis.window;
        try {
            expect(notify({ kind: "error", title: "Server side" })).toBe("notification-1");
            expect(notify({ id: "mine", kind: "error", title: "Server side" })).toBe("mine");
        } finally {
            globalThis.window = window;
        }
        expect(visible()).toEqual([]);
        expect(getServerNotificationsSnapshot()).toEqual({ visible: [], queued: 0, history: [], unseenErrors: 0 });
    });
});

describe("update", () => {
    it("resolves a notification: only the given fields change, its clock restarts and stickiness follows its kind", () => {
        const id = notify({ kind: "error", title: "Sending...", message: "In progress", actions: [{ label: "Cancel" }] });
        expect(visible()[0].sticky).toBe(true);
        expect(update(id, { kind: "success", title: "Sent", message: undefined, actions: [] })).toBe(true);
        expect(visible()[0]).toMatchObject({ kind: "success", title: "Sent", message: undefined, sticky: false });
        vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS.success - 1);
        expect(visible()).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(visible()).toEqual([]);
    });

    it("keeps what it is not told to change, including stickiness and the clock", () => {
        const id = notify({ kind: "info", title: "Working", timeoutMs: 1000 });
        vi.advanceTimersByTime(600);
        update(id, { message: "Still working" });
        expect(visible()[0]).toMatchObject({ title: "Working", message: "Still working", sticky: false });
        vi.advanceTimersByTime(999);
        expect(visible()).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(visible()).toEqual([]);
        const sticky = notify({ kind: "info", title: "Pinned", sticky: true });
        update(sticky, { title: "Pinned again" });
        expect(visible()[0].sticky).toBe(true);
        update(sticky, { sticky: false, timeoutMs: 100 });
        vi.advanceTimersByTime(100);
        expect(visible()).toEqual([]);
    });

    it("returns false for one that is gone, but still updates its history entry", () => {
        notify({ id: "other", kind: "error", title: "Other" });
        const id = notify({ kind: "error", title: "Failed", message: "boom", details: ["a"] });
        dismiss(id);
        expect(update(id, { kind: "success", title: "Recovered", message: undefined, details: ["b"] })).toBe(false);
        expect(getNotificationsSnapshot().history[0]).toMatchObject({ id, kind: "success", title: "Recovered", message: undefined, details: ["b"] });
        // Only what is given changes, and an unknown id is nothing at all.
        expect(update(id, {})).toBe(false);
        expect(getNotificationsSnapshot().history[0]).toMatchObject({ title: "Recovered", details: ["b"] });
        expect(update("nope", { title: "x" })).toBe(false);
    });
});

describe("dismiss", () => {
    it("removes a showing or a queued notification, and ignores an unknown id", () => {
        for (const name of ["A", "B", "C", "D"]) {
            notify({ id: name, kind: "error", title: name });
        }
        dismiss("D");
        expect(getNotificationsSnapshot().queued).toBe(0);
        dismiss("nope");
        dismiss("A");
        expect(titles()).toEqual(["B", "C"]);
    });

    it("tells subscribers, and stops when they unsubscribe", () => {
        const listener = vi.fn();
        const off = subscribeNotifications(listener);
        const id = notify({ kind: "info", title: "One" });
        dismiss(id);
        expect(listener).toHaveBeenCalledTimes(2);
        off();
        notify({ kind: "info", title: "Two" });
        expect(listener).toHaveBeenCalledTimes(2);
    });
});

describe("pausing", () => {
    it("stops one notification's clock while it is hovered or focused and resumes with what was left", () => {
        const id = notify({ kind: "info", title: "Hover me", timeoutMs: 1000 });
        vi.advanceTimersByTime(400);
        setPaused(id, true);
        setPaused(id, true);
        vi.advanceTimersByTime(60_000);
        expect(visible()).toHaveLength(1);
        setPaused(id, false);
        vi.advanceTimersByTime(599);
        expect(visible()).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(visible()).toEqual([]);
        setPaused("gone", true);
    });

    it("stops every clock while the tab is hidden, including those of notifications that arrive meanwhile", () => {
        const first = notify({ kind: "info", title: "First", timeoutMs: 1000 });
        vi.advanceTimersByTime(500);
        setAllPaused(true);
        setAllPaused(true);
        notify({ kind: "info", title: "Second", timeoutMs: 1000 });
        vi.advanceTimersByTime(60_000);
        expect(titles()).toEqual(["First", "Second"]);
        setAllPaused(false);
        vi.advanceTimersByTime(500);
        expect(titles()).toEqual(["Second"]);
        vi.advanceTimersByTime(500);
        expect(titles()).toEqual([]);
        expect(first).toBeTruthy();
    });

    it("a paused notification stays paused when the tab comes back", () => {
        const id = notify({ kind: "info", title: "Held", timeoutMs: 1000 });
        setPaused(id, true);
        setAllPaused(true);
        setAllPaused(false);
        vi.advanceTimersByTime(5000);
        expect(visible()).toHaveLength(1);
    });
});

describe("history", () => {
    it("keeps the last 30 newest first, except new-mail pop-ups, and counts unseen errors", () => {
        for (let index = 0; index < HISTORY_LIMIT + 5; index++) {
            notify({ id: `n${index}`, kind: index % 2 === 0 ? "error" : "info", title: `N${index}`, sticky: false, timeoutMs: 1 });
        }
        notify({ id: "mail", kind: "mail", title: "Mail" });
        notify({ id: "quiet", kind: "info", title: "Quiet", history: false });
        const { history, unseenErrors } = getNotificationsSnapshot();
        expect(history).toHaveLength(HISTORY_LIMIT);
        expect(history[0].id).toBe("n34");
        expect(history.some((entry) => entry.id === "mail" || entry.id === "quiet")).toBe(false);
        expect(unseenErrors).toBe(history.filter((entry) => entry.kind === "error").length);
        markHistorySeen();
        expect(getNotificationsSnapshot().unseenErrors).toBe(0);
        markHistorySeen();
        notify({ kind: "error", title: "New one" });
        expect(getNotificationsSnapshot().unseenErrors).toBe(1);
        // Some seen, some not: only the unseen change.
        notify({ kind: "info", title: "Newest", sticky: false });
        markHistorySeen();
        expect(getNotificationsSnapshot().history.every((entry) => !entry.unseen)).toBe(true);
    });

    it("keeps one entry per notification, updated in place when it is raised again", () => {
        notify({ id: "x", kind: "error", title: "Once", dedupeKey: "k" });
        notify({ kind: "error", title: "Once", dedupeKey: "k" });
        const { history } = getNotificationsSnapshot();
        expect(history).toHaveLength(1);
        expect(history[0].count).toBe(2);
    });

    it("is kept in sessionStorage and read back on first use, tolerating garbage and unavailable storage", () => {
        notify({ kind: "error", title: "Persisted", details: ["line"] });
        const stored = sessionStorage.getItem(HISTORY_STORAGE_KEY)!;
        expect(JSON.parse(stored)[0]).toMatchObject({ title: "Persisted", details: ["line"] });

        resetNotifications();
        sessionStorage.setItem(HISTORY_STORAGE_KEY, stored);
        expect(getNotificationsSnapshot().history[0]).toMatchObject({ title: "Persisted", unseen: true });

        resetNotifications();
        sessionStorage.setItem(
            HISTORY_STORAGE_KEY,
            JSON.stringify([{ id: "a", kind: "error", title: "Odd", at: 1, count: 1 }, { nonsense: true }, null]),
        );
        expect(getNotificationsSnapshot().history).toEqual([{ id: "a", kind: "error", title: "Odd", at: 1, count: 1, details: [], unseen: false }]);

        resetNotifications();
        sessionStorage.setItem(HISTORY_STORAGE_KEY, "not json");
        expect(getNotificationsSnapshot().history).toEqual([]);
        resetNotifications();
        sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({ not: "a list" }));
        expect(getNotificationsSnapshot().history).toEqual([]);

        resetNotifications();
        const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("full");
        });
        const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        notify({ kind: "error", title: "Memory only" });
        expect(getNotificationsSnapshot().history[0].title).toBe("Memory only");
        resetNotifications();
        getItem.mockRestore();
        setItem.mockRestore();
        removeItem.mockRestore();
    });

    it("clears, and marks seen or clears before anything was raised", () => {
        markHistorySeen();
        clearHistory();
        notify({ kind: "error", title: "Gone soon" });
        clearHistory();
        expect(getNotificationsSnapshot().history).toEqual([]);
    });
});

describe("dismissAll", () => {
    it("removes everything showing and waiting", () => {
        for (const name of ["A", "B", "C", "D"]) {
            notify({ id: name, kind: "error", title: name });
        }
        dismissAll();
        expect(getNotificationsSnapshot()).toMatchObject({ visible: [], queued: 0 });
        vi.advanceTimersByTime(60_000);
    });
});
