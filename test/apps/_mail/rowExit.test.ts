// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROW_EXIT_MS, canAnimateRowExit, collapseRow } from "../../../apps/shared/mail/rowExit.js";
import { mockMatchMedia } from "../testUtils.js";

afterEach(() => {
    vi.unstubAllGlobals();
    delete (Element.prototype as { animate?: unknown }).animate;
});

describe("canAnimateRowExit", () => {
    it("is false where the browser cannot animate an element (jsdom)", () => {
        expect(canAnimateRowExit()).toBe(false);
    });

    it("is true where it can, unless the reader prefers reduced motion", () => {
        Element.prototype.animate = vi.fn();
        // No matchMedia at all: nothing says the reader wants less motion.
        vi.stubGlobal("matchMedia", undefined);
        expect(canAnimateRowExit()).toBe(true);
        const media = mockMatchMedia(false);
        expect(canAnimateRowExit()).toBe(true);
        media.setMatches(true);
        expect(canAnimateRowExit()).toBe(false);
    });
});

describe("collapseRow", () => {
    it("runs the row's height and opacity to zero once, keeping it collapsed", () => {
        const animate = vi.fn();
        Element.prototype.animate = animate;
        const row = document.createElement("li");

        collapseRow(row);
        collapseRow(row);

        expect(animate).toHaveBeenCalledTimes(1);
        const [keyframes, options] = animate.mock.calls[0];
        expect(keyframes[1]).toMatchObject({ height: "0px", opacity: 0 });
        expect(options).toMatchObject({ duration: ROW_EXIT_MS, fill: "forwards" });
        expect(row.style.overflow).toBe("hidden");
    });
});
