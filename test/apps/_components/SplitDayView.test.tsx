// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SplitDayView from "../../../apps/shared/components/calendar/SplitDayView.js";
import { CalendarOccurrence } from "@rapidmx/react-shared/recurrence.js";

const DAY = new Date("2026-06-10T00:00:00.000Z");
const COLUMNS = [
    { folderUid: "f1", name: "Work", color: "#2563eb" },
    { folderUid: "f2", name: "Personal", color: "#dc2626" },
];

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

function renderSplit(props: Partial<React.ComponentProps<typeof SplitDayView>> = {}) {
    return render(<SplitDayView day={DAY} columns={COLUMNS} occurrences={[]} onSelectEvent={vi.fn()} onSelectSlot={vi.fn()} {...props} />);
}

describe("SplitDayView", () => {
    it("renders one header per column, with its name and color swatch", () => {
        renderSplit();
        expect(screen.getByText("Work")).toBeInTheDocument();
        expect(screen.getByText("Personal")).toBeInTheDocument();
    });

    it("places each occurrence only in its own calendar's column, filtered to the given day", () => {
        renderSplit({
            occurrences: [
                occurrence({ folderUid: "f1", title: "Work Thing" }),
                occurrence({ occurrenceKey: "e2", uid: "e2", folderUid: "f2", title: "Personal Thing" }),
                occurrence({ occurrenceKey: "e3", uid: "e3", folderUid: "f1", title: "Other Day", startDate: "2026-06-11T15:00:00.000Z", endDate: "2026-06-11T16:00:00.000Z" }),
            ],
        });
        expect(screen.getByText("Work Thing")).toBeInTheDocument();
        expect(screen.getByText("Personal Thing")).toBeInTheDocument();
        expect(screen.queryByText("Other Day")).not.toBeInTheDocument();
    });

    it("styles a busy event with its column's color, and a free one with the muted style", () => {
        renderSplit({
            occurrences: [
                occurrence({ folderUid: "f1", title: "Busy Thing", busyStatus: "busy" }),
                occurrence({ occurrenceKey: "e2", uid: "e2", folderUid: "f2", title: "Free Thing", busyStatus: "free" }),
            ],
        });
        const busyBlock = screen.getByText("Busy Thing").closest("div[style]") as HTMLElement;
        const freeBlock = screen.getByText("Free Thing").closest("div[style]") as HTMLElement;
        expect(busyBlock.style.backgroundColor).toBe("rgb(37, 99, 235)");
        expect(freeBlock.className).toContain("bg-surface-alt");
        expect(freeBlock.style.backgroundColor).toBe("");
    });

    it("calls onSelectEvent when an event block is clicked", async () => {
        const onSelectEvent = vi.fn();
        const occ = occurrence();
        const user = userEvent.setup();
        renderSplit({ occurrences: [occ], onSelectEvent });

        await user.click(screen.getByText("Standup"));
        expect(onSelectEvent).toHaveBeenCalledWith(occ);
    });

    it("calls onSelectSlot with the clicked slot's time range and that column's folderUid", async () => {
        const onSelectSlot = vi.fn();
        const user = userEvent.setup();
        renderSplit({ onSelectSlot });

        await user.click(screen.getByLabelText("New event at 9:00 AM in Personal"));

        expect(onSelectSlot).toHaveBeenCalledWith(
            new Date("2026-06-10T09:00:00.000Z"),
            new Date("2026-06-10T09:30:00.000Z"),
            "f2",
        );
    });

    it("renders hour labels down the left rail", () => {
        renderSplit();
        expect(screen.getByText("1AM")).toBeInTheDocument();
        expect(screen.getByText("11PM")).toBeInTheDocument();
    });
});
