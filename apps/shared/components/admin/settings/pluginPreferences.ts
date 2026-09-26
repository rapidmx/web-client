///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Whether the Plugins page offers prerelease versions (`1.0.0-beta.2`) of plugins - for an update, in the version lists
 * and in a plugin search. Stored in `localStorage`, so it is a preference of this browser, not a setting the server
 * keeps: it only decides what the administrator is shown, since an administrator can already install any published
 * version by name. Off unless it was turned on.
 *
 * A read that finds nothing, or a `localStorage` that throws (private-browsing/storage-blocked contexts), is off, and a
 * write that fails is swallowed, so a blocked store only means the choice doesn't survive a reload.
 */
const STORAGE_KEY = "rapidmx:plugins-allow-prerelease";

export function getAllowPrerelease(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
        return false;
    }
}

export function setAllowPrerelease(allow: boolean): void {
    try {
        if (allow) {
            localStorage.setItem(STORAGE_KEY, "true");
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
    } catch {
        // Not persisted; the choice still applies until the page is reloaded.
    }
}
