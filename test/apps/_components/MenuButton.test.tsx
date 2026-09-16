// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import MenuButton, { MenuSectionSpec, menuHeight } from "../../../apps/shared/components/mail/MenuButton.js";

function sections(onSelect = vi.fn()): MenuSectionSpec[] {
    return [
        {
            key: "sortBy",
            label: "Sort by",
            items: [
                { key: "date", label: "Date", role: "menuitemradio", checked: true, onSelect },
                { key: "from", label: "From", role: "menuitemradio", onSelect },
                { key: "size", label: "Size", role: "menuitemradio", disabled: true, onSelect },
            ],
        },
        {
            key: "arrange",
            note: "Conversations are always listed by latest activity.",
            items: [
                {
                    key: "conversations",
                    label: "Show as conversations",
                    description: "Group replies under the message they answer",
                    role: "menuitemcheckbox",
                    onSelect,
                },
            ],
        },
    ];
}

function renderMenu(props: Partial<React.ComponentProps<typeof MenuButton>> = {}, onSelect = vi.fn()) {
    render(<MenuButton label="Sort: Date" aria-label="Sort: Date" sections={sections(onSelect)} {...props} />);
    return { onSelect };
}

describe("MenuButton", () => {
    it("renders a closed menu button", () => {
        renderMenu();
        const trigger = screen.getByRole("button", { name: "Sort: Date" });
        expect(trigger).toHaveAttribute("aria-haspopup", "menu");
        expect(trigger).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("opens on click, names its groups and items, and marks the current choice", async () => {
        const user = userEvent.setup();
        renderMenu();

        await user.click(screen.getByRole("button", { name: "Sort: Date" }));

        expect(screen.getByRole("menu", { name: "Sort: Date" })).toBeInTheDocument();
        expect(screen.getByRole("group", { name: "Sort by" })).toBeInTheDocument();
        expect(screen.getByRole("menuitemradio", { name: "Date" })).toHaveAttribute("aria-checked", "true");
        expect(screen.getByRole("menuitemradio", { name: "From" })).toHaveAttribute("aria-checked", "false");
        expect(screen.getByRole("menuitemradio", { name: "Size" })).toBeDisabled();
        expect(screen.getByText("Group replies under the message they answer")).toBeInTheDocument();
        expect(screen.getByText("Conversations are always listed by latest activity.")).toBeInTheDocument();
        // The checked item takes focus, so a keyboard user starts from the current choice.
        expect(screen.getByRole("menuitemradio", { name: "Date" })).toHaveFocus();
    });

    it("opens with Arrow Down from the trigger and starts on the first enabled item when nothing is checked", async () => {
        const user = userEvent.setup();
        render(
            <MenuButton
                label="Filter"
                aria-label="Filter"
                sections={[{ key: "f", items: [{ key: "a", label: "All", role: "menuitemradio", onSelect: vi.fn() }] }]}
            />,
        );

        screen.getByRole("button", { name: "Filter" }).focus();
        await user.keyboard("{ArrowDown}");

        expect(await screen.findByRole("menuitemradio", { name: "All" })).toHaveFocus();
    });

    it("moves with the arrow keys, wrapping and skipping disabled items, and jumps with Home/End", async () => {
        const user = userEvent.setup();
        renderMenu();
        await user.click(screen.getByRole("button", { name: "Sort: Date" }));

        await user.keyboard("{ArrowDown}");
        expect(screen.getByRole("menuitemradio", { name: "From" })).toHaveFocus();

        // Skips the disabled "Size" and lands on the last enabled item.
        await user.keyboard("{ArrowDown}");
        expect(screen.getByRole("menuitemcheckbox", { name: /Show as conversations/ })).toHaveFocus();

        await user.keyboard("{ArrowDown}");
        expect(screen.getByRole("menuitemradio", { name: "Date" })).toHaveFocus();

        await user.keyboard("{ArrowUp}");
        expect(screen.getByRole("menuitemcheckbox", { name: /Show as conversations/ })).toHaveFocus();

        await user.keyboard("{Home}");
        expect(screen.getByRole("menuitemradio", { name: "Date" })).toHaveFocus();

        await user.keyboard("{End}");
        expect(screen.getByRole("menuitemcheckbox", { name: /Show as conversations/ })).toHaveFocus();
    });

    it("chooses an item, closes and returns focus to the trigger", async () => {
        const user = userEvent.setup();
        const { onSelect } = renderMenu();
        await user.click(screen.getByRole("button", { name: "Sort: Date" }));

        await user.click(screen.getByRole("menuitemradio", { name: "From" }));

        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Sort: Date" })).toHaveFocus();
    });

    it("closes on Escape and on Tab, returning focus to the trigger each time", async () => {
        const user = userEvent.setup();
        renderMenu();

        await user.click(screen.getByRole("button", { name: "Sort: Date" }));
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Sort: Date" })).toHaveFocus();

        await user.keyboard("{Enter}");
        expect(await screen.findByRole("menu")).toBeInTheDocument();
        await user.keyboard("{Tab}");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Sort: Date" })).toHaveFocus();
    });

    it("ignores other keys inside the menu", async () => {
        const user = userEvent.setup();
        renderMenu();
        await user.click(screen.getByRole("button", { name: "Sort: Date" }));

        await user.keyboard("{ArrowRight}");

        expect(screen.getByRole("menu")).toBeInTheDocument();
        expect(screen.getByRole("menuitemradio", { name: "Date" })).toHaveFocus();
    });

    it("closes again when the trigger is clicked a second time, and on a click outside", async () => {
        const user = userEvent.setup();
        renderMenu();

        await user.click(screen.getByRole("button", { name: "Sort: Date" }));
        await user.click(screen.getByRole("button", { name: "Sort: Date" }));
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Sort: Date" }));
        expect(await screen.findByRole("menu")).toBeInTheDocument();
        await user.click(document.body);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("does not open while the trigger is disabled", async () => {
        const user = userEvent.setup();
        renderMenu({ disabled: true, title: "Filters don't apply to search results" });

        const trigger = screen.getByRole("button", { name: "Sort: Date" });
        expect(trigger).toBeDisabled();
        expect(trigger).toHaveAttribute("title", "Filters don't apply to search results");
        await user.click(trigger);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("stays put when every item is disabled", async () => {
        const user = userEvent.setup();
        render(
            <MenuButton
                label="Move to"
                aria-label="Move to"
                sections={[{ key: "f", items: [{ key: "a", label: "Archive", disabled: true, onSelect: vi.fn() }] }]}
            />,
        );
        await user.click(screen.getByRole("button", { name: "Move to" }));

        // Nothing focusable inside, so the menu itself takes focus and still handles the keys.
        expect(await screen.findByRole("menu")).toHaveFocus();
        await user.keyboard("{ArrowDown}");
        await user.keyboard("{ArrowUp}");
        await user.keyboard("{Home}");
        await user.keyboard("{End}");

        expect(screen.getByRole("menuitem", { name: "Archive" })).toBeDisabled();
        expect(screen.getByRole("menu")).toHaveFocus();
    });

    it("keeps the menu open for a row that asks to stay, and shows a partially-applied row as mixed", async () => {
        const onSelect = vi.fn();
        const user = userEvent.setup();
        render(
            <MenuButton
                label="Apply label"
                aria-label="Apply label"
                sections={[
                    {
                        key: "labels",
                        items: [
                            { key: "a", label: "Invoices", role: "menuitemcheckbox", checked: "mixed", keepOpen: true, onSelect },
                            { key: "b", label: "Travel", role: "menuitemcheckbox", swatchColor: "#ff0000", keepOpen: true, onSelect },
                        ],
                    },
                ]}
            />,
        );
        await user.click(screen.getByRole("button", { name: "Apply label" }));

        expect(screen.getByRole("menuitemcheckbox", { name: "Invoices" })).toHaveAttribute("aria-checked", "mixed");
        await user.click(screen.getByRole("menuitemcheckbox", { name: "Invoices" }));
        await user.click(screen.getByRole("menuitemcheckbox", { name: "Travel" }));

        expect(onSelect).toHaveBeenCalledTimes(2);
        expect(screen.getByRole("menu")).toBeInTheDocument();
    });

    it("drills into a submenu and back, by click and by keyboard", async () => {
        const onSelect = vi.fn();
        const user = userEvent.setup();
        render(
            <MenuButton
                label="Filter"
                aria-label="Filter"
                sections={[
                    { key: "f", items: [{ key: "all", label: "All", role: "menuitemradio", checked: true, onSelect }] },
                    {
                        key: "more",
                        items: [
                            {
                                key: "labels",
                                label: "Labels",
                                submenu: [{ key: "l", label: "Labels", items: [{ key: "l1", label: "Invoices", onSelect }] }],
                                onSelect,
                            },
                        ],
                    },
                ]}
            />,
        );
        await user.click(screen.getByRole("button", { name: "Filter" }));
        const parent = screen.getByRole("menuitem", { name: "Labels" });
        expect(parent).toHaveAttribute("aria-haspopup", "menu");

        await user.click(parent);
        expect(screen.getByRole("menuitem", { name: "Invoices" })).toHaveFocus();
        expect(screen.queryByRole("menuitemradio", { name: "All" })).not.toBeInTheDocument();

        // Escape leaves the submenu rather than the whole menu, putting focus back on the row it opened.
        await user.keyboard("{Escape}");
        expect(screen.getByRole("menuitem", { name: "Labels" })).toHaveFocus();

        // Arrow Right opens it again, Arrow Left leaves it, Back does the same by click.
        await user.keyboard("{ArrowRight}");
        expect(await screen.findByRole("menuitem", { name: "Invoices" })).toBeInTheDocument();
        await user.keyboard("{ArrowLeft}");
        expect(screen.getByRole("menuitem", { name: "Labels" })).toHaveFocus();
        await user.keyboard("{ArrowRight}");
        await user.click(screen.getByRole("menuitem", { name: "Back to Filter" }));
        expect(screen.getByRole("menuitemradio", { name: "All" })).toBeInTheDocument();

        // And the whole menu closes from the top level, forgetting the submenu it was in.
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("tells its caller when it opens and closes", async () => {
        const onOpenChange = vi.fn();
        const user = userEvent.setup();
        render(
            <MenuButton
                label="Filter"
                aria-label="Filter"
                onOpenChange={onOpenChange}
                sections={[{ key: "f", items: [{ key: "a", label: "All", onSelect: vi.fn() }] }]}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Filter" }));
        expect(onOpenChange).toHaveBeenLastCalledWith(true);
        await user.click(screen.getByRole("menuitem", { name: "All" }));
        expect(onOpenChange).toHaveBeenLastCalledWith(false);
    });

    it("sizes the popup from its own contents and caps a long menu", () => {
        expect(menuHeight([{ key: "a", items: [{ key: "1", label: "One", onSelect: vi.fn() }] }])).toBe(8 + 36);
        expect(
            menuHeight([
                { key: "a", label: "Group", items: [{ key: "1", label: "One", description: "why", onSelect: vi.fn() }] },
                { key: "b", note: "a note", items: [{ key: "2", label: "Two", onSelect: vi.fn() }] },
            ]),
        ).toBe(8 + 24 + 36 + 16 + 9 + 36 + 20);
        const many = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, label: `Item ${i}`, onSelect: vi.fn() }));
        expect(menuHeight([{ key: "a", items: many }])).toBe(460);
    });

    it("gives a note room for every line it wraps to, at the width the menu is drawn at", () => {
        const note = "x".repeat(100);
        const sections = [{ key: "a", note, items: [{ key: "1", label: "One", onSelect: vi.fn() }] }];
        // 35 characters a line at the default 248px: three lines.
        expect(menuHeight(sections)).toBe(8 + 36 + 3 * 16 + 4);
        // Half the width fits half as much, so the same note needs twice the lines.
        expect(menuHeight(sections, 136)).toBe(8 + 36 + 6 * 16 + 4);
    });
});
