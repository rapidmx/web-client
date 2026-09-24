// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENTER_SLIDE_MS, useEnterSlide } from "../../../apps/shared/gestures/useEnterSlide.js";

function Target() {
    const slide = useEnterSlide();
    return (
        <div>
            <button onClick={() => slide.enter(1)}>next</button>
            <button onClick={() => slide.enter(-1)}>previous</button>
            <div data-testid="content" style={slide.style} />
        </div>
    );
}

const content = () => screen.getByTestId("content");

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

describe("useEnterSlide", () => {
    it("starts the new contents a little way below for the next page, faded, and settles them into place", () => {
        render(<Target />);
        expect(content().style.transform).toBe("");

        fireEvent.click(screen.getByText("next"));
        expect(content().style.transform).toBe("translate3d(0, 56px, 0)");
        expect(content().style.opacity).toBe("0.35");
        expect(content().style.transition).toBe("none");

        act(() => void vi.advanceTimersByTime(20));
        expect(content().style.transform).toBe("");
        expect(content().style.opacity).toBe("");
        expect(content().style.transition).toContain(`${ENTER_SLIDE_MS}ms`);
    });

    it("comes from above for the previous page", () => {
        render(<Target />);
        fireEvent.click(screen.getByText("previous"));
        expect(content().style.transform).toBe("translate3d(0, -56px, 0)");
    });

    it("starts the next one from its start when another step comes before the last has settled", () => {
        render(<Target />);
        fireEvent.click(screen.getByText("next"));
        act(() => void vi.advanceTimersByTime(20));
        act(() => void vi.advanceTimersByTime(ENTER_SLIDE_MS / 2));
        fireEvent.click(screen.getByText("next"));
        expect(content().style.transform).toBe("translate3d(0, 56px, 0)");
        expect(content().style.transition).toBe("none");
        act(() => void vi.advanceTimersByTime(20));
        expect(content().style.transform).toBe("");
    });

    it("moves nothing for someone who asked for less motion", () => {
        stubMotion(true);
        render(<Target />);
        fireEvent.click(screen.getByText("next"));
        expect(content().style.transform).toBe("");
        expect(content().style.opacity).toBe("");
    });

    it("finishes nothing after it is unmounted", () => {
        const { unmount } = render(<Target />);
        fireEvent.click(screen.getByText("next"));
        unmount();
        expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    });
});
