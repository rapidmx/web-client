// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import CalendarListSidebar from "../../../apps/shared/components/calendar/CalendarListSidebar.js";
import { CALENDAR_COLOR_PALETTE } from "@rapidmx/react-shared/calendarColors.js";
import { Folder } from "@rapidmx/react-shared/mailApi.js";

function folder(overrides: Partial<Folder> = {}): Folder {
    return {
        uid: "f1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        name: "Calendar",
        type: "calendar",
        unreadCount: 0,
        totalCount: 0,
        ...overrides,
    };
}

describe("CalendarListSidebar", () => {
    it("renders one checkbox row per calendar, checked according to checkedFolderUids", () => {
        render(
            <CalendarListSidebar
                calendars={[folder({ uid: "f1", name: "Work" }), folder({ uid: "f2", name: "Personal" })]}
                checkedFolderUids={new Set(["f1"])}
                onToggle={vi.fn()}
                onAddCalendar={vi.fn()}
            />,
        );
        const workCheckbox = screen.getByText("Work").closest("label")!.querySelector("input")!;
        const personalCheckbox = screen.getByText("Personal").closest("label")!.querySelector("input")!;
        expect(workCheckbox).toBeChecked();
        expect(personalCheckbox).not.toBeChecked();
    });

    it("calls onToggle with the clicked calendar's folderUid", async () => {
        const onToggle = vi.fn();
        const user = userEvent.setup();
        render(
            <CalendarListSidebar
                calendars={[folder({ uid: "f1", name: "Work" })]}
                checkedFolderUids={new Set(["f1"])}
                onToggle={onToggle}
                onAddCalendar={vi.fn()}
            />,
        );

        await user.click(screen.getByText("Work").closest("label")!.querySelector("input")!);
        expect(onToggle).toHaveBeenCalledWith("f1");
    });

    it("does nothing on submit when the new calendar's name is blank", async () => {
        const onAddCalendar = vi.fn();
        const user = userEvent.setup();
        render(<CalendarListSidebar calendars={[]} checkedFolderUids={new Set()} onToggle={vi.fn()} onAddCalendar={onAddCalendar} />);

        await user.click(screen.getByLabelText("Add calendar"));
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(onAddCalendar).not.toHaveBeenCalled();
    });

    it("creates a new calendar with the entered name and chosen color, then closes the form", async () => {
        const onAddCalendar = vi.fn().mockResolvedValue(undefined);
        const user = userEvent.setup();
        render(<CalendarListSidebar calendars={[]} checkedFolderUids={new Set()} onToggle={vi.fn()} onAddCalendar={onAddCalendar} />);

        await user.click(screen.getByLabelText("Add calendar"));
        await user.type(screen.getByLabelText("New calendar name"), "Birthdays");
        await user.click(screen.getByLabelText(`Color ${CALENDAR_COLOR_PALETTE[2]}`));
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(onAddCalendar).toHaveBeenCalledWith("Birthdays", CALENDAR_COLOR_PALETTE[2]);
        expect(screen.queryByLabelText("New calendar name")).not.toBeInTheDocument();
    });

    it("shows an error message when creating a calendar fails", async () => {
        const onAddCalendar = vi.fn().mockRejectedValue(new Error("boom"));
        const user = userEvent.setup();
        render(<CalendarListSidebar calendars={[]} checkedFolderUids={new Set()} onToggle={vi.fn()} onAddCalendar={onAddCalendar} />);

        await user.click(screen.getByLabelText("Add calendar"));
        await user.type(screen.getByLabelText("New calendar name"), "Oops");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByText("Could not create this calendar.")).toBeInTheDocument();
        // The form stays open (with its data) after a failure, matching Contacts'/Tasks' own list-creation forms.
        expect(screen.getByLabelText("New calendar name")).toHaveValue("Oops");
    });

    it("closes the new-calendar form when Cancel is clicked", async () => {
        const user = userEvent.setup();
        render(<CalendarListSidebar calendars={[]} checkedFolderUids={new Set()} onToggle={vi.fn()} onAddCalendar={vi.fn()} />);

        await user.click(screen.getByLabelText("Add calendar"));
        expect(screen.getByLabelText("New calendar name")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByLabelText("New calendar name")).not.toBeInTheDocument();
    });
});
