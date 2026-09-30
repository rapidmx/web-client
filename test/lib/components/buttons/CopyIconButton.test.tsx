// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import CopyIconButton from "../../../../lib/components/buttons/CopyIconButton.js";

afterEach(() => vi.restoreAllMocks());

describe("CopyIconButton", () => {
    it("is an icon-only button named for what it copies", () => {
        render(<CopyIconButton value="jane@example.com" label="Copy address" />);
        const button = screen.getByRole("button", { name: "Copy address" });
        expect(button).toHaveAttribute("title", "Copy address");
        expect(button.textContent).toBe("");
        expect(button.querySelector("svg")).not.toBeNull();
    });

    it("copies the value and says so", async () => {
        const user = userEvent.setup();
        const writeText = vi.spyOn(navigator.clipboard, "writeText");
        render(<CopyIconButton value="jane@example.com" label="Copy address" className="ml-1" />);
        await user.click(screen.getByRole("button", { name: "Copy address" }));
        await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copied"));
        expect(writeText).toHaveBeenCalledWith("jane@example.com");
    });

    it("says when it could not copy", async () => {
        const user = userEvent.setup();
        vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
        render(<CopyIconButton value="jane@example.com" label="Copy address" />);
        await user.click(screen.getByRole("button", { name: "Copy address" }));
        await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Couldn’t copy"));
    });
});
