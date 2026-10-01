///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createContext, useContext } from "react";
import { CalendarOccurrence } from "../../../../lib/calendar/recurrence.js";

/** The `occurrenceKey` of the search result the calendar is pointing at (`null`: none), for the views to mark - a context, so the month, week and split
 * views and their many kinds of chip need no prop threaded through each. */
export const ActiveOccurrenceContext = createContext<string | null>(null);

/** The key of the occurrence the calendar's search is on. */
export function useActiveOccurrenceKey(): string | null {
    return useContext(ActiveOccurrenceContext);
}

/** What an occurrence's chip or block spreads on itself: `data-occurrence-key` (how the page finds it to scroll to) and, when it is the
 * `activeKey` one, a ring and `data-active-match`. */
export function occurrenceMarker(
    activeKey: string | null,
    occurrence: CalendarOccurrence,
): { attrs: { "data-occurrence-key": string; "data-active-match"?: "true" }; className: string } {
    const active = activeKey === occurrence.occurrenceKey;
    return {
        attrs: { "data-occurrence-key": occurrence.occurrenceKey, ...(active ? { "data-active-match": "true" as const } : undefined) },
        className: active ? "ring-2 ring-text ring-offset-1 ring-offset-surface" : "",
    };
}
