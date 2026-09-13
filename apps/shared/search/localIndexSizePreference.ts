///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The user-adjustable byte budget behind the Tier 2 local index's window (`localIndexBuilder.ts`'s
 * `buildLocalIndex()`). Stored in `localStorage`, not synced to the server - a per-device preference
 * about *this device's* own local OPFS storage, the same posture `idleTimeout.ts`
 * (`@rapidmx/react-shared`) already takes for its own per-device setting, which this file mirrors.
 *
 * `specs/search.md` §10/§11 distinguish "Web" (quota-limited) from "Native desktop" (disk-limited) as
 * different rows of the same Window Sizing table, not different storage engines - Electron's renderer is
 * Chromium, so it runs this exact same OPFS/wa-sqlite/`EncryptingVFS` code, just with more disk headroom
 * to spend. `isElectronRuntime()` reads `window.rapidmx` - the `contextBridge` global
 * `electron-client/src/main/preload.ts` exposes only inside that renderer (see its own `global.d.ts`) -
 * as a runtime duck-type signal, so this file (which `electron-client` consumes unmodified via its
 * `link:../web-client` dependency - see `localIndexBuilder.ts`'s own doc comment on that) never needs an
 * explicit "which platform am I" value threaded down from anywhere.
 */
const STORAGE_KEY = "rapidmx:local-index-byte-budget";

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** §11's Window Sizing table, Web row. */
export const WEB_DEFAULT_BYTE_BUDGET_BYTES = 500 * MB;
/** §11's Window Sizing table, Native desktop row - still a real, user-adjustable ceiling (not
 * `UNBOUNDED`), just a roomier default given Electron's storage is disk-limited rather than
 * browser-quota-limited. */
export const ELECTRON_DEFAULT_BYTE_BUDGET_BYTES = 1 * GB;

export interface LocalIndexSizeOption {
    bytes: number;
    label: string;
}

/** Selectable presets for the Settings UI. `0` means "unlimited" - `applyEviction()`
 * (`localIndexWorker.ts`) already treats a falsy byte budget as unconfigured/unenforced. */
export const LOCAL_INDEX_SIZE_OPTIONS: LocalIndexSizeOption[] = [
    { bytes: 100 * MB, label: "100 MB" },
    { bytes: 250 * MB, label: "250 MB" },
    { bytes: WEB_DEFAULT_BYTE_BUDGET_BYTES, label: "500 MB" },
    { bytes: ELECTRON_DEFAULT_BYTE_BUDGET_BYTES, label: "1 GB" },
    { bytes: 2 * GB, label: "2 GB" },
    { bytes: 5 * GB, label: "5 GB" },
    { bytes: 10 * GB, label: "10 GB" },
    { bytes: 0, label: "Unlimited (disk space only)" },
];

function isElectronRuntime(): boolean {
    return typeof window !== "undefined" && "rapidmx" in window;
}

/** This device's default byte budget before any explicit preference is saved - `500 MB` in a browser
 * tab, `1 GB` in the Electron shell. */
export function getDefaultLocalIndexByteBudget(): number {
    return isElectronRuntime() ? ELECTRON_DEFAULT_BYTE_BUDGET_BYTES : WEB_DEFAULT_BYTE_BUDGET_BYTES;
}

/**
 * Reads this device's configured local-index byte budget. Falls back to
 * `getDefaultLocalIndexByteBudget()` for a never-configured device, a corrupted/non-numeric stored
 * value, or a `localStorage` access that throws (private-browsing/storage-blocked contexts) - never
 * throws itself, matching `getIdleTimeoutMinutes()`'s identical fallback posture.
 */
export function getLocalIndexByteBudget(): number {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored === null) {
            return getDefaultLocalIndexByteBudget();
        }
        const parsed = Number(stored);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : getDefaultLocalIndexByteBudget();
    } catch {
        return getDefaultLocalIndexByteBudget();
    }
}

/** Persists this device's local-index byte-budget preference. A `localStorage` write failure is
 * swallowed, not thrown - the setting just doesn't survive a reload in that case, same fallback-to-default
 * behavior `getLocalIndexByteBudget()` already has for a storage-blocked context. */
export function setLocalIndexByteBudget(bytes: number): void {
    try {
        localStorage.setItem(STORAGE_KEY, String(bytes));
    } catch {
        // Best-effort - see this function's own doc comment.
    }
}
