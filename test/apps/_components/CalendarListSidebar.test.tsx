// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import CalendarListSidebar from "../../../apps/shared/components/calendar/CalendarListSidebar.js";
import { getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";
import { CALENDAR_COLOR_PALETTE } from "@rapidmx/react-shared/calendar/calendarColors.js";
import { Folder, Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";

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

function mailbox(overrides: Partial<Mailbox> = {}): Mailbox {
    return { uid: "mb1", ownerUserUid: "u1", displayName: "My Mail", primarySmtpAddress: "me@example.com", aliasAddresses: [], ...overrides } as Mailbox;
}

/** The single-mailbox case every pre-existing test here covers. */
function single(calendars: Folder[]) {
    return [{ mailbox: mailbox(), calendarFolders: calendars }];
}

describe("CalendarListSidebar", () => {
    it("renders one checkbox row per calendar, checked according to checkedFolderUids", () => {
        render(
            <CalendarListSidebar
                mailboxCalendars={single([folder({ uid: "f1", name: "Work" }), folder({ uid: "f2", name: "Personal" })])}
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
                mailboxCalendars={single([folder({ uid: "f1", name: "Work" })])}
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
        render(<CalendarListSidebar mailboxCalendars={single([])} checkedFolderUids={new Set()} onToggle={vi.fn()} onAddCalendar={onAddCalendar} />);

        await user.click(screen.getByLabelText("Add calendar"));
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(onAddCalendar).not.toHaveBeenCalled();
    });

    it("creates a new calendar with the entered name and chosen color, then closes the form", async () => {
        const onAddCalendar = vi.fn().mockResolvedValue(undefined);
        const user = userEvent.setup();
        render(<CalendarListSidebar mailboxCalendars={single([])} checkedFolderUids={new Set()} onToggle={vi.fn()} onAddCalendar={onAddCalendar} />);

        await user.click(screen.getByLabelText("Add calendar"));
        await user.type(screen.getByLabelText("New calendar name"), "Birthdays");
        await user.click(screen.getByLabelText(`Color ${CALENDAR_COLOR_PALETTE[2]}`));
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(onAddCalendar).toHaveBeenCalledWith("mb1", "Birthdays", CALENDAR_COLOR_PALETTE[2]);
        expect(screen.queryByLabelText("New calendar name")).not.toBeInTheDocument();
    });

    it("raises an error pop-up when creating a calendar fails", async () => {
        const onAddCalendar = vi.fn().mockRejectedValue(new Error("boom"));
        const user = userEvent.setup();
        render(<CalendarListSidebar mailboxCalendars={single([])} checkedFolderUids={new Set()} onToggle={vi.fn()} onAddCalendar={onAddCalendar} />);

        await user.click(screen.getByLabelText("Add calendar"));
        await user.type(screen.getByLabelText("New calendar name"), "Oops");
        await user.click(screen.getByRole("button", { name: "Add" }));

        // No pop-up host here (that is `AppShell`'s): what was raised is in the notification store.
        await waitFor(() =>
            expect(getNotificationsSnapshot().visible).toMatchObject([
                { kind: "error", title: "Couldn't create the calendar", message: "Something unexpected went wrong." },
            ]),
        );
        // The form stays open (with its data) after a failure, matching Contacts'/Tasks' own list-creation forms.
        expect(screen.getByLabelText("New calendar name")).toHaveValue("Oops");
    });

    it("closes the new-calendar form when Cancel is clicked", async () => {
        const user = userEvent.setup();
        render(<CalendarListSidebar mailboxCalendars={single([])} checkedFolderUids={new Set()} onToggle={vi.fn()} onAddCalendar={vi.fn()} />);

        await user.click(screen.getByLabelText("Add calendar"));
        expect(screen.getByLabelText("New calendar name")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByLabelText("New calendar name")).not.toBeInTheDocument();
    });

    describe("with more than one mailbox", () => {
        const shared = mailbox({ uid: "mb-shared", ownerUserUid: undefined, displayName: "Support" });
        const both = () => [
            { mailbox: mailbox(), calendarFolders: [folder({ uid: "f1", name: "Work" })] },
            { mailbox: shared, calendarFolders: [folder({ uid: "f-s", name: "Support Calendar", mailboxUid: "mb-shared" })] },
        ];

        it("groups calendars into one section per mailbox, marking a shared one", () => {
            render(<CalendarListSidebar mailboxCalendars={both()} checkedFolderUids={new Set()} onToggle={vi.fn()} onAddCalendar={vi.fn()} />);
            expect(screen.getByText("My Mail")).toBeInTheDocument();
            expect(screen.getByText("Support (shared)")).toBeInTheDocument();
            expect(screen.queryByText("My calendars")).not.toBeInTheDocument();
            expect(screen.getByText("Support Calendar")).toBeInTheDocument();
        });

        it("colors each calendar via colorFor", () => {
            const colorFor = (f: Folder) => (f.mailboxUid === "mb-shared" ? "rgb(1, 2, 3)" : "rgb(4, 5, 6)");
            render(
                <CalendarListSidebar mailboxCalendars={both()} checkedFolderUids={new Set()} onToggle={vi.fn()} onAddCalendar={vi.fn()} colorFor={colorFor} />,
            );
            const swatch = screen.getByText("Support Calendar").previousElementSibling as HTMLElement;
            expect(swatch.style.backgroundColor).toBe("rgb(1, 2, 3)");
        });

        it("creates a new calendar in the mailbox whose section's + was clicked", async () => {
            const onAddCalendar = vi.fn().mockResolvedValue(undefined);
            const user = userEvent.setup();
            render(<CalendarListSidebar mailboxCalendars={both()} checkedFolderUids={new Set()} onToggle={vi.fn()} onAddCalendar={onAddCalendar} />);

            await user.click(screen.getByLabelText("Add calendar to Support"));
            await user.type(screen.getByLabelText("New calendar name"), "On-call");
            await user.click(screen.getByRole("button", { name: "Add" }));

            expect(onAddCalendar).toHaveBeenCalledWith("mb-shared", "On-call", CALENDAR_COLOR_PALETTE[0]);
        });

        it("shows one mailbox's folder-load error inline in its own section", () => {
            render(
                <CalendarListSidebar
                    mailboxCalendars={[both()[0], { mailbox: shared, calendarFolders: [], error: "shared boom" }]}
                    checkedFolderUids={new Set()}
                    onToggle={vi.fn()}
                    onAddCalendar={vi.fn()}
                />,
            );
            expect(screen.getByText("shared boom")).toBeInTheDocument();
            expect(screen.getByText("Work")).toBeInTheDocument();
        });
    });
});
