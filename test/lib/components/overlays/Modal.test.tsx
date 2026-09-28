// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Modal from "../../../../lib/components/overlays/Modal.js";

describe("Modal", () => {
    it("renders nothing when closed", () => {
        render(
            <Modal open={false} onClose={vi.fn()} title="Hello">
                <div>content</div>
            </Modal>,
        );
        expect(screen.queryByText("content")).not.toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("renders its title and children into a portal on document.body when open", () => {
        render(
            <Modal open={true} onClose={vi.fn()} title="Hello">
                <div>content</div>
            </Modal>,
        );
        const dialog = screen.getByRole("dialog", { name: "Hello" });
        expect(dialog).toBeInTheDocument();
        expect(document.body.contains(dialog)).toBe(true);
        expect(screen.getByText("content")).toBeInTheDocument();
        expect(screen.getByText("Hello")).toBeInTheDocument();
    });

    it("calls onClose when the backdrop is clicked", async () => {
        const onClose = vi.fn();
        const user = userEvent.setup();
        const { container } = render(
            <Modal open={true} onClose={onClose} title="Hello">
                <div>content</div>
            </Modal>,
        );
        void container;
        const backdrop = screen.getByRole("dialog").parentElement as HTMLElement;
        await user.click(backdrop);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not call onClose when the dialog body itself is clicked", async () => {
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(
            <Modal open={true} onClose={onClose} title="Hello">
                <div>content</div>
            </Modal>,
        );
        await user.click(screen.getByText("content"));
        expect(onClose).not.toHaveBeenCalled();
    });

    it("calls onClose when the close button is clicked", async () => {
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(
            <Modal open={true} onClose={onClose} title="Hello">
                <div>content</div>
            </Modal>,
        );
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("calls onClose when Escape is pressed", async () => {
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(
            <Modal open={true} onClose={onClose} title="Hello">
                <div>content</div>
            </Modal>,
        );
        await user.keyboard("{Escape}");
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not call onClose for a non-Escape key", async () => {
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(
            <Modal open={true} onClose={onClose} title="Hello">
                <div>content</div>
            </Modal>,
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
                <Modal open={open} onClose={() => setOpen(false)} title="Hello">
                    <div>content</div>
                </Modal>
            );
        }
        const user = userEvent.setup();
        render(<Harness />);

        await user.keyboard("{Escape}");

        expect(focusSpy).not.toHaveBeenCalled();
        document.body.removeChild(svg);
    });

    it("moves focus into the dialog on open and restores it to the trigger on close", async () => {
        function Harness() {
            const [open, setOpen] = React.useState(false);
            return (
                <div>
                    <button onClick={() => setOpen(true)}>Open</button>
                    <Modal open={open} onClose={() => setOpen(false)} title="Hello">
                        <div>content</div>
                    </Modal>
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
            <Modal open={true} onClose={onClose} title="Hello">
                <div>content</div>
            </Modal>,
        );
        unmount();
        const user = userEvent.setup();
        await user.keyboard("{Escape}");
        expect(onClose).not.toHaveBeenCalled();
    });
});
