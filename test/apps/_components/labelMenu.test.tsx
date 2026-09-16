// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../testUtils.js";
import LabelMenuButton from "../../../apps/shared/components/mail/labelMenu.js";

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

const LABELS = [labelFixture("l1", "Invoices", "#ff0000"), labelFixture("l2", "Travel"), labelFixture("l3", "Urgent")];

function renderMenu(props: Partial<React.ComponentProps<typeof LabelMenuButton>> = {}) {
    const onCommit = vi.fn();
    render(
        <LabelMenuButton
            aria-label="Apply label"
            label="Apply label"
            labels={LABELS}
            applied={[]}
            onCommit={onCommit}
            emptyNote="This mailbox has no labels yet."
            commit={{ label: "Apply" }}
            clear={{ label: "Remove all labels" }}
            {...props}
        />,
    );
    return { onCommit };
}

describe("LabelMenuButton", () => {
    it("lists every label with the applied ones ticked, and holds Apply until something changes", async () => {
        const user = userEvent.setup();
        renderMenu({ applied: ["l2"] });

        await user.click(screen.getByRole("button", { name: "Apply label" }));

        expect(screen.getByRole("menuitemcheckbox", { name: "Travel" })).toHaveAttribute("aria-checked", "true");
        expect(screen.getByRole("menuitemcheckbox", { name: "Invoices" })).toHaveAttribute("aria-checked", "false");
        expect(screen.getByRole("menuitem", { name: "Apply" })).toBeDisabled();
    });

    it("ticks several labels with the menu staying open and commits them together", async () => {
        const user = userEvent.setup();
        const { onCommit } = renderMenu();

        await user.click(screen.getByRole("button", { name: "Apply label" }));
        await user.click(screen.getByRole("menuitemcheckbox", { name: "Invoices" }));
        await user.click(screen.getByRole("menuitemcheckbox", { name: "Urgent" }));
        expect(screen.getByRole("menu", { name: "Apply label" })).toBeInTheDocument();
        await user.click(screen.getByRole("menuitem", { name: "Apply" }));

        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenCalledWith(["l1", "l3"], []);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("shows a label only some of the targets carry as partially applied, and leaves it alone unless touched", async () => {
        const user = userEvent.setup();
        const { onCommit } = renderMenu({ applied: ["l1"], partial: ["l2"] });

        await user.click(screen.getByRole("button", { name: "Apply label" }));
        expect(screen.getByRole("menuitemcheckbox", { name: "Travel" })).toHaveAttribute("aria-checked", "mixed");

        // Touching another row leaves the partially-applied one exactly as it was.
        await user.click(screen.getByRole("menuitemcheckbox", { name: "Urgent" }));
        await user.click(screen.getByRole("menuitem", { name: "Apply" }));

        expect(onCommit).toHaveBeenCalledWith(["l1", "l3"], ["l2"]);
    });

    it("settles a partially-applied row into a plain tick once it is touched", async () => {
        const user = userEvent.setup();
        const { onCommit } = renderMenu({ applied: [], partial: ["l2"] });

        await user.click(screen.getByRole("button", { name: "Apply label" }));
        await user.click(screen.getByRole("menuitemcheckbox", { name: "Travel" }));

        expect(screen.getByRole("menuitemcheckbox", { name: "Travel" })).toHaveAttribute("aria-checked", "true");
        await user.click(screen.getByRole("menuitem", { name: "Apply" }));
        expect(onCommit).toHaveBeenCalledWith(["l2"], []);
    });

    it("unticks everything, including what was partially applied", async () => {
        const user = userEvent.setup();
        const { onCommit } = renderMenu({ applied: ["l1"], partial: ["l2"] });

        await user.click(screen.getByRole("button", { name: "Apply label" }));
        await user.click(screen.getByRole("menuitem", { name: "Remove all labels" }));

        expect(screen.getByRole("menuitemcheckbox", { name: "Invoices" })).toHaveAttribute("aria-checked", "false");
        expect(screen.getByRole("menuitemcheckbox", { name: "Travel" })).toHaveAttribute("aria-checked", "false");
        await user.click(screen.getByRole("menuitem", { name: "Apply" }));
        expect(onCommit).toHaveBeenCalledWith([], []);
    });

    it("disables Remove all labels when there is nothing to remove", async () => {
        const user = userEvent.setup();
        renderMenu();
        await user.click(screen.getByRole("button", { name: "Apply label" }));
        expect(screen.getByRole("menuitem", { name: "Remove all labels" })).toBeDisabled();
    });

    it("throws the draft away when the menu is dismissed instead of committed", async () => {
        const user = userEvent.setup();
        const { onCommit } = renderMenu({ applied: ["l1"] });

        await user.click(screen.getByRole("button", { name: "Apply label" }));
        await user.click(screen.getByRole("menuitemcheckbox", { name: "Travel" }));
        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "Apply label" }));

        expect(screen.getByRole("menuitemcheckbox", { name: "Travel" })).toHaveAttribute("aria-checked", "false");
        expect(onCommit).not.toHaveBeenCalled();
    });

    it("shows a label's own colour, and a default for one that has none", async () => {
        const user = userEvent.setup();
        renderMenu();
        await user.click(screen.getByRole("button", { name: "Apply label" }));

        const swatch = (name: string) =>
            screen.getByRole("menuitemcheckbox", { name }).querySelector("span[style]") as HTMLElement;
        expect(swatch("Invoices")).toHaveStyle({ backgroundColor: "rgb(255, 0, 0)" });
        expect(swatch("Travel")).toHaveStyle({ backgroundColor: "rgb(99, 102, 241)" });
    });

    it("says so, and offers nothing to tick, when the mailbox has no labels", async () => {
        const user = userEvent.setup();
        renderMenu({ labels: [] });

        await user.click(screen.getByRole("button", { name: "Apply label" }));

        expect(screen.getByText("This mailbox has no labels yet.")).toBeInTheDocument();
        expect(screen.queryByRole("menuitemcheckbox")).not.toBeInTheDocument();
    });

    it("holds every row while a save is in flight, and can be disabled outright", async () => {
        const user = userEvent.setup();
        renderMenu({ busy: true, applied: ["l1"] });

        await user.click(screen.getByRole("button", { name: "Apply label" }));
        expect(screen.getByRole("menuitemcheckbox", { name: "Invoices" })).toBeDisabled();
        expect(screen.getByRole("menuitem", { name: "Apply" })).toBeDisabled();

        renderMenu({ disabled: true, title: "Select messages first" });
        const trigger = screen.getAllByRole("button", { name: "Apply label" })[1];
        expect(trigger).toBeDisabled();
        expect(trigger).toHaveAttribute("title", "Select messages first");
    });

    it("creates a new label from the menu and hands it to its caller", async () => {
        const created = labelFixture("l9", "Receipts");
        const fetchMock = mockFetch(() => jsonResponse(200, created));
        const onLabelCreated = vi.fn();
        const user = userEvent.setup();
        renderMenu({ mailboxUid: "mb1", onLabelCreated });

        await user.click(screen.getByRole("button", { name: "Apply label" }));
        await user.click(screen.getByRole("menuitem", { name: "New label…" }));

        const dialog = await screen.findByRole("dialog", { name: "New label" });
        expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
        await user.type(within(dialog).getByLabelText("Name"), "Receipts");
        await user.click(within(dialog).getByRole("button", { name: "Create" }));

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/labels",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ mailboxUid: "mb1", name: "Receipts" }) }),
        );
        await waitFor(() => expect(onLabelCreated).toHaveBeenCalledWith(created));
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "New label" })).not.toBeInTheDocument());
        vi.unstubAllGlobals();
    });

    it("says why a new label couldn't be created", async () => {
        mockFetch(() => jsonResponse(500, { message: "label boom" }));
        const user = userEvent.setup();
        renderMenu({ mailboxUid: "mb1", onLabelCreated: vi.fn() });

        await user.click(screen.getByRole("button", { name: "Apply label" }));
        await user.click(screen.getByRole("menuitem", { name: "New label…" }));
        const dialog = await screen.findByRole("dialog", { name: "New label" });
        await user.type(within(dialog).getByLabelText("Name"), "Receipts");
        await user.click(within(dialog).getByRole("button", { name: "Create" }));

        expect(await screen.findByText("label boom")).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog", { name: "New label" })).not.toBeInTheDocument();
        vi.unstubAllGlobals();
    });

    it("says something generic when creating a label fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        renderMenu({ mailboxUid: "mb1", onLabelCreated: vi.fn() });

        await user.click(screen.getByRole("button", { name: "Apply label" }));
        await user.click(screen.getByRole("menuitem", { name: "New label…" }));
        const dialog = await screen.findByRole("dialog", { name: "New label" });
        await user.type(within(dialog).getByLabelText("Name"), "Receipts");
        await user.click(within(dialog).getByRole("button", { name: "Create" }));

        expect(await screen.findByText("Could not create this label.")).toBeInTheDocument();
        vi.unstubAllGlobals();
    });

    it("offers New label even when the mailbox has none yet", async () => {
        const user = userEvent.setup();
        renderMenu({ labels: [], mailboxUid: "mb1", onLabelCreated: vi.fn() });

        await user.click(screen.getByRole("button", { name: "Apply label" }));

        expect(screen.getByRole("menuitem", { name: "New label…" })).toBeInTheDocument();
    });

    it("leaves New label out when the caller can't take a created one", async () => {
        const user = userEvent.setup();
        renderMenu();
        await user.click(screen.getByRole("button", { name: "Apply label" }));
        expect(screen.queryByRole("menuitem", { name: "New label…" })).not.toBeInTheDocument();
    });

    it("points at where labels are created and deleted, even with none yet", async () => {
        const location = mockLocation();
        const user = userEvent.setup();
        renderMenu({ labels: [] });

        await user.click(screen.getByRole("button", { name: "Apply label" }));
        await user.click(screen.getByRole("menuitem", { name: "Manage labels…" }));

        expect(location.href).toBe("/settings/labels");
    });

    it("lets a caller replace what the clear row does, for a filter that applies straight away", async () => {
        const onClear = vi.fn();
        const user = userEvent.setup();
        renderMenu({ applied: ["l1"], clear: { label: "Clear labels", keepOpen: false, onSelect: onClear } });

        await user.click(screen.getByRole("button", { name: "Apply label" }));
        await user.click(screen.getByRole("menuitem", { name: "Clear labels" }));

        expect(onClear).toHaveBeenCalled();
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
});
