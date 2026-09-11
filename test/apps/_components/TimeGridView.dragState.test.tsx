// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
/** See `MonthView.dragState.test.tsx`'s header comment — same reasoning, applied to `TimeGridView`. */
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TimeGridView from "../../../apps/shared/components/calendar/TimeGridView.js";
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
};

const NO_DRAG = { setNodeRef: vi.fn(), listeners: {}, attributes: {}, transform: null, isDragging: false };

afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
});

describe("TimeGridView drag/today visual states", () => {
    it("highlights a time slot being dragged over", () => {
        mockUseDroppable.mockReturnValue({ setNodeRef: vi.fn(), isOver: true });
        mockUseDraggable.mockReturnValue(NO_DRAG);

        render(<TimeGridView days={[new Date("2026-06-10T00:00:00.000Z")]} occurrences={[]} folderColors={{}} onSelectEvent={vi.fn()} onSelectSlot={vi.fn()} />);

        expect(screen.getAllByLabelText(/New event at/)[0].className).toContain("bg-primary/10");
    });

    it("applies a translate transform, raised z-index, and reduced opacity to an event block actively being dragged", () => {
        mockUseDroppable.mockReturnValue({ setNodeRef: vi.fn(), isOver: false });
        mockUseDraggable.mockReturnValue({
            setNodeRef: vi.fn(),
            listeners: {},
            attributes: {},
            transform: { x: 5, y: 10, scaleX: 1, scaleY: 1 },
            isDragging: true,
        });

        render(
            <TimeGridView
                days={[new Date("2026-06-10T00:00:00.000Z")]}
                occurrences={[occurrence]}
                folderColors={{ f1: "#2563eb" }}
                onSelectEvent={vi.fn()}
                onSelectSlot={vi.fn()}
            />,
        );

        const block = screen.getByText("Standup").closest("div[style]") as HTMLElement;
        expect(block.style.transform).toBe("translate(5px, 10px)");
        expect(block.style.zIndex).toBe("10");
        expect(block.className).toContain("opacity-50");
    });

    it("highlights today's day column", () => {
        mockUseDroppable.mockReturnValue({ setNodeRef: vi.fn(), isOver: false });
        mockUseDraggable.mockReturnValue(NO_DRAG);
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date("2026-06-10T12:00:00.000Z"));

        render(<TimeGridView days={[new Date("2026-06-10T00:00:00.000Z")]} occurrences={[]} folderColors={{}} onSelectEvent={vi.fn()} onSelectSlot={vi.fn()} />);

        expect(screen.getAllByLabelText(/New event at/)[0].closest(".relative")!.className).toContain("bg-primary/5");
    });
});
