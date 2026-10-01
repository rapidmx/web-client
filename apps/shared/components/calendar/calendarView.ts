///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The calendar's views, and the one the reader last chose - kept in `localStorage` so coming back to the Calendar from elsewhere in the app (or
 * reopening it) lands on the same view, the way the mail list remembers its own arrangement (see `listPreferences.ts`). Per device, not synced.
 * A read that finds nothing, something this client doesn't know or a blocked store gives `null`, and a write that fails is swallowed: the
 * choice then only doesn't outlive the page.
 */

/** The views, in the order the switcher lists them: the List sits left of the Month. */
export type CalendarView = "list" | "month" | "week" | "workWeek" | "day" | "split";
export const CALENDAR_VIEWS: CalendarView[] = ["list", "month", "week", "workWeek", "day", "split"];

const STORAGE_KEY = "rapidmx:calendar-view";

/** Whether `value` names a view. */
export function isCalendarView(value: unknown): value is CalendarView {
    return (CALENDAR_VIEWS as unknown[]).includes(value);
}

/** The view last chosen, or `null` when none was (or it cannot be read). The calendar page does not restore a stored `"list"`: that view is the phone's
 * default and is never written by a desktop. */
export function getStoredCalendarView(): CalendarView | null {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return isCalendarView(stored) ? stored : null;
    } catch {
        return null;
    }
}

/** Remembers `view` as the one to open the Calendar on. */
export function storeCalendarView(view: CalendarView): void {
    try {
        localStorage.setItem(STORAGE_KEY, view);
    } catch {
        // A blocked store only means the choice does not outlive the page.
    }
}
