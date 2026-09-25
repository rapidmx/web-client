// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HiOutlinePlus } from "react-icons/hi2";
import { describe, expect, it, vi } from "vitest";
import FloatingActionButton from "../../../apps/shared/components/layout/FloatingActionButton.js";

describe("FloatingActionButton", () => {
    it("is a real button named by its label, showing only the icon", () => {
        render(<FloatingActionButton label="New thing" icon={HiOutlinePlus} onClick={() => undefined} />);

        const button = screen.getByRole("button", { name: "New thing" });
        expect(button).toHaveAttribute("type", "button");
        expect(button).toHaveTextContent("");
        expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    });

    it("floats at the bottom right above the bottom tab bar, on the phone layout only", () => {
        render(<FloatingActionButton label="New thing" icon={HiOutlinePlus} onClick={() => undefined} />);

        expect(screen.getByRole("button", { name: "New thing" })).toHaveClass("md:hidden", "fixed", "right-4", "bottom-[4.5rem]", "rounded-full", "bg-primary");
    });

    it("calls onClick when pressed, and passes other button attributes through", async () => {
        const onClick = vi.fn();
        const onFocus = vi.fn();
        const user = userEvent.setup();
        render(<FloatingActionButton label="New thing" icon={HiOutlinePlus} onClick={onClick} onFocus={onFocus} />);

        await user.tab();
        expect(onFocus).toHaveBeenCalledTimes(1);
        await user.keyboard("{Enter}");
        expect(onClick).toHaveBeenCalledTimes(1);
        await user.click(screen.getByRole("button", { name: "New thing" }));
        expect(onClick).toHaveBeenCalledTimes(2);
    });
});
