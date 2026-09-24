///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useRef, useState, type CSSProperties } from "react";

/** How long the new contents take to settle. Short, so a run of steps (a wheel kept turning) never waits on the last one. */
export const ENTER_SLIDE_MS = 140;
/** How far off, in pixels, and how faded the new contents start. */
const ENTER_OFFSET_PX = 56;
const ENTER_START_OPACITY = 0.35;
/** The pause that lets the browser draw the contents at their starting place before they move. */
const ENTER_SETTLE_MS = 20;

/** Whether the user asked their device for less motion. */
function prefersReducedMotion(): boolean {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The look of a page that has just been swapped for the next or previous one by a vertical step (the wheel): the new contents start
 * a little way off in the direction the step went - below for `1` (the next), above for `-1` - and faded, and settle into place.
 * The old contents are not animated out: the swap is immediate, so a run of steps never queues, and a step in the middle of a
 * settle just starts the next one from its start. Put `style` on the element that holds the contents and call `enter()` as the
 * contents change. Nothing moves for someone who asked for less motion.
 */
export function useEnterSlide() {
    const [offset, setOffset] = useState(0);
    const [animated, setAnimated] = useState(false);
    const timer = useRef<number | undefined>(undefined);

    useEffect(() => () => window.clearTimeout(timer.current), []);

    function enter(direction: 1 | -1) {
        if (prefersReducedMotion()) {
            return;
        }
        window.clearTimeout(timer.current);
        setAnimated(false);
        setOffset(direction * ENTER_OFFSET_PX);
        timer.current = window.setTimeout(() => {
            setAnimated(true);
            setOffset(0);
        }, ENTER_SETTLE_MS);
    }

    const style: CSSProperties = {
        transform: offset === 0 ? undefined : `translate3d(0, ${offset}px, 0)`,
        opacity: offset === 0 ? undefined : ENTER_START_OPACITY,
        transition: animated ? `transform ${ENTER_SLIDE_MS}ms ease-out, opacity ${ENTER_SLIDE_MS}ms ease-out` : "none",
    };

    return { style, enter };
}
