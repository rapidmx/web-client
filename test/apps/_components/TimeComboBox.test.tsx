// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TimeComboBox, { TimeOption } from "../../../apps/shared/components/calendar/TimeComboBox.js";

const OPTIONS: TimeOption[] = [
    { value: "11:00", label: "11:00 AM" },
    { value: "11:15", label: "11:15 AM", hint: "(15 mins)" },
    { value: "11:30", label: "11:30 AM" },
];

function setup(props: Partial<React.ComponentProps<typeof TimeComboBox>> = {}) {
    const onSelect = vi.fn();
    const onType = vi.fn();
    const view = render(
        <form onSubmit={(event) => event.preventDefault()}>
            <TimeComboBox aria-label="Start" display="11:15 AM" current="11:15" options={OPTIONS} onSelect={onSelect} onType={onType} {...props} />
            <button type="button">elsewhere</button>
        </form>,
    );
    return { onSelect, onType, input: screen.getByRole("combobox", { name: "Start" }) as HTMLInputElement, ...view };
}

describe("TimeComboBox", () => {
    it("shows the time, and a menu of times when it is focused or clicked, with the current one marked", async () => {
        const user = userEvent.setup();
        const { input } = setup();
        expect(input).toHaveValue("11:15 AM");
        expect(input).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

        await user.click(input);
        const list = screen.getByRole("listbox", { name: "Start options" });
        expect(input).toHaveAttribute("aria-expanded", "true");
        const options = within(list).getAllByRole("option");
        expect(options.map((option) => option.textContent)).toEqual(["11:00 AM", "11:15 AM(15 mins)", "11:30 AM"]);
        expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    });

    it("opens again on a click once a pick has closed it", async () => {
        const user = userEvent.setup();
        const { input } = setup();
        await user.click(input);
        await user.click(screen.getByRole("option", { name: /11:30 AM/ }));
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        await user.click(input);
        expect(screen.getByRole("listbox")).toBeInTheDocument();
    });

    it("picks a time from the menu with a click, and closes", async () => {
        const user = userEvent.setup();
        const { input, onSelect, onType } = setup();
        await user.click(input);
        await user.click(screen.getByRole("option", { name: "11:30 AM" }));
        expect(onSelect).toHaveBeenCalledWith("11:30");
        expect(onType).not.toHaveBeenCalled();
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("understands a time typed instead, when the field is left", async () => {
        const user = userEvent.setup();
        const { input, onSelect, onType } = setup();
        await user.click(input);
        await user.clear(input);
        await user.type(input, "3:47pm");
        expect(input).toHaveValue("3:47pm");
        await user.click(screen.getByRole("button", { name: "elsewhere" }));
        expect(onType).toHaveBeenCalledWith("15:47");
        expect(onSelect).not.toHaveBeenCalled();
        expect(input).toHaveValue("11:15 AM");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("understands a typed time on Enter, without submitting the form", async () => {
        const user = userEvent.setup();
        const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
        const onType = vi.fn();
        render(
            <form onSubmit={submit}>
                <TimeComboBox aria-label="Start" display="11:15 AM" options={OPTIONS} onSelect={vi.fn()} onType={onType} />
            </form>,
        );
        const input = screen.getByRole("combobox", { name: "Start" });
        await user.click(input);
        await user.clear(input);
        await user.type(input, "1130{Enter}");
        expect(onType).toHaveBeenCalledWith("11:30");
        expect(submit).not.toHaveBeenCalled();
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("puts the time back when what was typed is not one, or is left empty", async () => {
        const user = userEvent.setup();
        const { input, onType } = setup();
        await user.click(input);
        await user.clear(input);
        await user.type(input, "soonish");
        fireEvent.blur(input);
        expect(onType).not.toHaveBeenCalled();
        expect(input).toHaveValue("11:15 AM");

        await user.click(input);
        await user.clear(input);
        fireEvent.blur(input);
        expect(onType).not.toHaveBeenCalled();
        // Nothing was typed at all.
        fireEvent.focus(input);
        fireEvent.blur(input);
        expect(onType).not.toHaveBeenCalled();
    });

    it("puts the time back on Escape, closing only the menu", async () => {
        const user = userEvent.setup();
        const outer = vi.fn();
        const onType = vi.fn();
        render(
            <div onKeyDown={outer}>
                <TimeComboBox aria-label="Start" display="11:15 AM" options={OPTIONS} onSelect={vi.fn()} onType={onType} />
            </div>,
        );
        const input = screen.getByRole("combobox", { name: "Start" });
        await user.click(input);
        await user.clear(input);
        await user.type(input, "4pm");
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(input).toHaveValue("11:15 AM");
        expect(onType).not.toHaveBeenCalled();
        // The Escape was the menu's: the dialog around it doesn't hear it.
        expect(outer).not.toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));

        // With the menu already closed, Escape is left for whatever holds the field.
        await user.keyboard("{Escape}");
        expect(outer).toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
    });

    it("moves through the menu with the arrow keys, from the current time, and picks with Enter", async () => {
        const user = userEvent.setup();
        const { input, onSelect } = setup();
        input.focus();
        await user.keyboard("{ArrowDown}");
        expect(input).toHaveAttribute("aria-activedescendant", expect.stringMatching(/-2$/));
        await user.keyboard("{ArrowDown}");
        // Stays on the last.
        expect(input).toHaveAttribute("aria-activedescendant", expect.stringMatching(/-2$/));
        await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
        expect(input).toHaveAttribute("aria-activedescendant", expect.stringMatching(/-0$/));
        await user.keyboard("{Enter}");
        expect(onSelect).toHaveBeenCalledWith("11:00");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("starts from the first time when none is current, and opens the menu on an arrow key", async () => {
        const user = userEvent.setup();
        setup({ current: undefined });
        const input = screen.getByRole("combobox", { name: "Start" });
        fireEvent.keyDown(input, { key: "ArrowDown" });
        expect(screen.getByRole("listbox")).toBeInTheDocument();
        expect(input).toHaveAttribute("aria-activedescendant", expect.stringMatching(/-0$/));
        await user.keyboard("{Escape}");
    });

    it("scrolls the current time into view when the menu opens, where the browser can", async () => {
        const user = userEvent.setup();
        const scrollIntoView = vi.fn();
        Element.prototype.scrollIntoView = scrollIntoView;
        try {
            const { input } = setup();
            await user.click(input);
            expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
        } finally {
            delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
        }
    });
});
