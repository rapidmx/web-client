// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React, { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WHEEL_EDGE_PX, WHEEL_IDLE_MS, WHEEL_SETTLE_MS, WHEEL_STEP_PX, useWheelPaging } from "../../../apps/shared/gestures/useWheelPaging.js";

interface TargetProps {
    enabled?: boolean;
    scroller?: HTMLElement | null;
    onStep: (direction: 1 | -1, edge: "top" | "bottom" | null) => void;
}

function Target({ enabled = true, scroller = null, onStep }: TargetProps) {
    const ref = useRef<HTMLDivElement>(null);
    useWheelPaging(ref, { enabled, getScroller: () => scroller, onStep });
    return <div ref={ref} data-testid="target" />;
}

/** A scrolling element as jsdom (which lays nothing out) has to be told about it. */
function scrollerAt(scrollTop: number, scrollHeight = 1000, clientHeight = 400): HTMLElement {
    const element = document.createElement("div");
    let top = scrollTop;
    Object.defineProperty(element, "scrollTop", { get: () => top, set: (value: number) => (top = value), configurable: true });
    Object.defineProperty(element, "scrollHeight", { value: scrollHeight, configurable: true });
    Object.defineProperty(element, "clientHeight", { value: clientHeight, configurable: true });
    return element;
}

/** One turn of the wheel; resolves to whether the browser is still allowed to do what it would have (`false` once it was cancelled). */
const wheel = (init: WheelEventInit): boolean => fireEvent.wheel(screen.getByTestId("target"), init);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("useWheelPaging where nothing inside scrolls", () => {
    it("steps once for each notch of the wheel and takes the wheel's movement away from the page", () => {
        const onStep = vi.fn();
        render(<Target onStep={onStep} />);
        expect(wheel({ deltaY: WHEEL_STEP_PX })).toBe(false);
        expect(onStep).toHaveBeenCalledExactlyOnceWith(1, null);

        vi.advanceTimersByTime(10);
        wheel({ deltaY: -WHEEL_STEP_PX });
        expect(onStep).toHaveBeenLastCalledWith(-1, null);
    });

    it("keeps stepping for as long as the wheel turns, a big turn being several steps and the remainder carrying over", () => {
        const onStep = vi.fn();
        render(<Target onStep={onStep} />);
        wheel({ deltaY: 250 });
        expect(onStep).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(20);
        wheel({ deltaY: 50 });
        expect(onStep).toHaveBeenCalledTimes(3);
        // Small movements, as a touchpad reports them, add up.
        for (let i = 0; i < 10; i++) {
            vi.advanceTimersByTime(16);
            wheel({ deltaY: 30 });
        }
        expect(onStep).toHaveBeenCalledTimes(6);
        expect(onStep.mock.calls.every(([direction]) => direction === 1)).toBe(true);
    });

    it("starts again from nothing when the wheel changes direction or has been idle", () => {
        const onStep = vi.fn();
        render(<Target onStep={onStep} />);
        wheel({ deltaY: 60 });
        wheel({ deltaY: -60 });
        expect(onStep).not.toHaveBeenCalled();
        wheel({ deltaY: 60 });
        vi.advanceTimersByTime(WHEEL_IDLE_MS + 1);
        wheel({ deltaY: 60 });
        expect(onStep).not.toHaveBeenCalled();
        wheel({ deltaY: 60 });
        expect(onStep).toHaveBeenCalledTimes(1);
    });

    it("reads a wheel reporting lines or pages as pixels", () => {
        const onStep = vi.fn();
        render(<Target onStep={onStep} />);
        wheel({ deltaY: 7, deltaMode: 1 });
        expect(onStep).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(10);
        // A page is the element's height (600px where it has none, as in jsdom): six steps.
        wheel({ deltaY: 1, deltaMode: 2 });
        expect(onStep).toHaveBeenCalledTimes(7);
    });

    it("leaves zoom, sideways movement and an empty turn alone", () => {
        const onStep = vi.fn();
        render(<Target onStep={onStep} />);
        expect(wheel({ deltaY: 500, ctrlKey: true })).toBe(true);
        expect(wheel({ deltaY: 100, deltaX: 300 })).toBe(true);
        expect(wheel({ deltaY: 0 })).toBe(true);
        expect(onStep).not.toHaveBeenCalled();
    });

    it("does nothing while disabled, and stops listening once unmounted", () => {
        const onStep = vi.fn();
        const { rerender, unmount } = render(<Target enabled={false} onStep={onStep} />);
        expect(wheel({ deltaY: 500 })).toBe(true);
        rerender(<Target onStep={onStep} />);
        const target = screen.getByTestId("target");
        wheel({ deltaY: 500 });
        expect(onStep).toHaveBeenCalledTimes(5);
        unmount();
        fireEvent.wheel(target, { deltaY: 500 });
        expect(onStep).toHaveBeenCalledTimes(5);
    });
});

describe("useWheelPaging where something inside scrolls", () => {
    it("lets the wheel scroll it, in either direction, until it is at an end", () => {
        const onStep = vi.fn();
        render(<Target scroller={scrollerAt(300)} onStep={onStep} />);
        expect(wheel({ deltaY: 200 })).toBe(true);
        expect(wheel({ deltaY: -200 })).toBe(true);
        expect(onStep).not.toHaveBeenCalled();
    });

    it("steps on when the wheel keeps pushing past the bottom, arriving at the top of the next page", () => {
        const onStep = vi.fn();
        render(<Target scroller={scrollerAt(600)} onStep={onStep} />);
        expect(wheel({ deltaY: 30 })).toBe(false);
        wheel({ deltaY: 30 });
        expect(onStep).not.toHaveBeenCalled();
        wheel({ deltaY: 30 });
        expect(onStep).toHaveBeenCalledExactlyOnceWith(1, "top");
    });

    it("steps back when it keeps pushing past the top, arriving at the bottom of the previous page", () => {
        const onStep = vi.fn();
        render(<Target scroller={scrollerAt(0)} onStep={onStep} />);
        wheel({ deltaY: -WHEEL_EDGE_PX });
        expect(onStep).toHaveBeenCalledExactlyOnceWith(-1, "bottom");
    });

    it("counts one hard push as one step, and forgets a push that was let go of", () => {
        const onStep = vi.fn();
        render(<Target scroller={scrollerAt(0, 1000, 400)} onStep={onStep} />);
        wheel({ deltaY: -WHEEL_EDGE_PX });
        wheel({ deltaY: -WHEEL_EDGE_PX });
        wheel({ deltaY: -WHEEL_EDGE_PX });
        expect(onStep).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(WHEEL_SETTLE_MS + 1);
        wheel({ deltaY: -WHEEL_EDGE_PX });
        expect(onStep).toHaveBeenCalledTimes(2);

        // A push that stops short, then the wheel turning the other way to scroll back, adds up to nothing.
        vi.advanceTimersByTime(500);
        wheel({ deltaY: -40 });
        wheel({ deltaY: 40 });
        expect(onStep).toHaveBeenCalledTimes(2);
    });

    it("steps at once on a page where nothing needs scrolling, and forgets a nudge once it can scroll again", () => {
        const onStep = vi.fn();
        const { rerender } = render(<Target scroller={scrollerAt(0, 300, 400)} onStep={onStep} />);
        wheel({ deltaY: WHEEL_EDGE_PX });
        expect(onStep).toHaveBeenCalledExactlyOnceWith(1, "top");

        vi.advanceTimersByTime(500);
        const tall = scrollerAt(0, 1000, 400);
        rerender(<Target scroller={tall} onStep={onStep} />);
        wheel({ deltaY: -40 });
        (tall as any).scrollTop = 200;
        expect(wheel({ deltaY: 40 })).toBe(true);
        (tall as any).scrollTop = 0;
        wheel({ deltaY: -40 });
        expect(onStep).toHaveBeenCalledTimes(1);
    });
});
