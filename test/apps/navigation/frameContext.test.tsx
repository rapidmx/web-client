// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppFrameContext, FrameTakeover, useInAppFrame } from "../../../apps/shared/navigation/frameContext.js";

function Probe() {
    return <p>{useInAppFrame() ? "in frame" : "no frame"}</p>;
}

describe("useInAppFrame", () => {
    it("is false outside the persistent app frame and true inside it", () => {
        const { unmount } = render(<Probe />);
        expect(screen.getByText("no frame")).toBeInTheDocument();
        unmount();
        render(
            <AppFrameContext.Provider value={{ enterTakeover: () => () => undefined }}>
                <Probe />
            </AppFrameContext.Provider>,
        );
        expect(screen.getByText("in frame")).toBeInTheDocument();
    });
});

describe("FrameTakeover", () => {
    it("renders its children and does nothing outside a frame", () => {
        render(<FrameTakeover>screen content</FrameTakeover>);
        expect(screen.getByText("screen content")).toBeInTheDocument();
    });

    it("renders its children bare outside a frame, and in a wrapper that takes the frame's whole row inside one, so the screen centres", () => {
        const { container, unmount } = render(<FrameTakeover><p>screen content</p></FrameTakeover>);
        expect(container.firstElementChild?.tagName).toBe("P");
        unmount();
        const inside = render(
            <AppFrameContext.Provider value={{ enterTakeover: () => () => undefined }}>
                <FrameTakeover><p>screen content</p></FrameTakeover>
            </AppFrameContext.Provider>,
        );
        const wrapper = screen.getByText("screen content").parentElement!;
        expect(wrapper.className).toContain("flex-1");
        expect(wrapper.className).toContain("min-w-0");
        inside.unmount();
    });

    it("asks the frame to hide its chrome while mounted and lets go when it unmounts", () => {
        const leave = vi.fn();
        const enterTakeover = vi.fn(() => leave);
        const { unmount } = render(
            <AppFrameContext.Provider value={{ enterTakeover }}>
                <FrameTakeover>screen content</FrameTakeover>
            </AppFrameContext.Provider>,
        );
        expect(enterTakeover).toHaveBeenCalledTimes(1);
        expect(leave).not.toHaveBeenCalled();
        unmount();
        expect(leave).toHaveBeenCalledTimes(1);
    });
});
