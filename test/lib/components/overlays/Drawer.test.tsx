// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Drawer from "../../../../lib/components/overlays/Drawer.js";

describe("Drawer", () => {
    it("renders nothing when closed", () => {
        render(
            <Drawer open={false} onClose={vi.fn()} title="Folders">
                <div>content</div>
            </Drawer>,
        );
        expect(screen.queryByText("content")).not.toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("renders its title and children into a portal on document.body when open", () => {
        render(
            <Drawer open={true} onClose={vi.fn()} title="Folders">
                <div>content</div>
            </Drawer>,
        );
        const dialog = screen.getByRole("dialog", { name: "Folders" });
        expect(dialog).toBeInTheDocument();
        expect(document.body.contains(dialog)).toBe(true);
        expect(screen.getByText("content")).toBeInTheDocument();
        expect(screen.getByText("Folders")).toBeInTheDocument();
    });

    it("slides in from the left by default", () => {
        render(
            <Drawer open={true} onClose={vi.fn()} title="Folders">
                <div>content</div>
            </Drawer>,
        );
        expect(screen.getByRole("dialog")).toHaveClass("left-0");
    });

    it("fills the whole window when asked to, whichever side it is on", () => {
        render(
            <Drawer open={true} onClose={vi.fn()} title="Folders" side="right" fullScreen>
                <div>content</div>
            </Drawer>,
        );
        const dialog = screen.getByRole("dialog");
        expect(dialog).toHaveClass("inset-0", "w-full");
        expect(dialog).not.toHaveClass("w-72");
        expect(dialog).not.toHaveClass("right-0");
        expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    });

    it("is a narrow panel beside the page unless it is asked to fill the window", () => {
        render(
            <Drawer open={true} onClose={vi.fn()} title="Folders">
                <div>content</div>
            </Drawer>,
        );
        expect(screen.getByRole("dialog")).toHaveClass("w-72");
    });

    it("slides in from the right when side is set to right", () => {
        render(
            <Drawer open={true} onClose={vi.fn()} title="Folders" side="right">
                <div>content</div>
            </Drawer>,
        );
        expect(screen.getByRole("dialog")).toHaveClass("right-0");
    });

    it("calls onClose when the backdrop is clicked", async () => {
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(
            <Drawer open={true} onClose={onClose} title="Folders">
                <div>content</div>
            </Drawer>,
        );
        const backdrop = screen.getByRole("dialog").parentElement as HTMLElement;
        await user.click(backdrop);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not call onClose when the panel itself is clicked", async () => {
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(
            <Drawer open={true} onClose={onClose} title="Folders">
                <div>content</div>
            </Drawer>,
        );
        await user.click(screen.getByText("content"));
        expect(onClose).not.toHaveBeenCalled();
    });

    it("calls onClose when the close button is clicked", async () => {
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(
            <Drawer open={true} onClose={onClose} title="Folders">
                <div>content</div>
            </Drawer>,
        );
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("calls onClose when Escape is pressed", async () => {
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(
            <Drawer open={true} onClose={onClose} title="Folders">
                <div>content</div>
            </Drawer>,
        );
        await user.keyboard("{Escape}");
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not call onClose for a non-Escape key", async () => {
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(
            <Drawer open={true} onClose={onClose} title="Folders">
                <div>content</div>
            </Drawer>,
        );
        await user.keyboard("{Enter}");
        expect(onClose).not.toHaveBeenCalled();
    });

    it("does not attempt to restore focus to a previously-focused element that isn't an HTMLElement", async () => {
        // SVGElement (unlike HTMLElement) is a real, focusable DOM element that does NOT extend
        // HTMLElement — covers the instanceof guard's false branch on the focus-restore cleanup.
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("tabindex", "0");
        document.body.appendChild(svg);
        svg.focus();
        const focusSpy = vi.spyOn(svg, "focus");

        function Harness() {
            const [open, setOpen] = React.useState(true);
            return (
                <Drawer open={open} onClose={() => setOpen(false)} title="Folders">
                    <div>content</div>
                </Drawer>
            );
        }
        const user = userEvent.setup();
        render(<Harness />);

        await user.keyboard("{Escape}");

        expect(focusSpy).not.toHaveBeenCalled();
        document.body.removeChild(svg);
    });

    it("moves focus into the drawer on open and restores it to the trigger on close", async () => {
        function Harness() {
            const [open, setOpen] = React.useState(false);
            return (
                <div>
                    <button onClick={() => setOpen(true)}>Open</button>
                    <Drawer open={open} onClose={() => setOpen(false)} title="Folders">
                        <div>content</div>
                    </Drawer>
                </div>
            );
        }
        const user = userEvent.setup();
        render(<Harness />);

        const trigger = screen.getByRole("button", { name: "Open" });
        trigger.focus();
        await user.click(trigger);

        expect(screen.getByRole("dialog")).toHaveFocus();

        await user.keyboard("{Escape}");

        expect(trigger).toHaveFocus();
    });

    it("stops listening for Escape after unmount", async () => {
        const onClose = vi.fn();
        const { unmount } = render(
            <Drawer open={true} onClose={onClose} title="Folders">
                <div>content</div>
            </Drawer>,
        );
        unmount();
        const user = userEvent.setup();
        await user.keyboard("{Escape}");
        expect(onClose).not.toHaveBeenCalled();
    });
});
