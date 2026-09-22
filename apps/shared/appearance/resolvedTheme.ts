///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useSyncExternalStore } from "react";

/** The colour scheme the app is showing right now: what the user chose, or - for "System" - what the operating system prefers. */
export type ResolvedTheme = "light" | "dark";

/** The media query that says the operating system prefers a dark scheme. */
export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/**
 * The scheme in effect: an explicit `data-theme="light" | "dark"` on `<html>` (set by `AppearanceProvider` for every choice
 * including "System", and by a page's own `<html data-theme>`) wins, else the operating system's preference, else `"light"`.
 * `"light"` where there is no document (server-side rendering).
 */
export function readResolvedTheme(): ResolvedTheme {
    if (typeof document === "undefined") {
        return "light";
    }
    const override = document.documentElement.getAttribute("data-theme");
    if (override === "light" || override === "dark") {
        return override;
    }
    return typeof window.matchMedia === "function" && window.matchMedia(DARK_SCHEME_QUERY).matches ? "dark" : "light";
}

/** Calls `onChange` when the operating system's scheme or `<html data-theme>` changes; returns the unsubscribe. */
function subscribe(onChange: () => void): () => void {
    const media = typeof window.matchMedia === "function" ? window.matchMedia(DARK_SCHEME_QUERY) : undefined;
    media?.addEventListener("change", onChange);
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
        media?.removeEventListener("change", onChange);
        observer.disconnect();
    };
}

/**
 * `"light"` or `"dark"`: the scheme the app is showing now, kept live - it changes when the user picks another in Settings >
 * Appearance and, while they follow the system, when the operating system's preference flips. For anything that must match the
 * app's scheme without reading CSS (a message body rendered in its own document, a canvas, a chart). Needs no provider: it reads
 * `<html data-theme>` and `matchMedia` itself. Renders `"light"` on the server and for the hydrating render, then the real value.
 */
export function useResolvedTheme(): ResolvedTheme {
    return useSyncExternalStore(subscribe, readResolvedTheme, () => "light");
}

export { useAppearance } from "./appearanceContext.js";
export type { AppearanceApi, AppearancePatch } from "./appearanceContext.js";

function subscribeSystem(onChange: () => void): () => void {
    const media = typeof window.matchMedia === "function" ? window.matchMedia(DARK_SCHEME_QUERY) : undefined;
    media?.addEventListener("change", onChange);
    return () => media?.removeEventListener("change", onChange);
}

function readSystemDark(): boolean {
    return typeof window.matchMedia === "function" && window.matchMedia(DARK_SCHEME_QUERY).matches;
}

/** `true` while the operating system prefers a dark scheme - only the media query, never `<html data-theme>` (which `AppearanceProvider` sets from this). */
export function useSystemPrefersDark(): boolean {
    return useSyncExternalStore(subscribeSystem, readSystemDark, () => false);
}
