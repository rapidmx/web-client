// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPushClient, resetPushClient } from "@rapidmx/react-shared/mail/pushClient.js";
import { dismiss, getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";
import { useCalendarReminders } from "../../../apps/shared/calendar/useCalendarReminders.js";

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

function Harness(props: { userUid?: string; enabled?: boolean }) {
    useCalendarReminders({ userUid: "userUid" in props ? props.userUid : "u1", enabled: props.enabled ?? true });
    return null;
}

const NOW = new Date("2026-09-22T14:50:00.000Z");
/** Ten minutes out - longer than the five-minute snooze, so a snooze of this one waits the full `SNOOZE_MS`. */
const NOTICE = { eventUid: "evt1", title: "Team sync", startDate: "2026-09-22T15:00:00.000Z" };
/** Three minutes out - shorter than the snooze, so a snooze of this one is cut to the time left before it starts. */
const NOTICE_SOON = { eventUid: "evt2", title: "Standup", startDate: "2026-09-22T14:53:00.000Z" };

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetPushClient();
});

async function fireReminder(notice: typeof NOTICE) {
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
    it("shows a sticky calendar pop-up with Dismiss and Snooze when a reminder push event arrives", async () => {
        render(<Harness />);
        connect();
        await fireReminder(NOTICE);

        const visible = getNotificationsSnapshot().visible;
        expect(visible).toHaveLength(1);
        expect(visible[0]).toMatchObject({ kind: "calendar", title: "Team sync", sticky: true, href: "/calendar" });
        expect(visible[0].actions.map((action) => action.label)).toEqual(["Dismiss", "Snooze"]);
    });

    it("adds a leading Join Meeting action when the event's location is a URL, opening it in a new tab without resolving the pop-up", async () => {
        const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
        render(<Harness />);
        connect();
        await fireReminder({ ...NOTICE, location: "https://meet.example.com/room/abc" } as typeof NOTICE);

        const toast = getNotificationsSnapshot().visible[0];
        expect(toast.actions.map((action) => action.label)).toEqual(["Join Meeting", "Dismiss", "Snooze"]);
        const joinAction = toast.actions[0];
        expect(joinAction.keepOpen).toBe(true);

        joinAction.onClick?.();
        expect(openSpy).toHaveBeenCalledWith("https://meet.example.com/room/abc", "_blank", "noopener,noreferrer");
        // keepOpen: true - the pop-up is still there for Dismiss/Snooze afterward.
        expect(getNotificationsSnapshot().visible).toHaveLength(1);
    });

    it("has no Join Meeting action when the location is a room name, address or other non-URL text", async () => {
        render(<Harness />);
        connect();
        await fireReminder({ ...NOTICE, location: "Room 12" } as typeof NOTICE);

        expect(getNotificationsSnapshot().visible[0].actions.map((action) => action.label)).toEqual(["Dismiss", "Snooze"]);
    });

    it("has no Join Meeting action when the event has no location", async () => {
        render(<Harness />);
        connect();
        await fireReminder(NOTICE);

        expect(getNotificationsSnapshot().visible[0].actions.map((action) => action.label)).toEqual(["Dismiss", "Snooze"]);
    });

    it("ignores push events that are not a CalendarEvent reminder", async () => {
        render(<Harness />);
        connect();
        await act(async () => {
            socket().receive({ type: "MessageMongo", action: "create", data: { uid: "m1" } });
        });
        expect(getNotificationsSnapshot().visible).toHaveLength(0);
    });

    it("does nothing extra when Dismiss is used - just the pop-up closing", async () => {
        render(<Harness />);
        connect();
        await fireReminder(NOTICE);
        const toast = getNotificationsSnapshot().visible[0];
        const dismissAction = toast.actions.find((action) => action.label === "Dismiss")!;
        expect(dismissAction.onClick).toBeUndefined();
        dismiss(toast.id);
        await advance(10 * 60_000);
        expect(getNotificationsSnapshot().visible).toHaveLength(0);
        expect(getNotificationsSnapshot().history.some((entry) => entry.title === "Team sync")).toBe(true);
    });

    it("Snooze reschedules the same reminder after five minutes when the meeting is far off", async () => {
        render(<Harness />);
        connect();
        await fireReminder(NOTICE);
        const toast = getNotificationsSnapshot().visible[0];
        const snoozeAction = toast.actions.find((action) => action.label === "Snooze")!;

        // Mirrors what NotificationCenter's ActionButton does on a click: run the action, then dismiss (no keepOpen).
        await act(async () => {
            snoozeAction.onClick?.();
            dismiss(toast.id);
        });
        expect(getNotificationsSnapshot().visible).toHaveLength(0);

        await advance(5 * 60_000 - 1);
        expect(getNotificationsSnapshot().visible).toHaveLength(0);

        await advance(1);
        const reshown = getNotificationsSnapshot().visible;
        expect(reshown).toHaveLength(1);
        expect(reshown[0].id).toBe(toast.id);
        expect(reshown[0].title).toBe("Team sync");
    });

    it("Snooze fires at the meeting's start instead of five minutes out when less than five minutes remain", async () => {
        render(<Harness />);
        connect();
        await fireReminder(NOTICE_SOON);
        const toast = getNotificationsSnapshot().visible[0];
        const snoozeAction = toast.actions.find((action) => action.label === "Snooze")!;

        await act(async () => {
            snoozeAction.onClick?.();
            dismiss(toast.id);
        });

        // NOTICE_SOON starts three minutes after NOW - short of the five-minute snooze.
        await advance(3 * 60_000 - 1);
        expect(getNotificationsSnapshot().visible).toHaveLength(0);

        await advance(1);
        expect(getNotificationsSnapshot().visible).toHaveLength(1);
    });

    it("clears a pending snooze timer on unmount, so it never fires after the frame is gone", async () => {
        const { unmount } = render(<Harness />);
        connect();
        await fireReminder(NOTICE);
        const toast = getNotificationsSnapshot().visible[0];
        const snoozeAction = toast.actions.find((action) => action.label === "Snooze")!;
        await act(async () => {
            snoozeAction.onClick?.();
            dismiss(toast.id);
        });

        unmount();
        await advance(10 * 60_000);
        expect(getNotificationsSnapshot().visible).toHaveLength(0);
    });

    it("does nothing without a signed-in user", async () => {
        render(<Harness userUid={undefined} />);
        connect();
        await fireReminder(NOTICE);
        expect(getNotificationsSnapshot().visible).toHaveLength(0);
    });

    it("does nothing while disabled (outside the persistent app frame)", async () => {
        render(<Harness enabled={false} />);
        connect();
        await fireReminder(NOTICE);
        expect(getNotificationsSnapshot().visible).toHaveLength(0);
    });
});
