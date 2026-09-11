// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { DndContext, useSensors } from "@dnd-kit/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TimeGridView from "../../../apps/shared/components/calendar/TimeGridView.js";
import { CalendarOccurrence } from "@rapidmx/react-shared/recurrence.js";

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
        endDate: "2026-06-10T16:00:00.000Z",
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

const DAY = new Date("2026-06-10T00:00:00.000Z");

/** No sensors: see MonthView.test.tsx's identical note — `PointerSensor` needs pointer-capture APIs
 * jsdom doesn't implement, and these tests exercise plain click handlers, not real drag gestures. */
function TestDndContext({ children }: { children: React.ReactNode }) {
    const sensors = useSensors();
    return (
        <DndContext sensors={sensors} onDragEnd={() => undefined}>
            {children}
        </DndContext>
    );
}

function renderGrid(props: Partial<React.ComponentProps<typeof TimeGridView>> = {}) {
    return render(
        <TestDndContext>
            <TimeGridView days={[DAY]} occurrences={[]} folderColors={{ f1: "#2563eb" }} onSelectEvent={vi.fn()} onSelectSlot={vi.fn()} {...props} />
        </TestDndContext>,
    );
}

describe("TimeGridView", () => {
    it("shows an all-day event in its day's column of the all-day strip, and selects it on click", async () => {
        const onSelectEvent = vi.fn();
        const allDay = occurrence({ allDay: true, title: "Holiday" });
        const user = userEvent.setup();
        renderGrid({ occurrences: [allDay], onSelectEvent });

        const chip = screen.getByRole("button", { name: "Holiday" });
        await user.click(chip);
        expect(onSelectEvent).toHaveBeenCalledWith(allDay);
    });

    it("positions a timed event by its start time and duration", () => {
        // 15:00-16:00 UTC on a day starting at 00:00 UTC → top = 15 * 48px, height = 1 * 48px.
        renderGrid({ occurrences: [occurrence()] });
        const block = screen.getByText("Standup").closest("div[style]") as HTMLElement;
        expect(block.style.top).toBe("720px");
        expect(block.style.height).toBe("48px");
    });

    it("enforces a minimum block height for a very short event", () => {
        const short = occurrence({ endDate: "2026-06-10T15:05:00.000Z" });
        renderGrid({ occurrences: [short] });
        const block = screen.getByText("Standup").closest("div[style]") as HTMLElement;
        expect(block.style.height).toBe("16px");
    });

    it("calls onSelectEvent when a timed event block is clicked", async () => {
        const onSelectEvent = vi.fn();
        const occ = occurrence();
        const user = userEvent.setup();
        renderGrid({ occurrences: [occ], onSelectEvent });

        await user.click(screen.getByText("Standup"));
        expect(onSelectEvent).toHaveBeenCalledWith(occ);
    });

    it("styles a 'free' event distinctly from a 'busy' one", () => {
        renderGrid({
            occurrences: [
                occurrence({ occurrenceKey: "e1", uid: "e1", title: "Busy Thing", busyStatus: "busy" }),
                occurrence({ occurrenceKey: "e2", uid: "e2", title: "Free Thing", busyStatus: "free", startDate: "2026-06-10T18:00:00.000Z", endDate: "2026-06-10T19:00:00.000Z" }),
            ],
        });
        const busyBlock = screen.getByText("Busy Thing").closest("div[style]") as HTMLElement;
        const freeBlock = screen.getByText("Free Thing").closest("div[style]") as HTMLElement;
        expect(busyBlock.style.backgroundColor).toBe("rgb(37, 99, 235)");
        expect(freeBlock.className).toContain("bg-surface-alt");
        expect(freeBlock.style.backgroundColor).toBe("");
    });

    it("clicking an empty time slot calls onSelectSlot with a 30-minute default block", async () => {
        const onSelectSlot = vi.fn();
        const user = userEvent.setup();
        renderGrid({ onSelectSlot });

        await user.click(screen.getByLabelText(/New event at 9:00 AM/));

        expect(onSelectSlot).toHaveBeenCalledWith(new Date("2026-06-10T09:00:00.000Z"), new Date("2026-06-10T09:30:00.000Z"));
    });

    it("renders one day column per entry in `days` (week view)", () => {
        const week = Array.from({ length: 7 }, (_, i) => new Date(2026, 5, 8 + i));
        renderGrid({ days: week, occurrences: [] });
        // 7 day columns × 48 half-hour slots each = 336 slot buttons.
        expect(screen.getAllByLabelText(/New event at/)).toHaveLength(7 * 48);
    });

    it("renders hour labels down the left rail", () => {
        renderGrid();
        expect(screen.getByText("1AM")).toBeInTheDocument();
        expect(screen.getByText("11PM")).toBeInTheDocument();
    });

    it("shows a resize handle on each timed event block", () => {
        renderGrid({ occurrences: [occurrence()] });
        expect(screen.getByLabelText('Resize "Standup"')).toBeInTheDocument();
    });
});
