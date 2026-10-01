///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useMemo, useRef } from "react";
import { addDays, format, isToday, parseISO, startOfDay } from "date-fns";
import { CalendarOccurrence } from "../../../../lib/calendar/recurrence.js";
import { allDayDateKey, localDateKey, startsOnDay } from "./allDay.js";
import { occurrenceMarker, useActiveOccurrenceKey } from "./activeOccurrence.js";

/** The most days one event is listed on, so an event that runs for years does not become thousands of rows. */
export const LIST_MAX_DAYS_PER_EVENT = 366;

/** A step through the list's months: `nonce` makes a second press in the same direction a new step. */
export interface ListStep {
    direction: 1 | -1;
    nonce: number;
}

export interface ListViewProps {
    /** Every occurrence to list (or, while a search runs, only its matches) - see `eventSearch.ts`'s `allOccurrences()`. Only today and later is shown. */
    occurrences: CalendarOccurrence[];
    /** Each occurrence's own calendar color, keyed by `folderUid` - see `calendarColors.ts`. */
    folderColors: Record<string, string>;
    onSelectEvent: (occurrence: CalendarOccurrence) => void;
    /** The day the list scrolls to (the first day from it that has events - the top for one in the past -, the last day when none does) on opening and whenever `jumpNonce` changes. */
    focusDate: Date;
    jumpNonce: number;
    /** Scrolls to the first day of the previous or next month (from the one at the top) that has events. */
    step: ListStep | null;
}

/** When an occurrence is on show on `day`: its time range, "All day", or - on a later day of a multi-day event - that it continues. */
function timeLabel(occurrence: CalendarOccurrence, day: Date): string {
    if (occurrence.allDay) {
        return "All day";
    }
    if (!startsOnDay(occurrence, day)) {
        return "Continues";
    }
    const start = new Date(occurrence.startDate);
    const end = new Date(occurrence.endDate);
    return start.getTime() === end.getTime() ? format(start, "h:mma") : `${format(start, "h:mma")} – ${format(end, "h:mma")}`;
}

/** The days (local midnights) `occurrence` is on show on: from its first to its last, at most `LIST_MAX_DAYS_PER_EVENT`. */
function daysOf(occurrence: CalendarOccurrence): Date[] {
    let first: Date;
    let last: Date;
    if (occurrence.allDay) {
        // Date-only, the end exclusive (see `allDay.ts`), and at least the start day.
        first = parseISO(allDayDateKey(occurrence.startDate));
        last = addDays(parseISO(allDayDateKey(occurrence.endDate)), -1);
    } else {
        const start = new Date(occurrence.startDate);
        const end = new Date(occurrence.endDate);
        first = startOfDay(start);
        // An event that ends at midnight does not reach into that day.
        last = startOfDay(end > start ? new Date(end.getTime() - 1) : start);
    }
    const days = [first];
    for (let day = addDays(first, 1); day <= last && days.length < LIST_MAX_DAYS_PER_EVENT; day = addDays(day, 1)) {
        days.push(day);
    }
    return days;
}

/** The day's rows in the order they are read: the all-day events and those carried over from an earlier day, then the timed ones as they start. */
function sortedForDay(occurrences: CalendarOccurrence[], day: Date): CalendarOccurrence[] {
    const rank = (occurrence: CalendarOccurrence) => (occurrence.allDay || !startsOnDay(occurrence, day) ? 0 : 1);
    return occurrences.sort((a, b) => rank(a) - rank(b) || new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
}

/**
 * Every event from today on as one scrollable list, in date order, with a heading and a list for each day that has any (days without events are left out, and
 * nothing at all says so). A multi-day event is listed on every day it covers, as the month grid shows it. Each row is a full-width button that
 * opens the event's card, with the time, title, place (or organizer) and its calendar's colour.
 *
 * Every day is rendered (an event is a cheap row, and a series is bounded to 500 occurrences - see `eventSearch.ts`); the days are grouped once per
 * change of `occurrences`, not per render. The list scrolls itself to `focusDate` and, on a `step`, to the neighbouring month.
 */
export default function ListView({ occurrences, folderColors, onSelectEvent, focusDate, jumpNonce, step }: ListViewProps) {
    const activeKey = useActiveOccurrenceKey();
    const scrollerRef = useRef<HTMLDivElement>(null);
    const groups = useMemo(() => {
        const byDay = new Map<string, { day: Date; items: CalendarOccurrence[] }>();
        const todayKey = localDateKey(new Date());
        for (const occurrence of occurrences) {
            for (const day of daysOf(occurrence)) {
                const key = localDateKey(day);
                // The days an event spent before today are not listed.
                if (key < todayKey) {
                    continue;
                }
                const group = byDay.get(key) ?? { day, items: [] };
                group.items.push(occurrence);
                byDay.set(key, group);
            }
        }
        return Array.from(byDay.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, { day, items }]) => ({ key, day, items: sortedForDay(items, day) }));
    }, [occurrences]);

    const dayElements = () => Array.from(scrollerRef.current!.querySelectorAll<HTMLElement>("[data-day]"));

    // On opening and on a jump (Today, a date picked in the mini calendar): the first day from `focusDate` that has events, else the last one.
    useEffect(() => {
        const wanted = localDateKey(focusDate);
        const days = dayElements();
        (days.find((el) => el.dataset.day! >= wanted) ?? days[days.length - 1])?.scrollIntoView({ block: "start" });
    }, [jumpNonce]);

    // A step: from the month of the day at the top of the list to the first day of the previous or next month that has any.
    useEffect(() => {
        const days = dayElements();
        if (!step || days.length === 0) {
            return;
        }
        const top = scrollerRef.current!.getBoundingClientRect().top;
        const current = days.find((el) => el.getBoundingClientRect().bottom > top) ?? days[days.length - 1];
        const months = Array.from(new Set(days.map((el) => el.dataset.day!.slice(0, 7))));
        const month = months[months.indexOf(current.dataset.day!.slice(0, 7)) + step.direction];
        // Past the first or last month with events there is nowhere to go.
        days.find((el) => el.dataset.day!.startsWith(month))?.scrollIntoView({ block: "start" });
    }, [step]);

    const thisYear = new Date().getFullYear();
    return (
        <div ref={scrollerRef} role="region" aria-label="List" data-calendar-scroller className="flex-1 min-h-0 overflow-y-auto">
            {groups.length === 0 ? (
                <p className="p-4 text-sm text-text-muted">No upcoming events</p>
            ) : (
                groups.map(({ key, day, items }) => (
                    <section key={key} data-day={key} aria-labelledby={`list-day-${key}`}>
                        <h3
                            id={`list-day-${key}`}
                            // Today is marked, not shouted: the same opaque bar as every day, with a primary edge and a small pill.
                            aria-current={isToday(day) ? "date" : undefined}
                            className={[
                                "sticky top-0 z-10 px-4 py-2 text-sm font-semibold border-b border-border bg-surface-alt text-text border-l-4",
                                isToday(day) ? "border-l-primary" : "border-l-transparent",
                            ].join(" ")}
                        >
                            {format(day, day.getFullYear() === thisYear ? "EEEE, MMMM d" : "EEEE, MMMM d, yyyy")}
                            {isToday(day) && (
                                <span aria-hidden="true" className="ml-2 px-1.5 py-0.5 rounded-full bg-primary/15 text-primary-dark text-xs font-medium">
                                    Today
                                </span>
                            )}
                        </h3>
                        <ul>
                            {items.map((occurrence) => (
                                <ListRow
                                    key={occurrence.occurrenceKey}
                                    occurrence={occurrence}
                                    day={day}
                                    color={folderColors[occurrence.folderUid]}
                                    onSelect={onSelectEvent}
                                    activeKey={activeKey}
                                />
                            ))}
                        </ul>
                    </section>
                ))
            )}
        </div>
    );
}

function ListRow({
    occurrence,
    day,
    color,
    onSelect,
    activeKey,
}: {
    occurrence: CalendarOccurrence;
    day: Date;
    color: string;
    onSelect: (occurrence: CalendarOccurrence) => void;
    activeKey: string | null;
}) {
    const marker = occurrenceMarker(activeKey, occurrence);
    const place = occurrence.location || occurrence.organizer.displayName || occurrence.organizer.address;
    return (
        <li className="border-b border-border/50">
            <button
                type="button"
                {...marker.attrs}
                onClick={() => onSelect(occurrence)}
                className={["w-full min-h-14 px-4 py-2 flex items-center gap-3 text-left hover:bg-surface-alt", marker.className].join(" ")}
            >
                <span className="w-28 shrink-0 text-xs text-text-muted">{timeLabel(occurrence, day)}</span>
                <span
                    aria-hidden="true"
                    className={["w-3 h-3 rounded-full shrink-0", occurrence.busyStatus === "free" ? "border-2" : ""].join(" ")}
                    style={occurrence.busyStatus === "free" ? { borderColor: color } : { backgroundColor: color }}
                />
                <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium truncate">{occurrence.title}</span>
                    <span className="block text-xs text-text-muted truncate">{place}</span>
                </span>
            </button>
        </li>
    );
}
