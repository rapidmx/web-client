// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { format } from "date-fns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../testUtils.js";
import CalendarPage from "../../../apps/www/calendar/index.js";

// `@dnd-kit/core`'s real sensors can't be driven from jsdom (they call `setPointerCapture`, which
// jsdom doesn't implement, and that breaks the rest of synthetic event dispatch — see
// `MonthView.test.tsx`'s identical note). This page wires real `MouseSensor`/`TouchSensor` instances
// for production drag support, so plain-click tests here neutralize them the same way: `useSensors`
// is forced to return no active sensors, leaving `DndContext`/`useDraggable`/`useDroppable` themselves
// real so the grids still render normally.
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
const secondCalendarFolder = { ...calendarFolder, uid: "f-cal2", name: "Personal", color: "#dc2626" };

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

function mockShellAndEvents(
    events: unknown[],
    extra?: (url: string, init?: RequestInit) => Response | undefined,
    folders: unknown[] = [calendarFolder],
) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, folders);
        if (url.startsWith("/api/mail/calendar-events") && (init?.method ?? "GET") === "GET") return jsonResponse(200, events);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

// A pinned Monday (matches `tasks/index.test.tsx`'s own note on why Monday is chosen: every bucket/
// range this suite checks has a valid value from a week-start day). Read once on mount via `?date=`.
beforeEach(() => {
    window.history.pushState(null, "", "/calendar?date=2026-06-15&view=month");
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.history.pushState(null, "", "/");
});

describe("CalendarPage", () => {
    it("shows the visible month's events and title", async () => {
        mockShellAndEvents([calendarEvent()]);
        render(<CalendarPage userUid="u1" />);

        expect(await screen.findByText(/Standup/)).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "June 2026" })).toBeInTheDocument();
    });

    it("defaults to Month view on the real current date when the URL has no ?view=/?date=", async () => {
        window.history.pushState(null, "", "/calendar");
        mockShellAndEvents([]);
        render(<CalendarPage userUid="u1" />);

        expect(await screen.findByRole("heading", { name: format(new Date(), "MMMM yyyy") })).toBeInTheDocument();
    });

    it("shows an API error message when loading events fails", async () => {
        mockShellAndEvents([], (url, init) =>
            url.startsWith("/api/mail/calendar-events") && (init?.method ?? "GET") === "GET"
                ? jsonResponse(500, { message: "boom" })
                : undefined,
        );
        render(<CalendarPage userUid="u1" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading events fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [calendarFolder]);
            throw new TypeError("network down");
        });
        render(<CalendarPage userUid="u1" />);
        expect(await screen.findByText("Could not load your calendar.")).toBeInTheDocument();
    });

    it("clears events (not stuck loading) and ignores 'New event' when the mailbox has no calendar folder yet", async () => {
        mockShellAndEvents([], undefined, []);
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);

        expect(await screen.findByRole("heading", { name: "June 2026" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "+ New event" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("switches between Month, Week, Work Week, Day, and Split views, updating the title and grid", async () => {
        mockShellAndEvents([]);
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("heading", { name: "June 2026" });

        await user.click(screen.getByRole("button", { name: "Week" }));
        expect(screen.getByRole("heading", { name: "Jun 15 – Jun 21, 2026" })).toBeInTheDocument();
        expect(screen.getByText("1AM")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Work Week" }));
        expect(screen.getByRole("heading", { name: "Jun 15 – Jun 19, 2026" })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Day" }));
        expect(screen.getByRole("heading", { name: "Monday, June 15, 2026" })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Split" }));
        expect(screen.getByRole("heading", { name: "Monday, June 15, 2026" })).toBeInTheDocument();
    });

    it("Previous/Next shift the visible range according to the current view", async () => {
        mockShellAndEvents([]);
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("heading", { name: "June 2026" });

        await user.click(screen.getByRole("button", { name: "Previous" }));
        expect(screen.getByRole("heading", { name: "May 2026" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(screen.getByRole("heading", { name: "June 2026" })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Week" }));
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(screen.getByRole("heading", { name: "Jun 22 – Jun 28, 2026" })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Day" }));
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(screen.getByRole("heading", { name: "Tuesday, June 23, 2026" })).toBeInTheDocument();
    });

    it("Today jumps back to the real current date (fake-clocked, no userEvent — see tasks/index.test.tsx's note)", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date("2026-07-04T12:00:00.000Z"));
        mockShellAndEvents([]);
        render(<CalendarPage userUid="u1" />);
        await waitFor(() => expect(screen.getByRole("heading", { name: "June 2026" })).toBeInTheDocument());

        fireEvent.click(screen.getByRole("button", { name: "Today" }));
        await waitFor(() => expect(screen.getByRole("heading", { name: "July 2026" })).toBeInTheDocument());
    });

    it("clicking a day in Month view jumps to Day view for that date", async () => {
        mockShellAndEvents([]);
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("heading", { name: "June 2026" });

        const grid = screen.getByRole("grid", { name: "Month" });
        await user.click(within(grid).getByRole("button", { name: "15" }));
        expect(screen.getByRole("heading", { name: "Monday, June 15, 2026" })).toBeInTheDocument();
    });

    it("clicking an event opens the edit modal, and Cancel closes it without saving", async () => {
        mockShellAndEvents([calendarEvent()]);
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: /Standup/ }));
        expect(screen.getByRole("dialog", { name: "Edit event" })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("'+ New event' opens a blank create modal (no prefilled start/end) and saves it", async () => {
        const created = calendarEvent({ uid: "e-new", title: "Planning" });
        const fetchMock = mockShellAndEvents([], (url, init) =>
            url === "/api/mail/calendar-events" && init?.method === "POST" ? jsonResponse(200, created) : undefined,
        );
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("heading", { name: "June 2026" });

        await user.click(screen.getByRole("button", { name: "+ New event" }));
        expect(screen.getByRole("dialog", { name: "New event" })).toBeInTheDocument();
        await user.type(screen.getByLabelText("Title"), "Planning");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events", expect.objectContaining({ method: "POST" })),
        );
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("clicking an empty slot in Week view opens a create modal prefilled with that slot", async () => {
        mockShellAndEvents([]);
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("heading", { name: "June 2026" });
        await user.click(screen.getByRole("button", { name: "Week" }));

        await user.click(screen.getByLabelText("New event at 9:00 AM, Jun 15"));
        expect(screen.getByRole("dialog", { name: "New event" })).toBeInTheDocument();
    });

    it("deleting an event from the edit modal reloads the list", async () => {
        const fetchMock = mockShellAndEvents([calendarEvent()], (url, init) =>
            url === "/api/mail/calendar-events/e1?version=0" && init?.method === "DELETE" ? emptyResponse(200) : undefined,
        );
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: /Standup/ }));
        await user.click(screen.getByRole("button", { name: "Delete" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/calendar-events/e1?version=0",
                expect.objectContaining({ method: "DELETE" }),
            ),
        );
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("lists every calendar in the sidebar, and unchecking one stops fetching (and showing) its events", async () => {
        const fetchMock = mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [calendarFolder, secondCalendarFolder]);
            if (url.includes("folderUid=f-cal2")) return jsonResponse(200, [calendarEvent({ uid: "e2", folderUid: "f-cal2", title: "Personal Thing" })]);
            if (url.startsWith("/api/mail/calendar-events")) return jsonResponse(200, [calendarEvent()]);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);

        expect(await screen.findByText(/Standup/)).toBeInTheDocument();
        expect(screen.getByText(/Personal Thing/)).toBeInTheDocument();
        expect(screen.getByText("Personal")).toBeInTheDocument();

        const personalCheckbox = screen.getByText("Personal").closest("label")!.querySelector("input")!;
        fetchMock.mockClear();
        await user.click(personalCheckbox);

        await waitFor(() => expect(screen.queryByText(/Personal Thing/)).not.toBeInTheDocument());
        expect(screen.getByText(/Standup/)).toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([calledUrl]) => String(calledUrl).includes("folderUid=f-cal2"))).toBe(false);

        // Re-checking it brings its events back.
        await user.click(personalCheckbox);
        expect(await screen.findByText(/Personal Thing/)).toBeInTheDocument();
    });

    it("creates a new calendar from the sidebar and shows it checked, without a separate confirmation step", async () => {
        const folders = [calendarFolder];
        const fetchMock = mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url === "/api/mail/folders" && init?.method === "POST") {
                folders.push(secondCalendarFolder);
                return jsonResponse(200, secondCalendarFolder);
            }
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, folders);
            if (url.startsWith("/api/mail/calendar-events")) return jsonResponse(200, []);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("heading", { name: "June 2026" });

        await user.click(screen.getByLabelText("Add calendar"));
        await user.type(screen.getByLabelText("New calendar name"), "Personal");
        await user.click(screen.getByRole("button", { name: "Add" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/folders",
                expect.objectContaining({ method: "POST", body: expect.stringContaining("Personal") }),
            ),
        );
        expect(await screen.findByText("Personal")).toBeInTheDocument();
    });

    it("shows a combined error naming every calendar that failed to load, when more than one calendar is checked", async () => {
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [calendarFolder, secondCalendarFolder]);
            if (url.includes("folderUid=f-cal2")) return jsonResponse(500, { message: "personal calendar down" });
            if (url.startsWith("/api/mail/calendar-events")) return jsonResponse(200, [calendarEvent()]);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        render(<CalendarPage userUid="u1" />);

        expect(await screen.findByText("Could not load events for: Personal.")).toBeInTheDocument();
        // The calendar that *did* load still renders its events despite the other one's failure.
        expect(screen.getByText(/Standup/)).toBeInTheDocument();
    });

    it("clicking a day in the mini date picker jumps the main view to that date", async () => {
        mockShellAndEvents([]);
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("heading", { name: "June 2026" });

        const miniCalendar = screen.getByRole("navigation", { name: "Mini calendar" });
        await user.click(within(miniCalendar).getByText("20"));
        await user.click(screen.getByRole("button", { name: "Day" }));

        expect(screen.getByRole("heading", { name: "Saturday, June 20, 2026" })).toBeInTheDocument();
    });

    it("Split view shows one column per checked calendar, and clicking an empty slot creates an event pre-targeted at that column's calendar", async () => {
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [calendarFolder, secondCalendarFolder]);
            if (url.startsWith("/api/mail/calendar-events")) return jsonResponse(200, []);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("heading", { name: "June 2026" });

        await user.click(screen.getByRole("button", { name: "Split" }));
        const splitView = screen.getByRole("region", { name: "Split view" });
        expect(within(splitView).getByText("Calendar")).toBeInTheDocument();
        expect(within(splitView).getByText("Personal")).toBeInTheDocument();

        await user.click(screen.getByLabelText("New event at 9:00 AM in Personal"));
        const dialog = screen.getByRole("dialog", { name: "New event" });
        expect(within(dialog).getByLabelText("Calendar")).toHaveValue("f-cal2");
    });

    it("opens the calendars drawer via the mobile menu button, holding its own copy of the mini date picker/calendar list", async () => {
        mockShellAndEvents([]);
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("heading", { name: "June 2026" });

        expect(screen.queryByRole("dialog", { name: "Calendars" })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Open calendars" }));
        const drawer = screen.getByRole("dialog", { name: "Calendars" });
        expect(within(drawer).getByRole("navigation", { name: "Mini calendar" })).toBeInTheDocument();
        expect(within(drawer).getByText("Calendar")).toBeInTheDocument();

        await user.click(within(drawer).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog", { name: "Calendars" })).not.toBeInTheDocument();
    });

    it("hides Work Week and Split view options on mobile, still selectable on desktop", async () => {
        mockShellAndEvents([]);
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("heading", { name: "June 2026" });

        expect(screen.getByRole("button", { name: "Work Week" })).toHaveClass("hidden", "md:inline-block");
        expect(screen.getByRole("button", { name: "Split" })).toHaveClass("hidden", "md:inline-block");
        expect(screen.getByRole("button", { name: "Month" }).className).not.toContain("hidden");
    });
});
