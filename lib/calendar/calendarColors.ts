///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** A fixed client-side color palette for calendars, matching the plan's "no new `Category`-style
 * backend entity" approach already used for Contacts' categories: `Folder.color` just stores one of
 * these hex values (or, in principle, any string — an unrecognized one still works fine as a raw CSS
 * color), the palette itself never needs to round-trip through the backend. */

import { Folder } from "../mail/mailApi.js";

export const CALENDAR_COLOR_PALETTE: string[] = [
    "#2563eb", // blue
    "#7c3aed", // violet
    "#db2777", // pink
    "#dc2626", // red
    "#ea580c", // orange
    "#ca8a04", // amber
    "#16a34a", // green
    "#0d9488", // teal
];

/** The color a mailbox's original auto-provisioned calendar effectively had before this field
 * existed — kept as the fallback so every pre-existing calendar keeps looking the same. */
export const DEFAULT_CALENDAR_COLOR = CALENDAR_COLOR_PALETTE[0];

/** `fallback` replaces `DEFAULT_CALENDAR_COLOR` for a folder with no color of its own - e.g. a shared
 * mailbox's calendar falling back to that mailbox's `accentColorForMailbox()`, so it doesn't render in
 * the same default blue as the caller's own calendar. An explicit `Folder.color` always wins. */
export function colorForFolder(folder: Pick<Folder, "color">, fallback: string = DEFAULT_CALENDAR_COLOR): string {
    return folder.color || fallback;
}

/** A stable per-mailbox color for grouping one mailbox's calendars together (sidebar section accent, and
 * the fallback color for its uncolored calendars). Deterministic hash of `mailboxUid` into the palette
 * minus `DEFAULT_CALENDAR_COLOR`, so another mailbox never collides with the default a caller's own
 * calendar already uses. Client-side only - nothing is persisted. */
export function accentColorForMailbox(mailboxUid: string): string {
    const choices = CALENDAR_COLOR_PALETTE.slice(1);
    let hash = 0;
    for (let i = 0; i < mailboxUid.length; i++) {
        hash = (hash * 31 + mailboxUid.charCodeAt(i)) >>> 0;
    }
    return choices[hash % choices.length];
}
