// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import MailListToolbar from "../../../apps/shared/components/mail/MailListToolbar.js";

function renderToolbar(props: Partial<React.ComponentProps<typeof MailListToolbar>> = {}) {
    const handlers = {
        onSortChange: vi.fn(),
        onFilterChange: vi.fn(),
        onShowAsConversationsChange: vi.fn(),
        onSelectModeChange: vi.fn(),
    };
    render(
        <MailListToolbar
            sortBy="date"
            sortOrder="desc"
            filter="all"
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

        renderToolbar({ selectDisabled: true, selectDisabledReason: "Turn off Show as conversations to select messages" });
        const disabled = screen.getAllByRole("button", { name: "Select" })[1];
        expect(disabled).toBeDisabled();
        expect(disabled).toHaveAttribute("title", "Turn off Show as conversations to select messages");
    });
});
