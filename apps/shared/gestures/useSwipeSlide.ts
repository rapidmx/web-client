///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { SwipeDirection, useSwipe } from "./useSwipe.js";

/** How long the current contents take to leave, and the new ones to arrive - or the current ones to snap back. */
export const SLIDE_MS = 200;
/** The pause between the new contents being put off-screen and them starting to slide in, long enough for the browser to draw them there. */
const SETTLE_MS = 30;
/** How far a slide goes when the element's width can't be measured. */
const FALLBACK_WIDTH_PX = 320;

export interface UseSwipeSlideOptions {
    /** Nothing is tracked while this is `false`. */
    enabled: boolean;
    /** Changes what is shown to the period the swipe went to - called once the old contents have left, while the new ones wait off-screen. */
    onShift: (direction: SwipeDirection) => void;
}

/** Whether the user asked their device for less motion, in which case the change is made at once instead of slid. */
function prefersReducedMotion(): boolean {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A swipe between pages of content that visibly moves them, the way a phone calendar does: the contents follow the finger, and once
 * the swipe commits they carry on out of view in the direction it went while the next ones - `onShift()` changes what is shown at
 * that moment - slide in from the other side. A swipe that stops short slides back. The animation is timed here (`SLIDE_MS`) rather than
 * left to `transitionend`, so it can't stall if the browser skips a transition.
 *
 * Put `handlers` and `style` on a clipping element (`overflow-hidden`, so the contents don't widen the page while they are off to
 * the side), the contents inside it in an element of their own with `contentStyle`, and `ref` on the clipping element.
 */
export function useSwipeSlide({ enabled, onShift }: UseSwipeSlideOptions) {
    const [offset, setOffset] = useState(0);
    /** Whether a change of `offset` is animated: not while the finger is moving it, yes for everything else. */
    const [animated, setAnimated] = useState(false);
    /** A committed slide is under way: further swipes are ignored until it ends. */
    const [sliding, setSliding] = useState(false);
    const slidingRef = useRef(false);
    const ref = useRef<HTMLDivElement | null>(null);
    const timers = useRef<number[]>([]);
    const latest = useRef({ onShift });
    latest.current = { onShift };

    useEffect(
        () => () => {
            for (const timer of timers.current) {
                window.clearTimeout(timer);
            }
        },
        [],
    );

    function later(work: () => void, ms: number) {
        timers.current.push(window.setTimeout(work, ms));
    }

    const swipe = useSwipe({
        enabled: enabled && !sliding,
        onDrag: (dx) => {
            // `useSwipe()` reports the finger lifting (0) right after a swipe commits: that must not undo the slide out.
            if (slidingRef.current) {
                return;
            }
            setAnimated(dx === 0);
            setOffset(dx);
        },
        onSwipe: (direction) => {
            if (prefersReducedMotion()) {
                latest.current.onShift(direction);
                return;
            }
            const width = ref.current?.clientWidth || FALLBACK_WIDTH_PX;
            // The finger moved `direction`, so the contents go that way and the next ones come from the opposite side.
            const out = direction === "left" ? -width : width;
            slidingRef.current = true;
            setSliding(true);
            setAnimated(true);
            setOffset(out);
            later(() => {
                latest.current.onShift(direction);
                setAnimated(false);
                setOffset(-out);
                later(() => {
                    setAnimated(true);
                    setOffset(0);
                    later(() => {
                        slidingRef.current = false;
                        setSliding(false);
                    }, SLIDE_MS);
                }, SETTLE_MS);
            }, SLIDE_MS);
        },
    });

    const contentStyle: CSSProperties = {
        transform: offset === 0 ? undefined : `translate3d(${offset}px, 0, 0)`,
        transition: animated ? `transform ${SLIDE_MS}ms ease-out` : "none",
    };

    return {
        handlers: swipe.handlers,
        /** For the clipping element: `touch-action: pan-y`, and no overflow. */
        style: swipe.style,
        contentStyle,
        ref,
        /** For a test or a style hook: `"idle"`, `"dragging"` or `"sliding"`. */
        phase: sliding ? "sliding" : offset !== 0 && !animated ? "dragging" : "idle",
    };
}
