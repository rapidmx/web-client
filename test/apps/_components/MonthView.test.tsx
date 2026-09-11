// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { DndContext, useSensors } from "@dnd-kit/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { eachDayOfInterval, endOfMonth, endOfWeek, format, isSameMonth, startOfMonth, startOfWeek } from "date-fns";
import { describe, expect, it, vi } from "vitest";
import MonthView from "../../../apps/shared/components/calendar/MonthView.js";
import { CalendarOccurrence } from "@rapidmx/react-shared/recurrence.js";

const VIEW_DATE = new Date("2026-06-15T00:00:00.000Z");

// Mirrors MonthView's own grid math exactly (`date-fns` resolves month/week boundaries in the local
// timezone, not UTC — the exact day count for a given month is timezone-dependent, e.g. 5 vs. 6 weeks
// depending on which local weekday the 1st falls on), so these tests stay correct in any timezone
// rather than assuming a hardcoded day count/layout for June 2026 specifically.
const EXPECTED_GRID_DAYS = eachDayOfInterval({
    start: startOfWeek(startOfMonth(VIEW_DATE), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(VIEW_DATE), { weekStartsOn: 1 }),
});

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

/** No sensors registered: these tests exercise plain click handlers, not real drag gestures (which
 * `@dnd-kit`'s default `PointerSensor` can't reliably do under jsdom anyway — it depends on pointer-
 * capture APIs jsdom doesn't implement) — an ancestor `DndContext` is still required simply because
 * `MonthView`'s `useDraggable`/`useDroppable` calls throw without one. */
function TestDndContext({ children }: { children: React.ReactNode }) {
    const sensors = useSensors();
    return (
        <DndContext sensors={sensors} onDragEnd={() => undefined}>
            {children}
        </DndContext>
    );
}

function renderMonth(props: Partial<React.ComponentProps<typeof MonthView>> = {}) {
    return render(
        <TestDndContext>
            <MonthView
                viewDate={VIEW_DATE}
                occurrences={[]}
                folderColors={{ f1: "#2563eb" }}
                onSelectDay={vi.fn()}
                onSelectEvent={vi.fn()}
                {...props}
            />
        </TestDndContext>,
    );
}

describe("MonthView", () => {
    it("renders one day-number button per cell of the month's full-week grid", () => {
        renderMonth();
        const grid = screen.getByRole("grid", { name: "Month" });
        expect(within(grid).getAllByRole("button")).toHaveLength(EXPECTED_GRID_DAYS.length);
    });

    it("calling onSelectDay when a day number is clicked", async () => {
        const onSelectDay = vi.fn();
        const user = userEvent.setup();
        renderMonth({ onSelectDay });

        await user.click(screen.getByText("15"));

        expect(onSelectDay).toHaveBeenCalledTimes(1);
        const calledWith: Date = onSelectDay.mock.calls[0][0];
        expect(calledWith.toISOString().slice(0, 10)).toBe("2026-06-15");
    });

    it("places an event chip on its start day and shows the time for a timed event", () => {
        renderMonth({ occurrences: [occurrence()] });
        // 2026-06-10T15:00:00.000Z falls on June 10 in UTC.
        expect(screen.getByRole("button", { name: /Standup/ }).textContent).toContain("Standup");
        expect(screen.getByRole("button", { name: /Standup/ }).textContent).toMatch(/\d{1,2}:\d{2}[AP]M/);
    });

    it("omits the time prefix for an all-day event", () => {
        renderMonth({ occurrences: [occurrence({ allDay: true, title: "Holiday" })] });
        expect(screen.getByRole("button", { name: "Holiday" }).textContent).toBe("Holiday");
    });

    it("styles a 'free' busy-status chip differently from a 'busy' one", () => {
        renderMonth({
            folderColors: { f1: "#2563eb" },
            occurrences: [
                occurrence({ occurrenceKey: "e1", uid: "e1", title: "Busy Thing", busyStatus: "busy" }),
                occurrence({ occurrenceKey: "e2", uid: "e2", title: "Free Thing", busyStatus: "free" }),
            ],
        });
        expect(screen.getByRole("button", { name: /Busy Thing/ }).style.backgroundColor).toBe("rgb(37, 99, 235)");
        expect(screen.getByRole("button", { name: /Free Thing/ }).className).toContain("bg-surface-alt");
        expect(screen.getByRole("button", { name: /Free Thing/ }).style.backgroundColor).toBe("");
    });

    it("calls onSelectEvent when an event chip is clicked", async () => {
        const onSelectEvent = vi.fn();
        const occ = occurrence();
        const user = userEvent.setup();
        renderMonth({ occurrences: [occ], onSelectEvent });

        await user.click(screen.getByRole("button", { name: /Standup/ }));

        expect(onSelectEvent).toHaveBeenCalledWith(occ);
    });

    it("shows only the first 3 events per day plus a '+N more' link for the rest, which also selects the day", async () => {
        const onSelectDay = vi.fn();
        const events = Array.from({ length: 5 }, (_, i) =>
            occurrence({ occurrenceKey: `e${i}`, uid: `e${i}`, title: `Event ${i}`, allDay: true }),
        );
        const user = userEvent.setup();
        renderMonth({ occurrences: events, onSelectDay });

        expect(screen.getByText("Event 0")).toBeInTheDocument();
        expect(screen.getByText("Event 2")).toBeInTheDocument();
        expect(screen.queryByText("Event 3")).not.toBeInTheDocument();
        const more = screen.getByText("+2 more");
        expect(more).toBeInTheDocument();

        await user.click(more);
        expect(onSelectDay).toHaveBeenCalledTimes(1);
    });

    it("marks days outside the current month distinctly from days within it", () => {
        renderMonth();
        const grid = screen.getByRole("grid", { name: "Month" });
        const dayButtons = within(grid).getAllByRole("button");
        // Day-number *text* alone is ambiguous across the (up to three) months a month grid can span, so
        // this checks each cell's styling by position, against the same date-fns-computed day list the
        // component itself renders from.
        EXPECTED_GRID_DAYS.forEach((day, i) => {
            expect(dayButtons[i].textContent).toBe(format(day, "d"));
            const expectMuted = !isSameMonth(day, VIEW_DATE);
            expect(dayButtons[i].closest("div")!.className.includes("bg-surface-alt")).toBe(expectMuted);
        });
        // Sanity check the fixture itself actually spans more than one month (i.e. this test would catch
        // a real regression, not vacuously pass because every day happened to be in-month).
        expect(EXPECTED_GRID_DAYS.some((day) => !isSameMonth(day, VIEW_DATE))).toBe(true);
    });
});
