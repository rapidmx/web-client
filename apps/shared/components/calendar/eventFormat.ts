///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { format } from "date-fns";
import { Attendee, AttendeeResponseStatus, BusyStatus, EventVisibility, GuestPermissions } from "@rapidmx/react-shared/calendar/calendarApi.js";
import { fromEventWallClock, toEventWallClock } from "@rapidmx/react-shared/calendar/recurrence.js";
import { toDatetimeLocal } from "@rapidmx/react-shared/util/dateInput.js";
import { addDaysToKey, allDayDateKey } from "./allDay.js";

/** What the event form and the read-only event view both need to say about a busy status / an answer. */
export const BUSY_STATUSES: BusyStatus[] = ["busy", "free", "tentative", "oof"];
export const BUSY_STATUS_LABEL: Record<BusyStatus, string> = { busy: "Busy", free: "Free", tentative: "Tentative", oof: "Out of office" };
/** Who may see an event's details, in the order the form lists them. */
export const VISIBILITIES: EventVisibility[] = ["default", "public", "private", "confidential"];
export const VISIBILITY_LABEL: Record<EventVisibility, string> = {
    default: "Default visibility",
    public: "Public",
    private: "Private",
    confidential: "Confidential",
};
/** What each visibility means here, where a reader of a shared calendar sees only a busy block for a private or confidential event. */
export const VISIBILITY_HELP: Record<EventVisibility, string> = {
    default: "People who can see this calendar see the event's details, as the calendar's sharing allows.",
    public: "Everyone who can see this calendar sees the event's details.",
    private: "Only you and people who can edit this calendar see the details. Everyone else who can see the calendar sees a busy block.",
    confidential:
        "Shown like a private event on your calendar: only you and people who can edit it see the details. The invitation marks the event confidential for other calendar programs.",
};

/** What guests may do, as a sentence: "Guests can modify the event, invite others and see the guest list." (or, when they can do none of it, what they cannot). */
export function describeGuestPermissions(permissions: GuestPermissions): string {
    const can = [
        permissions.guestsCanModify && "modify the event",
        permissions.guestsCanInviteOthers && "invite others",
        permissions.guestsCanSeeGuestList && "see the guest list",
    ].filter((text): text is string => !!text);
    if (can.length === 0) {
        return "Guests can't modify the event, invite others or see the guest list.";
    }
    return `Guests can ${can.length === 1 ? can[0] : `${can.slice(0, -1).join(", ")} and ${can[can.length - 1]}`}.`;
}

export const RESPONSE_STATUS_LABEL: Record<AttendeeResponseStatus, string> = {
    needsAction: "Awaiting response",
    accepted: "Accepted",
    declined: "Declined",
    tentative: "Tentative",
};

/** The units a reminder's lead time can be entered in - the event itself stores only minutes. */
export const REMINDER_UNITS = [
    { unit: "minutes", singular: "minute", factor: 1 },
    { unit: "hours", singular: "hour", factor: 60 },
    { unit: "days", singular: "day", factor: 1440 },
    { unit: "weeks", singular: "week", factor: 10080 },
] as const;
export type ReminderUnit = (typeof REMINDER_UNITS)[number]["unit"];

/** The unit a stored reminder reads best in: the largest that divides it evenly (`0` and odd values stay in minutes). */
export function bestReminderUnit(minutes: number): (typeof REMINDER_UNITS)[number] {
    for (let i = REMINDER_UNITS.length - 1; i > 0; i--) {
        if (minutes > 0 && minutes % REMINDER_UNITS[i].factor === 0) {
            return REMINDER_UNITS[i];
        }
    }
    return REMINDER_UNITS[0];
}

/** "Notify 30 minutes before" / "Notify 1 hour before" / "Notify at the start" for a stored reminder, or "No notification". */
export function describeReminder(minutes: number | undefined): string {
    if (minutes === undefined || !Number.isFinite(minutes) || minutes < 0) {
        return "No notification";
    }
    if (minutes === 0) {
        return "Notify at the start";
    }
    const unit = bestReminderUnit(minutes);
    const amount = minutes / unit.factor;
    return `Notify ${amount} ${amount === 1 ? unit.singular : unit.unit} before`;
}

/** Splits what was typed into the guests field into its addresses: commas, semicolons and white space separate them. */
export function splitGuestInput(text: string): string[] {
    return text.split(/[,;\s]+/).filter(Boolean);
}

/** The loosest address check that is still worth making before an invitation is sent: something, an @, something. */
export function isValidGuestAddress(address: string): boolean {
    return /^[^\s@<>,;]+@[^\s@<>,;]+$/.test(address);
}

/** An attendee as the guests field adds one. */
export function newGuest(address: string): Attendee {
    return { address, role: "required", responseStatus: "needsAction", isOrganizer: false };
}

/** The wall-clock string a form input holds ("YYYY-MM-DDTHH:mm") read as `zone`'s clock, as an instant. `deviceZone` is the zone the browser
 * itself parses such a string in, which needs no conversion. */
export function wallStringToMs(value: string, zone: string, deviceZone: string): number {
    if (zone === deviceZone) {
        return new Date(value).getTime();
    }
    const wall = Date.parse(`${value.slice(0, 16)}:00Z`);
    return Number.isNaN(wall) ? Number.NaN : fromEventWallClock(wall, zone, false);
}

/** Inverse of `wallStringToMs()`. */
export function msToWallString(ms: number, zone: string, deviceZone: string): string {
    if (zone === deviceZone) {
        return toDatetimeLocal(new Date(ms).toISOString());
    }
    return new Date(toEventWallClock(ms, zone, false)).toISOString().slice(0, 16);
}

/** A local `Date` for a `YYYY-MM-DD` key (a plain `new Date(key)` would read it as UTC). */
export function localDateFromKey(key: string): Date {
    const [year, month, day] = key.split("-").map(Number);
    return new Date(year, month - 1, day);
}

function dayLabel(day: Date, now: Date): string {
    return format(day, day.getFullYear() === now.getFullYear() ? "EEEE, MMMM d" : "EEEE, MMMM d, yyyy");
}

/**
 * "Thursday, September 24   2:00pm – 3:00pm" for a timed event ("Thursday, September 24 – Friday, September 25" style, with both
 * days, when it crosses midnight), or "Thursday, September 24" (and the last day, when it spans several) for an all-day one. `start`
 * and `end` are local wall-clock `Date`s - for an all-day event the first and the (inclusive) last day. The year is left out for
 * the current one.
 */
export function formatWhen(start: Date, end: Date, allDay: boolean, now: Date = new Date()): string {
    const first = dayLabel(start, now);
    if (allDay) {
        return end.getTime() > start.getTime() ? `${first} – ${dayLabel(end, now)}` : first;
    }
    const startTime = format(start, "h:mmaaa");
    const endTime = format(end, "h:mmaaa");
    if (format(start, "yyyy-MM-dd") === format(end, "yyyy-MM-dd")) {
        return `${first}   ${startTime} – ${endTime}`;
    }
    return `${first} ${startTime} – ${dayLabel(end, now)} ${endTime}`;
}

/** `formatWhen()` for a stored event: instants for a timed one, the date-only keys (with the exclusive end) for an all-day one. */
export function formatStoredWhen(startDate: string, endDate: string, allDay: boolean, now: Date = new Date()): string {
    if (allDay) {
        const startKey = allDayDateKey(startDate);
        const lastKey = addDaysToKey(allDayDateKey(endDate), -1);
        return formatWhen(localDateFromKey(startKey), localDateFromKey(lastKey < startKey ? startKey : lastKey), true, now);
    }
    return formatWhen(new Date(startDate), new Date(endDate), false, now);
}

/** Adds the addresses typed into the guests field to `current`: an address already on the list (in any case) is skipped, and what is not an
 * address comes back as `invalid` for the field to keep. */
export function mergeGuests(current: Attendee[], text: string): { attendees: Attendee[]; invalid: string[] } {
    const attendees = [...current];
    const invalid: string[] = [];
    for (const token of splitGuestInput(text)) {
        if (!isValidGuestAddress(token)) {
            invalid.push(token);
        } else if (!attendees.some((a) => a.address.toLowerCase() === token.toLowerCase())) {
            attendees.push(newGuest(token));
        }
    }
    return { attendees, invalid };
}

/** `formatWhen()` for the form's own wall-clock strings (an all-day event's `end` is its inclusive last day); a message while either is empty. */
export function formatFormWhen(start: string, end: string, allDay: boolean, now: Date = new Date()): string {
    const first = allDay ? localDateFromKey(start.slice(0, 10)) : new Date(start);
    const last = allDay ? localDateFromKey(end.slice(0, 10)) : new Date(end);
    if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) {
        return "Pick a date and time";
    }
    return formatWhen(first, last, allDay, now);
}

/** A reminder as the form holds it (minutes, as typed; blank meaning none) as the number of minutes, or `undefined` for none. */
export function reminderOf(text: string): number | undefined {
    return text.trim() === "" ? undefined : Number(text);
}
