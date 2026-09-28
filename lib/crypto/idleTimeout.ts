///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The configured idle-timeout duration behind `useIdleKeyTimeout()` — the spec's own "configurable
 * idle period" trigger for `keySession.ts`'s `destroyUnlockedKeys()`. Stored in `localStorage`, not
 * synced to the server: it's a per-device preference about *this browser's* own in-memory key cache,
 * the same "never persisted anywhere durable" posture `keySession.ts` itself takes for the keys this
 * setting protects.
 */
const STORAGE_KEY = "rapidmx:idle-timeout-minutes";

/** The default for a device that has never set a preference - conservative enough for a shared/public
 * machine without being disruptive on a personal one. */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;

/** `0` means "never" - the idle timer is disabled entirely. */
export const IDLE_TIMEOUT_OPTIONS_MINUTES = [5, 15, 30, 60, 0] as const;

/**
 * Reads this device's configured idle-timeout duration, in minutes. Falls back to
 * `DEFAULT_IDLE_TIMEOUT_MINUTES` for a never-configured device, a corrupted/non-numeric stored value,
 * or a `localStorage` access that throws (private-browsing/storage-blocked contexts) - never throws
 * itself, since a broken read here must not be able to prevent the app from rendering at all.
 */
export function getIdleTimeoutMinutes(): number {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === null) {
            return DEFAULT_IDLE_TIMEOUT_MINUTES;
        }
        const parsed = Number(stored);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_IDLE_TIMEOUT_MINUTES;
    } catch {
        return DEFAULT_IDLE_TIMEOUT_MINUTES;
    }
}

/** Persists this device's idle-timeout preference. A `localStorage` write failure is swallowed, not
 * thrown - the setting just doesn't survive a reload in that case, same fallback-to-default behavior
 * `getIdleTimeoutMinutes()` already has for a storage-blocked context. */
export function setIdleTimeoutMinutes(minutes: number): void {
    try {
        localStorage.setItem(STORAGE_KEY, String(minutes));
    } catch {
        // Best-effort - see this function's own doc comment.
    }
}
