// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
/**
 * Covers `MonthView`'s visual states that only occur mid-drag (a day cell being dragged over, an
 * event chip actively being dragged) — real `@dnd-kit` drag gestures can't be reliably simulated
 * under jsdom (see `MonthView.test.tsx`'s note on `PointerSensor`), so this mocks `useDraggable`/
 * `useDroppable`'s return values directly instead of attempting to. Kept in its own file since the
 * mock applies file-wide and would defeat `MonthView.test.tsx`'s real (sensor-less) rendering there.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MonthView from "../../../apps/shared/components/calendar/MonthView.js";
import { CalendarOccurrence } from "@rapidmx/react-shared/recurrence.js";

const mockUseDroppable = vi.fn();
const mockUseDraggable = vi.fn();

vi.mock("@dnd-kit/core", async () => {
    const actual = await vi.importActual<typeof import("@dnd-kit/core")>("@dnd-kit/core");
    return {
        ...actual,
        useDroppable: (...args: unknown[]) => mockUseDroppable(...args),
        useDraggable: (...args: unknown[]) => mockUseDraggable(...args),
    };
});

const occurrence: CalendarOccurrence = {
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
};

afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
});

describe("MonthView drag/today visual states", () => {
    it("highlights a day cell while something is being dragged over it", () => {
        mockUseDroppable.mockReturnValue({ setNodeRef: vi.fn(), isOver: true });
        mockUseDraggable.mockReturnValue({ setNodeRef: vi.fn(), listeners: {}, attributes: {}, transform: null, isDragging: false });

        render(<MonthView viewDate={new Date("2026-06-15T00:00:00.000Z")} occurrences={[]} folderColors={{}} onSelectDay={vi.fn()} onSelectEvent={vi.fn()} />);

        const grid = screen.getByRole("grid", { name: "Month" });
        expect(grid.querySelector(".bg-primary\\/5")).not.toBeNull();
    });

    it("applies a translate transform and reduced opacity to an event chip actively being dragged", () => {
        mockUseDroppable.mockReturnValue({ setNodeRef: vi.fn(), isOver: false });
        mockUseDraggable.mockReturnValue({
            setNodeRef: vi.fn(),
            listeners: {},
            attributes: {},
            transform: { x: 12, y: 34, scaleX: 1, scaleY: 1 },
            isDragging: true,
        });

        render(
            <MonthView
                viewDate={new Date("2026-06-15T00:00:00.000Z")}
                occurrences={[occurrence]}
                folderColors={{ f1: "#2563eb" }}
                onSelectDay={vi.fn()}
                onSelectEvent={vi.fn()}
            />,
        );

        const chip = screen.getByRole("button", { name: /Standup/ });
        expect(chip.style.transform).toBe("translate(12px, 34px)");
        expect(chip.className).toContain("opacity-50");
    });

    it("highlights today's day-number button", () => {
        mockUseDroppable.mockReturnValue({ setNodeRef: vi.fn(), isOver: false });
        mockUseDraggable.mockReturnValue({ setNodeRef: vi.fn(), listeners: {}, attributes: {}, transform: null, isDragging: false });
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));

        render(<MonthView viewDate={new Date("2026-06-15T00:00:00.000Z")} occurrences={[]} folderColors={{}} onSelectDay={vi.fn()} onSelectEvent={vi.fn()} />);

        expect(screen.getByText("15").className).toContain("bg-primary text-white");
    });
});
