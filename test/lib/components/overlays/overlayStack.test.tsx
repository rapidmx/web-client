// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React, { useRef } from "react";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Drawer from "../../../../lib/components/overlays/Drawer.js";
import Modal from "../../../../lib/components/overlays/Modal.js";
import { useOverlayDialog } from "../../../../lib/components/overlays/overlayStack.js";

/** Fires a Tab keydown on whatever has focus, returning whether the trap prevented the default move. */
function pressTab(shiftKey = false): boolean {
    const target = document.activeElement ?? document.body;
    const event = createEvent.keyDown(target, { key: "Tab", shiftKey });
    fireEvent(target, event);
    return event.defaultPrevented;
}

describe("overlay focus trap", () => {
    function Form() {
        return (
            <Modal open={true} onClose={vi.fn()} title="Edit">
                <input aria-label="first field" />
                <button type="button" disabled>
                    disabled
                </button>
                <div tabIndex={-1}>not tabbable</div>
                <div hidden>
                    <button type="button">hidden button</button>
                </div>
                <button type="button" {...{ inert: true }}>
                    inert button
                </button>
                <button type="button">Save</button>
            </Modal>
        );
    }

    it("wraps Tab from the last tabbable element to the first (the Close button)", () => {
        render(<Form />);
        screen.getByRole("button", { name: "Save" }).focus();
        expect(pressTab()).toBe(true);
        expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });

    it("wraps Shift+Tab from the first tabbable element to the last, skipping disabled/hidden/inert/tabindex=-1", () => {
        render(<Form />);
        screen.getByRole("button", { name: "Close" }).focus();
        expect(pressTab(true)).toBe(true);
        expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    });

    it("sends Shift+Tab from the dialog container itself (its initial focus) to the last element", () => {
        render(<Form />);
        expect(screen.getByRole("dialog")).toHaveFocus();
        expect(pressTab(true)).toBe(true);
        expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    });

    it("lets Tab/Shift+Tab move normally between elements in the middle of the dialog", () => {
        render(<Form />);
        screen.getByRole("textbox", { name: "first field" }).focus();
        expect(pressTab()).toBe(false);
        expect(pressTab(true)).toBe(false);
    });

    it("pulls focus back inside when it has escaped the dialog", () => {
        render(
            <>
                <button type="button">outside</button>
                <Form />
            </>,
        );
        const outside = screen.getByRole("button", { name: "outside" });

        outside.focus();
        expect(pressTab()).toBe(true);
        expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

        outside.focus();
        expect(pressTab(true)).toBe(true);
        expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    });

    it("keeps focus on the dialog container when it has nothing tabbable", () => {
        function Bare() {
            const ref = useRef<HTMLDivElement>(null);
            useOverlayDialog(true, ref, vi.fn());
            return <div ref={ref} tabIndex={-1} data-testid="bare" />;
        }
        render(<Bare />);
        const bare = screen.getByTestId("bare");
        document.body.focus();
        expect(pressTab()).toBe(true);
        expect(bare).toHaveFocus();
    });

    it("ignores Tab when the dialog element isn't mounted, and ignores other keys", () => {
        const onClose = vi.fn();
        function Detached() {
            const ref = useRef<HTMLDivElement>(null);
            useOverlayDialog(true, ref, onClose);
            return null;
        }
        render(<Detached />);
        expect(pressTab()).toBe(false);
        fireEvent.keyDown(document.body, { key: "Enter" });
        expect(onClose).not.toHaveBeenCalled();
    });
});

describe("overlay stacking", () => {
    it("only the topmost overlay handles Escape, closing one layer at a time", async () => {
        const drawerClose = vi.fn();
        const modalClose = vi.fn();
        function Harness() {
            const [modalOpen, setModalOpen] = React.useState(true);
            const [drawerOpen, setDrawerOpen] = React.useState(true);
            return (
                <Drawer
                    open={drawerOpen}
                    onClose={() => {
                        drawerClose();
                        setDrawerOpen(false);
                    }}
                    title="Folders"
                >
                    <Modal
                        open={modalOpen}
                        onClose={() => {
                            modalClose();
                            setModalOpen(false);
                        }}
                        title="Confirm"
                    >
                        <button type="button">OK</button>
                    </Modal>
                </Drawer>
            );
        }
        const user = userEvent.setup();
        render(<Harness />);
        // Both mount open in one commit (child effects run first) - the nested Modal still ends up on top
        // and keeps focus rather than having it stolen by the Drawer containing it.
        expect(screen.getByRole("dialog", { name: "Confirm" })).toHaveFocus();

        await user.keyboard("{Escape}");
        expect(modalClose).toHaveBeenCalledTimes(1);
        expect(drawerClose).not.toHaveBeenCalled();
        expect(screen.queryByRole("dialog", { name: "Confirm" })).not.toBeInTheDocument();

        await user.keyboard("{Escape}");
        expect(drawerClose).toHaveBeenCalledTimes(1);
        expect(modalClose).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("traps Tab in the topmost overlay only, and restores focus into the lower one when the top closes", async () => {
        function Harness() {
            const [modalOpen, setModalOpen] = React.useState(false);
            return (
                <Drawer open={true} onClose={vi.fn()} title="Folders">
                    <button type="button" onClick={() => setModalOpen(true)}>
                        Open confirm
                    </button>
                    <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Confirm">
                        <button type="button">OK</button>
                    </Modal>
                </Drawer>
            );
        }
        const user = userEvent.setup();
        render(<Harness />);
        const opener = screen.getByRole("button", { name: "Open confirm" });
        await user.click(opener);

        const modal = screen.getByRole("dialog", { name: "Confirm" });
        expect(modal).toHaveFocus();
        screen.getByRole("button", { name: "OK" }).focus();
        expect(pressTab()).toBe(true);
        // Wrapped within the Modal (to its own Close button), not into the Drawer underneath.
        expect(modal.contains(document.activeElement)).toBe(true);

        await user.keyboard("{Escape}");
        expect(opener).toHaveFocus();
    });

    it("puts a shallower overlay opened in a later commit on top of an already-open nested one (round-4 review)", async () => {
        const nestedClose = vi.fn();
        const laterClose = vi.fn();
        function Harness({ laterOpen }: { laterOpen: boolean }) {
            return (
                <>
                    <Drawer open={true} onClose={vi.fn()} title="Folders">
                        <Modal open={true} onClose={nestedClose} title="Nested">
                            <div />
                        </Modal>
                    </Drawer>
                    <Modal open={laterOpen} onClose={laterClose} title="Later">
                        <div />
                    </Modal>
                </>
            );
        }
        const user = userEvent.setup();
        const { rerender } = render(<Harness laterOpen={false} />);
        // Let the first commit's microtask pass, so the next open is a separate commit.
        await Promise.resolve();
        rerender(<Harness laterOpen={true} />);
        expect(screen.getByRole("dialog", { name: "Later" })).toHaveFocus();

        await user.keyboard("{Escape}");
        expect(laterClose).toHaveBeenCalledTimes(1);
        expect(nestedClose).not.toHaveBeenCalled();
    });

    it("an overlay closing out of order leaves the remaining top overlay in charge", async () => {
        const lowerClose = vi.fn();
        const upperClose = vi.fn();
        function Harness({ lowerOpen }: { lowerOpen: boolean }) {
            return (
                <>
                    <Modal open={lowerOpen} onClose={lowerClose} title="Lower">
                        <div />
                    </Modal>
                    <Drawer open={true} onClose={upperClose} title="Upper">
                        <div />
                    </Drawer>
                </>
            );
        }
        const user = userEvent.setup();
        const { rerender, unmount } = render(<Harness lowerOpen={true} />);
        rerender(<Harness lowerOpen={false} />);

        await user.keyboard("{Escape}");
        expect(upperClose).toHaveBeenCalledTimes(1);
        expect(lowerClose).not.toHaveBeenCalled();

        unmount();
        await user.keyboard("{Escape}");
        expect(upperClose).toHaveBeenCalledTimes(1);
    });
});
