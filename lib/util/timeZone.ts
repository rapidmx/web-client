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
 * What `zone`'s clock is called and how far it is from UTC at `at`: `{ abbreviation: "PDT", offset: "-07:00" }`. `null` for a zone the runtime doesn't
 * know. The abbreviation is the runtime's own (`GMT+1` where it has no name for a zone), the offset counts daylight saving on that date.
 */
export function zoneClock(zone: string, at: Date = new Date()): { abbreviation: string; offset: string } | null {
    try {
        const part = (style: "short" | "longOffset") =>
            new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: style }).formatToParts(at).find((p) => p.type === "timeZoneName")!.value;
        return { abbreviation: part("short"), offset: part("longOffset").replace("GMT", "") || "+00:00" };
    } catch {
        return null;
    }
}

/** A zone id split into its city and the region it is in: "America/Argentina/Buenos_Aires" is "Buenos Aires" in "America/Argentina"; "UTC" is in none. */
function zoneNames(zone: string): { city: string; region: string } {
    const parts = zone.split("/");
    const city = parts.pop()!.replace(/_/g, " ");
    return { city, region: parts.join("/").replace(/_/g, " ") };
}

/**
 * A zone as a list or a line of text names it, city first, with how far its clock is from UTC: "Los Angeles, America (GMT-07:00)". Daylight saving
 * is read at `at` (now, unless a date matters). A zone the runtime doesn't know is just its name.
 */
export function describeTimeZone(zone: string, at: Date = new Date()): string {
    const clock = zoneClock(zone, at);
    if (!clock) {
        return zone.replace(/_/g, " ");
    }
    const { city, region } = zoneNames(zone);
    return `${city}${region ? `, ${region}` : ""} (GMT${clock.offset})`;
}

/**
 * Orders zones for a list: by how far their clocks are from UTC at `at` (the westernmost first), then by city, then by id. A zone the runtime
 * doesn't know comes last.
 */
export function compareTimeZones(a: string, b: string, at: Date = new Date()): number {
    const minutes = (zone: string) => {
        const offset = zoneClock(zone, at)?.offset;
        return offset ? (offset.startsWith("-") ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6))) : Number.POSITIVE_INFINITY;
    };
    const byOffset = minutes(a) - minutes(b);
    return (Number.isNaN(byOffset) ? 0 : byOffset) || zoneNames(a).city.localeCompare(zoneNames(b).city) || a.localeCompare(b);
}

/**
 * Every time zone the browser can name, for a picker (sorted by offset from UTC as it is now, then by city): `Intl.supportedValuesOf("timeZone")` where there is one (it leaves out `UTC`,
 * which is added), else just `extra` - the zones the caller already holds, such as a mailbox's current one.
 */
export function timeZoneOptions(...extra: string[]): string[] {
    let zones: string[] = [];
    try {
        zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    } catch {
        zones = [];
    }
    const now = new Date();
    return [...new Set([DEFAULT_TIME_ZONE, ...zones, ...extra.filter(Boolean)])].sort((a, b) => compareTimeZones(a, b, now));
}
