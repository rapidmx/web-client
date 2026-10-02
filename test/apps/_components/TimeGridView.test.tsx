// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { DndContext, useSensors } from "@dnd-kit/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
        const allDay = occurrence({ allDay: true, title: "Holiday", startDate: "2026-06-10T00:00:00.000Z", endDate: "2026-06-11T00:00:00.000Z" });
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

    it("clicking an empty time slot calls onSelectSlot with a 30-minute default block and the slot as the anchor", async () => {
        const onSelectSlot = vi.fn();
        const user = userEvent.setup();
        renderGrid({ onSelectSlot });
        const slot = screen.getByLabelText(/New event at 9:00 AM/);
        vi.spyOn(slot, "getBoundingClientRect").mockReturnValue({ left: 60, top: 432, right: 260, bottom: 456, width: 200, height: 24, x: 60, y: 432, toJSON: () => ({}) });

        await user.click(slot);

        expect(onSelectSlot).toHaveBeenCalledWith(
            new Date("2026-06-10T09:00:00.000Z"),
            new Date("2026-06-10T09:30:00.000Z"),
            { left: 60, top: 432, right: 260, bottom: 456, placement: "side" },
        );
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

    it("draws a multi-day timed event in every day column it overlaps, clipped, with only the first day draggable", async () => {
        const onSelectEvent = vi.fn();
        const occ = occurrence({ title: "Offsite", startDate: "2026-06-10T20:00:00.000Z", endDate: "2026-06-11T02:00:00.000Z" });
        const user = userEvent.setup();
        renderGrid({ days: [DAY, new Date("2026-06-11T00:00:00.000Z")], occurrences: [occ], onSelectEvent });

        const blocks = screen.getAllByText("Offsite").map((el) => el.closest("div[style]") as HTMLElement);
        expect(blocks).toHaveLength(2);
        expect(blocks[0].style.top).toBe("960px");
        expect(blocks[0].style.height).toBe("192px");
        expect(blocks[1].style.top).toBe("0px");
        expect(blocks[1].style.height).toBe("96px");
        expect(screen.getAllByLabelText('Resize "Offsite"')).toHaveLength(1);

        await user.click(blocks[1]);
        expect(onSelectEvent).toHaveBeenCalledWith(occ);
    });

    it("styles a 'free' continuation block with the muted style", () => {
        renderGrid({
            days: [new Date("2026-06-11T00:00:00.000Z")],
            occurrences: [occurrence({ title: "Free Offsite", busyStatus: "free", startDate: "2026-06-10T20:00:00.000Z", endDate: "2026-06-11T02:00:00.000Z" })],
        });
        const block = screen.getByText("Free Offsite").closest("div[style]") as HTMLElement;
        expect(block.className).toContain("bg-surface-alt");
        expect(block.style.backgroundColor).toBe("");
    });

    it("shows a multi-day all-day event on each day it covers in the all-day strip", () => {
        const week = [new Date("2026-06-10T00:00:00.000Z"), new Date("2026-06-11T00:00:00.000Z"), new Date("2026-06-12T00:00:00.000Z")];
        renderGrid({
            days: week,
            occurrences: [occurrence({ allDay: true, title: "Conference", startDate: "2026-06-10T00:00:00.000Z", endDate: "2026-06-12T00:00:00.000Z" })],
        });
        expect(screen.getAllByRole("button", { name: "Conference" })).toHaveLength(2);
    });
    it("keeps every hour label the height of its hour, so the labels stay on their lines instead of drifting up", () => {
        renderGrid();
        const label = screen.getByText("9AM");
        // A negative margin would shorten each row by its size: the labels would then sit 6px higher with every hour (an event at 8:00 beside "9AM").
        expect(label.style.height).toBe("48px");
        expect(label.className).toContain("relative");
        expect(label.className).not.toMatch(/(^|\s)-m[tb]-/);
    });
});

describe("TimeGridView: events that overlap in time", () => {
    const at = (title: string, from: string, to: string) =>
        occurrence({ occurrenceKey: title, uid: title, title, startDate: `2026-06-10T${from}:00.000Z`, endDate: `2026-06-10T${to}:00.000Z` });
    const block = (title: string) => screen.getByText(title).closest("div[style]") as HTMLElement;

    it("puts events that overlap side by side, each reachable, and leaves one that overlaps nothing the whole width", () => {
        renderGrid({ occurrences: [at("A", "09:00", "10:00"), at("B", "09:30", "10:30"), at("C", "09:45", "11:00"), at("D", "12:00", "13:00")] });
        // A, B and C chain into one group of three lanes.
        expect(block("A").style.left).toBe("calc(0% + 2px)");
        expect(block("A").style.width).toContain("33.33");
        expect(block("B").style.left).toContain("33.33");
        expect(block("C").style.left).toContain("66.66");
        // D is alone, in its own group.
        expect(block("D").style.left).toBe("2px");
        expect(block("D").style.right).toBe("2px");
        expect(block("D").style.width).toBe("");
    });

    it("reuses a lane that has become free, and does not group events that merely touch", () => {
        renderGrid({ occurrences: [at("A", "09:00", "10:00"), at("B", "09:30", "11:00"), at("C", "10:00", "10:30"), at("D", "11:00", "12:00")] });
        // C starts as A ends: it takes A's lane, beside B, and the two lanes are all that group needs.
        expect(block("A").style.left).toBe("calc(0% + 2px)");
        expect(block("C").style.left).toBe("calc(0% + 2px)");
        expect(block("B").style.left).toBe("calc(50% + 2px)");
        expect(block("C").style.width).toBe("calc(50% - 4px)");
        // D starts as B ends: a new group, the whole width.
        expect(block("D").style.left).toBe("2px");
    });
});

describe("TimeGridView: events that start together", () => {
    it("puts the longer one first, whatever order they were given in", () => {
        const at = (title: string, to: string) => occurrence({ occurrenceKey: title, uid: title, title, startDate: "2026-06-10T09:00:00.000Z", endDate: `2026-06-10T${to}:00.000Z` });
        renderGrid({ occurrences: [at("Short", "09:30"), at("Long", "11:00")] });
        expect((screen.getByText("Long").closest("div[style]") as HTMLElement).style.left).toBe("calc(0% + 2px)");
        expect((screen.getByText("Short").closest("div[style]") as HTMLElement).style.left).toBe("calc(50% + 2px)");
    });
});

describe("TimeGridView: days a daylight-saving change makes shorter or longer", () => {
    const zone = process.env.TZ;
    afterEach(() => {
        process.env.TZ = zone;
    });

    it("keeps events and rows on their clock hours on the 23-hour day the clocks go forward", async () => {
        process.env.TZ = "America/New_York";
        const onSelectSlot = vi.fn();
        const user = userEvent.setup();
        const day = new Date(2026, 2, 8); // 8 March 2026: 02:00 became 03:00
        const event = occurrence({ startDate: new Date(2026, 2, 8, 10, 0).toISOString(), endDate: new Date(2026, 2, 8, 11, 0).toISOString() });
        renderGrid({ days: [day], occurrences: [event], onSelectSlot });

        const block = screen.getByText("Standup").closest("div[style]") as HTMLElement;
        expect(block.style.top).toBe("480px");
        expect(block.style.height).toBe("48px");
        await user.click(screen.getByLabelText(/New event at 10:00 AM/));
        expect(onSelectSlot.mock.calls[0][0]).toEqual(new Date(2026, 2, 8, 10, 0));
    });

    it("keeps the last hour of the 25-hour day the clocks go back inside the column", () => {
        process.env.TZ = "America/New_York";
        const day = new Date(2026, 10, 1); // 1 November 2026: 02:00 became 01:00
        const event = occurrence({ startDate: new Date(2026, 10, 1, 23, 0).toISOString(), endDate: new Date(2026, 10, 2, 0, 0).toISOString() });
        renderGrid({ days: [day], occurrences: [event] });

        const block = screen.getByText("Standup").closest("div[style]") as HTMLElement;
        expect(block.style.top).toBe("1104px");
        expect(block.style.height).toBe("48px");
    });
});
