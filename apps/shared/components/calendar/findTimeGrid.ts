///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { format } from "date-fns";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { AvailabilitySummary } from "@rapidmx/react-shared/calendar/freeBusyApi.js";
import { addDaysToKey } from "./allDay.js";
import { msToWallString, wallStringToMs } from "./eventFormat.js";

/** How many days, from the one on show, one look-up covers: the grid's own day and the days the suggested times are found in. */
export const SEARCH_DAYS = 7;
/** The working day suggestions are found in, in the hours of the zone the event is being set in. */
export const WORK_START_HOUR = 8;
export const WORK_END_HOUR = 18;

/** Whether `value` is a `YYYY-MM-DD` key. */
export function isDayKey(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** The instant a `YYYY-MM-DD` day starts in `zone` (`deviceZone` is the zone the browser itself parses a wall clock in). */
export function dayStartMs(dayKey: string, zone: string, deviceZone: string): number {
    return wallStringToMs(`${dayKey}T00:00`, zone, deviceZone);
}

/** The stretches suggestions may fall in: each of the `SEARCH_DAYS` days from `dayKey`, 8:00 to 18:00 in `zone` - the first day always, the others only when
 * they are a weekday. */
export function workingWindows(dayKey: string, zone: string, deviceZone: string): { startMs: number; endMs: number }[] {
    const windows: { startMs: number; endMs: number }[] = [];
    for (let offset = 0; offset < SEARCH_DAYS; offset++) {
        const key = addDaysToKey(dayKey, offset);
        const weekday = new Date(`${key}T12:00:00Z`).getUTCDay();
        if (offset === 0 || (weekday >= 1 && weekday <= 5)) {
            windows.push({
                startMs: wallStringToMs(`${key}T${String(WORK_START_HOUR).padStart(2, "0")}:00`, zone, deviceZone),
                endMs: wallStringToMs(`${key}T${String(WORK_END_HOUR).padStart(2, "0")}:00`, zone, deviceZone),
            });
        }
    }
    return windows;
}

/**
 * Where an instant falls on the grid of `dayKey`, as minutes since that day's midnight on `zone`'s clock (so it lines up with the hour labels, whatever a
 * daylight-saving change did to the day's length): 0 for anything before the day, 1440 for anything after it.
 */
export function minuteOfDay(ms: number, dayKey: string, zone: string, deviceZone: string): number {
    const wall = msToWallString(ms, zone, deviceZone);
    const date = wall.slice(0, 10);
    if (date < dayKey) {
        return 0;
    }
    if (date > dayKey) {
        return 1440;
    }
    return Number(wall.slice(11, 13)) * 60 + Number(wall.slice(14, 16));
}

/** "9:00am" for an instant on `zone`'s clock. */
export function clockLabel(ms: number, zone: string, deviceZone: string): string {
    return format(new Date(msToWallString(ms, zone, deviceZone)), "h:mmaaa");
}

/** What a failed look-up says: the wait for a rate limit, the server's own reason, or a plain failure. */
export function freeBusyErrorMessage(err: unknown): string {
    if (err instanceof ApiRequestError) {
        return err.status === 429 ? "Too many availability look-ups just now. Wait a moment and try again." : err.message;
    }
    return "Couldn't load availability. Check your connection and try again.";
}

/**
 * The one line under the grid about the proposed time. "Everyone is free" is only ever said when every person could be checked and none is busy: someone
 * whose availability is unknown (an external guest, or somebody who hides their calendar) is said so, never counted as free.
 */
export function summaryLine(summary: AvailabilitySummary): string {
    const parts: string[] = [];
    if (summary.conflicts > 0) {
        parts.push(`${summary.conflicts} ${summary.conflicts === 1 ? "conflict" : "conflicts"}${summary.tentative > 0 ? ` (${summary.tentative} tentative)` : ""}`);
    } else if (summary.unknown === 0) {
        parts.push("Everyone is free");
    } else {
        parts.push("No conflicts found");
    }
    if (summary.unknown > 0) {
        parts.push(`${summary.unknown} ${summary.unknown === 1 ? "person's availability is" : "people's availability is"} unknown`);
    }
    return parts.join(" · ");
}
