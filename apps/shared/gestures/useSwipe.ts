///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useRef, type TouchEvent } from "react";

/** Which way the finger moved: `"left"` is right to left. */
export type SwipeDirection = "left" | "right";

export interface UseSwipeOptions {
    /** Nothing is tracked while this is `false` (a desktop pointer, select mode). Default `true`. */
    enabled?: boolean;
    /** The directions that mean something; a drag the other way doesn't move at all. Default both. */
    directions?: readonly SwipeDirection[];
    /** How far the finger has to travel to commit, in px. Default `MIN_SWIPE_DISTANCE`, or a third of the element's width when that is more. */
    distance?: number;
    /** Called as the finger moves, with the horizontal offset (the direction filter applied), and with `0` once it lifts. */
    onDrag?: (offset: number) => void;
    /** Called once when a swipe commits. `onDrag(0)` follows. */
    onSwipe: (direction: SwipeDirection) => void;
}

/** The least distance that commits a swipe, and how far the finger must move before its direction is decided. */
export const MIN_SWIPE_DISTANCE = 80;
export const SWIPE_SLOP = 10;
/** A quicker flick than this (px per ms) commits after `FLING_MIN_DISTANCE` alone. */
export const FLING_VELOCITY = 0.5;
export const FLING_MIN_DISTANCE = 40;

/**
 * A horizontal swipe by one finger, for the touch screens the app's phone layout is for: mouse and pen are left alone.
 *
 * Spread the handlers on the element and give it `touch-action: pan-y` (`style`), so the browser keeps scrolling vertically and leaves
 * the horizontal movement to this. A gesture that starts out mostly vertical is a scroll and is never a swipe, however far it later
 * strays sideways; one that starts out horizontal is a swipe, and stays one.
 */
export function useSwipe({ enabled = true, directions = ["left", "right"], distance, onDrag, onSwipe }: UseSwipeOptions) {
    const start = useRef<{ x: number; y: number; time: number; width: number; mode?: "swipe" | "scroll" } | null>(null);
    const offset = useRef(0);
    const latest = useRef({ directions, distance, onDrag, onSwipe });
    latest.current = { directions, distance, onDrag, onSwipe };

    function clamp(dx: number): number {
        const allowed = latest.current.directions;
        return (dx < 0 && !allowed.includes("left")) || (dx > 0 && !allowed.includes("right")) ? 0 : dx;
    }

    function onTouchStart(event: TouchEvent<HTMLElement>) {
        if (!enabled || event.touches.length !== 1) {
            start.current = null;
            return;
        }
        const touch = event.touches[0];
        start.current = { x: touch.clientX, y: touch.clientY, time: Date.now(), width: event.currentTarget.clientWidth };
        offset.current = 0;
    }

    function onTouchMove(event: TouchEvent<HTMLElement>) {
        const gesture = start.current;
        if (!gesture || gesture.mode === "scroll") {
            return;
        }
        if (event.touches.length !== 1) {
            cancel();
            return;
        }
        const dx = event.touches[0].clientX - gesture.x;
        const dy = event.touches[0].clientY - gesture.y;
        if (!gesture.mode) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_SLOP) {
                return;
            }
            gesture.mode = Math.abs(dx) > Math.abs(dy) * 1.5 ? "swipe" : "scroll";
            if (gesture.mode === "scroll") {
                return;
            }
        }
        offset.current = clamp(dx);
        latest.current.onDrag?.(offset.current);
    }

    function onTouchEnd() {
        const gesture = start.current;
        start.current = null;
        if (!gesture || gesture.mode !== "swipe") {
            return;
        }
        const dx = offset.current;
        offset.current = 0;
        const travelled = Math.abs(dx);
        const velocity = travelled / Math.max(1, Date.now() - gesture.time);
        const needed = latest.current.distance ?? Math.max(MIN_SWIPE_DISTANCE, gesture.width / 3);
        const committed = dx !== 0 && (travelled >= needed || (velocity >= FLING_VELOCITY && travelled >= FLING_MIN_DISTANCE));
        if (committed) {
            latest.current.onSwipe(dx < 0 ? "left" : "right");
        }
        latest.current.onDrag?.(0);
    }

    function cancel() {
        const moved = start.current?.mode === "swipe";
        start.current = null;
        offset.current = 0;
        if (moved) {
            latest.current.onDrag?.(0);
        }
    }

    return {
        handlers: enabled ? { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: cancel } : {},
        /** Leaves vertical panning to the browser. */
        style: enabled ? ({ touchAction: "pan-y" } as const) : undefined,
    };
}
