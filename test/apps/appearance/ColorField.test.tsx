// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ColorField from "../../../apps/shared/appearance/ColorField.js";

function field(props: Partial<React.ComponentProps<typeof ColorField>> = {}) {
    const onChange = vi.fn();
    const onReset = vi.fn();
    render(
        <ColorField
            id="c"
            label="Primary"
            description="Links and focus rings."
            value={undefined}
            current="#0d9488"
            onChange={onChange}
            onReset={onReset}
            {...props}
        />,
    );
    return { onChange, onReset };
}

describe("ColorField", () => {
    it("labels both inputs, describes the colour, and shows the app's current colour while none is chosen", () => {
        field();
        const hex = screen.getByLabelText("Primary");
        expect(hex).toHaveValue("#0d9488");
        expect(hex).toHaveAttribute("aria-describedby", "c-description");
        expect(screen.getByLabelText("Primary picker")).toHaveValue("#0d9488");
        expect(screen.getByText("Links and focus rings.")).toHaveAttribute("id", "c-description");
    });

    it("shows the chosen colour instead", () => {
        field({ value: "#112233" });
        expect(screen.getByLabelText("Primary")).toHaveValue("#112233");
        expect(screen.getByLabelText("Primary picker")).toHaveValue("#112233");
    });

    it("reports a picked colour at once, normalised", () => {
        const { onChange } = field();
        fireEvent.change(screen.getByLabelText("Primary picker"), { target: { value: "#aabbcc" } });
        expect(onChange).toHaveBeenCalledWith("#aabbcc");
    });

    it("applies a full #rrggbb as it is typed - and not the short forms that are only on the way to one", async () => {
        const user = userEvent.setup();
        const { onChange } = field();
        const hex = screen.getByLabelText("Primary");
        await user.clear(hex);
        await user.type(hex, "#1a2b");
        // "#1a2" was a colour on the way past, and applying it would have flashed #11aa22.
        expect(onChange).not.toHaveBeenCalled();
        expect(hex).toHaveAttribute("aria-invalid", "true");
        expect(screen.getByRole("alert")).toHaveTextContent("Use a colour like #1a2b3c.");
        expect(hex).toHaveAttribute("aria-describedby", "c-error c-description");
        await user.type(hex, "3c");
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenLastCalledWith("#1a2b3c");
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        await user.clear(hex);
        await user.type(hex, "AABBCC");
        expect(onChange).toHaveBeenLastCalledWith("#aabbcc");
    });

    it("applies a short colour when the field is left, and only if it is a change", async () => {
        const user = userEvent.setup();
        const { onChange } = field({ value: "#112233" });
        const hex = screen.getByLabelText("Primary");
        await user.clear(hex);
        await user.type(hex, "abc");
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        await user.tab();
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenLastCalledWith("#aabbcc");
        // The same colour again, written out: applied as it is typed, and leaving adds nothing.
        onChange.mockClear();
        await user.click(hex);
        await user.clear(hex);
        await user.type(hex, "112233");
        expect(onChange).toHaveBeenCalledTimes(1);
        await user.tab();
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("leaving the field untouched applies nothing", async () => {
        const user = userEvent.setup();
        const { onChange } = field({ value: "#112233" });
        await user.click(screen.getByLabelText("Primary"));
        await user.tab();
        expect(onChange).not.toHaveBeenCalled();
    });

    it("goes back to the colour when the field is left with something that isn't one", async () => {
        const user = userEvent.setup();
        field({ value: "#112233" });
        const hex = screen.getByLabelText("Primary");
        await user.clear(hex);
        await user.type(hex, "nope");
        expect(hex).toHaveValue("nope");
        await user.tab();
        expect(hex).toHaveValue("#112233");
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("resets, and has nothing to reset while no colour is chosen", async () => {
        const user = userEvent.setup();
        const { onReset } = field({ value: "#112233" });
        await user.click(screen.getByRole("button", { name: "Reset primary to the default" }));
        expect(onReset).toHaveBeenCalled();
    });

    it("disables the reset while the colour is the app's own", () => {
        field();
        expect(screen.getByRole("button", { name: "Reset primary to the default" })).toBeDisabled();
    });

    it("has no reset for a field with nothing to reset to", () => {
        field({ onReset: undefined });
        expect(screen.queryByRole("button", { name: /Reset/ })).not.toBeInTheDocument();
    });

    it("clears a half-typed value when Reset is used", async () => {
        const user = userEvent.setup();
        field({ value: "#112233" });
        const hex = screen.getByLabelText("Primary");
        await user.clear(hex);
        await user.type(hex, "zz");
        await user.click(screen.getByRole("button", { name: "Reset primary to the default" }));
        expect(hex).toHaveValue("#112233");
    });
});
