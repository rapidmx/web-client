// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UseSwipeOptions, useSwipe } from "../../../apps/shared/gestures/useSwipe.js";

function Target(options: UseSwipeOptions) {
    const swipe = useSwipe(options);
    return <div data-testid="target" style={swipe.style} {...swipe.handlers} />;
}

const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });

afterEach(() => {
    vi.useRealTimers();
});

describe("useSwipe", () => {
    it("commits a horizontal drag that is far enough, in the direction the finger went, and reports the drag", () => {
        const onSwipe = vi.fn();
        const onDrag = vi.fn();
        render(<Target onSwipe={onSwipe} onDrag={onDrag} />);
        const target = screen.getByTestId("target");
        fireEvent.touchStart(target, touch(300, 100));
        fireEvent.touchMove(target, touch(200, 102));
        fireEvent.touchMove(target, touch(100, 104));
        expect(onDrag).toHaveBeenLastCalledWith(-200);
        fireEvent.touchEnd(target);
        expect(onSwipe).toHaveBeenCalledExactlyOnceWith("left");
        expect(onDrag).toHaveBeenLastCalledWith(0);

        fireEvent.touchStart(target, touch(20, 100));
        fireEvent.touchMove(target, touch(200, 100));
        fireEvent.touchEnd(target);
        expect(onSwipe).toHaveBeenLastCalledWith("right");
    });

    it("leaves vertical panning to the browser, and never turns a scroll into a swipe", () => {
        const onSwipe = vi.fn();
        render(<Target onSwipe={onSwipe} />);
        const target = screen.getByTestId("target");
        expect(target.style.touchAction).toBe("pan-y");
        fireEvent.touchStart(target, touch(300, 100));
        fireEvent.touchMove(target, touch(295, 160));
        // It began as a scroll, so a later sideways drift is still one.
        fireEvent.touchMove(target, touch(60, 200));
        fireEvent.touchEnd(target);
        expect(onSwipe).not.toHaveBeenCalled();
    });

    it("ignores a drag that stops short, unless it is a quick flick", () => {
        vi.useFakeTimers();
        const onSwipe = vi.fn();
        render(<Target onSwipe={onSwipe} />);
        const target = screen.getByTestId("target");
        fireEvent.touchStart(target, touch(300, 100));
        vi.advanceTimersByTime(600);
        fireEvent.touchMove(target, touch(250, 100));
        fireEvent.touchEnd(target);
        expect(onSwipe).not.toHaveBeenCalled();

        fireEvent.touchStart(target, touch(300, 100));
        vi.advanceTimersByTime(50);
        fireEvent.touchMove(target, touch(250, 100));
        fireEvent.touchEnd(target);
        expect(onSwipe).toHaveBeenCalledExactlyOnceWith("left");
    });

    it("doesn't move at all in a direction that isn't wired, and can be given its own distance", () => {
        const onSwipe = vi.fn();
        const onDrag = vi.fn();
        render(<Target directions={["left"]} distance={20} onSwipe={onSwipe} onDrag={onDrag} />);
        const target = screen.getByTestId("target");
        fireEvent.touchStart(target, touch(100, 100));
        fireEvent.touchMove(target, touch(200, 100));
        expect(onDrag).toHaveBeenLastCalledWith(0);
        fireEvent.touchEnd(target);
        expect(onSwipe).not.toHaveBeenCalled();

        fireEvent.touchStart(target, touch(100, 100));
        fireEvent.touchMove(target, touch(70, 100));
        fireEvent.touchEnd(target);
        expect(onSwipe).toHaveBeenCalledExactlyOnceWith("left");
    });

    it("gives up when a second finger lands, or the gesture is cancelled, and lets go of the row", () => {
        const onSwipe = vi.fn();
        const onDrag = vi.fn();
        render(<Target onSwipe={onSwipe} onDrag={onDrag} />);
        const target = screen.getByTestId("target");
        fireEvent.touchStart(target, touch(300, 100));
        fireEvent.touchMove(target, touch(150, 100));
        fireEvent.touchMove(target, { touches: [{ clientX: 100, clientY: 100 }, { clientX: 200, clientY: 100 }] });
        expect(onDrag).toHaveBeenLastCalledWith(0);
        fireEvent.touchEnd(target);

        fireEvent.touchStart(target, touch(300, 100));
        fireEvent.touchMove(target, touch(100, 100));
        fireEvent.touchCancel(target);
        fireEvent.touchEnd(target);
        expect(onDrag).toHaveBeenLastCalledWith(0);
        expect(onSwipe).not.toHaveBeenCalled();

        // A two-finger start isn't tracked either.
        fireEvent.touchStart(target, { touches: [{ clientX: 300, clientY: 100 }, { clientX: 310, clientY: 100 }] });
        fireEvent.touchMove(target, touch(100, 100));
        fireEvent.touchEnd(target);
        expect(onSwipe).not.toHaveBeenCalled();
    });

    it("does nothing while disabled, and asks the browser for no panning rules", () => {
        const onSwipe = vi.fn();
        render(<Target enabled={false} onSwipe={onSwipe} />);
        const target = screen.getByTestId("target");
        expect(target.style.touchAction).toBe("");
        fireEvent.touchStart(target, touch(300, 100));
        fireEvent.touchMove(target, touch(50, 100));
        fireEvent.touchEnd(target);
        expect(onSwipe).not.toHaveBeenCalled();
    });
});
