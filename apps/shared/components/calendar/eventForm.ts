///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { FormEvent } from "react";
import { Attendee, BusyStatus, EventVisibility, RecurrenceRule, WeekdayCode } from "@rapidmx/react-shared/calendar/calendarApi.js";
import { Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import { CalendarOccurrence } from "@rapidmx/react-shared/calendar/recurrence.js";

/** Which occurrences of a recurring event an edit applies to. */
export type EditScope = "occurrence" | "series";

/**
 * Everything the event form edits. The quick-create popover and the full form are two faces of the same values, so a title typed in the
 * one is still there when "More options" opens the other.
 */
export interface EventFormValues {
    title: string;
    location: string;
    /** `YYYY-MM-DDTHH:mm` on the wall clock of `formZone` (for an all-day event only the date part matters). */
    start: string;
    end: string;
    allDay: boolean;
    /** The zone `start` and `end` are read in: the device's own until the user picks another. */
    formZone: string;
    /** The IANA zone the event is stored with. */
    timezone: string;
    attendees: Attendee[];
    /** What has been typed into the guests field but not added yet. */
    guestDraft: string;
    /** What was committed to the guests field (Enter, a comma, leaving it) but is not an address: kept there, flagged, until it is fixed or removed. */
    guestInvalid: string[];
    recurrenceRule: RecurrenceRule | null;
    /** Minutes before the start, as typed; blank means no reminder. */
    reminderMinutes: string;
    busyStatus: BusyStatus;
    /** Who may see the event's details. */
    visibility: EventVisibility;
    /** The description as the editor last wrote it: HTML, `""` when there is none (an emptied editor writes `<p></p>`, which counts as none). */
    descriptionHtml: string;
    /** What guests may do: ask for the event to change, ask for guests to be added, see who else is invited. */
    guestsCanModify: boolean;
    guestsCanInviteOthers: boolean;
    guestsCanSeeGuestList: boolean;
    autoReplyEnabled: boolean;
    autoReplyMessage: string;
    videoEnabled: boolean;
    targetMailboxUid: string;
    targetFolderUid: string;
}

/** What `EventEditor` hands both faces of the form: the values, and every action and derived fact they need. */
export interface EventFormController {
    /** The event being edited, `null` for a new one. */
    occurrence: CalendarOccurrence | null;
    values: EventFormValues;
    update: (patch: Partial<EventFormValues>) => void;

    // Date and time.
    setStart: (next: string) => void;
    setEnd: (next: string) => void;
    onAllDayChange: (allDay: boolean) => void;
    onTimeZoneChange: (zone: string) => void;
    timeZones: string[];
    startWeekday: WeekdayCode | undefined;
    /** "This event only" of a recurring event: the copy it detaches has no rule of its own. */
    editingSingleOccurrence: boolean;

    // Find a time: whose calendar the grid shows as "you", and the zone the device's own clock is in.
    /** The address the event is organized from (the chosen mailbox's, for a new event). */
    organizerAddress: string;
    deviceZone: string;

    // Guests.
    updateAttendee: (index: number, patch: Partial<Attendee>) => void;
    removeAttendee: (index: number) => void;
    addResource: (mailbox: Mailbox) => void;
    /** Addresses already on the list (lowercased), for the room/equipment picker to leave out. */
    guestAddresses: string[];

    // Where the event goes.
    mailboxOptions: { mailbox: Mailbox; calendars: { uid: string; name: string }[] }[] | undefined;
    onMailboxChange: (mailboxUid: string) => void;
    /** The calendars to choose between when creating; `undefined` for an existing event, which keeps its own. */
    calendarChoices: { uid: string; name: string }[] | undefined;
    calendarName: string | undefined;
    calendarColor: string | undefined;

    // Video conferencing.
    videoMeetingUid: string | undefined;
    /** The organizer's own join link once it is known and safe to open. */
    joinUrl: string | undefined;
    /** `undefined` while it is being fetched, `null` once it is known there is none. */
    organizerJoinUrl: string | null | undefined;
    videoError: string | null;

    // The form as a whole.
    editScope: EditScope;
    setEditScope: (scope: EditScope) => void;
    /** Whether the "Apply changes to" choice is offered (editing an occurrence of a recurring event). */
    showEditScope: boolean;
    error: string | null;
    saving: boolean;
    /** Submits the form. */
    onSubmit: (event: FormEvent) => void;
    /** The X / Cancel: leaves the form (back to the details for an existing event). */
    onCancel: () => void;
}
