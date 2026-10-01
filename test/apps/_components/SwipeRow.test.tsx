// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SwipeRow from "../../../apps/shared/components/mail/SwipeRow.js";
import { LONG_PRESS_MS } from "../../../apps/shared/gestures/useLongPress.js";

const ROW_WIDTH = 320;

/** jsdom lays nothing out, so every element is as wide as a phone's list row. */
beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(ROW_WIDTH);
});

afterEach(() => {
    vi.restoreAllMocks();
});

/** One finger from x=300 to `toX`. */
function swipe(target: Element, toX: number) {
    fireEvent.touchStart(target, { touches: [{ clientX: 300, clientY: 100 }] });
    fireEvent.touchMove(target, { touches: [{ clientX: toX, clientY: 100 }] });
    fireEvent.touchEnd(target, { touches: [], changedTouches: [{ clientX: toX, clientY: 100 }] });
}

function renderRow(props: Partial<React.ComponentProps<typeof SwipeRow>> = {}) {
    const onArchive = vi.fn<() => Promise<boolean>>(() => Promise.resolve(true));
    const onMove = vi.fn();
    const result = render(
        <ul>
            <SwipeRow as="li" enabled onArchive={onArchive} onMove={onMove} data-testid="row" className="relative" {...props}>
                <span>Quarterly report</span>
            </SwipeRow>
        </ul>,
    );
    return { onArchive, onMove, ...result };
}

describe("SwipeRow", () => {
    it("is just the row while swipes are off: no handlers, no panning rules, no panels", () => {
        const { onArchive, onMove } = renderRow({ enabled: false });
        const row = screen.getByTestId("row");

        expect(row.tagName).toBe("LI");
        expect(row).toHaveClass("relative");
        expect(row.style.touchAction).toBe("");
        swipe(row, 40);
        swipe(row, 500);
        expect(onArchive).not.toHaveBeenCalled();
        expect(onMove).not.toHaveBeenCalled();
        expect(row.querySelector("[data-swipe-panel]")).toBeNull();
    });

    it("follows the finger, with a panel for each action just outside its edges, and lets go with it", () => {
        const { onArchive, onMove } = renderRow();
        const row = screen.getByTestId("row");
        expect(row.style.touchAction).toBe("pan-y");
        expect(row.querySelector("[data-swipe-panel]")).toBeNull();

        // A short, slow drag: far enough to see, not enough to commit.
        const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
        fireEvent.touchStart(row, { touches: [{ clientX: 300, clientY: 100 }] });
        now.mockReturnValue(1_000_600);
        fireEvent.touchMove(row, { touches: [{ clientX: 270, clientY: 100 }] });
        expect(row.style.transform).toBe("translateX(-30px)");
        // Following the finger, so no easing.
        expect(row.style.transition).toBe("none");
        expect(row).toHaveAttribute("data-swiping", "true");
        expect(row.querySelector('[data-swipe-panel="move"]')).not.toBeNull();
        expect(row.querySelector('[data-swipe-panel="archive"]')).not.toBeNull();

        fireEvent.touchEnd(row, { touches: [], changedTouches: [{ clientX: 270, clientY: 100 }] });
        expect(row.style.transform).toBe("");
        expect(row.style.transition).not.toBe("none");
        expect(row).not.toHaveAttribute("data-swiping");
        expect(row.querySelector("[data-swipe-panel]")).toBeNull();
        expect(onArchive).not.toHaveBeenCalled();
        expect(onMove).not.toHaveBeenCalled();
    });

    it("asks for a folder when swiped left to right, and comes back at once", () => {
        const { onArchive, onMove } = renderRow();
        const row = screen.getByTestId("row");

        swipe(row, 300 + 200);

        expect(onMove).toHaveBeenCalledOnce();
        expect(onArchive).not.toHaveBeenCalled();
        expect(row.style.transform).toBe("");
        expect(row.querySelector("[data-swipe-panel]")).toBeNull();
    });

    it("archives when swiped right to left, sizes the archive panel to the row, and keeps the row from being dragged again", async () => {
        const { onArchive, onMove } = renderRow();
        const row = screen.getByTestId("row");

        await act(async () => swipe(row, 100));

        expect(onArchive).toHaveBeenCalledOnce();
        expect(onMove).not.toHaveBeenCalled();
        expect(row.querySelector('[data-swipe-panel="archive"]')).toHaveStyle({ width: `${ROW_WIDTH}px` });
        // Archived: the list drops the row, so until then it stays as it is - and a finger can't take it back for a move.
        swipe(row, 500);
        expect(onMove).not.toHaveBeenCalled();
        expect(onArchive).toHaveBeenCalledOnce();
    });

    it("brings the row back, ready for another swipe, when the archive is refused", async () => {
        const refused = vi.fn(() => Promise.resolve(false));
        renderRow({ onArchive: refused });
        const row = screen.getByTestId("row");

        // Waits for the refusal to come back.
        await act(async () => swipe(row, 100));

        expect(refused).toHaveBeenCalledOnce();
        expect(row.style.transform).toBe("");
        expect(row.querySelector("[data-swipe-panel]")).toBeNull();

        await act(async () => swipe(row, 100));
        expect(refused).toHaveBeenCalledTimes(2);
    });

    it("leaves a row alone that its list dropped before a refusal came back", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        let refuse: (archived: boolean) => void = () => undefined;
        const pending = vi.fn(() => new Promise<boolean>((resolve) => (refuse = resolve)));
        const { unmount } = renderRow({ onArchive: pending });

        swipe(screen.getByTestId("row"), 100);
        expect(pending).toHaveBeenCalledOnce();
        unmount();
        await act(async () => refuse(false));

        expect(error).not.toHaveBeenCalled();
    });

    describe("press and hold", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });
        const hold = () => act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));

        it("hears a held finger beside the swipe, and keeps the page's text from being selected under it", () => {
            const onLongPress = vi.fn();
            const { onArchive, onMove } = renderRow({ onLongPress });
            const row = screen.getByTestId("row");
            expect(row.style.touchAction).toBe("pan-y");
            expect(row.style.userSelect).toBe("none");

            fireEvent.touchStart(row, { touches: [{ clientX: 300, clientY: 100 }] });
            hold();
            fireEvent.touchEnd(row, { touches: [], changedTouches: [{ clientX: 300, clientY: 100 }] });

            expect(onLongPress).toHaveBeenCalledOnce();
            expect(onArchive).not.toHaveBeenCalled();
            expect(onMove).not.toHaveBeenCalled();
        });

        it("gives the finger to a swipe as soon as it drags, and a swipe is still a swipe", async () => {
            const onLongPress = vi.fn();
            const { onArchive } = renderRow({ onLongPress });
            const row = screen.getByTestId("row");

            await act(async () => swipe(row, 100));
            hold();

            expect(onArchive).toHaveBeenCalledOnce();
            expect(onLongPress).not.toHaveBeenCalled();
        });

        it("hears it while swipes are off too, and has none without a handler", () => {
            const onLongPress = vi.fn();
            const { rerender } = renderRow({ enabled: false, onLongPress });
            const row = screen.getByTestId("row");
            expect(row.style.touchAction).toBe("");
            expect(row.style.userSelect).toBe("none");

            fireEvent.touchStart(row, { touches: [{ clientX: 300, clientY: 100 }] });
            hold();
            expect(onLongPress).toHaveBeenCalledOnce();

            rerender(
                <ul>
                    <SwipeRow as="li" enabled={false} onArchive={vi.fn()} onMove={vi.fn()} data-testid="row" />
                </ul>,
            );
            expect(screen.getByTestId("row").style.userSelect).toBe("");
            fireEvent.touchStart(screen.getByTestId("row"), { touches: [{ clientX: 300, clientY: 100 }] });
            hold();
            expect(onLongPress).toHaveBeenCalledOnce();
        });
    });
});
