// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { DndContext, useSensors } from "@dnd-kit/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CalendarSearchBox, { CalendarSearchBoxProps, searchStatusText } from "../../../apps/shared/components/calendar/CalendarSearchBox.js";
import EventMatchNav from "../../../apps/shared/components/calendar/EventMatchNav.js";
import { ActiveOccurrenceContext, occurrenceMarker } from "../../../apps/shared/components/calendar/activeOccurrence.js";
import { occurrenceDay } from "../../../apps/shared/components/calendar/allDay.js";
import MonthView from "../../../apps/shared/components/calendar/MonthView.js";
import SplitDayView from "../../../apps/shared/components/calendar/SplitDayView.js";
import TimeGridView from "../../../apps/shared/components/calendar/TimeGridView.js";
import { CalendarOccurrence } from "../../../lib/calendar/recurrence.js";

function occurrence(overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
    return {
        uid: "e1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        title: "Standup",
        startDate: "2026-06-10T15:00:00.000Z",
        endDate: "2026-06-10T15:30:00.000Z",
        allDay: false,
        timezone: "UTC",
        organizer: { address: "jane@example.com", type: "to" },
        attendees: [],
        status: "confirmed",
        busyStatus: "busy",
        icalUid: "abc",
        sequence: 0,
        occurrenceKey: "e1",
        isRecurringOccurrence: false,
        ...overrides,
    };
}

function Dnd({ children }: { children: React.ReactNode }) {
    return (
        <DndContext sensors={useSensors()} onDragEnd={() => undefined}>
            {children}
        </DndContext>
    );
}

function props(overrides: Partial<CalendarSearchBoxProps> = {}): CalendarSearchBoxProps {
    return {
        value: "",
        onChange: vi.fn(),
        onSubmit: vi.fn(),
        onClear: vi.fn(),
        onPrevious: vi.fn(),
        onNext: vi.fn(),
        active: false,
        count: 0,
        position: -1,
        ...overrides,
    };
}

describe("searchStatusText", () => {
    it("names no matches, the count, or the place among them", () => {
        expect(searchStatusText(0, -1)).toBe("No matches");
        expect(searchStatusText(1, -1)).toBe("1 result");
        expect(searchStatusText(4, -1)).toBe("4 results");
        expect(searchStatusText(4, 1)).toBe("2 of 4");
    });
});

describe("CalendarSearchBox", () => {
    it("shows just the input while idle, and reports typing, Enter, Shift+Enter and Escape", () => {
        const p = props();
        render(<CalendarSearchBox {...p} />);
        expect(screen.queryByRole("button")).not.toBeInTheDocument();

        const input = screen.getByRole("textbox", { name: "Search events" });
        fireEvent.change(input, { target: { value: "abc" } });
        expect(p.onChange).toHaveBeenCalledWith("abc");
        fireEvent.keyDown(input, { key: "Enter" });
        expect(p.onSubmit).toHaveBeenLastCalledWith(false);
        fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
        expect(p.onSubmit).toHaveBeenLastCalledWith(true);
        fireEvent.keyDown(input, { key: "Escape" });
        expect(p.onClear).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(input, { key: "a" });
        expect(p.onSubmit).toHaveBeenCalledTimes(2);
        expect(p.onClear).toHaveBeenCalledTimes(1);
    });

    it("offers clear, the count and Previous/Next match while searching, announcing the count", () => {
        const p = props({ value: "abc", active: true, count: 5, position: 2 });
        render(<CalendarSearchBox {...p} />);

        expect(screen.getByRole("status")).toHaveTextContent("3 of 5");
        fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
        fireEvent.click(screen.getByRole("button", { name: "Next match" }));
        fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
        expect(p.onPrevious).toHaveBeenCalledTimes(1);
        expect(p.onNext).toHaveBeenCalledTimes(1);
        expect(p.onClear).toHaveBeenCalledTimes(1);
    });

    it("disables stepping and says so when nothing matches", () => {
        render(<CalendarSearchBox {...props({ value: "zzz", active: true, count: 0 })} />);
        expect(screen.getByRole("status")).toHaveTextContent("No matches");
        expect(screen.getByRole("button", { name: "Previous match" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
    });
});

describe("occurrenceMarker", () => {
    it("names the occurrence and rings it only when it is the active one", () => {
        const o = occurrence();
        expect(occurrenceMarker(null, o)).toEqual({ attrs: { "data-occurrence-key": "e1" }, className: "" });
        const active = occurrenceMarker("e1", o);
        expect(active.attrs).toEqual({ "data-occurrence-key": "e1", "data-active-match": "true" });
        expect(active.className).toContain("ring-2");
    });
});

describe("occurrenceDay", () => {
    it("is the local day a timed event starts on and the stated date of an all-day one", () => {
        const timed = occurrence({ startDate: "2026-06-10T15:00:00.000Z" });
        expect(occurrenceDay(timed)).toEqual(new Date(new Date(timed.startDate).getFullYear(), new Date(timed.startDate).getMonth(), new Date(timed.startDate).getDate()));
        expect(occurrenceDay(occurrence({ allDay: true, startDate: "2026-06-10T00:00:00.000Z", endDate: "2026-06-11T00:00:00.000Z" }))).toEqual(new Date(2026, 5, 10));
    });
});

describe("the views mark the active search result", () => {
    const colors = { f1: "#123456" };
    const none = () => undefined;

    it("Month view marks a chip and a continuation chip, and keeps the active one out of '+N more'", () => {
        const day = (n: number) => `2026-06-${String(n).padStart(2, "0")}T`;
        const busy = [1, 2, 3, 4].map((n) =>
            occurrence({ uid: `b${n}`, occurrenceKey: `b${n}`, title: `Busy ${n}`, startDate: `${day(10)}0${n + 5}:00:00.000Z`, endDate: `${day(10)}0${n + 5}:30:00.000Z` }),
        );
        const span = occurrence({ uid: "span", occurrenceKey: "span", title: "Span", startDate: `${day(20)}10:00:00.000Z`, endDate: `${day(22)}10:00:00.000Z` });
        const { rerender } = render(
            <Dnd>
                <ActiveOccurrenceContext.Provider value="b4">
                    <MonthView viewDate={new Date(2026, 5, 15)} occurrences={busy} folderColors={colors} onSelectDay={none} onSelectEvent={none} />
                </ActiveOccurrenceContext.Provider>
            </Dnd>,
        );
        const marked = document.querySelector('[data-active-match="true"]')!;
        expect(marked).toHaveTextContent("Busy 4");
        expect(screen.queryByText(/Busy 3/)).not.toBeInTheDocument();
        expect(screen.getByText("+1 more")).toBeInTheDocument();

        rerender(
            <Dnd>
                <ActiveOccurrenceContext.Provider value="span">
                    <MonthView viewDate={new Date(2026, 5, 15)} occurrences={[span]} folderColors={colors} onSelectDay={none} onSelectEvent={none} />
                </ActiveOccurrenceContext.Provider>
            </Dnd>,
        );
        expect(document.querySelectorAll('[data-active-match="true"]').length).toBeGreaterThan(1);
    });

    it("Week view marks all-day, timed and continuation items", () => {
        const days = [new Date(2026, 5, 9), new Date(2026, 5, 10)];
        const allDay = occurrence({ uid: "ad", occurrenceKey: "ad", title: "Holiday", allDay: true, startDate: "2026-06-10T00:00:00.000Z", endDate: "2026-06-11T00:00:00.000Z" });
        const timed = occurrence({ uid: "t", occurrenceKey: "t", title: "Timed", startDate: new Date(2026, 5, 9, 10).toISOString(), endDate: new Date(2026, 5, 10, 11).toISOString() });
        render(
            <Dnd>
                <ActiveOccurrenceContext.Provider value="t">
                    <TimeGridView days={days} occurrences={[allDay, timed]} folderColors={colors} onSelectEvent={none} onSelectSlot={none} />
                </ActiveOccurrenceContext.Provider>
            </Dnd>,
        );
        // The start block and the continuation block on the second day share the key.
        expect(document.querySelectorAll('[data-active-match="true"]')).toHaveLength(2);
        expect(document.querySelector('[data-occurrence-key="ad"]')).not.toHaveAttribute("data-active-match");

        render(
            <Dnd>
                <ActiveOccurrenceContext.Provider value="ad">
                    <TimeGridView days={days} occurrences={[allDay]} folderColors={colors} onSelectEvent={none} onSelectSlot={none} />
                </ActiveOccurrenceContext.Provider>
            </Dnd>,
        );
        expect(document.querySelectorAll('[data-occurrence-key="ad"][data-active-match="true"]')).toHaveLength(1);
    });

    it("Split view marks the active block", () => {
        render(
            <ActiveOccurrenceContext.Provider value="e1">
                <SplitDayView
                    day={new Date(2026, 5, 10)}
                    columns={[{ folderUid: "f1", name: "Calendar", color: "#123456" }]}
                    occurrences={[occurrence({ startDate: new Date(2026, 5, 10, 9).toISOString(), endDate: new Date(2026, 5, 10, 10).toISOString() })]}
                    onSelectEvent={none}
                    onSelectSlot={none}
                />
            </ActiveOccurrenceContext.Provider>,
        );
        expect(document.querySelector('[data-occurrence-key="e1"]')).toHaveAttribute("data-active-match", "true");
    });
});

describe("EventMatchNav", () => {
    it("steps with its buttons and the bare arrow keys, leaving the keys to fields and to modified presses", () => {
        const onPrevious = vi.fn();
        const onNext = vi.fn();
        render(
            <>
                <input aria-label="field" />
                <EventMatchNav onPrevious={onPrevious} onNext={onNext} />
            </>,
        );
        fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
        fireEvent.click(screen.getByRole("button", { name: "Next match" }));
        expect(onPrevious).toHaveBeenCalledTimes(1);
        expect(onNext).toHaveBeenCalledTimes(1);

        fireEvent.keyDown(document.body, { key: "ArrowLeft" });
        fireEvent.keyDown(document.body, { key: "ArrowRight" });
        expect(onPrevious).toHaveBeenCalledTimes(2);
        expect(onNext).toHaveBeenCalledTimes(2);

        fireEvent.keyDown(screen.getByLabelText("field"), { key: "ArrowLeft" });
        fireEvent.keyDown(document.body, { key: "ArrowLeft", altKey: true });
        fireEvent.keyDown(document.body, { key: "ArrowLeft", shiftKey: true });
        fireEvent.keyDown(document.body, { key: "ArrowUp" });
        expect(onPrevious).toHaveBeenCalledTimes(2);
    });
});
