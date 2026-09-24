///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { Attachment } from "@rapidmx/react-shared/mail/mailApi.js";
import type { InviteResponse, MessageInvite } from "@rapidmx/react-shared/calendar/inviteApi.js";
import { APP_HREFS } from "../../../navigation/appHrefs.js";

/** Whether an attachment is a calendar file - what tells the pane a message may carry an invitation worth asking the server about. By type
 * or by name, since mail clients disagree about which one they set (`text/calendar`, `application/ics`, or a bare `.ics` as octet-stream). */
export function isCalendarAttachment(attachment: Pick<Attachment, "filename" | "mimeType">): boolean {
    const type = (attachment.mimeType ?? "").split(";")[0].trim().toLowerCase();
    return type === "text/calendar" || type === "application/ics" || (attachment.filename ?? "").trim().toLowerCase().endsWith(".ics");
}

const DAY_FORMAT: Intl.DateTimeFormatOptions = { weekday: "short", year: "numeric", month: "short", day: "numeric" };
const CLOCK_FORMAT: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** `zone` if the browser knows it, else UTC - an all-day date is a calendar day, and needs a fixed zone to stay the same day for every reader. */
export function allDayZone(zone: string | undefined): string {
    try {
        new Intl.DateTimeFormat(undefined, { timeZone: zone });
        return zone ?? "UTC";
    } catch {
        return "UTC";
    }
}

/** The instant an ISO string names, or `undefined` when it is missing or unparseable. */
export function validDate(iso: string | undefined): Date | undefined {
    const date = iso ? new Date(iso) : undefined;
    return date && !isNaN(date.getTime()) ? date : undefined;
}

/**
 * When the meeting is, in the reader's own locale and time zone: one date and a time range for a same-day event, both ends in full for
 * one that spans days, and dates only for an all-day event (drawn in the organizer's zone, since a calendar day is not an instant). `undefined`
 * when the invitation names no usable start. A missing or unusable end shows the start alone.
 */
export function formatInviteWhen(invite: Pick<MessageInvite, "startDate" | "endDate" | "allDay" | "timezone">): string | undefined {
    const start = validDate(invite.startDate);
    if (!start) {
        return undefined;
    }
    const parsedEnd = validDate(invite.endDate);
    const end = parsedEnd && parsedEnd > start ? parsedEnd : undefined;
    if (invite.allDay) {
        const day = new Intl.DateTimeFormat(undefined, { ...DAY_FORMAT, timeZone: allDayZone(invite.timezone) });
        const first = day.format(start);
        // An all-day event's end is the midnight after its last day (iCalendar's DTEND is exclusive), so the last day is a moment before it.
        const last = end ? day.format(new Date(end.getTime() - 1)) : first;
        return last === first ? first : `${first} - ${last}`;
    }
    const date = new Intl.DateTimeFormat(undefined, DAY_FORMAT);
    const time = new Intl.DateTimeFormat(undefined, CLOCK_FORMAT);
    // The zone is named once, after the last time shown: the times are the reader's own, not the organizer's.
    const timeAndZone = new Intl.DateTimeFormat(undefined, { ...CLOCK_FORMAT, timeZoneName: "short" });
    const startDay = date.format(start);
    if (!end) {
        return `${startDay}, ${timeAndZone.format(start)}`;
    }
    return startDay === date.format(end)
        ? `${startDay}, ${time.format(start)} - ${timeAndZone.format(end)}`
        : `${startDay}, ${time.format(start)} - ${date.format(end)}, ${timeAndZone.format(end)}`;
}

/** The meeting's start the way a list row writes it - `Thu 9/24/2026 1:00 PM` (dates only for an all-day event), in the reader's zone. */
export function formatRowStart(invite: Pick<MessageInvite, "startDate" | "allDay" | "timezone">): string | undefined {
    const start = validDate(invite.startDate);
    if (!start) {
        return undefined;
    }
    const zone = invite.allDay ? allDayZone(invite.timezone) : undefined;
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: zone }).format(start);
    const date = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "numeric", day: "numeric", timeZone: zone }).format(start);
    return invite.allDay ? `${weekday} ${date}` : `${weekday} ${date} ${new Intl.DateTimeFormat(undefined, CLOCK_FORMAT).format(start)}`;
}

/** `YYYY-MM-DD` of an instant in the reader's zone, or in `timeZone` when given (`en-CA` writes a date that way). */
export function isoDay(date: Date, timeZone?: string): string {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(date);
}

/** Where "Open in Calendar" goes: the day view of the day the meeting starts (the `date`/`view` the calendar page reads), or the calendar itself
 * when the invitation names no usable start. An all-day event's day is the organizer's; any other is the reader's. */
export function calendarHref(invite: Pick<MessageInvite, "startDate" | "allDay" | "timezone">): string {
    const start = validDate(invite.startDate);
    if (!start) {
        return APP_HREFS.calendar;
    }
    return `${APP_HREFS.calendar}?date=${isoDay(start, invite.allDay ? allDayZone(invite.timezone) : undefined)}&view=day`;
}

/** The reader's answer as a list row says it. */
export const ANSWER_LABEL: Record<InviteResponse, string> = {
    accepted: "Accepted",
    tentative: "Tentative",
    declined: "Declined",
};

/** The most conflicting events that are named; more are counted. */
const MAX_NAMED_CONFLICTS = 3;

/** The titles of the events an invitation conflicts with, as "A, B and 2 more". */
export function conflictSummary(conflicts: { title: string }[]): string {
    const titles = conflicts.map((c) => c.title.trim() || "(no title)");
    return titles.length <= MAX_NAMED_CONFLICTS
        ? titles.join(", ")
        : `${titles.slice(0, MAX_NAMED_CONFLICTS).join(", ")} and ${titles.length - MAX_NAMED_CONFLICTS} more`;
}
