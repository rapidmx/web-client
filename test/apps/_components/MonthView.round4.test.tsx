// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { DndContext, useSensors } from "@dnd-kit/core";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MonthView from "../../../apps/shared/components/calendar/MonthView.js";
import { CalendarEvent } from "@rapidmx/react-shared/calendar/calendarApi.js";
import { dayDropId, eventDragId, resolveDragAction } from "@rapidmx/react-shared/calendar/calendarDragIds.js";
import { expandAllOccurrences } from "@rapidmx/react-shared/calendar/recurrence.js";

// Round-4: all-day recurrences (weekly/monthly) and all-day drags in the month grid, viewed west of UTC
// (America/New_York, UTC-4/-5) - react-shared now expands all-day series in UTC and drags them by UTC date.

function allDayEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
        uid: "e1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        title: "Gym",
        startDate: "2026-09-14T00:00:00.000Z",
        endDate: "2026-09-15T00:00:00.000Z",
        allDay: true,
        timezone: "America/New_York",
        organizer: { address: "jane@example.com", type: "to" },
        attendees: [],
        status: "confirmed",
        busyStatus: "busy",
        icalUid: "abc",
        sequence: 0,
        ...overrides,
    };
}

function TestDndContext({ children }: { children: React.ReactNode }) {
    const sensors = useSensors();
    return (
        <DndContext sensors={sensors} onDragEnd={() => undefined}>
            {children}
        </DndContext>
    );
}

/** The first day cell whose day-number button reads `dayNumber` (the grid runs Aug 31 - Oct 4, so "1" is Sep 1). */
function dayCell(dayNumber: string): HTMLElement {
    return screen.getAllByRole("button", { name: dayNumber })[0].parentElement!;
}

const originalTz = process.env.TZ;

beforeEach(() => {
    process.env.TZ = "America/New_York";
});

afterEach(() => {
    process.env.TZ = originalTz;
});

describe("MonthView all-day events west of UTC (round 4)", () => {
    const viewDate = new Date(2026, 8, 15);
    const gridStart = new Date(2026, 7, 31);
    const gridEnd = new Date(2026, 9, 5);

    it("shows a weekly all-day series on its Mondays and a monthly one on the 1st - never the day before", () => {
        const occurrences = expandAllOccurrences(
            [
                allDayEvent({ recurrenceRule: { freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] } }),
                allDayEvent({
                    uid: "e2",
                    title: "Rent",
                    startDate: "2026-09-01T00:00:00.000Z",
                    endDate: "2026-09-02T00:00:00.000Z",
                    recurrenceRule: { freq: "monthly", interval: 1, exceptions: [] },
                }),
            ],
            gridStart,
            gridEnd,
        );
        render(
            <TestDndContext>
                <MonthView viewDate={viewDate} occurrences={occurrences} folderColors={{ f1: "#123456" }} onSelectDay={vi.fn()} onSelectEvent={vi.fn()} />
            </TestDndContext>,
        );

        for (const monday of ["14", "21", "28"]) {
            expect(within(dayCell(monday)).getByRole("button", { name: "Gym" })).toBeInTheDocument();
        }
        for (const sunday of ["13", "20", "27"]) {
            expect(within(dayCell(sunday)).queryByRole("button", { name: "Gym" })).not.toBeInTheDocument();
        }
        expect(within(dayCell("1")).getByRole("button", { name: "Rent" })).toBeInTheDocument();
        expect(within(dayCell("31")).queryByRole("button", { name: "Rent" })).not.toBeInTheDocument();
    });

    it("dropping an all-day chip on another day moves it by exactly those calendar days", () => {
        const [occurrence] = expandAllOccurrences([allDayEvent()], gridStart, gridEnd);

        const action = resolveDragAction(eventDragId(occurrence), dayDropId(new Date(2026, 8, 16)), [occurrence]);

        expect(action).toEqual({ type: "move", occurrence, deltaMs: 2 * 86_400_000 });
        expect(new Date(new Date(occurrence.startDate).getTime() + (action as { deltaMs: number }).deltaMs).toISOString()).toBe(
            "2026-09-16T00:00:00.000Z",
        );
    });
});
