// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TimeZonePicker from "../../../../lib/components/pickers/TimeZonePicker.js";

const AT = new Date("2026-09-29T12:00:00Z");
const ZONES = ["Africa/Abidjan", "America/Adak", "America/Indiana/Knox", "America/Los_Angeles", "Asia/Tokyo", "Europe/Berlin", "UTC"];

function setup(props: Partial<React.ComponentProps<typeof TimeZonePicker>> = {}) {
    const onChange = vi.fn();
    const outer = vi.fn();
    render(
        <div onKeyDown={outer}>
            <form onSubmit={(event) => event.preventDefault()}>
                <TimeZonePicker aria-label="Zone" value="America/Los_Angeles" zones={ZONES} onChange={onChange} at={AT} {...props} />
            </form>
            <button type="button">elsewhere</button>
        </div>,
    );
    return { onChange, outer, trigger: screen.getByRole("combobox", { name: "Zone" }) };
}

const searchBox = () => screen.getByRole("searchbox", { name: "Search time zones" });
const optionTexts = () => within(screen.getByRole("listbox", { name: "Time zones" })).getAllByRole("option").map((option) => option.textContent);

describe("TimeZonePicker", () => {
    it("shows the chosen zone as the city, its region and the offset from UTC", () => {
        const { trigger } = setup();
        expect(trigger).toHaveTextContent("Los Angeles, America (GMT-07:00)");
        expect(trigger).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("lists every zone from west to east and then by city, the same way, with the chosen one marked, and a search box", async () => {
        const user = userEvent.setup();
        const { trigger } = setup();
        await user.click(trigger);
        expect(trigger).toHaveAttribute("aria-expanded", "true");
        expect(searchBox()).toHaveFocus();
        expect(optionTexts()).toEqual([
            "Adak, America (GMT-09:00)",
            "Los Angeles, America (GMT-07:00)",
            "Knox, America/Indiana (GMT-05:00)",
            "Abidjan, Africa (GMT+00:00)",
            "UTC (GMT+00:00)",
            "Berlin, Europe (GMT+02:00)",
            "Tokyo, Asia (GMT+09:00)",
        ]);
        const selected = screen.getAllByRole("option").filter((option) => option.getAttribute("aria-selected") === "true");
        expect(selected.map((option) => option.textContent)).toEqual(["Los Angeles, America (GMT-07:00)"]);
    });

    it("narrows the list to the zones matching every word typed, in the name or the offset", async () => {
        const user = userEvent.setup();
        const { trigger } = setup();
        await user.click(trigger);
        await user.type(searchBox(), "AMERICA indiana");
        expect(optionTexts()).toEqual(["Knox, America/Indiana (GMT-05:00)"]);

        await user.clear(searchBox());
        await user.type(searchBox(), "gmt+09");
        expect(optionTexts()).toEqual(["Tokyo, Asia (GMT+09:00)"]);

        await user.clear(searchBox());
        await user.type(searchBox(), "los_angeles");
        expect(optionTexts()).toEqual(["Los Angeles, America (GMT-07:00)"]);

        await user.clear(searchBox());
        await user.type(searchBox(), "atlantis");
        expect(screen.queryAllByRole("option")).toHaveLength(0);
        expect(screen.getByText("No time zones match.")).toBeInTheDocument();
    });

    it("chooses a zone with a click, closes, and hands focus back to the button", async () => {
        const user = userEvent.setup();
        const { trigger, onChange } = setup();
        await user.click(trigger);
        await user.click(screen.getByRole("option", { name: "Berlin, Europe (GMT+02:00)" }));
        expect(onChange).toHaveBeenCalledWith("Europe/Berlin");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });

    it("says nothing when the zone already chosen is chosen again", async () => {
        const user = userEvent.setup();
        const { trigger, onChange } = setup();
        await user.click(trigger);
        await user.click(screen.getByRole("option", { name: /^Los Angeles/ }));
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("moves through the list with the arrow keys, from the chosen zone, and chooses with Enter without submitting the form", async () => {
        const user = userEvent.setup();
        const { trigger, onChange } = setup();
        trigger.focus();
        await user.keyboard("{ArrowDown}");
        expect(searchBox()).toHaveFocus();
        await user.keyboard("{ArrowDown}");
        // From Los Angeles (index 1) to the next.
        expect(searchBox()).toHaveAttribute("aria-activedescendant", expect.stringMatching(/-2$/));
        await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
        expect(searchBox()).toHaveAttribute("aria-activedescendant", expect.stringMatching(/-6$/));
        await user.keyboard("{ArrowUp}{ArrowUp}");
        expect(searchBox()).toHaveAttribute("aria-activedescendant", expect.stringMatching(/-4$/));
        await user.keyboard("{Enter}");
        expect(onChange).toHaveBeenCalledWith("UTC");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("chooses the one zone left by a search on Enter, and nothing while several are left and none is active", async () => {
        const user = userEvent.setup();
        const { trigger, onChange } = setup();
        await user.click(trigger);
        await user.type(searchBox(), "america{Enter}");
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByRole("listbox")).toBeInTheDocument();
        await user.type(searchBox(), " adak{Enter}");
        expect(onChange).toHaveBeenCalledWith("America/Adak");
    });

    it("does nothing on Enter when a search matches nothing", async () => {
        const user = userEvent.setup();
        const { trigger, onChange } = setup();
        await user.click(trigger);
        await user.type(searchBox(), "atlantis{Enter}");
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByRole("listbox")).toBeInTheDocument();
    });

    it("opens on the arrow key only when closed, and starts from the first zone when the chosen one isn't listed", async () => {
        const user = userEvent.setup();
        const { trigger } = setup({ value: "Nowhere/Land" });
        trigger.focus();
        await user.keyboard("{ArrowDown}");
        expect(screen.getByRole("listbox")).toBeInTheDocument();
        await user.keyboard("{ArrowDown}");
        expect(searchBox()).toHaveAttribute("aria-activedescendant", expect.stringMatching(/-0$/));
        // An arrow on the button while the list is open is left alone.
        fireEvent.keyDown(trigger, { key: "ArrowDown" });
        expect(screen.getByRole("listbox")).toBeInTheDocument();
        expect(trigger).toHaveTextContent("Nowhere/Land");
    });

    it("closes on Escape with the search cleared and the focus back on the button, without the dialog around it hearing", async () => {
        const user = userEvent.setup();
        const { trigger, outer, onChange } = setup();
        await user.click(trigger);
        await user.type(searchBox(), "tok");
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
        expect(onChange).not.toHaveBeenCalled();
        expect(outer).not.toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
        await user.click(trigger);
        expect(searchBox()).toHaveValue("");
        expect(optionTexts()).toHaveLength(ZONES.length);
    });

    it("closes on a click elsewhere, and on the button again, but not on a click inside it", async () => {
        const user = userEvent.setup();
        const { trigger } = setup();
        await user.click(trigger);
        await user.click(searchBox());
        expect(screen.getByRole("listbox")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "elsewhere" }));
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

        await user.click(trigger);
        await user.click(trigger);
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("scrolls the chosen zone into view when it opens, where the browser can", async () => {
        const user = userEvent.setup();
        const scrollIntoView = vi.fn();
        Element.prototype.scrollIntoView = scrollIntoView;
        try {
            const { trigger } = setup();
            await user.click(trigger);
            expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
        } finally {
            delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
        }
    });

    it("reads offsets on now when no date is given, and passes its id and description on to the button", () => {
        render(<TimeZonePicker id="zone" aria-describedby="help" value="UTC" zones={["UTC"]} onChange={vi.fn()} />);
        const trigger = screen.getByRole("combobox");
        expect(trigger).toHaveAttribute("id", "zone");
        expect(trigger).toHaveAttribute("aria-describedby", "help");
        expect(trigger).toHaveTextContent("UTC (GMT+00:00)");
    });
});
