// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { DndContext, useSensors } from "@dnd-kit/core";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TimeGridView from "../../../apps/shared/components/calendar/TimeGridView.js";
import { CalendarOccurrence } from "../../../lib/calendar/recurrence.js";

// W3-04: the timed events of the Week, Work Week and Day views open from the keyboard.

const lateNight: CalendarOccurrence = {
    uid: "e1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    folderUid: "f1",
    mailboxUid: "mb1",
    title: "Late",
    startDate: new Date(2026, 5, 10, 22).toISOString(),
    endDate: new Date(2026, 5, 11, 3).toISOString(),
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

function TestDndContext({ children }: { children: React.ReactNode }) {
    const sensors = useSensors();
    return (
        <DndContext sensors={sensors} onDragEnd={() => undefined}>
            {children}
        </DndContext>
    );
}

describe("TimeGridView keyboard", () => {
    it("opens an event block, and its continuation on the next day, with Enter or Space, and ignores other keys", async () => {
        const onSelectEvent = vi.fn();
        const user = userEvent.setup();
        render(
            <TestDndContext>
                <TimeGridView
                    days={[new Date(2026, 5, 10), new Date(2026, 5, 11)]}
                    occurrences={[lateNight]}
                    folderColors={{ f1: "#2563eb" }}
                    onSelectEvent={onSelectEvent}
                    onSelectSlot={vi.fn()}
                />
            </TestDndContext>,
        );
        const [block, continuation] = screen.getAllByText("Late").map((title) => title.parentElement!);

        await user.tab();
        block.focus();
        await user.keyboard("{Enter}");
        expect(onSelectEvent).toHaveBeenCalledTimes(1);
        await user.keyboard(" ");
        expect(onSelectEvent).toHaveBeenCalledTimes(2);
        await user.keyboard("a");
        expect(onSelectEvent).toHaveBeenCalledTimes(2);

        expect(continuation).toHaveAttribute("tabindex", "0");
        continuation.focus();
        await user.keyboard("{Enter}");
        expect(onSelectEvent).toHaveBeenCalledTimes(3);
        await user.keyboard("a");
        expect(onSelectEvent).toHaveBeenCalledTimes(3);
        expect(onSelectEvent).toHaveBeenLastCalledWith(lateNight);
    });

    it("keeps the slot buttons and the resize handle out of the tab order", () => {
        const onSelectEvent = vi.fn();
        render(
            <TestDndContext>
                <TimeGridView days={[new Date(2026, 5, 10)]} occurrences={[lateNight]} folderColors={{ f1: "#2563eb" }} onSelectEvent={onSelectEvent} onSelectSlot={vi.fn()} />
            </TestDndContext>,
        );
        expect(screen.getAllByRole("button", { name: /New event at/ })[0]).toHaveAttribute("tabindex", "-1");
        expect(screen.getByLabelText('Resize "Late"')).toHaveAttribute("tabindex", "-1");
        // A key pressed on the handle is not the block's own.
        fireEvent.keyDown(screen.getByLabelText('Resize "Late"'), { key: "Enter" });
        expect(onSelectEvent).not.toHaveBeenCalled();
    });
});
