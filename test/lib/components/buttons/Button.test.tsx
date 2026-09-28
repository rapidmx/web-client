// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Button from "../../../../lib/components/buttons/Button.js";

describe("Button", () => {
    it("renders its children and defaults to the primary variant", () => {
        render(<Button>Save</Button>);
        const button = screen.getByRole("button", { name: "Save" });
        expect(button.className).toContain("bg-gradient-to-b");
    });

    it("renders the secondary variant's classes", () => {
        render(<Button variant="secondary">Cancel</Button>);
        expect(screen.getByRole("button", { name: "Cancel" }).className).toContain("border-border");
    });

    it("renders the text variant's classes", () => {
        render(<Button variant="text">Learn more</Button>);
        expect(screen.getByRole("button", { name: "Learn more" }).className).toContain("hover:not-disabled:underline");
    });

    it("shows a loading spinner when loading is true", () => {
        const { container } = render(<Button loading>Saving</Button>);
        expect(container.querySelector(".animate-spin")).not.toBeNull();
    });

    it("shows no spinner when loading is unset", () => {
        const { container } = render(<Button>Save</Button>);
        expect(container.querySelector(".animate-spin")).toBeNull();
    });

    it("merges a custom className with its own base/variant classes", () => {
        render(<Button className="mt-4">Save</Button>);
        const button = screen.getByRole("button", { name: "Save" });
        expect(button.className).toContain("mt-4");
        expect(button.className).toContain("inline-flex");
    });

    it("forwards standard button props and calls onClick", async () => {
        const onClick = vi.fn();
        const user = userEvent.setup();
        render(
            <Button type="submit" disabled={false} onClick={onClick}>
                Submit
            </Button>,
        );
        const button = screen.getByRole("button", { name: "Submit" });
        expect(button).toHaveAttribute("type", "submit");

        await user.click(button);
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("disables the button and does not call onClick when disabled", async () => {
        const onClick = vi.fn();
        const user = userEvent.setup();
        render(
            <Button disabled onClick={onClick}>
                Submit
            </Button>,
        );
        const button = screen.getByRole("button", { name: "Submit" });
        expect(button).toBeDisabled();

        await user.click(button);
        expect(onClick).not.toHaveBeenCalled();
    });
});
