///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The last appearance this browser applied, kept in `localStorage` so a page load (or a page the server didn't send the preferences
 * to) paints with the user's theme from the first frame instead of flashing the default. It holds the finished stylesheet text, so
 * the tiny inline script in `<head>` (`APPEARANCE_BOOT_SCRIPT`) applies it without any of this app's code having loaded.
 *
 * **Which copy wins.** The server renders a page's preferences into it, but the server caches a rendered page for up to a minute, so
 * that copy can be *older* than what this browser last applied (a change made a few seconds ago). Each copy therefore carries a time -
 * the server's `updatedAt`, or for an edit this browser has made and not yet heard back about, the moment it was made - and the newer
 * one is applied (`t`). After a reset the cache keeps an empty stylesheet ("nothing chosen") rather than being removed, for the same
 * reason: it is newer than the stale page's idea of a background. Every access is in try/catch: storage can be blocked, full or
 * absent (private windows, server-side rendering).
 */
import { AppearanceMode, AppearancePreferences, normalizeAppearance } from "@rapidmx/react-shared/appearance/preferencesApi.js";
import { rangeFromLevels, rangeToLevels } from "./photo.js";
import type { PhotoRange } from "./theme.js";

export const APPEARANCE_CACHE_KEY = "rapidmx-appearance";

export interface AppearanceCache {
    v: 1;
    /** Whose it is - so a browser shared by two accounts never shows one the other's background. Absent when the page didn't know. */
    uid?: string;
    /** `cacheKeyOf(prefs)`: what the stylesheet was made from. */
    key: string;
    /** When these preferences were last changed, in milliseconds - see this module's doc comment. */
    t: number;
    mode: AppearanceMode;
    prefs: AppearancePreferences;
    /** The finished stylesheet text; empty when the preferences change nothing. */
    css: string;
    /** The measured lightness of the image, as two gray levels, with the image version they belong to. */
    measured?: { version: string; levels: [number, number] };
}

/** What identifies a set of preferences (the server-rendered stylesheet carries the same in `data-key`): their normalised JSON, whose key order is always the same. */
export function cacheKeyOf(prefs: AppearancePreferences): string {
    return JSON.stringify(normalizeAppearance(prefs) ?? prefs);
}

/** A server `updatedAt` (an ISO date or milliseconds, both opaque to the rest of the client) as milliseconds; `0` for none or one that isn't a date. */
export function timeOf(updatedAt: string | number | undefined): number {
    const time = typeof updatedAt === "number" ? updatedAt : updatedAt === undefined ? 0 : Date.parse(updatedAt);
    return Number.isFinite(time) ? time : 0;
}

/** The stored cache, or `undefined` when there is none, it can't be read, or it isn't well formed. */
export function readAppearanceCache(): AppearanceCache | undefined {
    try {
        const raw = JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY) ?? "null");
        const prefs = normalizeAppearance(raw?.prefs);
        if (raw?.v !== 1 || !prefs || typeof raw.css !== "string") {
            return undefined;
        }
        const cache: AppearanceCache = {
            v: 1,
            key: cacheKeyOf(prefs),
            t: typeof raw.t === "number" && Number.isFinite(raw.t) ? raw.t : 0,
            mode: prefs.mode,
            prefs,
            css: raw.css,
        };
        if (typeof raw.uid === "string") {
            cache.uid = raw.uid;
        }
        if (typeof raw.measured?.version === "string" && rangeFromLevels(raw.measured.levels)) {
            cache.measured = { version: raw.measured.version, levels: raw.measured.levels };
        }
        return cache;
    } catch {
        return undefined;
    }
}

export function writeAppearanceCache(
    prefs: AppearancePreferences,
    css: string,
    time: number,
    uid?: string,
    measured?: { version: string; range: PhotoRange },
): void {
    try {
        const cache: AppearanceCache = { v: 1, key: cacheKeyOf(prefs), t: time, mode: prefs.mode, prefs, css };
        if (uid) {
            cache.uid = uid;
        }
        if (measured) {
            cache.measured = { version: measured.version, levels: rangeToLevels(measured.range) };
        }
        localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify(cache));
    } catch {
        // Storage is unavailable or full: the theme still applies, it just isn't remembered.
    }
}

/** Forgets the cache - on sign-out, so the next person to sign in on this browser starts from their own. */
export function clearAppearanceCache(): void {
    try {
        localStorage.removeItem(APPEARANCE_CACHE_KEY);
    } catch {
        // Nothing to forget.
    }
}
