// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { Attendee } from "@rapidmx/react-shared/calendar/calendarApi.js";
import { FreeBusyResult } from "@rapidmx/react-shared/calendar/freeBusyApi.js";
import { CalendarOccurrence } from "@rapidmx/react-shared/calendar/recurrence.js";
import FindATime, { FIND_TIME_DEBOUNCE_MS } from "../../../apps/shared/components/calendar/FindATime.js";
import { EventFormController, EventFormValues } from "../../../apps/shared/components/calendar/eventForm.js";

// The Find a time tab: a day of the guests' calendars side by side, and suggested times. Runs with TZ=UTC (see vitest.config.ts).

const guest = (address: string, displayName?: string): Attendee => ({ address, displayName, role: "required", responseStatus: "needsAction", isOrganizer: false });

const busy = (start: string, end: string, tentative = false) => ({ start, end, tentative });

function controller(overrides: Partial<EventFormValues> = {}, extra: Partial<EventFormController> = {}) {
    const c = {
        values: {
            start: "2026-06-10T09:00",
            end: "2026-06-10T10:00",
            allDay: false,
            formZone: "UTC",
            attendees: [guest("bob@example.com", "Bob Brown")],
            ...overrides,
        },
        deviceZone: "UTC",
        organizerAddress: "jane@example.com",
        occurrence: null,
        setStart: vi.fn(),
        ...extra,
    } as unknown as EventFormController;
    return c;
}

/** Answers a free/busy look-up with `results` for the addresses asked (in order), each result overridden by address. */
function answer(byAddress: Record<string, Partial<FreeBusyResult>> = {}) {
    return mockFetch((url, init) => {
        if (url !== "/api/mail/calendar-events/free-busy") {
            return undefined;
        }
        const body = JSON.parse(init.body as string) as { addresses: string[]; start: string; end: string };
        return jsonResponse(200, {
            start: body.start,
            end: body.end,
            results: body.addresses.map((address) => ({ address, status: "available", busy: [], ...byAddress[address] })),
        });
    });
}

function lookUps(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as { addresses: string[]; start: string; end: string });
}

/** Lets the debounce run out and the answer arrive. */
async function settle() {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(FIND_TIME_DEBOUNCE_MS + 10);
    });
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("FindATime without anything to look up", () => {
    it("tells the reader to add guests, and asks the server nothing", async () => {
        const fetchMock = answer();
        render(<FindATime c={controller({ attendees: [] })} />);
        await settle();
        expect(screen.getByText("Add guests to see when they are free.")).toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not count the organizer's own entry as a guest", async () => {
        const fetchMock = answer();
        render(<FindATime c={controller({ attendees: [guest("JANE@example.com")] })} />);
        await settle();
        expect(screen.getByText("Add guests to see when they are free.")).toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("says an all-day event has no times to find, and asks the server nothing", async () => {
        const fetchMock = answer();
        render(<FindATime c={controller({ allDay: true })} />);
        await settle();
        expect(screen.getByText(/Uncheck All day/)).toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("FindATime look-up", () => {
    it("asks once, after a pause, for you and each guest (once each, in order) over the day and the week that follows", async () => {
        const fetchMock = answer();
        render(<FindATime c={controller({ attendees: [guest("bob@example.com", "Bob Brown"), guest("BOB@example.com"), guest("jane@example.com"), guest("cy@example.com")] })} />);

        expect(screen.getByText("Checking availability…")).toBeInTheDocument();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(FIND_TIME_DEBOUNCE_MS - 50);
        });
        expect(fetchMock).not.toHaveBeenCalled();
        await settle();

        expect(lookUps(fetchMock)).toEqual([
            { addresses: ["jane@example.com", "bob@example.com", "cy@example.com"], start: "2026-06-10T00:00:00.000Z", end: "2026-06-17T00:00:00.000Z" },
        ]);
    });

    it("asks for at most fifty people", async () => {
        const fetchMock = answer();
        const many = Array.from({ length: 60 }, (_, i) => guest(`g${i}@example.com`));
        render(<FindATime c={controller({ attendees: many })} />);
        await settle();
        expect(lookUps(fetchMock)[0].addresses).toHaveLength(50);
        expect(lookUps(fetchMock)[0].addresses[0]).toBe("jane@example.com");
    });

    it("reads the day in the zone the event is set in", async () => {
        const fetchMock = answer();
        render(<FindATime c={controller({ formZone: "America/New_York" })} />);
        await settle();
        expect(lookUps(fetchMock)[0]).toMatchObject({ start: "2026-06-10T04:00:00.000Z", end: "2026-06-17T04:00:00.000Z" });
        expect(screen.getByText("America/New York")).toBeInTheDocument();
    });

    it("asks again for another day, and again when the guests change - not once for each change made within the pause", async () => {
        const fetchMock = answer();
        const { rerender } = render(<FindATime c={controller()} />);
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole("button", { name: "Next day" }));
        fireEvent.click(screen.getByRole("button", { name: "Next day" }));
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(lookUps(fetchMock)[1].start).toBe("2026-06-12T00:00:00.000Z");
        expect(screen.getByText("Friday, June 12")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
        expect(screen.getByText("Thursday, June 11")).toBeInTheDocument();
        await settle();
        expect(lookUps(fetchMock)[2].start).toBe("2026-06-11T00:00:00.000Z");

        rerender(<FindATime c={controller({ attendees: [guest("bob@example.com"), guest("cy@example.com")] })} />);
        rerender(<FindATime c={controller({ attendees: [guest("bob@example.com"), guest("cy@example.com"), guest("di@example.com")] })} />);
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(lookUps(fetchMock)[3].addresses).toEqual(["jane@example.com", "bob@example.com", "cy@example.com", "di@example.com"]);
    });

    it("moves to the day of the form's own date when that changes", async () => {
        answer();
        const { rerender } = render(<FindATime c={controller()} />);
        await settle();
        rerender(<FindATime c={controller({ start: "2026-06-20T09:00", end: "2026-06-20T10:00" })} />);
        expect(screen.getByText("Saturday, June 20")).toBeInTheDocument();
        // An empty date leaves the grid where it is.
        rerender(<FindATime c={controller({ start: "", end: "" })} />);
        expect(screen.getByText("Saturday, June 20")).toBeInTheDocument();
        await settle();
    });

    it("starts on today when the form has no date yet", async () => {
        answer();
        render(<FindATime c={controller({ start: "", end: "" })} />);
        expect(screen.getByText("Monday, June 1")).toBeInTheDocument();
        await settle();
    });

    it("drops an answer for a look-up that has since been replaced", async () => {
        const resolvers: ((response: Response) => void)[] = [];
        const fetchMock = mockFetch(() => new Promise<Response>((resolve) => resolvers.push(resolve)));
        render(<FindATime c={controller()} />);
        await settle();
        fireEvent.click(screen.getByRole("button", { name: "Next day" }));
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(2);

        const result = (busyWindows: ReturnType<typeof busy>[]) =>
            jsonResponse(200, {
                start: "x",
                end: "y",
                results: [
                    { address: "jane@example.com", status: "available", busy: busyWindows },
                    { address: "bob@example.com", status: "available", busy: [] },
                ],
            });
        // The newer answer arrives first, then the older one - which must not replace it.
        await act(async () => {
            resolvers[1](result([]));
            await vi.advanceTimersByTimeAsync(0);
        });
        await act(async () => {
            resolvers[0](result([busy("2026-06-10T09:00:00Z", "2026-06-10T10:00:00Z")]));
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(document.querySelector("[data-busy]")).toBeNull();
    });

    it("ignores an answer that arrives after it is gone", async () => {
        let finish: (response: Response) => void = () => undefined;
        mockFetch(() => new Promise<Response>((resolve) => (finish = resolve)));
        const { unmount } = render(<FindATime c={controller()} />);
        await settle();
        unmount();
        await act(async () => {
            finish(jsonResponse(200, { start: "x", end: "y", results: [] }));
            await vi.advanceTimersByTimeAsync(0);
        });
    });
});

describe("FindATime errors", () => {
    it("says a rate limit is a wait, and retries on request", async () => {
        let calls = 0;
        const fetchMock = mockFetch((_url, init) => {
            calls++;
            if (calls === 1) {
                return jsonResponse(429, { message: "Too many requests" });
            }
            const body = JSON.parse(init.body as string);
            return jsonResponse(200, { start: body.start, end: body.end, results: body.addresses.map((address: string) => ({ address, status: "available", busy: [] })) });
        });
        render(<FindATime c={controller()} />);
        await settle();

        expect(screen.getByRole("alert")).toHaveTextContent(/Too many availability look-ups/);
        expect(screen.queryByText("Everyone is free")).not.toBeInTheDocument();
        expect(screen.queryByText("Suggested times")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.getByText("Everyone is free")).toBeInTheDocument();
    });

    it("says so, with a retry, when the request never got an answer", async () => {
        mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
        render(<FindATime c={controller()} />);
        await settle();
        expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load availability. Check your connection and try again.");
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });
});

describe("FindATime grid", () => {
    it("has a row for you and one for each guest, each with its status under the name", async () => {
        answer();
        render(<FindATime c={controller({ attendees: [guest("bob@example.com", "Bob Brown"), guest("cy@example.com")] })} />);
        expect(screen.getAllByText("Checking…")).toHaveLength(3);
        await settle();

        const grid = screen.getByRole("group", { name: "Guests' availability" });
        expect(within(grid).getByText("You")).toBeInTheDocument();
        expect(within(grid).getByText("Bob Brown")).toBeInTheDocument();
        expect(within(grid).getByText("cy@example.com")).toBeInTheDocument();
        expect(within(grid).getAllByText("Free")).toHaveLength(3);
        expect(grid).toHaveAttribute("aria-busy", "false");
        expect(within(grid).getByRole("img", { name: "You: Free all day." })).toBeInTheDocument();
    });

    it("draws each person's busy time, a tentative one differently, with what it is for a screen reader, and the proposed time across every row", async () => {
        answer({
            "jane@example.com": { busy: [busy("2026-06-10T13:00:00Z", "2026-06-10T14:00:00Z")] },
            "bob@example.com": { busy: [busy("2026-06-10T11:00:00Z", "2026-06-10T12:30:00Z", true)] },
        });
        render(<FindATime c={controller()} />);
        await settle();

        const blocks = Array.from(document.querySelectorAll<HTMLElement>("[data-busy]"));
        expect(blocks.map((b) => b.getAttribute("data-busy"))).toEqual(["busy", "tentative"]);
        // 52px an hour: 13:00 is 13 * 52.
        expect(blocks[0]).toHaveStyle({ left: "676px", width: "52px" });
        expect(blocks[1]).toHaveStyle({ left: "572px", width: "78px" });
        expect(screen.getByRole("img", { name: "You: Busy 1:00pm to 2:00pm" })).toBeInTheDocument();
        expect(screen.getByRole("img", { name: "Bob Brown: Tentatively busy 11:00am to 12:30pm" })).toBeInTheDocument();

        const proposed = document.querySelector<HTMLElement>("[data-proposed-time]")!;
        // The name column is 136px wide, and 09:00 is 9 * 52 across it.
        expect(proposed).toHaveStyle({ left: `${136 + 9 * 52}px`, width: "52px" });
    });

    it("says whether the proposed time suits everyone: free, busy, or maybe busy", async () => {
        answer({
            "jane@example.com": { busy: [busy("2026-06-10T09:30:00Z", "2026-06-10T10:30:00Z")] },
            "bob@example.com": { busy: [busy("2026-06-10T09:00:00Z", "2026-06-10T09:15:00Z", true)] },
            "cy@example.com": {},
        });
        render(<FindATime c={controller({ attendees: [guest("bob@example.com", "Bob Brown"), guest("cy@example.com", "Cy")] })} />);
        await settle();

        expect(screen.getByRole("status")).toHaveTextContent("2 conflicts (1 tentative)");
        expect(screen.getByText("Busy at this time")).toBeInTheDocument();
        expect(screen.getByText("Maybe busy at this time")).toBeInTheDocument();
        expect(screen.getByText("Free")).toBeInTheDocument();
    });

    it("shows a guest it cannot see as unknown or hiding their calendar - never free - and never says everyone is free", async () => {
        answer({
            "bob@example.com": { status: "unknown" },
            "cy@example.com": { status: "restricted" },
        });
        render(<FindATime c={controller({ attendees: [guest("bob@example.com", "Bob Brown"), guest("cy@example.com", "Cy")] })} />);
        await settle();

        expect(screen.getAllByText("Availability unknown").length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText("Hides their calendar").length).toBeGreaterThanOrEqual(1);
        expect(screen.getByRole("img", { name: "Bob Brown: Availability unknown" })).toBeInTheDocument();
        expect(screen.getByRole("img", { name: "Cy: Hides their calendar" })).toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveTextContent("No conflicts found · 2 people's availability is unknown");
        expect(screen.queryByText(/Everyone is free/)).not.toBeInTheDocument();
        // Only you are known, so the suggestions rest on you alone - and say who they leave out.
        expect(screen.getByText("Suggestions leave out 2 people whose calendars can’t be seen.")).toBeInTheDocument();
    });

    it("says so in the singular for one person it cannot see", async () => {
        answer({ "bob@example.com": { status: "restricted" } });
        render(<FindATime c={controller()} />);
        await settle();
        expect(screen.getByRole("status")).toHaveTextContent("No conflicts found · 1 person's availability is unknown");
        expect(screen.getByText("Suggestions leave out 1 person whose calendar can’t be seen.")).toBeInTheDocument();
    });

    it("scrolls the working day into view, and the event's own start when that is outside it", async () => {
        answer();
        const { unmount } = render(<FindATime c={controller()} />);
        await settle();
        expect((screen.getByRole("group", { name: "Guests' availability" })).scrollLeft).toBe(8 * 52);
        unmount();

        render(<FindATime c={controller({ start: "2026-06-10T20:00", end: "2026-06-10T21:00" })} />);
        await settle();
        expect((screen.getByRole("group", { name: "Guests' availability" })).scrollLeft).toBe(19 * 52);
    });

    it("leaves the proposed time off a day it is not on, and says to pick one within the week", async () => {
        answer();
        render(<FindATime c={controller()} />);
        await settle();
        for (let i = 0; i < 8; i++) {
            fireEvent.click(screen.getByRole("button", { name: "Next day" }));
        }
        await settle();
        expect(document.querySelector("[data-proposed-time]")).toBeNull();
        expect(screen.getByRole("status")).toHaveTextContent("Pick a time within this week to see who is free.");
        // Their calendars were read, so they are not "Checking…", but there is nothing to say about a time not on these days.
        expect(screen.queryByText("Checking…")).not.toBeInTheDocument();
        expect(screen.queryByText("Free")).not.toBeInTheDocument();
    });

    it("asks for a start and an end time when the form's are not a span", async () => {
        answer();
        render(<FindATime c={controller({ start: "2026-06-10T10:00", end: "2026-06-10T09:00" })} />);
        await settle();
        expect(document.querySelector("[data-proposed-time]")).toBeNull();
        expect(screen.getByRole("status")).toHaveTextContent("Set a start and an end time to see who is free.");
        expect(screen.queryByText("Suggested times")).not.toBeInTheDocument();
    });

    it("draws a block that began on an earlier day from the start of this one, and none for a block on another day", async () => {
        answer({
            "jane@example.com": {
                busy: [busy("2026-06-09T22:00:00Z", "2026-06-10T01:00:00Z"), busy("2026-06-12T09:00:00Z", "2026-06-12T10:00:00Z")],
            },
        });
        render(<FindATime c={controller()} />);
        await settle();
        const blocks = Array.from(document.querySelectorAll<HTMLElement>("[data-busy]"));
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toHaveStyle({ left: "0px", width: "52px" });
        expect(screen.getByRole("img", { name: "You: Busy 10:00pm to 1:00am" })).toBeInTheDocument();
    });

    it("does not count the event's own time on the calendars of the people already invited as a conflict", async () => {
        answer({
            "jane@example.com": { busy: [busy("2026-06-10T09:00:00Z", "2026-06-10T10:00:00Z")] },
            "bob@example.com": { busy: [busy("2026-06-10T09:00:00Z", "2026-06-10T10:00:00Z")] },
            "cy@example.com": { busy: [busy("2026-06-10T09:00:00Z", "2026-06-10T10:00:00Z")] },
        });
        const occurrence = {
            organizer: { address: "jane@example.com", type: "to" },
            attendees: [guest("bob@example.com")],
            startDate: "2026-06-10T09:00:00.000Z",
            endDate: "2026-06-10T10:00:00.000Z",
            allDay: false,
        } as unknown as CalendarOccurrence;
        render(<FindATime c={controller({ attendees: [guest("bob@example.com"), guest("cy@example.com")] }, { occurrence })} />);
        await settle();
        // Cy was added just now and has a real meeting at that time.
        expect(screen.getByRole("status")).toHaveTextContent("1 conflict");
        expect(screen.getByText("Busy at this time")).toBeInTheDocument();
    });

    it("does the same for an all-day event's occurrence without hiding anything", async () => {
        answer({ "jane@example.com": { busy: [busy("2026-06-10T09:00:00Z", "2026-06-10T10:00:00Z")] } });
        const occurrence = { organizer: { address: "jane@example.com", type: "to" }, attendees: [], startDate: "2026-06-10T00:00:00.000Z", endDate: "2026-06-11T00:00:00.000Z", allDay: true } as unknown as CalendarOccurrence;
        render(<FindATime c={controller({}, { occurrence })} />);
        await settle();
        expect(screen.getByRole("status")).toHaveTextContent("1 conflict");
    });
});

describe("FindATime choosing a time", () => {
    it("moves the start to an hour of the day with its header cell", async () => {
        answer();
        const c = controller();
        render(<FindATime c={c} />);
        await settle();

        fireEvent.click(screen.getByRole("button", { name: "Start at 2pm" }));
        expect(c.setStart).toHaveBeenLastCalledWith("2026-06-10T14:00");
        fireEvent.click(screen.getByRole("button", { name: "Start at 12am" }));
        expect(c.setStart).toHaveBeenLastCalledWith("2026-06-10T00:00");
    });

    it("moves the start to the half hour that was pressed in a row, and ignores a press it cannot place", async () => {
        answer();
        const c = controller();
        render(<FindATime c={c} />);
        await settle();
        const row = screen.getByRole("img", { name: "You: Free all day." });

        // The timeline is 1248px wide (24 hours of 52px): a press 10.6 hours across is 10:30.
        vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ left: 100, width: 1248, top: 0, right: 1348, bottom: 44, height: 44, x: 100, y: 0, toJSON: () => ({}) });
        fireEvent.click(row, { clientX: 100 + 10.6 * 52 });
        expect(c.setStart).toHaveBeenLastCalledWith("2026-06-10T10:30");
        fireEvent.click(row, { clientX: 0 });
        expect(c.setStart).toHaveBeenLastCalledWith("2026-06-10T00:00");
        fireEvent.click(row, { clientX: 5000 });
        expect(c.setStart).toHaveBeenLastCalledWith("2026-06-10T23:30");

        // No layout (an unmeasured row): nothing to place it by.
        vi.mocked(c.setStart).mockClear();
        vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ left: 0, width: 0, top: 0, right: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
        fireEvent.click(row, { clientX: 50 });
        expect(c.setStart).not.toHaveBeenCalled();
    });

    it("suggests the next times everyone who can be seen is free, and sets the start when one is chosen", async () => {
        answer({
            "jane@example.com": { busy: [busy("2026-06-10T08:00:00Z", "2026-06-10T11:00:00Z")] },
            "bob@example.com": { busy: [busy("2026-06-10T11:00:00Z", "2026-06-10T13:00:00Z", true)] },
        });
        const c = controller();
        render(<FindATime c={c} />);
        await settle();

        const suggestions = within(screen.getByRole("region", { name: "Suggested times" })).getAllByRole("button");
        expect(suggestions).toHaveLength(5);
        // 13:00 is the first the hour-long event fits in, 30 minutes apart.
        expect(suggestions[0]).toHaveTextContent(/June 10\s+1:00pm – 2:00pm/);
        expect(suggestions[1]).toHaveTextContent(/June 10\s+1:30pm – 2:30pm/);

        fireEvent.click(suggestions[0]);
        expect(c.setStart).toHaveBeenCalledWith("2026-06-10T13:00");
    });

    it("says when no time in the week suits everybody, and when there is nobody to check", async () => {
        answer({ "jane@example.com": { busy: [busy("2026-06-10T00:00:00Z", "2026-06-17T00:00:00Z")] } });
        const { unmount } = render(<FindATime c={controller()} />);
        await settle();
        expect(screen.getByText("No time this week has everyone free between 8am and 6pm.")).toBeInTheDocument();
        unmount();

        // Nobody can be checked - not even yourself, as if the server did not know your own mailbox.
        answer({ "jane@example.com": { status: "unknown" }, "bob@example.com": { status: "restricted" } });
        render(<FindATime c={controller()} />);
        await settle();
        expect(screen.getByText("There is no calendar to check, so no time can be suggested.")).toBeInTheDocument();
    });

    it("suggests nothing that starts before now", async () => {
        vi.setSystemTime(new Date("2026-06-10T09:30:00Z"));
        answer();
        render(<FindATime c={controller({ start: "2026-06-10T09:00", end: "2026-06-10T09:30" })} />);
        await settle();
        const suggestions = within(screen.getByRole("region", { name: "Suggested times" })).getAllByRole("button");
        // 9:30am is over by the time the look-up has been made (the pause counts), and 9:00am long before.
        expect(suggestions[0]).toHaveTextContent(/June 10\s+10:00am – 10:30am/);
    });
});
