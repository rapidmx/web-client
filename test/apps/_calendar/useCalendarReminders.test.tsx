// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPushClient, resetPushClient } from "../../../lib/mail/pushClient.js";
import { getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";
import { setNotificationsEnabled } from "../../../apps/shared/notifications/preferences.js";
import { resetNotificationSounds } from "../../../apps/shared/notifications/sounds.js";
import { CalendarAlarms, useCalendarReminders } from "../../../apps/shared/calendar/useCalendarReminders.js";

/** A stand-in for the browser's WebSocket, driven by hand - the same shape `useMailLiveUpdates.test.tsx` uses. */
class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    readyState = 1;
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(public url: string) {
        FakeWebSocket.instances.push(this);
    }
    send() {
        // Nothing this hook sends drives these tests.
    }
    close() {
        this.readyState = 3;
    }
    receive(frame: unknown) {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }
    greet(channels: string[] = []) {
        this.receive({ id: 0, type: "SUBSCRIBED", success: true, data: channels });
    }
}

function socket(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

/** Starts the shared push client and completes its handshake - stands in for `useMailConnection`'s own `useMailLiveUpdates`, which
 * always owns the connection in the real app; this hook only ever listens. */
function connect(): void {
    getPushClient().start();
    socket().greet();
}

/** What the hook last returned. */
let latest: CalendarAlarms;

function Harness(props: { userUid?: string; enabled?: boolean }) {
    latest = useCalendarReminders({ userUid: "userUid" in props ? props.userUid : "u1", enabled: props.enabled ?? true });
    return null;
}

/** A stand-in for `AudioContext` that counts the oscillators the sounds are made of (the bell is eight). */
const audio = { oscillators: 0 };
class FakeAudioContext {
    state = "running";
    currentTime = 0;
    destination = {};
    createOscillator() {
        audio.oscillators += 1;
        return { type: "", frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
    }
    createGain() {
        return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
    }
}
const BELL_OSCILLATORS = 8;

const NOW = new Date("2026-09-22T14:50:00.000Z");
const NOTICE = { eventUid: "evt1", title: "Team sync", startDate: "2026-09-22T15:00:00.000Z" };
const OTHER = { eventUid: "evt2", title: "Standup", startDate: "2026-09-22T14:53:00.000Z", location: "https://meet.example.com/room/abc" };

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    localStorage.clear();
    FakeWebSocket.instances = [];
    audio.oscillators = 0;
    resetNotificationSounds();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetPushClient();
    resetNotificationSounds();
});

async function fireReminder(notice: typeof NOTICE | typeof OTHER) {
    await act(async () => {
        socket().receive({ type: "CalendarEvent", action: "reminder", data: notice });
    });
}

async function advance(ms: number) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

describe("useCalendarReminders", () => {
    it("raises an alarm, with a bell, when a reminder push event arrives", async () => {
        render(<Harness />);
        connect();
        expect(latest.current).toBeUndefined();

        await fireReminder(NOTICE);

        expect(latest.current).toEqual(NOTICE);
        expect(latest.waiting).toBe(0);
        expect(audio.oscillators).toBe(BELL_OSCILLATORS);
        // It is a dialog, not a pop-up: nothing in the notification stack.
        expect(getNotificationsSnapshot().visible).toHaveLength(0);
    });

    it("carries the event's location through to the alarm", async () => {
        render(<Harness />);
        connect();
        await fireReminder(OTHER);
        expect(latest.current?.location).toBe("https://meet.example.com/room/abc");
    });

    it("queues alarms that arrive together, showing one at a time, oldest first", async () => {
        render(<Harness />);
        connect();
        await fireReminder(NOTICE);
        await fireReminder(OTHER);

        expect(latest.current).toEqual(NOTICE);
        expect(latest.waiting).toBe(1);

        await act(async () => latest.dismiss());
        expect(latest.current).toEqual(OTHER);
        expect(latest.waiting).toBe(0);

        await act(async () => latest.dismiss());
        expect(latest.current).toBeUndefined();
    });

    it("shows the same alarm once when its push event arrives twice", async () => {
        render(<Harness />);
        connect();
        await fireReminder(NOTICE);
        await fireReminder(NOTICE);
        expect(latest.waiting).toBe(0);
    });

    it("ignores push events that are not a CalendarEvent reminder", async () => {
        render(<Harness />);
        connect();
        await act(async () => {
            socket().receive({ type: "MessageMongo", action: "create", data: { uid: "m1" } });
        });
        expect(latest.current).toBeUndefined();
        expect(audio.oscillators).toBe(0);
    });

    it("Dismiss closes the alarm for good", async () => {
        render(<Harness />);
        connect();
        await fireReminder(NOTICE);
        await act(async () => latest.dismiss());
        await advance(10 * 60_000);
        expect(latest.current).toBeUndefined();
    });

    it("Snooze closes the alarm and brings it back, with the bell again, after exactly five minutes", async () => {
        render(<Harness />);
        connect();
        await fireReminder(NOTICE);
        audio.oscillators = 0;
        resetNotificationSounds();

        await act(async () => latest.snooze());
        expect(latest.current).toBeUndefined();

        await advance(5 * 60_000 - 1);
        expect(latest.current).toBeUndefined();
        expect(audio.oscillators).toBe(0);

        await advance(1);
        expect(latest.current).toEqual(NOTICE);
        expect(audio.oscillators).toBe(BELL_OSCILLATORS);
    });

    it("snoozes five minutes even when the meeting has already started", async () => {
        render(<Harness />);
        connect();
        await fireReminder({ ...NOTICE, startDate: "2026-09-22T14:40:00.000Z" });
        await act(async () => latest.snooze());

        await advance(60_000);
        expect(latest.current).toBeUndefined();
        await advance(4 * 60_000);
        expect(latest.current).toBeDefined();
    });

    it("snoozes only the alarm on screen, the next one taking its place", async () => {
        render(<Harness />);
        connect();
        await fireReminder(NOTICE);
        await fireReminder(OTHER);
        await act(async () => latest.snooze());
        expect(latest.current).toEqual(OTHER);
        await advance(5 * 60_000);
        expect(latest.current).toEqual(OTHER);
        expect(latest.waiting).toBe(1);
    });

    it("does nothing when there is no alarm to snooze", async () => {
        render(<Harness />);
        connect();
        await act(async () => latest.snooze());
        await advance(10 * 60_000);
        expect(latest.current).toBeUndefined();
    });

    it("clears a pending snooze on unmount, so it never fires after the frame is gone", async () => {
        const { unmount } = render(<Harness />);
        connect();
        await fireReminder(NOTICE);
        await act(async () => latest.snooze());
        unmount();
        await advance(10 * 60_000);
        expect(audio.oscillators).toBe(BELL_OSCILLATORS);
    });

    it("forgets the queue when the user signs out", async () => {
        const view = render(<Harness />);
        connect();
        await fireReminder(NOTICE);
        view.rerender(<Harness userUid={undefined} />);
        expect(latest.current).toBeUndefined();
    });

    it("with pop-ups turned off shows no dialog and makes no sound, only recording the alarm in the history", async () => {
        setNotificationsEnabled(false);
        render(<Harness />);
        connect();
        await fireReminder(NOTICE);

        expect(latest.current).toBeUndefined();
        expect(audio.oscillators).toBe(0);
        expect(getNotificationsSnapshot().history.some((entry) => entry.title === "Team sync")).toBe(true);
    });

    it("does nothing without a signed-in user", async () => {
        render(<Harness userUid={undefined} />);
        connect();
        await fireReminder(NOTICE);
        expect(latest.current).toBeUndefined();
    });

    it("does nothing while disabled (outside the persistent app frame)", async () => {
        render(<Harness enabled={false} />);
        connect();
        await fireReminder(NOTICE);
        expect(latest.current).toBeUndefined();
    });
});
