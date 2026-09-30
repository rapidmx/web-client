///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** Where this browser remembers whether the admin console's side rail is showing its labels. */
export const RAIL_EXPANDED_KEY = "rapidmx:admin-rail-expanded";

/** Whether the rail was left expanded. A missing or blocked store means collapsed, as it always was. */
export function readRailExpanded(): boolean {
    try {
        return localStorage.getItem(RAIL_EXPANDED_KEY) === "true";
    } catch {
        return false;
    }
}

/** Remembers the rail's state. Best effort: a blocked store only means it starts collapsed the next time. */
export function writeRailExpanded(expanded: boolean): void {
    try {
        localStorage.setItem(RAIL_EXPANDED_KEY, String(expanded));
    } catch {
        // Nothing to do.
    }
}
