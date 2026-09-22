///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Pure helpers behind `useCalendarReminders.ts` - kept apart from the hook so the push-payload parsing, the snooze
 * arithmetic and the pop-up's wording are each testable without a React tree or a socket. */

import type { PushEvent } from "@rapidmx/react-shared/mail/pushClient.js";

/** How long "Snooze" waits before the reminder reappears - or less, if the meeting starts sooner (`snoozeDelayMs()`). */
export const SNOOZE_MS = 5 * 60_000;

/** The payload restapi's `CalendarReminderJob` publishes (`{ eventUid, title, startDate }`) as a `"CalendarEvent"`/`"reminder"` push event. */
export interface CalendarReminderNotice {
    eventUid: string;
    title: string;
    /** The due occurrence's own start (an ISO string) - the series' `startDate` for a non-recurring event, one occurrence's for a recurring one. */
    startDate: string;
}

function isReminderNotice(data: unknown): data is CalendarReminderNotice {
    const notice = data as Partial<CalendarReminderNotice> | null;
    return !!notice && typeof notice.eventUid === "string" && typeof notice.title === "string" && typeof notice.startDate === "string";
}

/** The reminder `event` carries, or `undefined` for anything else the shared push connection delivers (mail, folders, appearance, ...). */
export function calendarReminderOf(event: PushEvent): CalendarReminderNotice | undefined {
    return event.type === "CalendarEvent" && event.action === "reminder" && isReminderNotice(event.data) ? event.data : undefined;
}

/** How long "Snooze" waits before showing the reminder again: `SNOOZE_MS`, or less if the meeting starts first - never negative (snoozing a
 * reminder for a meeting that has already started shows it again at once rather than waiting a further five minutes). */
export function snoozeDelayMs(startDate: string, now: number = Date.now()): number {
    return Math.max(0, Math.min(SNOOZE_MS, new Date(startDate).getTime() - now));
}

/** The pop-up's message line: when the meeting starts, relative to `now`. */
export function reminderMessage(startDate: string, now: number = Date.now()): string {
    const time = new Date(startDate).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const diffMinutes = Math.round((new Date(startDate).getTime() - now) / 60_000);
    if (diffMinutes <= 0) {
        return `Starting now - ${time}`;
    }
    return `Starting in ${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} - ${time}`;
}

/** The one notification id a reminder, and every "Snooze" of it, reuses - so snoozing replaces the same pop-up rather than stacking a new one. */
export function reminderNotificationId(eventUid: string, startDate: string): string {
    return `calendar-reminder:${eventUid}:${startDate}`;
}
