// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLIDE_MS, UseSwipeSlideOptions, useSwipeSlide } from "../../../apps/shared/gestures/useSwipeSlide.js";

function Target(options: UseSwipeSlideOptions) {
    const slide = useSwipeSlide(options);
    return (
        <div data-testid="clip" ref={slide.ref} style={slide.style} {...slide.handlers}>
            <div data-testid="content" data-phase={slide.phase} style={slide.contentStyle} />
        </div>
    );
}

const touch = (x: number, y = 100) => ({ touches: [{ clientX: x, clientY: y }] });
const content = () => screen.getByTestId("content");
const clip = () => screen.getByTestId("clip");

/** A committed swipe of `dx`, quick enough to count however short. */
function swipe(dx: number) {
    fireEvent.touchStart(clip(), touch(300));
    fireEvent.touchMove(clip(), touch(300 + dx / 2, 102));
    fireEvent.touchMove(clip(), touch(300 + dx, 104));
    fireEvent.touchEnd(clip());
}

/** Whether the browser is told the user wants less motion. */
function stubMotion(reduced: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
        matches: reduced && query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    }));
}

beforeEach(() => {
    vi.useFakeTimers();
    stubMotion(false);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("useSwipeSlide", () => {
    it("follows the finger without animating it", () => {
        render(<Target enabled onShift={vi.fn()} />);
        fireEvent.touchStart(clip(), touch(300));
        fireEvent.touchMove(clip(), touch(240, 102));
        fireEvent.touchMove(clip(), touch(180, 104));

        expect(content().style.transform).toBe("translate3d(-120px, 0, 0)");
        expect(content().style.transition).toBe("none");
        expect(content().dataset.phase).toBe("dragging");
    });

    it("slides the contents out the way the finger went, changes them, and slides the new ones in from the other side", () => {
        const onShift = vi.fn();
        render(<Target enabled onShift={onShift} />);

        swipe(-200);
        // Leaving: on its way to the left edge, animated, and nothing has changed yet.
        expect(content().style.transform).toBe("translate3d(-320px, 0, 0)");
        expect(content().style.transition).toContain(`${SLIDE_MS}ms`);
        expect(content().dataset.phase).toBe("sliding");
        expect(onShift).not.toHaveBeenCalled();

        act(() => void vi.advanceTimersByTime(SLIDE_MS));
        // Swapped while off-screen: the new contents wait at the right edge, put there without animation.
        expect(onShift).toHaveBeenCalledExactlyOnceWith("left");
        expect(content().style.transform).toBe("translate3d(320px, 0, 0)");
        expect(content().style.transition).toBe("none");

        act(() => void vi.advanceTimersByTime(30));
        // Arriving.
        expect(content().style.transform).toBe("");
        expect(content().style.transition).toContain(`${SLIDE_MS}ms`);
        expect(content().dataset.phase).toBe("sliding");

        act(() => void vi.advanceTimersByTime(SLIDE_MS));
        expect(content().dataset.phase).toBe("idle");
    });

    it("mirrors that for a swipe to the right", () => {
        const onShift = vi.fn();
        render(<Target enabled onShift={onShift} />);
        swipe(200);
        expect(content().style.transform).toBe("translate3d(320px, 0, 0)");
        act(() => void vi.advanceTimersByTime(SLIDE_MS));
        expect(onShift).toHaveBeenCalledExactlyOnceWith("right");
        expect(content().style.transform).toBe("translate3d(-320px, 0, 0)");
    });

    it("measures the width it slides across", () => {
        render(<Target enabled onShift={vi.fn()} />);
        Object.defineProperty(clip(), "clientWidth", { value: 400, configurable: true });
        swipe(-200);
        expect(content().style.transform).toBe("translate3d(-400px, 0, 0)");
    });

    it("ignores another swipe until the slide has ended", () => {
        const onShift = vi.fn();
        render(<Target enabled onShift={onShift} />);
        swipe(-200);
        swipe(-200);
        act(() => void vi.advanceTimersByTime(SLIDE_MS + 30 + SLIDE_MS));
        expect(onShift).toHaveBeenCalledTimes(1);

        swipe(-200);
        act(() => void vi.advanceTimersByTime(SLIDE_MS));
        expect(onShift).toHaveBeenCalledTimes(2);
    });

    it("slides back, animated, when the swipe stops short", () => {
        const onShift = vi.fn();
        render(<Target enabled onShift={onShift} />);
        fireEvent.touchStart(clip(), touch(300));
        fireEvent.touchMove(clip(), touch(280, 102));
        fireEvent.touchMove(clip(), touch(270, 104));
        expect(content().style.transform).toBe("translate3d(-30px, 0, 0)");
        vi.advanceTimersByTime(1000);
        fireEvent.touchEnd(clip());

        expect(content().style.transform).toBe("");
        expect(content().style.transition).toContain(`${SLIDE_MS}ms`);
        expect(content().dataset.phase).toBe("idle");
        act(() => void vi.advanceTimersByTime(2000));
        expect(onShift).not.toHaveBeenCalled();
    });

    it("changes the contents at once, with no movement, for someone who asked for less motion", () => {
        stubMotion(true);
        const onShift = vi.fn();
        render(<Target enabled onShift={onShift} />);
        swipe(-200);
        expect(onShift).toHaveBeenCalledExactlyOnceWith("left");
        expect(content().dataset.phase).toBe("idle");
        expect(content().style.transform).toBe("");
    });

    it("does nothing while disabled", () => {
        const onShift = vi.fn();
        render(<Target enabled={false} onShift={onShift} />);
        swipe(-200);
        act(() => void vi.advanceTimersByTime(1000));
        expect(onShift).not.toHaveBeenCalled();
        expect(content().style.transform).toBe("");
    });

    it("finishes nothing after it is unmounted", () => {
        const onShift = vi.fn();
        const { unmount } = render(<Target enabled onShift={onShift} />);
        swipe(-200);
        unmount();
        vi.advanceTimersByTime(1000);
        expect(onShift).not.toHaveBeenCalled();
    });
});
