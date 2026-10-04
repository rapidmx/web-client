// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockIntersectionObserver } from "../testUtils.js";
import CalendarPageBase from "../../../apps/www/calendar/index.js";
import { withTestRouter } from "../routerTestUtils.js";
import { occurrenceMarker } from "../../../apps/shared/components/calendar/activeOccurrence.js";

// Every list row renders through `occurrenceMarker`, so its calls count the rows rendered.
vi.mock("../../../apps/shared/components/calendar/activeOccurrence.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../apps/shared/components/calendar/activeOccurrence.js")>();
    return { ...actual, occurrenceMarker: vi.fn(actual.occurrenceMarker) };
});

// Rendered inside a router, as the app's shell does (see routerTestUtils.tsx).
const CalendarPage = withTestRouter(CalendarPageBase);

// See `index.test.tsx`: dnd-kit's real sensors cannot be driven from jsdom.
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

const at = (day: number, hour: number, minute = 0, month = 5, year = 2026) => new Date(year, month, day, hour, minute).toISOString();
const alice = { address: "alice@example.com", displayName: "Alice", type: "to" as const };

const standup = calendarEvent({ uid: "e1", title: "Standup", startDate: at(15, 9), endDate: at(15, 9, 30), location: "Room 1" });
// Listed before the standup in the data, after it on the day.
const review = calendarEvent({ uid: "e2", title: "Design review", startDate: at(15, 14), endDate: at(15, 15), organizer: alice });
const birthday = calendarEvent({ uid: "e3", title: "Birthday", allDay: true, startDate: "2026-06-15T00:00:00.000Z", endDate: "2026-06-16T00:00:00.000Z" });
const holiday = calendarEvent({ uid: "e4", title: "Holiday", allDay: true, startDate: "2026-06-17T00:00:00.000Z", endDate: "2026-06-18T00:00:00.000Z" });
const trip = calendarEvent({ uid: "e5", title: "Trip", startDate: at(20, 20), endDate: at(22, 10), location: "Lisbon" });
const free = calendarEvent({ uid: "e6", title: "Focus time", busyStatus: "free", startDate: at(25, 10), endDate: at(25, 11) });
const instant = calendarEvent({ uid: "e7", title: "Deadline", startDate: at(26, 10), endDate: at(26, 10) });
const july = calendarEvent({ uid: "e8", title: "Summer party", startDate: at(3, 18, 0, 6), endDate: at(3, 20, 0, 6) });
const nextYear = calendarEvent({ uid: "e10", title: "Next year", startDate: at(5, 10, 0, 2, 2027), endDate: at(5, 11, 0, 2, 2027) });
const past = calendarEvent({ uid: "e13", title: "Already over", startDate: at(10, 10), endDate: at(10, 11) });
const pastAllDay = calendarEvent({ uid: "e14", title: "Over all day", allDay: true, startDate: "2026-06-14T00:00:00.000Z", endDate: "2026-06-15T00:00:00.000Z" });
// Began before today and runs into it: listed from today on.
const ongoing = calendarEvent({ uid: "e15", title: "Ongoing", location: "Berlin", startDate: at(13, 20), endDate: at(16, 10) });
const overnight = calendarEvent({ uid: "e11", title: "Overnight", startDate: at(21, 22), endDate: at(22, 0) });
// A date-only event of two years: listed on its first 366 days only.
const sabbatical = calendarEvent({ uid: "e12", title: "Sabbatical", allDay: true, startDate: "2026-01-01T00:00:00.000Z", endDate: "2028-01-01T00:00:00.000Z" });
const daily = calendarEvent({
    uid: "e9",
    title: "Daily sync",
    startDate: at(2, 11),
    endDate: at(2, 12),
    recurrenceRule: { freq: "daily", interval: 1, exceptions: [] },
});

function mockShellAndEvents(events: unknown[], folders: unknown[] = [calendarFolder], byFolder?: Record<string, unknown[]>) {
    return mockFetch((url, init) => {
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, folders);
        if (url.startsWith("/api/mail/calendar-events") && (init?.method ?? "GET") === "GET") {
            const folderUid = new URL(url, "http://x").searchParams.get("folderUid") ?? "";
            return jsonResponse(200, byFolder?.[folderUid] ?? events);
        }
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}


let scrolled: HTMLElement[] = [];
beforeEach(() => {
    window.history.pushState(null, "", "/calendar?date=2026-06-15");
    // Today is the 15th unless a test says otherwise: the List shows nothing before it.
    setToday("2026-06-15T09:00:00");
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: HTMLElement) {
        scrolled.push(this);
    };
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.history.pushState(null, "", "/");
});

/** Today is `date` for the page, whose timers keep running. */
function setToday(date: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(date));
}

function onPhone() {
    vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query.includes("max-width"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    }));
}

function listRegion() {
    return screen.findByRole("region", { name: "List" });
}

function viewButtons() {
    const switcher = screen.getByRole("button", { name: "Month" }).parentElement!;
    return within(switcher).getAllByRole("button").map((button) => button.textContent);
}

describe("CalendarPage list view", () => {
    it("is the sixth view, with its button to the left of Month, and Month is still the default on a desktop", async () => {
        mockShellAndEvents([standup]);
        render(<CalendarPage userUid="u1" />);

        expect(await screen.findByRole("grid", { name: "Month" })).toBeInTheDocument();
        expect(viewButtons()).toEqual(["List", "Month", "Week", "Work Week", "Day", "Split"]);
        expect(screen.getByRole("button", { name: "Month" })).toHaveClass("bg-primary");
        expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("title", "List (Ctrl+Alt+5)");
        expect(localStorage.getItem("rapidmx:calendar-view")).toBeNull();
    });

    it("lists the events from today on under a heading for each day that has any, in date order, with the year where it is not this year's", async () => {
        setToday("2026-06-15T12:00:00");
        mockShellAndEvents([review, standup, birthday, holiday, trip, free, instant, july, nextYear, overnight, past, pastAllDay, ongoing]);
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("grid", { name: "Month" });
        await user.click(screen.getByRole("button", { name: "List" }));

        const region = await listRegion();
        expect(screen.getByRole("heading", { name: "Upcoming events" })).toBeInTheDocument();
        const headings = within(region).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
        // Nothing before today, not even the days of an event that began earlier; days without events are left out.
        expect(headings).toEqual([
            "Monday, June 15Today",
            "Tuesday, June 16",
            "Wednesday, June 17",
            "Saturday, June 20",
            "Sunday, June 21",
            "Monday, June 22",
            "Thursday, June 25",
            "Friday, June 26",
            "Friday, July 3",
            "Friday, March 5, 2027",
        ]);
        expect(within(region).queryByText("Already over")).not.toBeInTheDocument();
        expect(within(region).queryByText("Over all day")).not.toBeInTheDocument();
        expect(within(region).getAllByText("Ongoing")).toHaveLength(2);
        // Today is marked quietly: a pill and an edge, the same opaque bar as the other days - never a filled primary one.
        const todayHeading = within(region).getByRole("heading", { name: "Monday, June 15" });
        expect(todayHeading).toHaveAttribute("aria-current", "date");
        expect(todayHeading).toHaveTextContent("Monday, June 15Today");
        expect(todayHeading).toHaveClass("bg-surface-alt", "border-l-primary");
        expect(todayHeading).not.toHaveClass("bg-primary");
        const otherHeading = within(region).getByRole("heading", { name: "Wednesday, June 17" });
        expect(otherHeading).not.toHaveAttribute("aria-current");
        expect(otherHeading).toHaveClass("bg-surface-alt", "border-l-transparent");
        expect(otherHeading).toHaveTextContent(/^Wednesday, June 17$/);

        // The day is a list: the all-day event first, then by start time whatever order they came in.
        const rows = within(within(region).getByRole("heading", { name: "Monday, June 15" }).closest("section")!).getAllByRole("listitem");
        expect(rows.map((row) => row.textContent)).toEqual([
            "ContinuesOngoingBerlin",
            "All dayBirthdayu1@example.com",
            expect.stringMatching(/^9:00AM . 9:30AMStandupRoom 1$/),
            expect.stringMatching(/^2:00PM . 3:00PMDesign reviewAlice$/),
        ]);

        // A multi-day event is on each of its days; the later days say it continues. An instant is just its time.
        const trips = within(region).getAllByText("Trip");
        expect(trips).toHaveLength(3);
        expect(trips[0].closest("li")).toHaveTextContent(/^8:00PM . 10:00AMTripLisbon$/);
        expect(trips[1].closest("li")).toHaveTextContent("ContinuesTripLisbon");
        expect(within(region).getByText("Deadline").closest("li")).toHaveTextContent(/^10:00AMDeadline/);
        expect(within(region).getByText("Holiday").closest("li")).toHaveTextContent("All day");
        // One that ends at midnight does not reach into the next day.
        expect(within(region).getAllByText("Overnight")).toHaveLength(1);
    });

    it("lists today's events (the all-day and the timed, earlier ones too) and everything after the viewed month, every event of each day", async () => {
        setToday("2026-09-30T09:00:00");
        window.history.pushState(null, "", "/calendar?date=2026-09-30");
        const allDay = (uid: string, title: string, day: string, next: string) =>
            calendarEvent({ uid, title, allDay: true, startDate: `${day}T00:00:00.000Z`, endDate: `${next}T00:00:00.000Z` });
        mockShellAndEvents([
            allDay("s10", "Really Old", "2026-09-10", "2026-09-11"),
            allDay("s25", "Old Stuff", "2026-09-25", "2026-09-26"),
            allDay("s29", "Goobye", "2026-09-29", "2026-09-30"),
            allDay("s30", "Hello", "2026-09-30", "2026-10-01"),
            calendarEvent({ uid: "o1b", title: "One more time", startDate: at(1, 15, 0, 9), endDate: at(1, 16, 0, 9) }),
            calendarEvent({ uid: "o1a", title: "Test", startDate: at(1, 9, 0, 9), endDate: at(1, 10, 0, 9) }),
            allDay("o4", "Stuff", "2026-10-04", "2026-10-05"),
            calendarEvent({ uid: "t2", title: "Later today", startDate: at(30, 17, 0, 8), endDate: at(30, 18, 0, 8) }),
            calendarEvent({ uid: "t1", title: "Earlier today", startDate: at(30, 8, 0, 8), endDate: at(30, 8, 30, 8) }),
        ]);
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("grid", { name: "Month" });
        await user.click(screen.getByRole("button", { name: "List" }));
        const region = await listRegion();

        const sections = Array.from(region.querySelectorAll("section")).map((section) => [
            section.dataset.day,
            within(section).getAllByRole("listitem").map((row) => row.querySelector(".font-medium")!.textContent),
        ]);
        expect(sections).toEqual([
            // Today: the all-day event, then the timed ones as they start.
            ["2026-09-30", ["Hello", "Earlier today", "Later today"]],
            // Two events on one day are two rows.
            ["2026-10-01", ["Test", "One more time"]],
            ["2026-10-04", ["Stuff"]],
        ]);
        expect(within(region).getByRole("heading", { name: "Wednesday, September 30" })).toHaveAttribute("aria-current", "date");
    });

    it("lists a very long event on its first year of days only, as the end of the list is scrolled to", async () => {
        setToday("2026-01-01T09:00:00");
        const io = mockIntersectionObserver();
        mockShellAndEvents([sabbatical]);
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("grid", { name: "Month" });
        await user.click(screen.getByRole("button", { name: "List" }));

        const region = await listRegion();
        // The days are rendered a page at a time (the page opens on the 15th of June, so up to there and a page past it are).
        expect(within(region).getAllByText("Sabbatical").length).toBeLessThan(366);
        for (let page = 0; page < 5; page++) {
            act(() => io.trigger());
        }
        expect(within(region).getAllByText("Sabbatical")).toHaveLength(366);
    });

    it("marks each row with its calendar's colour, an outline for time shown as free", async () => {
        mockShellAndEvents([standup, free]);
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("grid", { name: "Month" });
        await user.click(screen.getByRole("button", { name: "List" }));
        const region = await listRegion();

        const dot = (title: string) => within(region).getByText(title).closest("button")!.querySelector<HTMLElement>("[aria-hidden='true']")!;
        expect(dot("Standup").style.backgroundColor).not.toBe("");
        expect(dot("Focus time").style.backgroundColor).toBe("");
        expect(dot("Focus time")).toHaveClass("border-2");
    });

    it("expands a recurring event within the same window a search uses (five years either side of today, the 500 nearest it), from today on", async () => {
        setToday("2026-06-15T12:00:00");
        const io = mockIntersectionObserver();
        mockShellAndEvents([daily]);
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("grid", { name: "Month" });
        await user.click(screen.getByRole("button", { name: "List" }));
        const region = await listRegion();

        // Rendered a page of days at a time: the first 60 days, then more as the end of the list comes into view.
        expect(within(region).getAllByText("Daily sync")).toHaveLength(60);
        for (let page = 0; page < 10; page++) {
            act(() => io.trigger());
        }
        expect(within(region).getAllByText("Daily sync")).toHaveLength(487);
    });

    it("opens the event's card when a row is clicked", async () => {
        mockShellAndEvents([standup]);
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("grid", { name: "Month" });
        await user.click(screen.getByRole("button", { name: "List" }));
        await user.click(within(await listRegion()).getByRole("button", { name: /Standup/ }));

        const dialog = await screen.findByRole("dialog", { name: "Event details" });
        expect(within(dialog).getByText("Standup")).toBeInTheDocument();
    });

    it("says there are no events when there are none at all, and leaves out the calendars that are unchecked", async () => {
        mockShellAndEvents([], [calendarFolder, secondCalendarFolder], { "f-cal": [july], "f-cal2": [standup] });
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("grid", { name: "Month" });
        await user.click(screen.getByRole("button", { name: "List" }));
        const region = await listRegion();
        expect(within(region).getByText("Standup")).toBeInTheDocument();
        expect(within(region).getByText("Summer party")).toBeInTheDocument();

        await user.click(screen.getAllByRole("checkbox", { name: "Personal" })[0]);
        await waitFor(() => expect(within(screen.getByRole("region", { name: "List" })).queryByText("Standup")).not.toBeInTheDocument());
        await user.click(screen.getAllByRole("checkbox", { name: "Calendar" })[0]);
        await waitFor(() => expect(within(screen.getByRole("region", { name: "List" })).getByText("No upcoming events")).toBeInTheDocument());

        // Previous and Next have nowhere to go.
        scrolled = [];
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(scrolled).toEqual([]);
    });

    it("opens with nothing to scroll to when there are no events at all", async () => {
        mockShellAndEvents([]);
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("grid", { name: "Month" });
        await user.click(screen.getByRole("button", { name: "List" }));

        expect(within(await listRegion()).getByText("No upcoming events")).toBeInTheDocument();
        expect(scrolled).toEqual([]);
    });

    describe("scrolling", () => {
        const days = () => scrolled.map((el) => el.dataset.day);

        it("opens on today's day, or the next day that has events, and goes there again each time Today is pressed", async () => {
            setToday("2026-06-16T12:00:00");
            window.history.pushState(null, "", "/calendar?date=2026-06-16");
            mockShellAndEvents([standup, holiday]);
            const user = userEvent.setup();
            render(<CalendarPage userUid="u1" />);
            await screen.findByRole("grid", { name: "Month" });
            await user.click(screen.getByRole("button", { name: "List" }));
            await listRegion();

            // The 16th has no events: the next day that has some (the 17th).
            expect(days()).toEqual(["2026-06-17"]);
            await user.click(screen.getByRole("button", { name: "Today" }));
            expect(days()).toEqual(["2026-06-17", "2026-06-17"]);
        });

        it("goes to the last day when the day asked for is after every event", async () => {
            window.history.pushState(null, "", "/calendar?date=2027-01-01");
            mockShellAndEvents([standup, july]);
            const user = userEvent.setup();
            render(<CalendarPage userUid="u1" />);
            await screen.findByRole("grid", { name: "Month" });
            await user.click(screen.getByRole("button", { name: "List" }));
            await listRegion();

            expect(days()).toEqual(["2026-07-03"]);
        });

        it("has nothing to show or scroll to when every event is in the past", async () => {
            setToday("2027-01-01T12:00:00");
            mockShellAndEvents([standup, july]);
            const user = userEvent.setup();
            render(<CalendarPage userUid="u1" />);
            await screen.findByRole("grid", { name: "Month" });
            await user.click(screen.getByRole("button", { name: "List" }));

            expect(within(await listRegion()).getByText("No upcoming events")).toBeInTheDocument();
            expect(scrolled).toEqual([]);
        });

        it("goes to the day picked in the mini calendar, or the nearest following one", async () => {
            mockShellAndEvents([standup, holiday]);
            const user = userEvent.setup();
            render(<CalendarPage userUid="u1" />);
            await screen.findByRole("grid", { name: "Month" });
            await user.click(screen.getByRole("button", { name: "List" }));
            await listRegion();
            scrolled = [];

            await user.click(within(screen.getAllByRole("navigation", { name: "Mini calendar" })[0]).getByText("16"));
            expect(days()).toEqual(["2026-06-17"]);
            expect(screen.getByRole("heading", { name: "Upcoming events" })).toBeInTheDocument();

            // A day in the past has nothing earlier to show: the list goes to its first day.
            await user.click(within(screen.getAllByRole("navigation", { name: "Mini calendar" })[0]).getByText("10"));
            expect(days()).toEqual(["2026-06-17", "2026-06-15"]);
        });

        describe("Previous and Next", () => {
            // jsdom lays nothing out: the list's own top is 0, and the days before `topIndex` have scrolled past it.
            let topIndex = 0;
            let rect: ReturnType<typeof vi.spyOn>;
            beforeEach(() => {
                rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
                    const index = Array.from(this.parentElement?.querySelectorAll("[data-day]") ?? []).indexOf(this);
                    return { top: 0, bottom: index >= 0 && index < topIndex ? -1 : 50 } as DOMRect;
                });
            });
            afterEach(() => rect.mockRestore());

            async function openList() {
                const august = calendarEvent({ uid: "a1", title: "August one", startDate: at(1, 9, 0, 7), endDate: at(1, 10, 0, 7) });
                const august2 = calendarEvent({ uid: "a2", title: "August two", startDate: at(2, 9, 0, 7), endDate: at(2, 10, 0, 7) });
                mockShellAndEvents([july, standup, august2, august]);
                const user = userEvent.setup();
                render(<CalendarPage userUid="u1" />);
                await screen.findByRole("grid", { name: "Month" });
                await user.click(screen.getByRole("button", { name: "List" }));
                await listRegion();
                scrolled = [];
                return user;
            }

            it("scroll to the first day of the next or previous month that has events, counted from the day at the top", async () => {
                topIndex = 1; // Days: Jun 15, Jul 3, Aug 1, Aug 2 - the top one is Jul 3.
                const user = await openList();

                await user.click(screen.getByRole("button", { name: "Next" }));
                expect(days()).toEqual(["2026-08-01"]);
                await user.click(screen.getByRole("button", { name: "Previous" }));
                expect(days()).toEqual(["2026-08-01", "2026-06-15"]);
                expect(screen.getByRole("heading", { name: "Upcoming events" })).toBeInTheDocument();
            });

            it("do nothing past the first and last month (nothing is earlier than today's)", async () => {
                topIndex = 0;
                const user = await openList();
                await user.click(screen.getByRole("button", { name: "Previous" }));
                expect(scrolled).toEqual([]);

                topIndex = 4; // Everything has scrolled past: the last day is the one at the top.
                await user.click(screen.getByRole("button", { name: "Previous" }));
                expect(days()).toEqual(["2026-07-03"]);
                await user.click(screen.getByRole("button", { name: "Next" }));
                expect(days()).toEqual(["2026-07-03"]);
            });

            it("never change what the list holds: every event from today on stays, whichever way it is stepped or jumped", async () => {
                const eventOn = (uid: string, day: number, month: number, year = 2026) =>
                    calendarEvent({ uid, title: `Event ${uid}`, startDate: at(day, 10, 0, month, year), endDate: at(day, 11, 0, month, year) });
                setToday("2026-09-30T09:00:00");
                window.history.pushState(null, "", "/calendar?date=2026-09-30");
                const events = [eventOn("sep", 30, 8), eventOn("oct1", 1, 9), eventOn("oct4", 4, 9), eventOn("dec", 7, 11), eventOn("y27", 12, 1, 2027)];
                mockShellAndEvents(events);
                const user = userEvent.setup();
                render(<CalendarPage userUid="u1" />);
                await screen.findByRole("grid", { name: "Month" });
                await user.click(screen.getByRole("button", { name: "List" }));
                const region = await listRegion();
                const titles = () => within(screen.getByRole("region", { name: "List" })).getAllByRole("listitem").map((row) => row.querySelector(".font-medium")!.textContent);
                const all = ["Event sep", "Event oct1", "Event oct4", "Event dec", "Event y27"];
                expect(titles()).toEqual(all);
                expect(region).toBeInTheDocument();

                await user.click(screen.getByRole("button", { name: "Next" }));
                await user.click(screen.getByRole("button", { name: "Previous" }));
                await user.click(within(screen.getAllByRole("navigation", { name: "Mini calendar" })[0]).getByText("20"));
                await user.click(screen.getByRole("button", { name: "Today" }));
                expect(titles()).toEqual(all);
                expect(screen.getByRole("heading", { name: "Upcoming events" })).toBeInTheDocument();
            });
        });
    });

    describe("search", () => {
        const alphaReview = calendarEvent({ uid: "m1", title: "Alpha review", startDate: at(15, 9), endDate: at(15, 10) });
        const beta = calendarEvent({ uid: "m2", title: "Beta", startDate: at(16, 9), endDate: at(16, 10) });
        const alphaSync = calendarEvent({ uid: "m3", title: "Alpha sync", startDate: at(3, 9, 0, 6), endDate: at(3, 10, 0, 6) });
        const alphaOld = calendarEvent({ uid: "m4", title: "Alpha old", startDate: at(3, 9, 0, 0), endDate: at(3, 10, 0, 0) });

        it("lists only the matches, rings the active one and steps to the previous and next without leaving the list", async () => {
            const user = userEvent.setup();
            mockShellAndEvents([alphaReview, beta, alphaSync, alphaOld]);
            render(<CalendarPage userUid="u1" />);
            await screen.findByRole("grid", { name: "Month" });
            await user.click(screen.getByRole("button", { name: "List" }));
            await listRegion();

            await user.type(screen.getByRole("textbox", { name: "Search events" }), "alpha{Enter}");
            const region = await listRegion();
            await waitFor(() => expect(within(region).queryByText("Beta")).not.toBeInTheDocument());
            const active = () => region.querySelector("[data-active-match]");
            // From the day being viewed on.
            await waitFor(() => expect(active()).toHaveTextContent("Alpha review"));
            expect(active()).toHaveClass("ring-2");
            // The match in the past is not in the list, nor counted or stepped to there.
            expect(within(region).queryByText("Alpha old")).not.toBeInTheDocument();
            expect(within(screen.getByRole("search")).getByRole("status")).toHaveTextContent("1 of 2");

            scrolled = [];
            await user.click(screen.getByRole("button", { name: "Next match" }));
            await waitFor(() => expect(active()).toHaveTextContent("Alpha sync"));
            expect(scrolled).toContain(active());
            expect(screen.getByRole("heading", { name: "Upcoming events" })).toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: "Previous match" }));
            await waitFor(() => expect(active()).toHaveTextContent("Alpha review"));
            expect(scrolled).toContain(active());
        });

        it("starts at the nearest match before when none is from the day being viewed on", async () => {
            const user = userEvent.setup();
            mockShellAndEvents([alphaReview, alphaOld]);
            window.history.pushState(null, "", "/calendar?date=2026-12-01");
            render(<CalendarPage userUid="u1" />);
            await screen.findByRole("grid", { name: "Month" });
            await user.click(screen.getByRole("button", { name: "List" }));
            await user.type(screen.getByRole("textbox", { name: "Search events" }), "alpha{Enter}");

            await waitFor(() => expect(screen.getByRole("region", { name: "List" }).querySelector("[data-active-match]")).toHaveTextContent("Alpha review"));
        });

        it("steps the open event card through the matches", async () => {
            const user = userEvent.setup();
            mockShellAndEvents([alphaReview, alphaSync]);
            render(<CalendarPage userUid="u1" />);
            await screen.findByRole("grid", { name: "Month" });
            await user.click(screen.getByRole("button", { name: "List" }));
            await user.type(screen.getByRole("textbox", { name: "Search events" }), "alpha{Enter}");
            await user.click(await screen.findByRole("button", { name: /Alpha review/ }));

            const dialog = await screen.findByRole("dialog", { name: "Event details" });
            await user.click(within(dialog).getByRole("button", { name: "Next match" }));
            await waitFor(() => expect(within(screen.getByRole("dialog")).getByText("Alpha sync")).toBeInTheDocument());
            expect(screen.getByRole("heading", { name: "Upcoming events" })).toBeInTheDocument();
        });
    });

    describe("the view that opens", () => {
        it("is the List on a phone", async () => {
            onPhone();
            mockShellAndEvents([standup]);
            render(<CalendarPage userUid="u1" />);

            expect(await listRegion()).toBeInTheDocument();
            expect(screen.queryByRole("grid", { name: "Month" })).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "List" })).toHaveClass("bg-primary");
            // The default is not a choice: nothing is remembered until the reader picks.
            expect(localStorage.getItem("rapidmx:calendar-view")).toBeNull();
        });

        it("remembers the view the reader picked for the next visit, which then wins over the device's default", async () => {
            mockShellAndEvents([standup]);
            const user = userEvent.setup();
            const first = render(<CalendarPage userUid="u1" />);
            await screen.findByRole("grid", { name: "Month" });
            await user.click(screen.getByRole("button", { name: "Week" }));
            expect(localStorage.getItem("rapidmx:calendar-view")).toBe("week");
            first.unmount();

            // Back on the Calendar from elsewhere in the app: the Week it was left on.
            render(<CalendarPage userUid="u1" />);
            expect(await screen.findByRole("heading", { name: "Jun 14 \u2013 Jun 20, 2026" })).toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: "Month" }));
            expect(localStorage.getItem("rapidmx:calendar-view")).toBe("month");
        });

        describe("on a desktop the List is never the default", () => {
            it("opens on the Month with nothing remembered", async () => {
                mockShellAndEvents([standup]);
                render(<CalendarPage userUid="u1" />);

                expect(await screen.findByRole("grid", { name: "Month" })).toBeInTheDocument();
                expect(screen.queryByRole("region", { name: "List" })).not.toBeInTheDocument();
            });

            it("opens on the Month although a List is remembered, and leaves what is stored alone", async () => {
                localStorage.setItem("rapidmx:calendar-view", "list");
                mockShellAndEvents([standup]);
                render(<CalendarPage userUid="u1" />);

                expect(await screen.findByRole("grid", { name: "Month" })).toBeInTheDocument();
                // Not for good, either: settling in on the Month does not wait for a later render to be corrected.
                await waitFor(() => expect(screen.getByRole("button", { name: "Month" })).toHaveClass("bg-primary"));
                expect(screen.queryByRole("region", { name: "List" })).not.toBeInTheDocument();
            });

            it("still restores a remembered Week, Work Week, Day, Split or Month", async () => {
                for (const [stored, shown] of [
                    ["week", "Jun 14 \u2013 Jun 20, 2026"],
                    ["day", "Monday, June 15, 2026"],
                ]) {
                    localStorage.setItem("rapidmx:calendar-view", stored);
                    mockShellAndEvents([standup]);
                    const { unmount } = render(<CalendarPage userUid="u1" />);
                    expect(await screen.findByRole("heading", { name: shown })).toBeInTheDocument();
                    unmount();
                }
            });

            it("does not write the List to storage when it is picked, by the button or the shortcut, so it cannot come back next time", async () => {
                localStorage.setItem("rapidmx:calendar-view", "week");
                mockShellAndEvents([standup]);
                const user = userEvent.setup();
                const first = render(<CalendarPage userUid="u1" />);
                await screen.findByRole("heading", { name: "Jun 14 \u2013 Jun 20, 2026" });

                await user.click(screen.getByRole("button", { name: "List" }));
                expect(await listRegion()).toBeInTheDocument();
                await user.click(screen.getByRole("button", { name: "Month" }));
                await user.keyboard("{Control>}{Alt>}5{/Alt}{/Control}");
                expect(await listRegion()).toBeInTheDocument();
                // What was remembered before is still what is.
                expect(localStorage.getItem("rapidmx:calendar-view")).toBe("month");
                first.unmount();

                render(<CalendarPage userUid="u1" />);
                expect(await screen.findByRole("grid", { name: "Month" })).toBeInTheDocument();
            });
        });

        describe("on a phone", () => {
            it("opens on the List with nothing remembered, and with a List remembered", async () => {
                onPhone();
                localStorage.setItem("rapidmx:calendar-view", "list");
                mockShellAndEvents([standup]);
                const { unmount } = render(<CalendarPage userUid="u1" />);
                expect(await listRegion()).toBeInTheDocument();
                unmount();

                localStorage.clear();
                render(<CalendarPage userUid="u1" />);
                expect(await listRegion()).toBeInTheDocument();
            });

            it("remembers going back to the List after the Month, so it is the List that opens next time", async () => {
                onPhone();
                localStorage.setItem("rapidmx:calendar-view", "month");
                mockShellAndEvents([standup]);
                const user = userEvent.setup();
                render(<CalendarPage userUid="u1" />);
                await screen.findByRole("grid", { name: "Month" });

                await user.click(screen.getByRole("button", { name: "List" }));
                expect(await listRegion()).toBeInTheDocument();
                expect(localStorage.getItem("rapidmx:calendar-view")).toBe("list");
            });
        });

        it("keeps a remembered Month on a phone instead of the List", async () => {
            onPhone();
            localStorage.setItem("rapidmx:calendar-view", "month");
            mockShellAndEvents([standup]);
            render(<CalendarPage userUid="u1" />);

            expect(await screen.findByRole("grid", { name: "Month" })).toBeInTheDocument();
            expect(screen.queryByRole("region", { name: "List" })).not.toBeInTheDocument();
        });

        it("ignores a remembered view it does not know", async () => {
            localStorage.setItem("rapidmx:calendar-view", "agenda");
            mockShellAndEvents([standup]);
            render(<CalendarPage userUid="u1" />);

            expect(await screen.findByRole("grid", { name: "Month" })).toBeInTheDocument();
        });

        it("shows the view the link asks for, over what was remembered and on a phone, without remembering it", async () => {
            onPhone();
            localStorage.setItem("rapidmx:calendar-view", "week");
            window.history.pushState(null, "", "/calendar?date=2026-06-15&view=list");
            mockShellAndEvents([standup]);
            const { unmount } = render(<CalendarPage userUid="u1" />);
            expect(await listRegion()).toBeInTheDocument();
            expect(localStorage.getItem("rapidmx:calendar-view")).toBe("week");
            unmount();

            window.history.pushState(null, "", "/calendar?date=2026-06-15&view=month");
            render(<CalendarPage userUid="u1" />);
            expect(await screen.findByRole("grid", { name: "Month" })).toBeInTheDocument();
        });

        it("does not remember going to a day by clicking it in the month", async () => {
            mockShellAndEvents([standup]);
            const user = userEvent.setup();
            render(<CalendarPage userUid="u1" />);
            const grid = await screen.findByRole("grid", { name: "Month" });
            await user.click(within(grid).getByRole("button", { name: "17" }));

            expect(await screen.findByRole("heading", { name: "Wednesday, June 17, 2026" })).toBeInTheDocument();
            expect(localStorage.getItem("rapidmx:calendar-view")).toBeNull();
        });

        it("still works where the browser will not let the page store anything", async () => {
            const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
                throw new Error("blocked");
            });
            const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
                throw new Error("blocked");
            });
            try {
                mockShellAndEvents([standup]);
                const user = userEvent.setup();
                render(<CalendarPage userUid="u1" />);
                await screen.findByRole("grid", { name: "Month" });
                await user.click(screen.getByRole("button", { name: "List" }));
                expect(await listRegion()).toBeInTheDocument();
            } finally {
                setItem.mockRestore();
                getItem.mockRestore();
            }
        });

        it("is switched to with Ctrl+Alt+5", async () => {
            mockShellAndEvents([standup]);
            const user = userEvent.setup();
            render(<CalendarPage userUid="u1" />);
            await screen.findByRole("grid", { name: "Month" });

            await user.keyboard("{Control>}{Alt>}5{/Alt}{/Control}");
            expect(await listRegion()).toBeInTheDocument();
        });
    });

    it("does not render the rows again for a keystroke in the search box, only for the search it becomes", async () => {
        mockShellAndEvents([standup, review, holiday]);
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("grid", { name: "Month" });
        await user.click(screen.getByRole("button", { name: "List" }));
        await listRegion();
        vi.mocked(occurrenceMarker).mockClear();

        // Typing alone (the search itself waits for a pause) changes nothing in the list.
        fireEvent.change(screen.getByRole("textbox", { name: "Search events" }), { target: { value: "stand" } });
        expect(screen.getByRole("textbox", { name: "Search events" })).toHaveValue("stand");
        expect(occurrenceMarker).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByText("Holiday")).not.toBeInTheDocument());
    });

    it("moves on at midnight: a card open on an event no longer has the events of yesterday to step back to", async () => {
        setToday("2026-06-15T23:59:00");
        mockShellAndEvents([standup, july]);
        const user = userEvent.setup();
        render(<CalendarPage userUid="u1" />);
        await screen.findByRole("grid", { name: "Month" });
        await user.click(screen.getByRole("button", { name: "List" }));
        await user.click(within(await listRegion()).getByRole("button", { name: /Summer party/ }));
        const dialog = await screen.findByRole("dialog", { name: "Event details" });
        // The standup of the 15th is still listed, so there is an event before the party.
        expect(within(dialog).getByRole("button", { name: "Previous event" })).not.toHaveAttribute("aria-disabled");

        // The machine slept through midnight (or the tab was hidden): back in view, it is the 16th.
        vi.setSystemTime(new Date("2026-06-16T00:00:05"));
        act(() => void document.dispatchEvent(new Event("visibilitychange")));
        await waitFor(() => expect(within(dialog).getByRole("button", { name: "Previous event" })).toHaveAttribute("aria-disabled", "true"));
    });
});
