// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import EmptyFolderBar from "../../../apps/shared/components/mail/EmptyFolderBar.js";

describe("EmptyFolderBar", () => {
    it("names the folder on the button, says how many items it holds, and reports the click", async () => {
        const onEmpty = vi.fn();
        const user = userEvent.setup();
        render(<EmptyFolderBar folderName="Deleted Items" count={12} disabled={false} onEmpty={onEmpty} />);

        expect(screen.getByText("12 items")).toBeInTheDocument();
        const button = screen.getByRole("button", { name: "Empty Deleted Items" });
        expect(button).toHaveAttribute("title", "Permanently delete everything in Deleted Items");
        await user.click(button);

        expect(onEmpty).toHaveBeenCalledTimes(1);
    });

    it("says one item in the singular, and nothing about a count that is not known", () => {
        const { rerender } = render(<EmptyFolderBar folderName="Junk Email" count={1} disabled={false} onEmpty={vi.fn()} />);
        expect(screen.getByText("1 item")).toBeInTheDocument();

        rerender(<EmptyFolderBar folderName="Junk Email" disabled={false} onEmpty={vi.fn()} />);
        expect(screen.queryByText(/items?$/)).not.toBeInTheDocument();
    });

    it("is disabled with its reason as the tooltip", async () => {
        const onEmpty = vi.fn();
        const user = userEvent.setup();
        render(<EmptyFolderBar folderName="Deleted Items" disabled disabledReason="This folder is already empty" onEmpty={onEmpty} />);

        const button = screen.getByRole("button", { name: "Empty Deleted Items" });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("title", "This folder is already empty");
        await user.click(button);

        expect(onEmpty).not.toHaveBeenCalled();
    });
});
