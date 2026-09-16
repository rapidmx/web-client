// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import MailSelectionBar from "../../../apps/shared/components/mail/MailSelectionBar.js";

function messageFixture(uid: string) {
    return {
        uid,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        messageId: `${uid}@example.com`,
        subject: uid,
        from: { address: "sender@example.com", type: "to" as const },
        recipients: [],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: "2026-01-01T00:00:00.000Z",
        bodyPreview: "",
        flags: { read: false, flagged: false, answered: false, forwarded: false },
        importance: "normal" as const,
        hasAttachments: false,
    };
}

function folderFixture(uid: string, name: string, type: string) {
    return {
        uid,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        name,
        type: type as never,
        unreadCount: 0,
        totalCount: 0,
    };
}

function labelFixture(uid: string, name: string, color?: string) {
    return {
        uid,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        name,
        color,
    };
}

const LABELS = [labelFixture("l1", "Invoices", "#ff0000"), labelFixture("l2", "Travel")];

const FOLDERS = [
    folderFixture("f1", "Inbox", "inbox"),
    folderFixture("f2", "Junk Email", "junk"),
    folderFixture("f3", "Deleted Items", "deleted_items"),
    folderFixture("f4", "Project X", "user"),
    folderFixture("f5", "Outbox", "outbox"),
];

function renderBar(props: Partial<React.ComponentProps<typeof MailSelectionBar>> = {}) {
    const handlers = {
        onSelectAll: vi.fn(),
        onClearSelection: vi.fn(),
        onCancel: vi.fn(),
        onSetRead: vi.fn(),
        onSetFlagged: vi.fn(),
        onArchive: vi.fn(),
        onMoveTo: vi.fn(),
        onReportJunk: vi.fn(),
        onDelete: vi.fn(),
        onApplyLabels: vi.fn(),
        onLabelCreated: vi.fn(),
    };
    const listed = [messageFixture("m1"), messageFixture("m2")];
    render(
        <MailSelectionBar
            selected={[listed[0]]}
            listed={listed}
            folders={FOLDERS}
            currentFolderUid="f1"
            labels={LABELS}
            mailboxUid="mb1"
            busy={false}
            error={null}
            {...handlers}
            {...props}
        />,
    );
    return handlers;
}

describe("MailSelectionBar", () => {
    it("counts the selection and offers select-all, clear and cancel", async () => {
        const user = userEvent.setup();
        const handlers = renderBar();

        expect(screen.getByText("1 selected")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Select all" }));
        await user.click(screen.getByRole("button", { name: "Clear" }));
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        expect(handlers.onSelectAll).toHaveBeenCalled();
        expect(handlers.onClearSelection).toHaveBeenCalled();
        expect(handlers.onCancel).toHaveBeenCalled();
    });

    it("disables Select all once everything listed is selected, and Clear with nothing selected", () => {
        const listed = [messageFixture("m1")];
        renderBar({ selected: listed, listed });
        expect(screen.getByRole("button", { name: "Select all" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Clear" })).toBeEnabled();
    });

    it("disables Select all when nothing is listed at all", () => {
        renderBar({ selected: [], listed: [] });
        expect(screen.getByRole("button", { name: "Select all" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    });

    it("runs each bulk action", async () => {
        const user = userEvent.setup();
        const handlers = renderBar();

        await user.click(screen.getByRole("button", { name: "Mark read" }));
        await user.click(screen.getByRole("button", { name: "Mark unread" }));
        await user.click(screen.getByRole("button", { name: "Flag" }));
        await user.click(screen.getByRole("button", { name: "Unflag" }));
        await user.click(screen.getByRole("button", { name: "Archive" }));
        await user.click(screen.getByRole("button", { name: "Report junk" }));
        await user.click(screen.getByRole("button", { name: "Delete" }));

        expect(handlers.onSetRead).toHaveBeenCalledWith(true);
        expect(handlers.onSetRead).toHaveBeenCalledWith(false);
        expect(handlers.onSetFlagged).toHaveBeenCalledWith(true);
        expect(handlers.onSetFlagged).toHaveBeenCalledWith(false);
        expect(handlers.onArchive).toHaveBeenCalled();
        expect(handlers.onReportJunk).toHaveBeenCalled();
        expect(handlers.onDelete).toHaveBeenCalled();
    });

    it("applies several labels to the whole selection at once", async () => {
        const user = userEvent.setup();
        const handlers = renderBar();

        await user.click(screen.getByRole("button", { name: "Apply label" }));
        await user.click(screen.getByRole("menuitemcheckbox", { name: "Invoices" }));
        await user.click(screen.getByRole("menuitemcheckbox", { name: "Travel" }));
        await user.click(screen.getByRole("menuitem", { name: "Apply" }));

        expect(handlers.onApplyLabels).toHaveBeenCalledWith(["l1", "l2"], []);
    });

    it("shows a label only some of the selection carries as partially applied, and says what Apply does", async () => {
        const listed = [
            { ...messageFixture("m1"), labelUids: ["l1", "l2"] },
            { ...messageFixture("m2"), labelUids: ["l1"] },
        ];
        const user = userEvent.setup();
        renderBar({ selected: listed, listed });

        await user.click(screen.getByRole("button", { name: "Apply label" }));

        expect(screen.getByRole("menuitemcheckbox", { name: "Invoices" })).toHaveAttribute("aria-checked", "true");
        expect(screen.getByRole("menuitemcheckbox", { name: "Travel" })).toHaveAttribute("aria-checked", "mixed");
        expect(screen.getByText(/a dash means only some have that label/)).toBeInTheDocument();
    });

    it("words the note for a single selected message", async () => {
        const user = userEvent.setup();
        renderBar();
        await user.click(screen.getByRole("button", { name: "Apply label" }));
        expect(screen.getByText("Ticked labels are applied, unticked ones removed.")).toBeInTheDocument();
    });

    it("disables Apply label with nothing selected", () => {
        renderBar({ selected: [] });
        expect(screen.getByRole("button", { name: "Apply label" })).toBeDisabled();
    });

    it("moves to another folder of this mailbox, never to the one being viewed or to Outbox", async () => {
        const user = userEvent.setup();
        const handlers = renderBar();

        await user.click(screen.getByRole("button", { name: "Move to" }));

        expect(screen.queryByRole("menuitem", { name: "Inbox" })).not.toBeInTheDocument();
        expect(screen.queryByRole("menuitem", { name: "Outbox" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("menuitem", { name: "Project X" }));
        expect(handlers.onMoveTo).toHaveBeenCalledWith("f4");
    });

    it("disables Move to, with a note, when there is nowhere else to move", async () => {
        const user = userEvent.setup();
        renderBar({ folders: [FOLDERS[0]] });

        const button = screen.getByRole("button", { name: "Move to" });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("title", "There is no other folder in this mailbox to move to");

        // With nothing selected the button is disabled for that reason too, so the note is asserted through
        // a rendering of the menu itself.
        renderBar({ folders: [FOLDERS[0], folderFixture("f9", "Archive", "archive")] });
        await user.click(screen.getAllByRole("button", { name: "Move to" })[1]);
        expect(screen.getByRole("menuitem", { name: "Archive" })).toBeInTheDocument();
    });

    it("disables the actions whose target folder is the one already being viewed", () => {
        renderBar({ currentFolderUid: "f3" });
        const remove = screen.getByRole("button", { name: "Delete" });
        expect(remove).toBeDisabled();
        expect(remove).toHaveAttribute("title", "These messages are already in Deleted Items");
    });

    it("says so when Archive or Junk is the folder being viewed", () => {
        renderBar({ folders: [...FOLDERS, folderFixture("f9", "Archive", "archive")], currentFolderUid: "f9" });
        expect(screen.getByRole("button", { name: "Archive" })).toHaveAttribute(
            "title",
            "These messages are already in Archive",
        );

        renderBar({ currentFolderUid: "f2" });
        expect(screen.getAllByRole("button", { name: "Report junk" })[1]).toHaveAttribute(
            "title",
            "These messages are already in Junk",
        );
    });

    it("still offers Report junk and Delete when this mailbox has no such folder yet - the caller creates it", () => {
        renderBar({ folders: [FOLDERS[0]] });
        expect(screen.getByRole("button", { name: "Report junk" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    });

    it("disables every action with nothing selected, and while one is in flight", () => {
        renderBar({ selected: [] });
        expect(screen.getByRole("button", { name: "Mark read" })).toBeDisabled();

        renderBar({ busy: true });
        expect(screen.getAllByRole("button", { name: "Mark read" })[1]).toBeDisabled();
    });

    it("shows a failure message", () => {
        renderBar({ error: "Those messages couldn't all be updated." });
        expect(screen.getByText("Those messages couldn't all be updated.")).toBeInTheDocument();
    });
});
