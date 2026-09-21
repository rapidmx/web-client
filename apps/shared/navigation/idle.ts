///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** How long an idle callback may be held back on a busy page before it runs anyway. */
export const IDLE_TIMEOUT_MS = 3_000;

/** The delay used where the browser has no `requestIdleCallback` (Safari). */
export const IDLE_FALLBACK_DELAY_MS = 200;

/**
 * Runs `callback` once the page has finished loading (the window `load` event, which waits for every script and image the page
 * asked for) and the browser has nothing better to do (`requestIdleCallback`), or shortly after where there is no such thing.
 * For work that only makes later things faster - fetching a code chunk, warming a cache - and must never compete with what
 * the user is waiting for. Returns a function that cancels it if it hasn't run yet.
 */
export function whenIdle(callback: () => void): () => void {
    let cancelIdle: () => void = () => undefined;
    function schedule() {
        if (typeof window.requestIdleCallback === "function") {
            const handle = window.requestIdleCallback(callback, { timeout: IDLE_TIMEOUT_MS });
            cancelIdle = () => window.cancelIdleCallback(handle);
        } else {
            const timer = setTimeout(callback, IDLE_FALLBACK_DELAY_MS);
            cancelIdle = () => clearTimeout(timer);
        }
    }
    if (document.readyState === "complete") {
        schedule();
    } else {
        window.addEventListener("load", schedule, { once: true });
    }
    return () => {
        window.removeEventListener("load", schedule);
        cancelIdle();
    };
}

/** `true` when the user has asked the browser to save data (or is on a very slow connection): work that only speculates
 * about what will be needed - prefetching - should not run then. */
export function shouldSaveData(): boolean {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    return connection?.saveData === true || connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g";
}
