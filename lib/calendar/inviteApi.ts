///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Typed wrappers over `@rapidmx/restapi`'s `/mail/calendar-events/invite` surface - the calendar invitation (iMIP: an
 * `.ics` attachment carrying an iTIP `METHOD`) a mail message may hold, read for the reading pane's invitation card. The
 * server does all the work of an answer: it puts the meeting on the reader's calendar (or takes it off), and sends the
 * iTIP REPLY to the organizer. The client only reads the state and asks for a change; every call returns the invitation as
 * it now stands, ready to draw. */

import { ApiClient, ApiRequestError, withClient } from "../util/api.js";
import type { EventVisibility, GuestPermissions } from "./calendarApi.js";

/** What the reader can answer an invitation with. */
export type InviteResponse = "accepted" | "tentative" | "declined";

export interface InviteParticipant {
    address: string;
    displayName?: string;
    responseStatus?: "accepted" | "tentative" | "declined" | "needs-action";
}

/** One of the reader's own events near an invitation, as the server lists it for the RSVP day view and its conflict check. */
export interface InviteScheduleEntry {
    uid: string;
    title: string;
    /** ISO 8601 instants. */
    startDate: string;
    endDate: string;
    allDay: boolean;
    /** The event blocks the reader's time (it is not marked free). */
    busy: boolean;
    tentative: boolean;
}

/** The calendar invitation a message carries, together with what the reader's own calendar says about it. */
export interface MessageInvite {
    /** The iTIP `METHOD` as sent: `"REQUEST"`, `"CANCEL"`, `"REPLY"`, `"PUBLISH"` or `"COUNTER"`, or `""` when the file names none. */
    method: string;
    /** The iCalendar `UID`. */
    uid: string;
    sequence: number;
    summary?: string;
    location?: string;
    /** ISO 8601 instant. */
    startDate?: string;
    endDate?: string;
    allDay: boolean;
    /** The IANA zone the organizer used. */
    timezone?: string;
    organizer?: { address: string; displayName?: string };
    attendees: InviteParticipant[];
    recurring: boolean;
    /** The reader's mailbox is the organizer. */
    isOrganizer: boolean;
    /** What the reader answered, if anything. */
    response?: InviteResponse;
    /** An event for it is on the reader's calendar now. */
    onCalendar: boolean;
    /** That event's uid (for a link into the calendar). */
    calendarEventUid?: string;
    /** The calendar already holds a newer revision than this message. */
    outdated: boolean;
    /** A `REQUEST` addressed to the reader: offer Accept / Tentative / Decline. */
    canRespond: boolean;
    /** A `PUBLISH`, or no method at all: offer "Add to calendar". */
    canAdd: boolean;
    /** A `CANCEL` whose meeting is on the calendar: offer "Remove from calendar". */
    canRemove: boolean;
    /** A `REQUEST` the reader can answer with a different time: offer "Propose new time". */
    canPropose: boolean;
    /** A `COUNTER` for a meeting the reader organizes: offer "Accept proposal". */
    canAcceptProposal: boolean;
    /** For a `REPLY` or `COUNTER`: the attendee who sent it and what they answered or proposed. For a `COUNTER`,
     * `startDate`/`endDate` are the proposed time. */
    reply?: InviteParticipant;
    /** The reader's busy events that overlap the invitation's time. */
    conflicts: InviteScheduleEntry[];
    /** The reader's other events from 12 hours before the invitation's start to 12 hours after its end (recurrences
     * expanded, this meeting left out) - what the RSVP day view draws around the invitation. */
    schedule: InviteScheduleEntry[];
    /** The description as plain text, if the organizer wrote one. */
    description?: string;
    /** The description as HTML the server sanitized - still rendered through `sanitizeEventDescriptionHtml()`, never trusted as it stands. */
    descriptionHtml?: string;
    /** Who may see the event's details, as the organizer sent it. */
    visibility?: EventVisibility;
    /** What the organizer allows the guests to do. Every field is present when the server says any (all optional here so an older server, which says none, reads
     * as the defaults - see `guestPermissionsOf()`). */
    guestPermissions?: Partial<GuestPermissions>;
    /** A guest's copy that allows a change of the title, location, description or time: offer "Request a change" (`requestEventChange()` on `calendarEventUid`). */
    canRequestChange?: boolean;
    /** A guest's copy that allows adding guests: offer "Add guests" (`requestEventChange()` with `addAttendees` on `calendarEventUid`). */
    canRequestInvite?: boolean;
    /** On a `COUNTER` that is a guest's change request (rather than a proposed time) received by the organizer: whether it was applied automatically. */
    changeRequest?: { applied: boolean };
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
/**
 * Reads the invitation a message carries. Resolves `null` when the message has none the server can read (a `404`) - the
 * common, expected answer for a message that merely has an attachment - and rejects for any other failure.
 */
export async function getMessageInvite(messageUid: string, client?: ApiClient): Promise<MessageInvite | null> {
    try {
        return await withClient<MessageInvite>(client, `/mail/calendar-events/invite/${encodeURIComponent(messageUid)}`);
    } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) {
            return null;
        }
        throw err;
    }
}

/**
 * Answers an invitation. The server puts the meeting on the reader's calendar for `"accepted"`/`"tentative"` (or takes it
 * off for `"declined"`) and sends the organizer the matching iTIP REPLY; for a `PUBLISH`ed event (which has no organizer to
 * answer) `"accepted"` only adds it to the calendar. Resolves with the invitation as it now stands.
 */
export function respondToMessageInvite(messageUid: string, responseStatus: InviteResponse, client?: ApiClient): Promise<MessageInvite> {
    return withClient(client, `/mail/calendar-events/invite/${encodeURIComponent(messageUid)}/respond`, {
        method: "POST",
        body: JSON.stringify({ responseStatus }),
    });
}

/** Takes a canceled meeting off the reader's calendar. Resolves with the invitation as it now stands. */
export function removeMessageInvite(messageUid: string, client?: ApiClient): Promise<MessageInvite> {
    return withClient(client, `/mail/calendar-events/invite/${encodeURIComponent(messageUid)}/remove`, { method: "POST" });
}

/** A different time to suggest to the organizer. */
export interface ProposedTime {
    /** ISO 8601 instants. */
    startDate: string;
    endDate: string;
    /** A note to the organizer, sent with the proposal. */
    comment?: string;
}

/** Proposes a different time to the organizer of a `REQUEST` (an iTIP `COUNTER` sent by the server). Resolves with the invitation as it now stands. */
export function proposeNewTime(messageUid: string, proposal: ProposedTime, client?: ApiClient): Promise<MessageInvite> {
    return withClient(client, `/mail/calendar-events/invite/${encodeURIComponent(messageUid)}/propose`, {
        method: "POST",
        body: JSON.stringify(proposal),
    });
}

/** Accepts an attendee's proposed time (a `COUNTER`) for a meeting the reader organizes: the server moves the event and sends the attendees the update. Resolves with the invitation as it now stands. */
export function acceptProposal(messageUid: string, client?: ApiClient): Promise<MessageInvite> {
    return withClient(client, `/mail/calendar-events/invite/${encodeURIComponent(messageUid)}/accept-proposal`, { method: "POST" });
}
