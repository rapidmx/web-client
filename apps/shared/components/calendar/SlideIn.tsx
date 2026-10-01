///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode, useLayoutEffect, useRef } from "react";
import { prefersReducedMotion } from "../../gestures/useEnterSlide.js";

/** The side a card slides in from: the Previous match's comes from the left, the Next match's from the right. */
export type SlideFrom = "left" | "right";

/** How long the card takes to settle, and how far off it starts, in px. */
export const SLIDE_IN_MS = 220;
const SLIDE_IN_OFFSET_PX = 48;

/**
 * Slides what it holds in from `from` (and fades it in) as it mounts - mount it afresh (a `key`) for each card. Without `from` (the card was just
 * opened, not stepped to) nothing moves. The animation is the Web Animations API's, so nothing is left behind in the styles, and it is skipped
 * for someone who asked for less motion and where the browser has no `Element.animate()`. `data-slide-from` says which way it came, for tests and
 * styling. Its own clip (`overflow-x-clip`, which makes no scroller) keeps the sliding card inside the dialog's edges; the dialog itself, the
 * backdrop and the buttons beside the card are not moved.
 */
export default function SlideIn({ from, children }: { from?: SlideFrom; children: ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const element = ref.current!;
        if (!from || typeof element.animate !== "function" || prefersReducedMotion()) {
            return;
        }
        const offset = from === "left" ? -SLIDE_IN_OFFSET_PX : SLIDE_IN_OFFSET_PX;
        element.animate(
            [
                { transform: `translateX(${offset}px)`, opacity: 0 },
                { transform: "translateX(0)", opacity: 1 },
            ],
            { duration: SLIDE_IN_MS, easing: "ease-out" },
        );
    }, []);

    return (
        <div className="overflow-x-clip">
            <div ref={ref} data-slide-from={from}>
                {children}
            </div>
        </div>
    );
}
