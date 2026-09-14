///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { format } from "date-fns";
import { WeekdayCode } from "@rapidmx/react-shared/calendar/calendarApi.js";
import { CalendarOccurrence, toEventWallClock } from "@rapidmx/react-shared/calendar/recurrence.js";

const MS_PER_DAY = 86_400_000;

/**
 * All-day events are stored date-only: `startDate` is UTC midnight of the first day and `endDate` is UTC
 * midnight of the day *after* the last day (exclusive, like iCalendar's `DTEND;VALUE=DATE`). That keeps
 * an all-day event on the same calendar date for every viewer, whatever their timezone.
 *
 * Older events were saved as the creator's *local* midnight converted to UTC (e.g. `...T22:00Z` for a
 * UTC+2 creator), so reading one rounds the instant to the nearest UTC midnight rather than slicing the
 * ISO string — which gives the intended date for both formats.
 */
export function allDayDateKey(iso: string): string {
    const rounded = Math.round(new Date(iso).getTime() / MS_PER_DAY) * MS_PER_DAY;
    return new Date(rounded).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` -> the stored UTC-midnight instant for that date. */
export function allDayInstant(dateKey: string): string {
    return `${dateKey}T00:00:00.000Z`;
}

/** Adds `days` to a `YYYY-MM-DD` date key. */
export function addDaysToKey(dateKey: string, days: number): string {
    return new Date(new Date(allDayInstant(dateKey)).getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** The local calendar date `day` (a local-midnight `Date` from a grid view) as a `YYYY-MM-DD` key. */
export function localDateKey(day: Date): string {
    return format(day, "yyyy-MM-dd");
}

/**
 * A recurrence rule's inclusive "Ends on" date -> its stored `until` instant: the end of that day in the
 * frame the series expands in. A timed series expands in its own (normally the viewer's) timezone, so that's
 * the end of the local day - `new Date("YYYY-MM-DD")` would be UTC midnight, the previous day west of UTC.
 * An all-day series expands in UTC (react-shared's `expandOccurrences`), so it's the end of the UTC day: the
 * local end of day is already the next UTC day west of UTC and would add one more occurrence.
 */
export function recurrenceUntilInstant(dateKey: string, allDay: boolean): string {
    if (allDay) {
        return `${dateKey}T23:59:59.999Z`;
    }
    const [y, m, d] = dateKey.split("-").map(Number);
    return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

/** The stored form of an all-day series' "Ends on" date - the last millisecond of that UTC day. */
const ALL_DAY_UNTIL_PATTERN = /^(\d{4}-\d{2}-\d{2})T23:59:59\.999Z$/;
/** A bare UTC midnight - how the oldest editor (and date-only `UNTIL` values) stored the chosen date itself. */
const UTC_MIDNIGHT_PATTERN = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/;

/**
 * Inverse of `recurrenceUntilInstant()`. An all-day series' value is recognized explicitly in its stored
 * `T23:59:59.999Z` form (and as a bare UTC midnight, the oldest form). Anything else is a legacy value stored
 * as the creator's *local* end of day, which can land anywhere from just before 10:00Z on the chosen date (UTC+14)
 * to just before 12:00Z the day after (UTC-12) - a 26-hour spread no UTC-only rounding can resolve (UTC+14 and UTC-10
 * creators' values are exactly 24h apart for the same date), so it reads back on the local calendar, the
 * frame it was written in.
 */
export function recurrenceUntilDateKey(until: string, allDay: boolean): string {
    if (allDay) {
        const stored = ALL_DAY_UNTIL_PATTERN.exec(until) ?? UTC_MIDNIGHT_PATTERN.exec(until);
        if (stored) {
            return stored[1];
        }
    }
    return format(new Date(until), "yyyy-MM-dd");
}

/** `Date#getUTCDay()` index -> RFC 5545 weekday code. */
const JS_WEEKDAY_CODES: WeekdayCode[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** The weekday an event starts on, in the frame its series expands in: the UTC date for an all-day event
 * (`start`'s date part), the event's own timezone otherwise (`start` being a local `datetime-local` value).
 * `undefined` while the start input is empty/invalid. */
export function startWeekdayCode(start: string, allDay: boolean, timezone: string | undefined): WeekdayCode | undefined {
    const ms = allDay ? new Date(allDayInstant(start.slice(0, 10))).getTime() : new Date(start).getTime();
    if (Number.isNaN(ms)) {
        return undefined;
    }
    return JS_WEEKDAY_CODES[new Date(toEventWallClock(ms, timezone, allDay)).getUTCDay()];
}

/**
 * Whether `occurrence` should be shown on the grid's local calendar day `day`. All-day events cover every
 * date from their start date up to (not including) their exclusive end date — at least their start date.
 * Timed events cover every local day their [start, end) interval overlaps, so a multi-day event shows on
 * each day rather than only on its start day.
 */
export function occursOnDay(occurrence: CalendarOccurrence, day: Date): boolean {
    if (occurrence.allDay) {
        const key = localDateKey(day);
        const startKey = allDayDateKey(occurrence.startDate);
        const endKey = allDayDateKey(occurrence.endDate);
        return key === startKey || (key > startKey && key < endKey);
    }
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    const start = new Date(occurrence.startDate);
    const end = new Date(occurrence.endDate);
    if (start.getTime() === end.getTime()) {
        return start >= dayStart && start < dayEnd;
    }
    return start < dayEnd && end > dayStart;
}

/**
 * Whether `day` is the first day `occurrence` covers. Grid views only make that day's chip/block
 * draggable — a drag id must be unique, so the continuation copies on later days are display-only.
 */
export function startsOnDay(occurrence: CalendarOccurrence, day: Date): boolean {
    if (occurrence.allDay) {
        return allDayDateKey(occurrence.startDate) === localDateKey(day);
    }
    return localDateKey(new Date(occurrence.startDate)) === localDateKey(day);
}
