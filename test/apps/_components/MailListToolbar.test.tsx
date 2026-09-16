// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import MailListToolbar from "../../../apps/shared/components/mail/MailListToolbar.js";

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

function renderToolbar(props: Partial<React.ComponentProps<typeof MailListToolbar>> = {}) {
    const handlers = {
        onSortChange: vi.fn(),
        onFilterChange: vi.fn(),
        onShowAsConversationsChange: vi.fn(),
        onSelectModeChange: vi.fn(),
        onLabelUidsChange: vi.fn(),
        onLabelCreated: vi.fn(),
    };
    render(
        <MailListToolbar
            sortBy="date"
            sortOrder="desc"
            filter="all"
            labelUids={[]}
            labels={LABELS}
            mailboxUid="mb1"
            showAsConversations={false}
            selectMode={false}
            offerClassificationFilters={false}
            {...handlers}
            {...props}
        />,
    );
    return handlers;
}

describe("MailListToolbar", () => {
    it("names the buttons for what they are set to", () => {
        renderToolbar({ filter: "unread", sortBy: "subject" });
        expect(screen.getByRole("button", { name: "Filter: Unread" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Sort: Subject" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Select" })).toHaveAttribute("aria-pressed", "false");
    });

    it("says only 'Filter' when nothing is filtered out", () => {
        renderToolbar();
        expect(screen.getByRole("button", { name: "Filter" })).toBeInTheDocument();
    });

    it("offers every named filter, checking the current one", async () => {
        const user = userEvent.setup();
        const { onFilterChange } = renderToolbar({ filter: "flagged" });

        await user.click(screen.getByRole("button", { name: "Filter: Flagged" }));

        expect(screen.getByRole("menuitemradio", { name: "Flagged" })).toHaveAttribute("aria-checked", "true");
        expect(screen.getByRole("menuitemradio", { name: "All" })).toHaveAttribute("aria-checked", "false");
        for (const label of ["Unread", "Read", "Has attachments"]) {
            expect(screen.getByRole("menuitemradio", { name: label })).toBeInTheDocument();
        }
        // Nothing the data model can't answer.
        expect(screen.queryByRole("menuitemradio", { name: /To me|Mentions|calendar/ })).not.toBeInTheDocument();

        await user.click(screen.getByRole("menuitemradio", { name: "Unread" }));
        expect(onFilterChange).toHaveBeenCalledWith("unread");
    });

    it("offers Focused and Other only where the Focused Inbox applies", async () => {
        const user = userEvent.setup();
        const { onFilterChange } = renderToolbar({ offerClassificationFilters: true });

        await user.click(screen.getByRole("button", { name: "Filter" }));
        expect(screen.getByRole("group", { name: "Focused Inbox" })).toBeInTheDocument();
        expect(screen.getByText("One filter at a time: picking Focused or Other replaces the filter above.")).toBeInTheDocument();

        await user.click(screen.getByRole("menuitemradio", { name: "Other" }));
        expect(onFilterChange).toHaveBeenCalledWith("other");
    });

    it("hides the Focused Inbox group elsewhere", async () => {
        const user = userEvent.setup();
        renderToolbar();
        await user.click(screen.getByRole("button", { name: "Filter" }));
        expect(screen.queryByRole("group", { name: "Focused Inbox" })).not.toBeInTheDocument();
    });

    it("offers exactly the sort keys the data model supports", async () => {
        const user = userEvent.setup();
        renderToolbar();
        await user.click(screen.getByRole("button", { name: "Sort: Date" }));

        for (const label of ["Date", "Date sent", "From", "Subject", "Importance", "Flag status"]) {
            expect(screen.getByRole("menuitemradio", { name: label })).toBeInTheDocument();
        }
        expect(screen.queryByRole("menuitemradio", { name: /Category|Size|Type/ })).not.toBeInTheDocument();
    });

    it("resets the direction to the one that reads naturally when the sort key changes", async () => {
        const user = userEvent.setup();
        const { onSortChange } = renderToolbar();

        await user.click(screen.getByRole("button", { name: "Sort: Date" }));
        await user.click(screen.getByRole("menuitemradio", { name: "Subject" }));

        expect(onSortChange).toHaveBeenCalledWith("subject", "asc");
    });

    it("words the order options for the key being sorted on", async () => {
        const user = userEvent.setup();
        const { onSortChange } = renderToolbar({ sortBy: "from", sortOrder: "asc" });

        await user.click(screen.getByRole("button", { name: "Sort: From" }));
        expect(screen.getByRole("menuitemradio", { name: "A to Z" })).toHaveAttribute("aria-checked", "true");

        await user.click(screen.getByRole("menuitemradio", { name: "Z to A" }));
        expect(onSortChange).toHaveBeenCalledWith("from", "desc");
    });

    it("words the order options as newest/oldest for a date sort", async () => {
        const user = userEvent.setup();
        renderToolbar();
        await user.click(screen.getByRole("button", { name: "Sort: Date" }));
        expect(screen.getByRole("menuitemradio", { name: "Newest on top" })).toHaveAttribute("aria-checked", "true");
        expect(screen.getByRole("menuitemradio", { name: "Oldest on top" })).toBeInTheDocument();
    });

    it("carries 'Show as conversations' in the Sort menu, as a checkbox item", async () => {
        const user = userEvent.setup();
        const { onShowAsConversationsChange } = renderToolbar();

        await user.click(screen.getByRole("button", { name: "Sort: Date" }));
        const item = screen.getByRole("menuitemcheckbox", { name: /^Show as conversations/ });
        expect(item).toHaveAttribute("aria-checked", "false");

        await user.click(item);
        expect(onShowAsConversationsChange).toHaveBeenCalledWith(true);
    });

    it("turns conversations back off from the same item", async () => {
        const user = userEvent.setup();
        const { onShowAsConversationsChange } = renderToolbar({ showAsConversations: true });

        await user.click(screen.getByRole("button", { name: "Sort: Date" }));
        await user.click(screen.getByRole("menuitemcheckbox", { name: /^Show as conversations/ }));

        expect(onShowAsConversationsChange).toHaveBeenCalledWith(false);
    });

    it("greys out the sort keys, but not the menu itself, when something else decides the order", async () => {
        const user = userEvent.setup();
        renderToolbar({ sortKeysDisabled: true, sortKeysNote: "Search results are ranked by relevance rather than sorted." });

        await user.click(screen.getByRole("button", { name: "Sort: Date" }));

        expect(screen.getByRole("menuitemradio", { name: "Subject" })).toBeDisabled();
        expect(screen.getByRole("menuitemradio", { name: "Oldest on top" })).toBeDisabled();
        expect(screen.getByRole("menuitemcheckbox", { name: /^Show as conversations/ })).toBeEnabled();
        expect(screen.getByText("Search results are ranked by relevance rather than sorted.")).toBeInTheDocument();
    });

    it("narrows the list to several labels at once, from the Filter menu's own Labels submenu", async () => {
        const user = userEvent.setup();
        const { onLabelUidsChange } = renderToolbar();

        await user.click(screen.getByRole("button", { name: "Filter" }));
        await user.click(screen.getByRole("menuitem", { name: /^Labels/ }));

        expect(screen.getByRole("menuitemcheckbox", { name: "Invoices" })).toBeInTheDocument();
        expect(screen.getByText("Shows messages with any of the ticked labels.")).toBeInTheDocument();
        await user.click(screen.getByRole("menuitemcheckbox", { name: "Invoices" }));
        await user.click(screen.getByRole("menuitemcheckbox", { name: "Travel" }));
        await user.click(screen.getByRole("menuitem", { name: "Apply labels" }));

        expect(onLabelUidsChange).toHaveBeenCalledWith(["l1", "l2"]);
    });

    it("names the chosen labels on the Filter button, alongside any named filter", () => {
        const { unmount } = render(
            <MailListToolbar
                sortBy="date"
                sortOrder="desc"
                filter="all"
                labelUids={["l1"]}
                labels={LABELS}
                mailboxUid="mb1"
                showAsConversations={false}
                selectMode={false}
                offerClassificationFilters={false}
                onSortChange={vi.fn()}
                onFilterChange={vi.fn()}
                onShowAsConversationsChange={vi.fn()}
                onSelectModeChange={vi.fn()}
                onLabelUidsChange={vi.fn()}
                onLabelCreated={vi.fn()}
            />,
        );
        expect(screen.getByRole("button", { name: "Filter: Invoices" })).toBeInTheDocument();
        unmount();

        renderToolbar({ filter: "unread", labelUids: ["l1", "l2"] });
        expect(screen.getByRole("button", { name: "Filter: Unread, 2 labels" })).toBeInTheDocument();
    });

    it("falls back to a count for a chosen label this mailbox no longer has", () => {
        renderToolbar({ labelUids: ["gone"] });
        expect(screen.getByRole("button", { name: "Filter: 1 label" })).toBeInTheDocument();
    });

    it("clears the label filter in one step", async () => {
        const user = userEvent.setup();
        const { onLabelUidsChange } = renderToolbar({ labelUids: ["l1"] });

        await user.click(screen.getByRole("button", { name: "Filter: Invoices" }));
        await user.click(screen.getByRole("menuitem", { name: /^Labels/ }));
        await user.click(screen.getByRole("menuitem", { name: "Clear labels" }));

        expect(onLabelUidsChange).toHaveBeenCalledWith([]);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("says so when the mailbox has no labels to filter by", async () => {
        const user = userEvent.setup();
        renderToolbar({ labels: [] });

        await user.click(screen.getByRole("button", { name: "Filter" }));
        await user.click(screen.getByRole("menuitem", { name: /^Labels/ }));

        expect(screen.getByText("This mailbox has no labels yet.")).toBeInTheDocument();
        // Still a way to make one, and a way to the page that manages them.
        expect(screen.getByRole("menuitem", { name: "New label…" })).toBeInTheDocument();
        expect(screen.getByRole("menuitem", { name: "Manage labels…" })).toBeInTheDocument();
    });

    it("disables Filter with a reason", () => {
        renderToolbar({ filterDisabled: true, filterDisabledReason: "Filters don't apply to search results" });
        const button = screen.getByRole("button", { name: "Filter" });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("title", "Filters don't apply to search results");
    });

    it("toggles select mode, and disables it with a reason where it can't apply", async () => {
        const user = userEvent.setup();
        const { onSelectModeChange } = renderToolbar({ selectMode: true });

        expect(screen.getByRole("button", { name: "Select" })).toHaveAttribute("aria-pressed", "true");
        await user.click(screen.getByRole("button", { name: "Select" }));
        expect(onSelectModeChange).toHaveBeenCalledWith(false);

        renderToolbar({ selectDisabled: true, selectDisabledReason: "There is nothing here to select" });
        const disabled = screen.getAllByRole("button", { name: "Select" })[1];
        expect(disabled).toBeDisabled();
        expect(disabled).toHaveAttribute("title", "There is nothing here to select");
    });

    it("draws Select as an icon alone, named only for assistive technology", () => {
        renderToolbar();
        const button = screen.getByRole("button", { name: "Select" });
        expect(button).toHaveAttribute("title", "Select");
        expect(button).not.toHaveTextContent("Select");
        // The pressed state is its own background, not only a text colour, so it reads while toggled.
        expect(button.className).not.toContain("bg-primary/10");
        renderToolbar({ selectMode: true });
        expect(screen.getAllByRole("button", { name: "Select" })[1].className).toContain("bg-primary/10");
    });

    it("greys out only the sort keys a conversation row has no value for, saying why on each", async () => {
        const user = userEvent.setup();
        renderToolbar({
            showAsConversations: true,
            unavailableSortKeys: { sentDate: "A thread has no sent date" },
            sortKeysNote: "Ordered within the rows loaded so far.",
        });

        await user.click(screen.getByRole("button", { name: "Sort: Date" }));

        expect(screen.getByRole("menuitemradio", { name: /^Date sent/ })).toBeDisabled();
        expect(screen.getByText("A thread has no sent date")).toBeInTheDocument();
        expect(screen.getByRole("menuitemradio", { name: /^Subject/ })).toBeEnabled();
        // The order is still the reader's to pick - only the field it applies to is narrowed.
        expect(screen.getByRole("menuitemradio", { name: "Newest on top" })).toBeEnabled();
    });
});
