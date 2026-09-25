// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushEvent } from "@rapidmx/react-shared/mail/pushClient.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import CalendarPageRouted from "../../../apps/www/calendar/index.js";
import { redactedEventUidOf } from "../../../apps/shared/calendar/calendarLiveUpdates.js";

// The calendar page and what the push connection tells it about a private or confidential event: a busy block, to be fetched again by its uid.

const CalendarPage = CalendarPageRouted.page;

// The shared push connection: the page adds a listener, and the tests are the server.
const listeners = new Set<(event: PushEvent) => void>();
vi.mock("@rapidmx/react-shared/mail/pushClient.js", () => ({
    getPushClient: () => ({
        onEvent: (listener: (event: PushEvent) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    }),
}));
function push(event: PushEvent) {
    act(() => {
        for (const listener of [...listeners]) {
            listener(event);
        }
    });
}

vi.mock("@dnd-kit/core", async () => {
    const actual = await vi.importActual<typeof import("@dnd-kit/core")>("@dnd-kit/core");
    return { ...actual, useSensors: () => [] };
});

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "My Mail",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};
const calendarFolder = {
    uid: "f-cal",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    name: "Calendar",
    type: "calendar" as const,
    unreadCount: 0,
    totalCount: 0,
    color: "#2563eb",
};

function calendarEvent(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        uid: "e1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        folderUid: "f-cal",
        title: "Standup",
        startDate: "2026-06-15T15:00:00.000Z",
        endDate: "2026-06-15T15:30:00.000Z",
        allDay: false,
        timezone: "UTC",
        organizer: { address: "u1@example.com", type: "to" as const },
        attendees: [],
        status: "confirmed" as const,
        busyStatus: "busy" as const,
        icalUid: "abc",
        sequence: 0,
        ...overrides,
    };
}

/** The busy block a push carries of a private event: what any subscriber may see. */
const busyBlock = (overrides: Partial<Record<string, unknown>> = {}) =>
    calendarEvent({ uid: "e2", title: "Busy", redacted: true, visibility: "private", organizer: { address: "", type: "to" }, ...overrides });

let events: unknown[];
let single: (uid: string) => Response;

function mockCalendar() {
    return mockFetch((url, init) => {
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [calendarFolder]);
        if (url.startsWith("/api/mail/calendar-events?")) return jsonResponse(200, events);
        const one = /^\/api\/mail\/calendar-events\/([^/?]+)$/.exec(url);
        if (one && (init?.method ?? "GET") === "GET") return single(one[1]);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

beforeEach(() => {
    listeners.clear();
    events = [calendarEvent()];
    single = () => jsonResponse(404, { message: "not found" });
    window.history.pushState(null, "", "/calendar?date=2026-06-15&view=month");
});

afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState(null, "", "/");
});

describe("redactedEventUidOf", () => {
    it("is the uid of a created or updated calendar event whose payload is a busy block, on either database", () => {
        expect(redactedEventUidOf({ type: "CalendarEventMongo", action: "create", data: { uid: "e2", redacted: true } })).toBe("e2");
        expect(redactedEventUidOf({ type: "CalendarEventSQL", action: "update", data: { uid: "e3", redacted: true } })).toBe("e3");
    });

    it("is nothing for anything else the connection carries", () => {
        expect(redactedEventUidOf({ type: "CalendarEventMongo", action: "update", data: { uid: "e2", redacted: false } })).toBeUndefined();
        expect(redactedEventUidOf({ type: "CalendarEventMongo", action: "update", data: { uid: "e2" } })).toBeUndefined();
        expect(redactedEventUidOf({ type: "CalendarEventMongo", action: "delete", data: { uid: "e2", redacted: true } })).toBeUndefined();
        expect(redactedEventUidOf({ type: "CalendarEventMongo", data: { uid: "e2", redacted: true } })).toBeUndefined();
        expect(redactedEventUidOf({ type: "CalendarEventMongo", action: "update", data: { uid: 5, redacted: true } })).toBeUndefined();
        expect(redactedEventUidOf({ type: "CalendarEventMongo", action: "update", data: null })).toBeUndefined();
        expect(redactedEventUidOf({ type: "CalendarEventMongo", action: "update" })).toBeUndefined();
        // The reminder is the same model's, under its own name and action.
        expect(redactedEventUidOf({ type: "CalendarEvent", action: "reminder", data: { uid: "e2", redacted: true } })).toBeUndefined();
        expect(redactedEventUidOf({ type: "MessageMongo", action: "update", data: { uid: "m1", redacted: true } })).toBeUndefined();
    });
});

describe("CalendarPage live updates for a private event", () => {
    it("fetches the event again by its uid, and shows what that says instead of the busy block that was pushed", async () => {
        mockCalendar();
        render(<CalendarPage userUid="u1" />);
        await screen.findByText(/Standup/);

        // The owner asks again and is told everything.
        single = (uid) => jsonResponse(200, calendarEvent({ uid, title: "Therapy", visibility: "private", startDate: "2026-06-16T10:00:00.000Z", endDate: "2026-06-16T11:00:00.000Z" }));
        push({ type: "CalendarEventMongo", action: "create", data: busyBlock() });

        expect(await screen.findByText(/Therapy/)).toBeInTheDocument();
        // The pushed block was never stored as the event.
        expect(screen.queryByText("Busy")).not.toBeInTheDocument();
        expect(screen.getByText(/Standup/)).toBeInTheDocument();
    });

    it("replaces an event the page already holds, and leaves the others as they are", async () => {
        events = [calendarEvent(), calendarEvent({ uid: "e2", title: "Old title" })];
        mockCalendar();
        render(<CalendarPage userUid="u1" />);
        await screen.findByText(/Old title/);

        single = (uid) => jsonResponse(200, calendarEvent({ uid, title: "New title" }));
        push({ type: "CalendarEventSQL", action: "update", data: busyBlock() });

        expect(await screen.findByText(/New title/)).toBeInTheDocument();
        expect(screen.queryByText(/Old title/)).not.toBeInTheDocument();
        expect(screen.getByText(/Standup/)).toBeInTheDocument();
    });

    it("drops an event that is gone, and leaves the calendar alone when the fetch fails for any other reason", async () => {
        events = [calendarEvent({ uid: "e2", title: "Doomed" })];
        const fetchMock = mockCalendar();
        render(<CalendarPage userUid="u1" />);
        await screen.findByText(/Doomed/);

        single = () => jsonResponse(500, { message: "boom" });
        push({ type: "CalendarEventMongo", action: "update", data: busyBlock() });
        await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/mail/calendar-events/e2")).toBe(true));
        await act(async () => {
            await Promise.resolve();
        });
        expect(screen.getByText(/Doomed/)).toBeInTheDocument();

        single = () => jsonResponse(404, { message: "gone" });
        push({ type: "CalendarEventMongo", action: "update", data: busyBlock() });
        await waitFor(() => expect(screen.queryByText(/Doomed/)).not.toBeInTheDocument());
    });

    it("does not add an event from a calendar that is not showing", async () => {
        const fetchMock = mockCalendar();
        render(<CalendarPage userUid="u1" />);
        await screen.findByText(/Standup/);

        single = (uid) => jsonResponse(200, calendarEvent({ uid, title: "Elsewhere", folderUid: "f-other" }));
        push({ type: "CalendarEventMongo", action: "create", data: busyBlock() });
        await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/mail/calendar-events/e2")).toBe(true));
        await act(async () => {
            await Promise.resolve();
        });
        expect(screen.queryByText(/Elsewhere/)).not.toBeInTheDocument();
    });

    it("does nothing for a push that is not a busy block, and stops listening when the page goes", async () => {
        const fetchMock = mockCalendar();
        const { unmount } = render(<CalendarPage userUid="u1" />);
        await screen.findByText(/Standup/);
        // The page's own, and whatever the app frame around it listens for.
        expect(listeners.size).toBeGreaterThanOrEqual(1);

        push({ type: "CalendarEventMongo", action: "update", data: calendarEvent({ uid: "e2" }) });
        push({ type: "MessageMongo", action: "create", data: { uid: "m1" } });
        expect(fetchMock.mock.calls.some(([url]) => url === "/api/mail/calendar-events/e2")).toBe(false);

        unmount();
        expect(listeners.size).toBe(0);
    });
});

describe("CalendarPage and a busy block", () => {
    it("opens an event that is only a busy block as just that", async () => {
        events = [busyBlock({ title: "Busy" })];
        mockCalendar();
        render(<CalendarPage userUid="u1" />);

        fireEvent.click(await screen.findByText(/Busy/));

        const dialog = await screen.findByRole("dialog", { name: "Event details" });
        expect(within(dialog).getByRole("heading", { name: "Busy" })).toBeInTheDocument();
        expect(within(dialog).queryByRole("button", { name: "Modify" })).not.toBeInTheDocument();
        expect(within(dialog).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    });
});
