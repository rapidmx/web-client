// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React, { useContext } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import EventShell, { EventShellContext, EventShellProps, anchorOf, placePopover } from "../../../apps/shared/components/calendar/EventShell.js";

const VIEWPORT = { width: 1000, height: 700 };
const SIZE = { width: 450, height: 300 };

describe("placePopover", () => {
    it("centers a popover with no anchor, near the top", () => {
        expect(placePopover(undefined, SIZE, VIEWPORT)).toEqual({ left: 275, top: 70 });
    });

    it("opens beside the anchor, on its right, level with its top", () => {
        expect(placePopover({ left: 100, top: 200, right: 220, bottom: 224 }, SIZE, VIEWPORT)).toEqual({ left: 228, top: 200 });
    });

    it("opens on the anchor's left when there is no room on its right", () => {
        expect(placePopover({ left: 700, top: 200, right: 820, bottom: 224 }, SIZE, VIEWPORT)).toEqual({ left: 242, top: 200 });
    });

    it("opens under the anchor, on its left edge, when asked to", () => {
        expect(placePopover({ left: 100, top: 40, right: 220, bottom: 76, placement: "below" }, SIZE, VIEWPORT)).toEqual({ left: 100, top: 84 });
    });

    it("keeps the popover inside the window on every side", () => {
        // Too low: pulled up so its bottom edge keeps the margin.
        expect(placePopover({ left: 100, top: 600, right: 220, bottom: 624 }, SIZE, VIEWPORT).top).toBe(392);
        // Off the left after flipping: pushed back to the margin.
        expect(placePopover({ left: 100, top: 200, right: 960, bottom: 224 }, { width: 450, height: 300 }, VIEWPORT).left).toBe(8);
        // Off the top.
        expect(placePopover({ left: 100, top: -50, right: 220, bottom: -26 }, SIZE, VIEWPORT).top).toBe(8);
        // Off the right, below an anchor near the edge.
        expect(placePopover({ left: 900, top: 40, right: 990, bottom: 76, placement: "below" }, SIZE, VIEWPORT).left).toBe(542);
    });
});

describe("anchorOf", () => {
    it("reads an element's rectangle, opening beside it unless told otherwise", () => {
        const element = document.createElement("button");
        vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ left: 1, top: 2, right: 3, bottom: 4, width: 2, height: 2, x: 1, y: 2, toJSON: () => ({}) });
        expect(anchorOf(element)).toEqual({ left: 1, top: 2, right: 3, bottom: 4, placement: "side" });
        expect(anchorOf(element, "below").placement).toBe("below");
    });
});

function shell(props: Partial<EventShellProps> = {}, children: React.ReactNode = <input aria-label="First" data-autofocus />) {
    return (
        <EventShell variant="card" label="Test dialog" focusKey="a" width={600} onClose={vi.fn()} {...props}>
            {children}
        </EventShell>
    );
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("EventShell", () => {
    it("draws a card with a backdrop, focusing the face's first field", () => {
        render(shell());
        const dialog = screen.getByRole("dialog", { name: "Test dialog" });
        expect(dialog).toHaveAttribute("aria-modal", "true");
        expect(dialog.parentElement).toHaveAttribute("data-event-shell", "card");
        expect(dialog).toHaveStyle({ maxWidth: "600px" });
        expect(screen.getByLabelText("First")).toHaveFocus();
    });

    it("focuses the dialog itself when the face has no field to autofocus, and moves focus when the face changes", () => {
        const { rerender } = render(shell({ focusKey: "details" }, <p>Read only</p>));
        expect(screen.getByRole("dialog")).toHaveFocus();

        rerender(shell({ focusKey: "form" }));
        expect(screen.getByLabelText("First")).toHaveFocus();
    });

    it("closes on Escape, and on a press on the backdrop (not on the dialog itself)", async () => {
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(shell({ onClose }));

        await user.click(screen.getByRole("dialog"));
        expect(onClose).not.toHaveBeenCalled();
        await user.keyboard("{Escape}");
        expect(onClose).toHaveBeenCalledTimes(1);

        fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it("lets the caller decide what a press on the backdrop does", () => {
        const onClose = vi.fn();
        const onBackdropPress = vi.fn();
        render(shell({ onClose, onBackdropPress }));

        fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
        expect(onBackdropPress).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();
    });

    it("draws a bottom sheet for a phone", () => {
        render(shell({ variant: "sheet" }));
        expect(screen.getByRole("dialog").parentElement).toHaveAttribute("data-event-shell", "sheet");
        expect(screen.getByRole("dialog").parentElement).toHaveClass("items-end");
    });

    describe("as a popover", () => {
        function stubSize(width: number, height: number) {
            vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width);
            vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(height);
        }

        it("is placed beside its anchor and kept inside the window (jsdom's window is 1024 x 768)", () => {
            stubSize(450, 300);
            render(shell({ variant: "popover", width: 450, anchor: { left: 100, top: 900, right: 220, bottom: 924 } }));
            const dialog = screen.getByRole("dialog");
            expect(dialog.style.left).toBe("228px");
            // 900 is off the bottom of a 768px window: pulled up to keep the margin.
            expect(dialog.style.top).toBe("460px");
            expect(dialog).toHaveStyle({ width: "450px" });
        });

        it("centers near the top without an anchor", () => {
            stubSize(450, 300);
            render(shell({ variant: "popover", width: 450 }));
            const dialog = screen.getByRole("dialog");
            expect(dialog.style.left).toBe("287px");
            expect(dialog.style.top).toBe("77px");
        });

        it("is placed again when its own size changes, and stops watching when it goes", () => {
            stubSize(450, 300);
            const observe = vi.fn();
            const disconnect = vi.fn();
            let notify: () => void = () => undefined;
            vi.stubGlobal(
                "ResizeObserver",
                class {
                    constructor(callback: () => void) {
                        notify = callback;
                    }
                    observe = observe;
                    disconnect = disconnect;
                },
            );
            const { unmount } = render(shell({ variant: "popover", width: 450, anchor: { left: 100, top: 300, right: 220, bottom: 324 } }));
            expect(observe).toHaveBeenCalledTimes(1);
            expect(screen.getByRole("dialog").style.top).toBe("300px");

            // The popover has grown taller: it no longer fits below where it was.
            stubSize(450, 700);
            notify();
            expect(screen.getByRole("dialog").style.top).toBe("60px");

            unmount();
            expect(disconnect).toHaveBeenCalled();
        });

        it("can be dragged by a grip, and stays inside the window while it is", () => {
            stubSize(450, 300);
            function Grip() {
                const { dragHandleProps } = useContext(EventShellContext);
                return <div data-testid="grip" {...dragHandleProps} />;
            }
            render(shell({ variant: "popover", width: 450, anchor: { left: 100, top: 200, right: 220, bottom: 224 } }, <Grip />));
            const dialog = screen.getByRole("dialog");
            expect(dialog.style.left).toBe("228px");

            fireEvent.pointerDown(screen.getByTestId("grip"), { clientX: 300, clientY: 210 });
            fireEvent.pointerMove(window, { clientX: 340, clientY: 250 });
            expect(dialog.style.left).toBe("268px");
            expect(dialog.style.top).toBe("240px");

            // Dragged far off the window: held at the margin.
            fireEvent.pointerMove(window, { clientX: -900, clientY: -900 });
            expect(dialog.style.left).toBe("8px");
            expect(dialog.style.top).toBe("8px");

            // Released: further movement does nothing.
            fireEvent.pointerUp(window);
            fireEvent.pointerMove(window, { clientX: 500, clientY: 500 });
            expect(dialog.style.left).toBe("8px");
        });

        it("offers no grip to a card, and ignores pointer movement nobody started", () => {
            function Grip() {
                const { dragHandleProps } = useContext(EventShellContext);
                return <div data-testid="grip" data-draggable={dragHandleProps ? "yes" : "no"} />;
            }
            render(shell({ variant: "card" }, <Grip />));
            expect(screen.getByTestId("grip")).toHaveAttribute("data-draggable", "no");
            fireEvent.pointerMove(window, { clientX: 5, clientY: 5 });
        });

        it("clears its own position when it grows into a card", () => {
            stubSize(450, 300);
            const { rerender } = render(shell({ variant: "popover", width: 450, anchor: { left: 100, top: 200, right: 220, bottom: 224 } }));
            expect(screen.getByRole("dialog").style.left).toBe("228px");
            rerender(shell({ variant: "card", width: 880 }));
            expect(screen.getByRole("dialog").style.left).toBe("");
        });
    });
});
