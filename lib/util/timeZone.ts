///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** The time zone a mailbox has when nothing better is known - the server's own default. */
export const DEFAULT_TIME_ZONE = "UTC";

/**
 * The IANA time zone of the device this is running on (`"America/Los_Angeles"`), as the browser reports it, or `"UTC"` where it
 * can't say (server-side rendering, an old engine). What a new mailbox, and a settings form with nothing chosen yet, start with.
 */
export function deviceTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE;
    } catch {
        return DEFAULT_TIME_ZONE;
    }
}

/**
 * Every time zone the browser can name, for a picker: `Intl.supportedValuesOf("timeZone")` where there is one (it leaves out `UTC`,
 * which is added), else just `extra` - the zones the caller already holds, such as a mailbox's current one.
 */
export function timeZoneOptions(...extra: string[]): string[] {
    let zones: string[] = [];
    try {
        zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    } catch {
        zones = [];
    }
    return [...new Set([DEFAULT_TIME_ZONE, ...zones, ...extra.filter(Boolean)])].sort((a, b) => a.localeCompare(b));
}
