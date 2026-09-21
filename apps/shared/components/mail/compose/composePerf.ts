///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * `performance.mark()`/`measure()` around the phases between clicking Compose/Reply/Forward and the window being usable,
 * for the browser's Performance panel (or `performance.getEntriesByType("measure")`). Marks are named
 * `compose:<window id>:<phase>`; the measures are named `compose:<from>-><to>` and carry the window id in `detail`.
 *
 * Phases, in order: `click` (the handler ran), `shell` (the window's frame is on screen - the placeholder, or the real
 * window once its chunk has loaded), `chunk` (the window's code has loaded and rendered), `body` (the seeded body -
 * signature and quoted original - is ready), `editor` (the editor has mounted and can be typed into), `draft` (the server
 * draft exists).
 *
 * On in development builds, and in a production build when `window.__RAPIDMX_PERF__` is set to `true` (from the console:
 * `window.__RAPIDMX_PERF__ = true`). Off otherwise, when each call is a no-op.
 */

export type ComposePhase = "click" | "shell" | "chunk" | "body" | "editor" | "draft";

function enabled(): boolean {
    if (typeof performance === "undefined" || typeof performance.mark !== "function") {
        return false;
    }
    return import.meta.env?.DEV === true || (globalThis as { __RAPIDMX_PERF__?: boolean }).__RAPIDMX_PERF__ === true;
}

/** The compose sessions a `click` mark was made for, so the first mark of each phase is the only one that counts. */
const marked = new Set<string>();

/** Marks `phase` of window `id` once (later calls for the same phase are ignored), and measures it from `click`. */
export function markComposePhase(id: string, phase: ComposePhase): void {
    if (!enabled()) {
        return;
    }
    const key = `compose:${id}:${phase}`;
    if (marked.has(key)) {
        return;
    }
    marked.add(key);
    performance.mark(key);
    const start = `compose:${id}:click`;
    if (phase !== "click" && marked.has(start)) {
        performance.measure(`compose:click->${phase}`, { start, end: key, detail: { id } });
    }
}
