///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { format } from "date-fns";
import { CalendarOccurrence } from "@rapidmx/react-shared/calendar/recurrence.js";

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
