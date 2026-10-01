///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useRef, type MouseEvent, type TouchEvent } from "react";

export interface UseLongPressOptions {
    /** Nothing starts while this is `false` (a desktop pointer, select mode); a press already held out is still seen through. Default `true`. */
    enabled?: boolean;
    /** How long a finger has to stay down, in ms. Default `LONG_PRESS_MS`. */
    delay?: number;
    /** How far it may wander meanwhile, in px. Default `LONG_PRESS_SLOP`. */
    tolerance?: number;
    /** Called once when the press has been held for `delay`. */
    onLongPress: () => void;
}

/** How long a finger holds still to count as a press and hold, and how far it may drift (an unsteady hand) before it is a scroll or a swipe instead. */
export const LONG_PRESS_MS = 480;
export const LONG_PRESS_SLOP = 8;
/** How long after the finger lifts the click it would make is still swallowed; a press that makes none (the browser took it as a context menu) must not eat a later one. */
const CLICK_WINDOW_MS = 500;

/**
 * Press and hold by one finger, for the touch screens the app's phone layout is for: mouse and pen are left alone.
 *
 * Spread the handlers on the element. The press is given up the moment the finger moves more than `tolerance`, a second finger lands, the touch is
 * cancelled (the browser took it over to scroll) or something scrolls, so it never fights vertical scrolling or `useSwipe()`: a swipe has to travel
 * further than the tolerance to be one. Once it fires, the finger lifting must not also be a click on whatever is under it (the click that follows is
 * swallowed once), and the browser's own long-press (the context menu, the text selection and the callout of a link) is suppressed.
 *
 * The handlers stay on even while `enabled` is `false`, because the row that was pressed usually makes itself disabled in answer (select mode),
 * and the click that ends the press still has to be swallowed after that.
 */
export function useLongPress({ enabled = true, delay = LONG_PRESS_MS, tolerance = LONG_PRESS_SLOP, onLongPress }: UseLongPressOptions) {
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const start = useRef({ x: 0, y: 0 });
    /** The press fired and its click has not come yet. */
    const fired = useRef(false);
    const clickWindow = useRef<ReturnType<typeof setTimeout> | null>(null);
    const latest = useRef(onLongPress);
    latest.current = onLongPress;

    // One function for the life of the row: it is also the scroll listener, which has to be removed with the very function it was added with.
    const forget: () => void = useRef(() => {
        if (timer.current !== null) {
            clearTimeout(timer.current);
            timer.current = null;
            window.removeEventListener("scroll", forget, true);
        }
    }).current;

    function clearClickWindow() {
        if (clickWindow.current !== null) {
            clearTimeout(clickWindow.current);
            clickWindow.current = null;
        }
    }

    // A timer left running would fire into a row that is gone.
    useEffect(
        () => () => {
            forget();
            if (clickWindow.current !== null) {
                clearTimeout(clickWindow.current);
            }
        },
        [forget],
    );

    function onTouchStart(event: TouchEvent<HTMLElement>) {
        forget();
        clearClickWindow();
        fired.current = false;
        if (!enabled || event.touches.length !== 1) {
            return;
        }
        start.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
        // Scroll events don't bubble: only a capturing listener hears the list (or the page) moving under a finger that hasn't moved.
        window.addEventListener("scroll", forget, { capture: true, passive: true });
        timer.current = setTimeout(() => {
            timer.current = null;
            window.removeEventListener("scroll", forget, true);
            fired.current = true;
            navigator.vibrate?.(10);
            latest.current();
        }, delay);
    }

    function onTouchMove(event: TouchEvent<HTMLElement>) {
        if (timer.current === null) {
            return;
        }
        const touch = event.touches[0];
        if (event.touches.length !== 1 || Math.hypot(touch.clientX - start.current.x, touch.clientY - start.current.y) >= tolerance) {
            forget();
        }
    }

    function onTouchEnd(event: TouchEvent<HTMLElement>) {
        forget();
        if (fired.current) {
            // No click of the browser's own after this; the one that comes anyway (older browsers) is swallowed by `onClickCapture`.
            event.preventDefault();
            clearClickWindow();
            clickWindow.current = setTimeout(() => {
                clickWindow.current = null;
                fired.current = false;
            }, CLICK_WINDOW_MS);
        }
    }

    function onTouchCancel() {
        forget();
        fired.current = false;
    }

    function onClickCapture(event: MouseEvent<HTMLElement>) {
        if (fired.current) {
            fired.current = false;
            event.preventDefault();
            event.stopPropagation();
        }
    }

    function onContextMenu(event: MouseEvent<HTMLElement>) {
        // The long-press menu of a touch screen comes while the finger is still down (Android) or just after it fired.
        if (timer.current !== null || fired.current) {
            event.preventDefault();
        }
    }

    return {
        handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, onClickCapture, onContextMenu },
        /** No text selection and no callout on what is pressed, while a press can start: the page's text stays selectable elsewhere. */
        style: enabled ? ({ WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" } as const) : undefined,
    };
}
