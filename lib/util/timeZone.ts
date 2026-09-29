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
            formatterFor(zone, style).formatToParts(at).find((p) => p.type === "timeZoneName")!.value;
        return { abbreviation: part("short"), offset: part("longOffset").replace("GMT", "") || "+00:00" };
    } catch {
        return null;
    }
}

/** Building an `Intl.DateTimeFormat` is by far the costly part of naming a zone's clock, and a list names hundreds: each is made once. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string, style: "short" | "longOffset"): Intl.DateTimeFormat {
    const key = `${style}|${zone}`;
    let formatter = formatters.get(key);
    if (!formatter) {
        // Throws for a zone the runtime doesn't know, which is then not remembered.
        formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: style });
        formatters.set(key, formatter);
    }
    return formatter;
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
export function sortTimeZones(zones: readonly string[], at: Date = new Date()): string[] {
    // Each zone's offset is read once, not once per comparison.
    const keyed = zones.map((zone) => {
        const offset = zoneClock(zone, at)?.offset;
        const minutes = offset ? (offset.startsWith("-") ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6))) : Number.POSITIVE_INFINITY;
        return { zone, minutes, city: zoneNames(zone).city };
    });
    keyed.sort((a, b) => (a.minutes === b.minutes ? 0 : a.minutes < b.minutes ? -1 : 1) || a.city.localeCompare(b.city) || a.zone.localeCompare(b.zone));
    return keyed.map((entry) => entry.zone);
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
    return sortTimeZones([...new Set([DEFAULT_TIME_ZONE, ...zones, ...extra.filter(Boolean)])]);
}
