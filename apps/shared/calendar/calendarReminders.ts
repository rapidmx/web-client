///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Pure helpers behind `useCalendarReminders.ts` - kept apart from the hook so the push-payload parsing, the snooze
 * arithmetic and the pop-up's wording are each testable without a React tree or a socket. */

import type { PushEvent } from "../../../lib/mail/pushClient.js";

/** How long "Snooze" waits before the alarm comes back. */
export const SNOOZE_MS = 5 * 60_000;

/** The payload restapi's `CalendarReminderJob` publishes (`{ eventUid, title, startDate, location }`) as a `"CalendarEvent"`/`"reminder"` push event. */
export interface CalendarReminderNotice {
    eventUid: string;
    title: string;
    /** The due occurrence's own start (an ISO string) - the series' `startDate` for a non-recurring event, one occurrence's for a recurring one. */
    startDate: string;
    /** The event's own `location`, verbatim - `undefined`/`null` when the event has none. Not necessarily a URL;
     * see `joinMeetingUrl()` for when it's shown as a join link. */
    location?: string | null;
}

function isReminderNotice(data: unknown): data is CalendarReminderNotice {
    const notice = data as Partial<CalendarReminderNotice> | null;
    return (
        !!notice &&
        typeof notice.eventUid === "string" &&
        typeof notice.title === "string" &&
        typeof notice.startDate === "string" &&
        (notice.location === undefined || notice.location === null || typeof notice.location === "string")
    );
}

/** A `notice.location` worth offering as a one-click "Join Meeting" link - a plain `http(s)://` URL and nothing
 * else (a room name, an address, free-text instructions are all real, common `location` values this must not
 * treat as a link). Trimmed first, so incidental whitespace never hides a real link. */
export function joinMeetingUrl(location: string | null | undefined): string | undefined {
    const trimmed = location?.trim();
    if (!trimmed) {
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return undefined;
    }
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : undefined;
}

/** What the alarm's button that opens an event's location URL is called: "Join" for a video meeting (a conferencing service's link, or any link that says
 * it is one to join), "Open" for any other web address. */
export function locationActionLabel(url: string): "Join" | "Open" {
    const { hostname, pathname } = new URL(url);
    const host = hostname.toLowerCase();
    const conferencing = /(^|\.)(zoom\.us|zoom\.com|zoomgov\.com|webex\.com|gotomeeting\.com|goto\.com|whereby\.com|bluejeans\.com|chime\.aws|meet\.jit\.si)$/;
    const known = conferencing.test(host) || host === "meet.google.com" || host === "teams.microsoft.com" || host === "teams.live.com";
    return known || /\/(join|meet|meeting|room|call)(\/|$)/i.test(pathname) || /^(meet|video|call|conference)\./.test(host) ? "Join" : "Open";
}

/** Where an alarm's View button leads: the Calendar, with the event (and the occurrence due) open. */
export function calendarEventHref(eventUid: string, startDate: string): string {
    return `/calendar?event=${encodeURIComponent(eventUid)}&start=${encodeURIComponent(startDate)}`;
}

/** The reminder `event` carries, or `undefined` for anything else the shared push connection delivers (mail, folders, appearance, ...). */
export function calendarReminderOf(event: PushEvent): CalendarReminderNotice | undefined {
    return event.type === "CalendarEvent" && event.action === "reminder" && isReminderNotice(event.data) ? event.data : undefined;
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
