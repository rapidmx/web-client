///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Typed wrappers over `@rapidmx/restapi`'s `/mail/calendar-events` REST surface — see `mailApi.ts`'s own
 * header comment for the shared ACL/authorization model every wrapper file here follows. Recurrence
 * expansion happens entirely client-side (see `apps/shared/lib/recurrence.ts`) — the backend stores/returns
 * `RecurrenceRule` as-is and does no RFC5545 expansion of its own. */

import { ApiClient, withClient } from "../util/api.js";
import { ListParams, buildQuery } from "../util/apiQuery.js";

export type AttendeeRole = "required" | "optional" | "resource";
export type AttendeeResponseStatus = "needsAction" | "accepted" | "declined" | "tentative";

export interface Attendee {
    address: string;
    displayName?: string;
    role: AttendeeRole;
    responseStatus: AttendeeResponseStatus;
    isOrganizer: boolean;
}

export type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";

/** RFC5545 two-letter weekday codes, matching `rrule`'s own `WeekdayStr` type exactly. */
export type WeekdayCode = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export interface RecurrenceRule {
    freq: RecurrenceFrequency;
    interval: number;
    /** Only meaningful for `freq: "weekly"`. */
    byDay?: WeekdayCode[];
    byMonthDay?: number[];
    byMonth?: number[];
    /** Ends after this many occurrences. Mutually exclusive with `until` — at most one may be set. */
    count?: number;
    /** Ends on this date (inclusive). Mutually exclusive with `count`. */
    until?: string;
    /** Specific occurrence start dates removed from the recurrence set. */
    exceptions: string[];
}

export type CalendarEventStatus = "tentative" | "confirmed" | "cancelled";
export type BusyStatus = "free" | "busy" | "tentative" | "oof";

/** Who may see an event's details (iCalendar `CLASS`). A private or confidential event is shown to a read-only reader of a shared calendar only as a
 * busy block (`CalendarEvent.redacted`). `"default"` is what an event with none says. */
export type EventVisibility = "default" | "public" | "private" | "confidential";

/** What the guests of an event may do (`CalendarEvent.guestsCan*`). */
export interface GuestPermissions {
    /** A guest may ask the organizer to change the title, location, description or time. */
    guestsCanModify: boolean;
    /** A guest may ask the organizer to add guests. */
    guestsCanInviteOthers: boolean;
    /** A guest sees who else was invited. */
    guestsCanSeeGuestList: boolean;
}

/** The guest permissions an event has when none were chosen (Google Calendar's own defaults). */
export const DEFAULT_GUEST_PERMISSIONS: GuestPermissions = { guestsCanModify: false, guestsCanInviteOthers: true, guestsCanSeeGuestList: true };

/** The guest permissions `source` says, a missing (or `null`) flag reading as its default - an event stored before they existed carries none. */
export function guestPermissionsOf(source: { [K in keyof GuestPermissions]?: boolean | null }): GuestPermissions {
    return {
        guestsCanModify: source.guestsCanModify ?? DEFAULT_GUEST_PERMISSIONS.guestsCanModify,
        guestsCanInviteOthers: source.guestsCanInviteOthers ?? DEFAULT_GUEST_PERMISSIONS.guestsCanInviteOthers,
        guestsCanSeeGuestList: source.guestsCanSeeGuestList ?? DEFAULT_GUEST_PERMISSIONS.guestsCanSeeGuestList,
    };
}

/** The visibility an event has, `"default"` when it says none. */
export function visibilityOf(event: { visibility?: EventVisibility | null }): EventVisibility {
    return event.visibility ?? "default";
}

/**
 * The organizer's shape is `@rapidmx/restapi`'s general-purpose `Recipient` type (it's reused from the
 * mail-recipient model), so it requires a `type` field even though a to/cc/bcc distinction is meaningless
 * for an event organizer — this wrapper always sends `type: "to"` as an inert filler value when building one.
 */
export interface CalendarOrganizer {
    address: string;
    displayName?: string;
    type: "to";
}

export interface CalendarEvent {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    folderUid: string;
    mailboxUid: string;
    title: string;
    location?: string;
    startDate: string;
    endDate: string;
    allDay: boolean;
    timezone: string;
    organizer: CalendarOrganizer;
    attendees: Attendee[];
    recurrenceRule?: RecurrenceRule;
    /** For a single occurrence of a recurring event that has been individually modified, its original start date. */
    recurrenceId?: string;
    status: CalendarEventStatus;
    busyStatus: BusyStatus;
    reminderMinutesBeforeStart?: number;
    icalUid: string;
    sequence: number;
    /** The `sequence` value invites were last sent for (server-internal iTIP tracking) — read-only
     * display, never sent back in a `CalendarEventInput`. */
    inviteSequenceSent?: number;
    /** Set when an iTIP CANCEL was last sent for this event — read-only display, never sent back. */
    cancelNoticeSentAt?: string;
    /** When `true`, this event's own [`startDate`, `endDate`] window independently triggers an
     * automatic-reply period for the mailbox, in addition to (not instead of) the mailbox-level
     * `Mailbox.oofEnabled` toggle — e.g. a "Vacation" event configuring its own out-of-office window
     * without touching the mailbox-wide setting. Takes precedence over `Mailbox.oofEnabled` while both
     * are active (see `@rapidmx/restapi`'s `resolveActiveOof()`). */
    autoReplyEnabled?: boolean;
    /** The automatic-reply body while this event's window is active. Only meaningful when
     * `autoReplyEnabled` is `true`. */
    autoReplyMessage?: string;
    /** The `@rapidmx/meet-plugin` `VideoMeeting` minted for this event, when the organizer turned on
     * video conferencing (see `videoconf/videoMeetingsApi.ts`). Only the link is stored here — each
     * attendee's own personal join URL is substituted into their own copy of the invitation server-side,
     * so this event carries no per-attendee link and the organizer's own link is fetched from the meeting
     * (`getVideoMeeting()`), never read off the event. */
    videoMeetingUid?: string;
    /** The description as plain text (at most 32,000 characters). When `descriptionHtml` is set this is its plain-text form. `null` or absent: none. */
    description?: string | null;
    /** The description as HTML the server has sanitized down to `b`/`strong`, `i`/`em`, `u`, `br`, `p`, `ul`/`ol`/`li` and `a` (`href` of `http`, `https` or
     * `mailto` only). Still to be rendered through `sanitizeEventDescriptionHtml()` (`eventDescription.ts`), never trusted as it stands. `null` or absent:
     * the description, if any, is plain text. */
    descriptionHtml?: string | null;
    /** Who may see the event's details - absent (or `null`, on a row stored before this existed) reads as `"default"`; see `visibilityOf()`. */
    visibility?: EventVisibility | null;
    /** Whether the guests may ask for the event to change (default `false`). Absent or `null` reads as the default; see `guestPermissionsOf()`. */
    guestsCanModify?: boolean | null;
    /** Whether the guests may ask for guests to be added (default `true`). */
    guestsCanInviteOthers?: boolean | null;
    /** Whether a guest sees the other guests (default `true`). When `false` a guest's copy lists only themselves. */
    guestsCanSeeGuestList?: boolean | null;
    /** Response-only. This reader (of a shared calendar, without edit access) sees the event only as a busy block: the title is `"Busy"` and there are no
     * attendees, location, description or guest permissions. Never sent back. A live-update notification for such an event carries it too, and the
     * owner's client refetches by `uid` instead of using the payload. */
    redacted?: boolean;
}

const LIST_PAGE_SIZE = 500;
const LIST_CALENDAR_EVENTS_MAX_PAGES = 100;

/**
 * Lists every event in a folder (same "fetch the flat list, filter client-side" contract as
 * `contactsApi.ts`'s `listContacts`/`tasksApi.ts`'s `listTasks`), for the caller to expand and filter
 * to a visible range itself (see `recurrence.ts`'s `expandAllOccurrences`). This deliberately does
 * *not* push `startDate`/`endDate` range filtering down to the server via `@rapidmx/restapi`'s
 * `field=lte(v)`/`gte(v)` query-operator DSL — confirmed directly against a running instance that
 * `CalendarEventMongo`'s `startDate`/`endDate` are persisted as plain strings despite being typed
 * `Date`, so a Mongo `$lte`/`$gte` comparison against them (a real `Date` operand) matches nothing at
 * all, silently returning zero events for *any* date-bounded query. Client-side filtering sidesteps
 * that entirely and needs no fix to land here.
 *
 * Pages through the whole folder (`limit=500`, the server's own page-size cap) until a short page comes
 * back, so a calendar with more than one page of events isn't silently truncated. A hard cap of
 * `LIST_CALENDAR_EVENTS_MAX_PAGES` pages guards against looping forever should a server ever ignore
 * `page` and keep returning full pages.
 */
export async function listCalendarEvents(folderUid: string, client?: ApiClient): Promise<CalendarEvent[]> {
    const events: CalendarEvent[] = [];
    for (let page = 0; page < LIST_CALENDAR_EVENTS_MAX_PAGES; page++) {
        const batch = await withClient<CalendarEvent[]>(
            client,
            `/mail/calendar-events?${buildQuery({ limit: LIST_PAGE_SIZE, page }, { folderUid })}`,
        );
        events.push(...batch);
        if (batch.length < LIST_PAGE_SIZE) {
            break;
        }
    }
    return events;
}

export function getCalendarEvent(uid: string, client?: ApiClient): Promise<CalendarEvent> {
    return withClient(client, `/mail/calendar-events/${encodeURIComponent(uid)}`);
}

export interface CalendarEventInput {
    mailboxUid: string;
    folderUid: string;
    title: string;
    location?: string;
    startDate: string;
    endDate: string;
    allDay?: boolean;
    timezone: string;
    organizer: CalendarOrganizer;
    attendees?: Attendee[];
    recurrenceRule?: RecurrenceRule;
    status?: CalendarEventStatus;
    busyStatus?: BusyStatus;
    reminderMinutesBeforeStart?: number;
    autoReplyEnabled?: boolean;
    autoReplyMessage?: string;
    /** Set (or, sent as `null` on an update, cleared) when the caller has just minted or cancelled this
     * event's video meeting — see `CalendarEvent.videoMeetingUid`. */
    videoMeetingUid?: string;
    /** Plain-text description (<= 32,000 characters). `null` (or `""`) clears it on an update. Sending only `descriptionHtml` makes the server derive this. */
    description?: string | null;
    /** Description HTML (<= 64,000 characters); the server sanitizes it. `null` (or `""`) clears it. Sending only `description` clears the HTML. */
    descriptionHtml?: string | null;
    visibility?: EventVisibility;
    /** Only the organizer's own copy takes these; on a guest's copy they are ignored. Changing any of them, the description or the visibility re-invites. */
    guestsCanModify?: boolean;
    guestsCanInviteOthers?: boolean;
    guestsCanSeeGuestList?: boolean;
}

export function createCalendarEvent(input: CalendarEventInput, client?: ApiClient): Promise<CalendarEvent> {
    return withClient(client, "/mail/calendar-events", {
        method: "POST",
        body: JSON.stringify({
            allDay: false,
            attendees: [],
            status: "confirmed",
            busyStatus: "busy",
            icalUid: crypto.randomUUID(),
            sequence: 0,
            ...input,
        }),
    });
}

export interface UpdateCalendarEventInput extends Partial<CalendarEventInput> {
    uid: string;
    version: number;
}

export function updateCalendarEvent(input: UpdateCalendarEventInput, client?: ApiClient): Promise<CalendarEvent> {
    return withClient(client, `/mail/calendar-events/${encodeURIComponent(input.uid)}`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

export function deleteCalendarEvent(uid: string, version: number, client?: ApiClient): Promise<void> {
    return withClient(client, `/mail/calendar-events/${encodeURIComponent(uid)}?version=${version}`, { method: "DELETE" });
}

/** The subset of `AttendeeResponseStatus` a caller can actually respond with — `"needsAction"` is only
 * ever a default/initial value, never a valid response. */
export type AttendeeResponseInput = Exclude<AttendeeResponseStatus, "needsAction">;

/**
 * Responds to a meeting invite as the calling mailbox's own attendee entry. Synchronous — unlike
 * `recallMessage()` in `mailApi.ts`, this immediately mutates and persists the response (the iTIP
 * REPLY email send is best-effort server-side and never affects this call's outcome). On
 * `"accepted"`/`"tentative"` the whole updated `CalendarEvent` comes back, with only the calling
 * attendee's own `responseStatus` changed. On `"declined"`, the backend instead soft-deletes the
 * mailbox's own copy of the event and returns only `{ uid }` — the caller should treat a decline the
 * same as a delete rather than expecting an updated event back.
 */
export function respondToEvent(
    uid: string,
    responseStatus: AttendeeResponseInput,
    client?: ApiClient,
): Promise<CalendarEvent | { uid: string }> {
    return withClient(client, `/mail/calendar-events/${encodeURIComponent(uid)}/respond`, {
        method: "POST",
        body: JSON.stringify({ responseStatus }),
    });
}

/** A change a guest asks the organizer for (`requestEventChange()`): only what is to differ. */
export interface EventChangeRequest {
    /** Non-empty, at most 1,000 characters. A request can set these, not clear them. */
    title?: string;
    location?: string;
    description?: string;
    descriptionHtml?: string;
    /** ISO 8601 instants. */
    startDate?: string;
    endDate?: string;
    /** Up to 50 guests to add. */
    addAttendees?: { address: string; displayName?: string }[];
}

/** What the server made of a change request. */
export interface EventChangeRequestResult {
    requested: true;
    /** Which fields the request changes (as the server named them, e.g. `title`, `startDate`, `addAttendees`). */
    changes: string[];
    addAttendees: { address: string; displayName?: string }[];
}

/**
 * Asks the organizer to change an event, as a guest (not the organizer) whose copy allows it: the title, location, description or time need
 * `guestsCanModify`, added guests need `guestsCanInviteOthers` (403 otherwise; 400 when nothing differs from what the event has, or a value is invalid).
 * Nothing changes on this mailbox's own copy - the request is mailed to the organizer, and when the change is allowed it is applied there and
 * arrives back later as an ordinary update of the invitation.
 */
export function requestEventChange(uid: string, request: EventChangeRequest, client?: ApiClient): Promise<EventChangeRequestResult> {
    return withClient(client, `/mail/calendar-events/${encodeURIComponent(uid)}/request-change`, {
        method: "POST",
        body: JSON.stringify(request),
    });
}
