///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The calendar's search: which events match what was typed, and the chronological list of their occurrences to step through. The calendar page
 * already holds every event of the checked calendars (`listCalendarEvents()` fetches whole folders - there is no server-side text or range query
 * to lean on), so this is entirely client-side and covers all time, not just the visible range. A series contributes the occurrences inside a window
 * of `SEARCH_WINDOW_YEARS` either side of today, at most `SEARCH_MAX_OCCURRENCES_PER_SERIES` of them (the ones nearest today).
 */

import { addYears } from "date-fns";
import { CalendarEvent } from "./calendarApi.js";
import { CalendarOccurrence, expandOccurrences } from "./recurrence.js";

/** How far either side of today a recurring event's occurrences are searched. */
export const SEARCH_WINDOW_YEARS = 5;
/** The most occurrences one recurring event contributes (the ones nearest today), so a daily series cannot flood the results. */
export const SEARCH_MAX_OCCURRENCES_PER_SERIES = 500;

/** Lower-cases `text` and strips its accents, so "cafe" finds "Café". */
function fold(text: string): string {
    return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The words of `query`, folded; an event must match every one of them. Empty for a blank query. */
export function searchTerms(query: string): string[] {
    return fold(query)
        .split(/\s+/)
        .filter((term) => term !== "");
}

/** The text of `event` a search looks in: title, location, description (plain text), organizer and guests (name and address). */
function searchableText(event: CalendarEvent): string {
    const parts: (string | null | undefined)[] = [
        event.title,
        event.location,
        event.description,
        event.organizer?.displayName,
        event.organizer?.address,
    ];
    for (const attendee of event.attendees ?? []) {
        parts.push(attendee.displayName, attendee.address);
    }
    return fold(parts.filter(Boolean).join("\n"));
}

/**
 * Whether `event` has every one of `terms` (from `searchTerms()`) somewhere in its readable text. A busy block (`redacted`: a private event on a
 * shared calendar) never matches - its title is a placeholder, not what the event says.
 */
export function eventMatchesTerms(event: CalendarEvent, terms: string[]): boolean {
    if (terms.length === 0 || event.redacted) {
        return false;
    }
    const text = searchableText(event);
    return terms.every((term) => text.includes(term));
}

function byStart(a: CalendarOccurrence, b: CalendarOccurrence): number {
    return new Date(a.startDate).getTime() - new Date(b.startDate).getTime() || a.title.localeCompare(b.title);
}

/**
 * The occurrences of the events of `events` that match `query`, in chronological order. A single event is one occurrence wherever it falls; a
 * recurring one contributes those within `SEARCH_WINDOW_YEARS` of `now`, the `SEARCH_MAX_OCCURRENCES_PER_SERIES` nearest to it at most.
 */
export function searchOccurrences(events: CalendarEvent[], query: string, now: Date = new Date()): CalendarOccurrence[] {
    const terms = searchTerms(query);
    const from = addYears(now, -SEARCH_WINDOW_YEARS);
    const to = addYears(now, SEARCH_WINDOW_YEARS);
    const found: CalendarOccurrence[] = [];
    for (const event of events) {
        if (!eventMatchesTerms(event, terms)) {
            continue;
        }
        if (!event.recurrenceRule) {
            found.push(...expandOccurrences(event, new Date(new Date(event.startDate).getTime() - 1), new Date(new Date(event.endDate).getTime() + 1)));
            continue;
        }
        const occurrences = expandOccurrences(event, from, to);
        if (occurrences.length > SEARCH_MAX_OCCURRENCES_PER_SERIES) {
            const distance = (o: CalendarOccurrence) => Math.abs(new Date(o.startDate).getTime() - now.getTime());
            occurrences.sort((a, b) => distance(a) - distance(b)).length = SEARCH_MAX_OCCURRENCES_PER_SERIES;
        }
        found.push(...occurrences);
    }
    return found.sort(byStart);
}

/** The `occurrences` that overlap `[rangeStart, rangeEnd]` - what `expandOccurrences()` keeps, so a view shows exactly these. */
export function occurrencesInRange(occurrences: CalendarOccurrence[], rangeStart: Date, rangeEnd: Date): CalendarOccurrence[] {
    return occurrences.filter((o) => new Date(o.startDate) < rangeEnd && new Date(o.endDate) > rangeStart);
}

/**
 * Which of the chronological `matches` to show first for a search: the first one inside the view (`[rangeStart, rangeEnd]`) when there is one,
 * else the first that ends after `from` (the day being viewed), else the last (the nearest before). `-1` when there are no matches.
 */
export function initialMatchIndex(matches: CalendarOccurrence[], rangeStart: Date, rangeEnd: Date, from: Date): number {
    if (matches.length === 0) {
        return -1;
    }
    const inView = matches.findIndex((o) => new Date(o.startDate) < rangeEnd && new Date(o.endDate) > rangeStart);
    if (inView >= 0) {
        return inView;
    }
    const after = matches.findIndex((o) => new Date(o.endDate) > from);
    return after >= 0 ? after : matches.length - 1;
}

/** The index one step from `index` (`-1`: none is current) in `direction` through `count` matches, wrapping round at either end. `-1` with none. */
export function stepMatchIndex(index: number, count: number, direction: 1 | -1): number {
    if (count === 0) {
        return -1;
    }
    if (index < 0) {
        return direction === 1 ? 0 : count - 1;
    }
    return (index + direction + count) % count;
}
