///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useRef, type RefObject } from "react";

/** Wheel movement, in pixels, that steps to the next or previous page when nothing inside scrolls: about one notch of a mouse wheel. */
export const WHEEL_STEP_PX = 100;
/** Wheel movement, in pixels, pushed against the top or bottom of what scrolls inside before it steps onto the next or previous page. */
export const WHEEL_EDGE_PX = 80;
/** Movement that isn't followed by more within this long starts from nothing again, so an old nudge doesn't add to a new one. */
export const WHEEL_IDLE_MS = 250;
/** After a step that starts at an edge, wheel events for this long are left to settle the new page, so one hard push isn't two steps. */
export const WHEEL_SETTLE_MS = 100;

/** Where the new page's scroll position goes: `"top"` when stepping forward past the bottom, `"bottom"` when stepping back past the top. */
export type WheelEdge = "top" | "bottom";

export interface UseWheelPagingOptions {
    /** Nothing is handled while this is `false` (a phone, an event being dragged, a dialog open). */
    enabled: boolean;
    /** The element inside that scrolls vertically, if there is one now: the wheel scrolls it as usual and only steps past its ends.
     * `null` when nothing inside scrolls (a month grid), and then every wheel movement counts towards a step. */
    getScroller: () => HTMLElement | null;
    /** Called for each step: `1` towards the next page (the wheel turned down), `-1` towards the previous. `edge` says where in the new
     * page's scroller to start, when there is one. */
    onStep: (direction: 1 | -1, edge: WheelEdge | null) => void;
}

/** A wheel event's vertical movement in pixels, whichever unit the browser reports it in. */
function pixelsOf(event: WheelEvent, page: number): number {
    return event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * page : event.deltaY;
}

/**
 * Turns the mouse wheel over `ref`'s element into stepping through pages - the months, weeks or days of a calendar - without a limit:
 * keep turning and it keeps stepping, and nothing waits for an animation to end.
 *
 * Where nothing inside scrolls, every `WHEEL_STEP_PX` of movement is a step (a bigger turn is several). Where something does, the
 * wheel scrolls it as it always did and only what is pushed against its top or bottom counts (`WHEEL_EDGE_PX`), so scrolling on
 * from the last hour of a day carries into the first hours of the next, and back the other way. The event is only cancelled when it
 * counts towards a step, so the page and whatever scrolls inside keep their own wheel behaviour everywhere else. Zooming
 * (Ctrl+wheel) and sideways movement are left alone.
 */
export function useWheelPaging(ref: RefObject<HTMLElement | null>, { enabled, getScroller, onStep }: UseWheelPagingOptions) {
    const latest = useRef({ getScroller, onStep });
    latest.current = { getScroller, onStep };
    /** Movement collected towards the next step, and when it last grew. */
    const collected = useRef({ pixels: 0, at: 0 });
    const settledUntil = useRef(0);

    useEffect(() => {
        const element = ref.current;
        if (!enabled || !element) {
            return;
        }

        function onWheel(event: WheelEvent) {
            if (event.ctrlKey || event.defaultPrevented || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
                return;
            }
            const pixels = pixelsOf(event, element!.clientHeight || 600);
            if (pixels === 0) {
                return;
            }
            const scroller = latest.current.getScroller();
            if (scroller) {
                const room = scroller.scrollHeight - scroller.clientHeight;
                const canScroll = pixels > 0 ? scroller.scrollTop < room - 1 : scroller.scrollTop > 0;
                if (room > 0 && canScroll) {
                    // Still something to scroll that way: the browser does it, and what was pushed against an end is forgotten.
                    collected.current = { pixels: 0, at: 0 };
                    return;
                }
            }

            event.preventDefault();
            const now = Date.now();
            if (scroller && now < settledUntil.current) {
                return;
            }
            const state = collected.current;
            if (now - state.at > WHEEL_IDLE_MS || Math.sign(state.pixels) !== Math.sign(pixels)) {
                state.pixels = 0;
            }
            state.at = now;
            state.pixels += pixels;

            const needed = scroller ? WHEEL_EDGE_PX : WHEEL_STEP_PX;
            while (Math.abs(state.pixels) >= needed) {
                const direction: 1 | -1 = state.pixels > 0 ? 1 : -1;
                state.pixels -= direction * needed;
                latest.current.onStep(direction, scroller ? (direction > 0 ? "top" : "bottom") : null);
                if (scroller) {
                    // One push against an end is one step; the next turn of the wheel scrolls the page it arrived at.
                    state.pixels = 0;
                    settledUntil.current = now + WHEEL_SETTLE_MS;
                    break;
                }
            }
        }

        // Not passive: the wheel's default (scrolling the page) has to be cancellable for the steps that replace it.
        element.addEventListener("wheel", onWheel, { passive: false });
        return () => element.removeEventListener("wheel", onWheel);
    }, [enabled, ref]);
}
