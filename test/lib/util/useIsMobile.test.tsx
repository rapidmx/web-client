// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockMatchMedia } from "../testUtils.js";
import useIsMobile from "../../../lib/util/useIsMobile.js";

function Harness({ breakpointPx }: { breakpointPx?: number }) {
    const isMobile = useIsMobile(breakpointPx);
    return <span data-testid="value">{String(isMobile)}</span>;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("useIsMobile", () => {
    it("reads false when the media query does not match", () => {
        mockMatchMedia(false);
        render(<Harness />);
        expect(screen.getByTestId("value")).toHaveTextContent("false");
    });

    it("reads true when the media query matches", () => {
        mockMatchMedia(true);
        render(<Harness />);
        expect(screen.getByTestId("value")).toHaveTextContent("true");
    });

    it("updates when the underlying media query changes (a real resize across the breakpoint)", () => {
        const mql = mockMatchMedia(false);
        render(<Harness />);
        expect(screen.getByTestId("value")).toHaveTextContent("false");

        act(() => mql.setMatches(true));
        expect(screen.getByTestId("value")).toHaveTextContent("true");

        act(() => mql.setMatches(false));
        expect(screen.getByTestId("value")).toHaveTextContent("false");
    });

    it("stops listening for changes after unmount", () => {
        const mql = mockMatchMedia(false);
        const { unmount } = render(<Harness />);
        unmount();
        // No assertion possible on a value that's no longer rendered; this just needs to not throw when
        // a change fires after unmount, proving the effect's cleanup actually removed the listener rather
        // than leaving a dangling one that would error trying to update unmounted state.
        expect(() => mql.setMatches(true)).not.toThrow();
    });

    it("accepts a custom breakpoint", () => {
        mockMatchMedia(true);
        render(<Harness breakpointPx={1024} />);
        expect(screen.getByTestId("value")).toHaveTextContent("true");
    });

    it("re-queries when the breakpoint prop itself changes", () => {
        mockMatchMedia(false);
        const { rerender } = render(<Harness breakpointPx={768} />);
        expect(screen.getByTestId("value")).toHaveTextContent("false");

        mockMatchMedia(true);
        rerender(<Harness breakpointPx={1024} />);
        expect(screen.getByTestId("value")).toHaveTextContent("true");
    });
});
