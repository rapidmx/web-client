///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useCallback, useRef } from "react";

/** The CSS variable (on `<html>`) that holds the height, in px, of the frame's sticky header - its title bar or the branding header. */
export const HEADER_HEIGHT_VAR = "--rr-header-h";

/**
 * A ref callback for the frame's sticky `<header>`: publishes its height as `--rr-header-h` (and keeps it current as the header resizes -
 * a branded header can be any height and wraps on a phone), so the pop-up stack (`NotificationCenter`) can stick just below it instead of
 * sliding under it or over the account menu. When the header goes (a page without one) the variable is set to 0 rather than left stale.
 */
export function useHeaderHeightRef(): (element: HTMLElement | null) => void {
    const stop = useRef<(() => void) | undefined>(undefined);
    return useCallback((element: HTMLElement | null) => {
        stop.current?.();
        stop.current = undefined;
        const root = document.documentElement;
        if (!element) {
            root.style.setProperty(HEADER_HEIGHT_VAR, "0px");
            return;
        }
        const publish = () => root.style.setProperty(HEADER_HEIGHT_VAR, `${Math.round(element.getBoundingClientRect().height)}px`);
        publish();
        const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(publish);
        observer?.observe(element);
        window.addEventListener("resize", publish);
        stop.current = () => {
            observer?.disconnect();
            window.removeEventListener("resize", publish);
        };
    }, []);
}
