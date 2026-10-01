// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ListView, { LIST_DAYS_PER_PAGE, LIST_INITIAL_DAYS, ListViewProps } from "../../../apps/shared/components/calendar/ListView.js";
import { ActiveOccurrenceContext, occurrenceMarker } from "../../../apps/shared/components/calendar/activeOccurrence.js";
import { CalendarOccurrence } from "../../../lib/calendar/recurrence.js";

// Every row's render calls `occurrenceMarker`, so its calls count the rows rendered.
vi.mock("../../../apps/shared/components/calendar/activeOccurrence.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../apps/shared/components/calendar/activeOccurrence.js")>();
    return { ...actual, occurrenceMarker: vi.fn(actual.occurrenceMarker) };
});

function occurrence(key: string, overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
    return {
        uid: key,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        title: `Event ${key}`,
        startDate: new Date(2026, 5, 15, 10).toISOString(),
        endDate: new Date(2026, 5, 15, 11).toISOString(),
        allDay: false,
        timezone: "UTC",
        organizer: { address: "jane@example.com", type: "to" },
        attendees: [],
        status: "confirmed",
        busyStatus: "busy",
        icalUid: key,
        sequence: 0,
        occurrenceKey: key,
        isRecurringOccurrence: false,
        ...overrides,
    };
}

/** One event on each of `count` days from the 15th of June 2026, keyed `d0`, `d1`, ... */
function daily(count: number): CalendarOccurrence[] {
    return Array.from({ length: count }, (_, index) =>
        occurrence(`d${index}`, { startDate: new Date(2026, 5, 15 + index, 10).toISOString(), endDate: new Date(2026, 5, 15 + index, 11).toISOString() }),
    );
}

const noop = () => undefined;
const props = (overrides: Partial<ListViewProps> = {}): ListViewProps => ({
    occurrences: [],
    folderColors: {},
    onSelectEvent: noop,
    focusDate: new Date(2026, 5, 15),
    jumpNonce: 0,
    step: null,
    ...overrides,
});

const sections = () => Array.from(screen.getByRole("region", { name: "List" }).querySelectorAll<HTMLElement>("section")).map((el) => el.dataset.day);

// jsdom has no IntersectionObserver: a stand-in that keeps every observer so a test can say the sentinel came into view.
let observers: { callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] = [];
function stubIntersectionObserver() {
    observers = [];
    vi.stubGlobal(
        "IntersectionObserver",
        vi.fn().mockImplementation(function (callback: IntersectionObserverCallback) {
            const observer = { callback, observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
            observers.push(observer);
            return observer;
        }),
    );
}
/** The sentinel comes into view (or, with `false`, is out of it). */
function scrollToEnd(isIntersecting = true) {
    act(() => observers[observers.length - 1].callback([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver));
}

let scrolled: HTMLElement[] = [];
beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15, 9));
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: HTMLElement) {
        scrolled.push(this);
    };
    vi.mocked(occurrenceMarker).mockClear();
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("ListView days of a long event", () => {
    it("lists an event that began more than a year ago and is still running, from today on", () => {
        const block = occurrence("block", { title: "Sabbatical", allDay: true, startDate: "2024-01-01T00:00:00.000Z", endDate: "2028-01-01T00:00:00.000Z" });
        // No IntersectionObserver to say the end was reached: every day is rendered.
        vi.stubGlobal("IntersectionObserver", undefined);
        render(<ListView {...props({ occurrences: [block] })} />);

        expect(sections()[0]).toBe("2026-06-15");
        // Counted from today, not from the day it began.
        expect(screen.getAllByText("Sabbatical")).toHaveLength(366);
    });

    it("lists a date-only event whose end is not after its start on its first day", () => {
        const odd = occurrence("odd", { title: "Odd one", allDay: true, startDate: "2026-06-17T00:00:00.000Z", endDate: "2026-06-17T00:00:00.000Z" });
        render(<ListView {...props({ occurrences: [odd] })} />);

        expect(sections()).toEqual(["2026-06-17"]);
    });

    it("still leaves out an event that is over", () => {
        const over = occurrence("over", { allDay: true, startDate: "2024-01-01T00:00:00.000Z", endDate: "2025-01-01T00:00:00.000Z" });
        const overTimed = occurrence("overTimed", { startDate: new Date(2026, 5, 10, 9).toISOString(), endDate: new Date(2026, 5, 10, 10).toISOString() });
        render(<ListView {...props({ occurrences: [over, overTimed] })} />);

        expect(screen.getByText("No upcoming events")).toBeInTheDocument();
    });
});

describe("ListView at midnight", () => {
    it("drops yesterday's events and moves the Today marker when the page is open past midnight, without the events changing", () => {
        vi.useRealTimers();
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 5, 15, 23, 59, 30));
        render(<ListView {...props({ occurrences: daily(2) })} />);
        expect(sections()).toEqual(["2026-06-15", "2026-06-16"]);

        act(() => void vi.advanceTimersByTime(60_000));
        expect(sections()).toEqual(["2026-06-16"]);
        expect(screen.getByRole("heading", { name: /June 16/ })).toHaveAttribute("aria-current", "date");
    });
});

describe("ListView windowing", () => {
    beforeEach(stubIntersectionObserver);

    it("renders the first days only, and the next ones as the end of the list comes into view", () => {
        render(<ListView {...props({ occurrences: daily(150) })} />);
        expect(sections()).toHaveLength(LIST_INITIAL_DAYS);
        expect(sections()[0]).toBe("2026-06-15");

        // Out of view: nothing more.
        scrollToEnd(false);
        expect(sections()).toHaveLength(LIST_INITIAL_DAYS);
        scrollToEnd();
        expect(sections()).toHaveLength(LIST_INITIAL_DAYS + LIST_DAYS_PER_PAGE);
        scrollToEnd();
        expect(sections()).toHaveLength(150);
        // Nothing is left to wait for.
        expect(screen.getByRole("region", { name: "List" }).querySelector("[data-list-end]")).toBeNull();
    });

    it("renders a short list whole, with nothing to observe", () => {
        render(<ListView {...props({ occurrences: daily(5) })} />);
        expect(sections()).toHaveLength(5);
        expect(observers).toHaveLength(0);
    });

    it("stops observing when it unmounts", () => {
        const { unmount } = render(<ListView {...props({ occurrences: daily(150) })} />);
        const first = observers[0];
        unmount();
        expect(first.disconnect).toHaveBeenCalled();
    });

    it("reaches a day beyond the window when a jump (Today, the mini calendar) asks for it", () => {
        const { rerender } = render(<ListView {...props({ occurrences: daily(200) })} />);
        scrolled = [];
        rerender(<ListView {...props({ occurrences: daily(200), focusDate: new Date(2026, 5, 15 + 150), jumpNonce: 1 })} />);

        expect(sections()).toContain("2026-11-12");
        expect(scrolled.map((el) => el.dataset.day)).toEqual(["2026-11-12"]);
    });

    it("scrolls to the last day, however far, when the day asked for is after every event", () => {
        const { rerender } = render(<ListView {...props({ occurrences: daily(200) })} />);
        scrolled = [];
        rerender(<ListView {...props({ occurrences: daily(200), focusDate: new Date(2030, 0, 1), jumpNonce: 1 })} />);

        expect(scrolled.map((el) => el.dataset.day)).toEqual(["2026-12-31"]);
    });

    it("reaches the match a search is on when it is beyond the window", () => {
        const { rerender } = render(
            <ActiveOccurrenceContext.Provider value={null}>
                <ListView {...props({ occurrences: daily(200) })} />
            </ActiveOccurrenceContext.Provider>,
        );
        scrolled = [];
        rerender(
            <ActiveOccurrenceContext.Provider value="d120">
                <ListView {...props({ occurrences: daily(200) })} />
            </ActiveOccurrenceContext.Provider>,
        );

        expect(sections()).toContain("2026-10-13");
        expect(scrolled).toHaveLength(1);
        expect(scrolled[0].dataset.occurrenceKey).toBe("d120");
        expect(scrolled[0]).toHaveAttribute("data-active-match", "true");
    });

    it("leaves the window alone for a match already in it, or one that is not listed", () => {
        const { rerender } = render(
            <ActiveOccurrenceContext.Provider value={null}>
                <ListView {...props({ occurrences: daily(200) })} />
            </ActiveOccurrenceContext.Provider>,
        );
        for (const key of ["d3", "not-listed"]) {
            rerender(
                <ActiveOccurrenceContext.Provider value={key}>
                    <ListView {...props({ occurrences: daily(200) })} />
                </ActiveOccurrenceContext.Provider>,
            );
        }
        expect(sections()).toHaveLength(LIST_INITIAL_DAYS);
    });

    it("steps to the first day of a month that lies beyond the rendered days", () => {
        const events = [...daily(60), occurrence("far", { startDate: new Date(2026, 11, 3, 10).toISOString(), endDate: new Date(2026, 11, 3, 11).toISOString() })];
        const { rerender } = render(<ListView {...props({ occurrences: events })} />);
        expect(sections()).toHaveLength(LIST_INITIAL_DAYS);
        scrolled = [];
        // jsdom lays nothing out, so the day at the top is the last one rendered (August 13): the next month with events is December, past the window.
        rerender(<ListView {...props({ occurrences: events, step: { direction: 1, nonce: 1 } })} />);

        expect(sections()).toContain("2026-12-03");
        expect(scrolled.map((el) => el.dataset.day)).toEqual(["2026-12-03"]);
    });
});

describe("ListView renders", () => {
    beforeEach(stubIntersectionObserver);

    it("only the rows whose own props changed: a new active match renders two rows, not every one", () => {
        const events = daily(30);
        const { rerender } = render(
            <ActiveOccurrenceContext.Provider value="d1">
                <ListView {...props({ occurrences: events })} />
            </ActiveOccurrenceContext.Provider>,
        );
        expect(vi.mocked(occurrenceMarker)).toHaveBeenCalledTimes(30);
        vi.mocked(occurrenceMarker).mockClear();

        rerender(
            <ActiveOccurrenceContext.Provider value="d2">
                <ListView {...props({ occurrences: events })} />
            </ActiveOccurrenceContext.Provider>,
        );
        expect(vi.mocked(occurrenceMarker)).toHaveBeenCalledTimes(2);
    });

    it("none of the rows when a parent renders again with the same list (a keystroke in the search box)", () => {
        const events = daily(30);
        const colors = {};
        const select = () => undefined;
        const focusDate = new Date(2026, 5, 15);
        const { rerender } = render(<ListView {...props({ occurrences: events, folderColors: colors, onSelectEvent: select, focusDate })} />);
        vi.mocked(occurrenceMarker).mockClear();

        rerender(<ListView {...props({ occurrences: events, folderColors: colors, onSelectEvent: select, focusDate })} />);
        expect(vi.mocked(occurrenceMarker)).not.toHaveBeenCalled();
    });
});
