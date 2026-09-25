///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, MutableRefObject, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    Attendee,
    CalendarEvent,
    CalendarEventInput,
    createCalendarEvent,
    getCalendarEvent,
    guestPermissionsOf,
    updateCalendarEvent,
    visibilityOf,
} from "@rapidmx/react-shared/calendar/calendarApi.js";
import {
    VideoMeetingInvitee,
    createVideoMeeting,
    getVideoMeeting,
    updateVideoMeeting,
} from "@rapidmx/react-shared/videoconf/videoMeetingsApi.js";
import { detachOccurrence, saveEventSeries } from "@rapidmx/react-shared/calendar/calendarMutations.js";
import { toDatetimeLocal } from "@rapidmx/react-shared/util/dateInput.js";
import { deviceTimeZone, timeZoneOptions } from "@rapidmx/react-shared/util/timeZone.js";
import { Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import { CalendarOccurrence, fromEventWallClock, toEventWallClock } from "@rapidmx/react-shared/calendar/recurrence.js";
import { addDaysToKey, allDayDateKey, allDayInstant, recurrenceUntilDateKey, recurrenceUntilInstant, startWeekdayCode } from "./allDay.js";
import { joinMeetingUrl } from "../../calendar/calendarReminders.js";
import EventExpandedForm from "./EventExpandedForm.js";
import QuickCreateFaces, { QuickCreateConfig } from "./QuickCreateFaces.js";
import { EditScope, EventFormController, EventFormValues } from "./eventForm.js";
import { descriptionProblem, dialogFields, hasDescriptionText, initialDescriptionHtml } from "./eventDialogFields.js";
import { mergeGuests, msToWallString, wallStringToMs } from "./eventFormat.js";

/**
 * The Location text this modal writes when it mints a video meeting for an event, and the one value it will
 * clear again when video conferencing is turned back off (see `applyVideoConferencing()`).
 *
 * Deliberately generic and identical for everyone: each attendee's own personal join link is substituted into
 * their own copy of the invitation server-side (`@rapidmx/restapi`'s `MeetingSchedulingJob`), so no link -
 * personal or otherwise - may be stored on the shared event itself, where every attendee would read the same
 * one.
 */
export const VIDEO_LOCATION_PLACEHOLDER = "Video call — link in this invitation";

/** The plugin's own title bound (`BaseVideoMeetingRoute`'s `MAX_TITLE_LENGTH`) - a longer title is a 400, so
 * an over-long event title is trimmed to fit rather than failing the whole meeting. */
const MAX_MEETING_TITLE_LENGTH = 200;

/** `CalendarEventInput` fields as sent on save. `null` explicitly clears a field on an update - an
 * omitted (`undefined`) field is dropped by `JSON.stringify` and would leave the stored value in place. */
type EventFields = { [K in keyof CalendarEventInput]?: CalendarEventInput[K] | null };

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Whether two ISO instants fall in the same minute - a stored `...T15:00:00Z` and the form's re-serialized
 * `...T15:00:00.000Z` name the same time without being equal strings. */
function sameMinute(a: string, b: string): boolean {
    return Math.round(new Date(a).getTime() / MS_PER_MINUTE) === Math.round(new Date(b).getTime() / MS_PER_MINUTE);
}

/** Milliseconds since midnight of an instant's wall clock in `timezone` (a timed event's own zone). */
function wallTimeOfDayMs(instantMs: number, timezone: string | undefined): number {
    const wall = toEventWallClock(instantMs, timezone, false);
    return ((wall % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
}

/**
 * Rewrites an edited occurrence's `startDate`/`endDate` for a save to the entire series. The modal only
 * ever shows (and edits) *this occurrence's* dates, but the series is stored as its master record starting
 * at the first occurrence - sending the occurrence's dates as-is would move the whole series' start to
 * this occurrence. So only the change in time-of-day (and the new duration) is applied to the master's own
 * start; the series keeps its original first date. Unchanged times aren't sent at all.
 *
 * Times of day are read on the event's own timezone wall clock (the series expands there), not the
 * browser's, and the change is the smallest signed difference modulo 24h - moving 23:00 to 01:00 is two
 * hours later (into the next day), never 22 hours earlier. The master's new start is converted back from
 * that wall clock, so a master on the other side of a DST change keeps the chosen local time.
 */
async function toSeriesFields(occurrence: CalendarOccurrence, fields: EventFields): Promise<EventFields> {
    const { startDate, endDate, ...rest } = fields;
    if (sameMinute(startDate as string, occurrence.startDate) && sameMinute(endDate as string, occurrence.endDate)) {
        // `saveEventSeries()` treats *any* `timezone`/`allDay` in the update as a possible reinterpretation of
        // the master's instant and fetches the master to check - so when neither differs from the occurrence's
        // own, both are dropped too, or every plain series save (e.g. just a new title) would pay for that GET.
        const { timezone, allDay, ...others } = rest;
        return timezone === occurrence.timezone && allDay === occurrence.allDay ? others : rest;
    }
    const master = await getCalendarEvent(occurrence.uid);
    const timezone = fields.timezone as string;
    const newStart = new Date(startDate as string).getTime();
    const durationMs = new Date(endDate as string).getTime() - newStart;
    let masterStart: number;
    if (fields.allDay) {
        // Timed -> all-day keeps the master's own date on its wall clock.
        const masterDateKey = master.allDay
            ? allDayDateKey(master.startDate)
            : new Date(toEventWallClock(new Date(master.startDate).getTime(), timezone, false)).toISOString().slice(0, 10);
        masterStart = new Date(allDayInstant(masterDateKey)).getTime();
    } else if (master.allDay) {
        // All-day -> timed: the master's own date at the newly chosen wall-clock time.
        const masterDateWall = new Date(allDayInstant(allDayDateKey(master.startDate))).getTime();
        masterStart = fromEventWallClock(masterDateWall + wallTimeOfDayMs(newStart, timezone), timezone, false);
    } else {
        const rawDelta = wallTimeOfDayMs(newStart, timezone) - wallTimeOfDayMs(new Date(occurrence.startDate).getTime(), timezone);
        const delta = ((((rawDelta + MS_PER_DAY / 2) % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY) - MS_PER_DAY / 2;
        const masterWall = toEventWallClock(new Date(master.startDate).getTime(), timezone, false);
        masterStart = fromEventWallClock(masterWall + delta, timezone, false);
    }
    return {
        ...rest,
        startDate: new Date(masterStart).toISOString(),
        endDate: new Date(masterStart + durationMs).toISOString(),
    };
}

export interface EventEditorProps {
    /** The quick-create popover's face of the form, or the full form's (only a new event, which has `quickCreate`, has the quick one). Both show the same values. */
    layout: "quick" | "expanded";
    /** "More options": the quick face asks to become the full one. */
    onExpand: () => void;
    /** Leave without saving (nothing was stored). */
    onCancel: () => void;
    /** Something was stored: the dialog closes and the calendar reloads. */
    onSaved: () => void;
    /** A series save could not move every occurrence edited on its own with it (`detachedOccurrenceSyncFailed`). */
    onSyncWarning: () => void;
    /** Kept up to date with whether the form holds anything a stray click outside it would throw away. */
    dirtyRef: MutableRefObject<boolean>;
    mailboxUid: string;
    folderUid: string;
    calendars?: { uid: string; name: string }[];
    mailboxOptions?: { mailbox: Mailbox; calendars: { uid: string; name: string }[] }[];
    /** Each calendar's colour, keyed by folder uid. */
    folderColors?: Record<string, string>;
    organizerAddress: string;
    /** `null` when creating a new event. */
    occurrence: CalendarOccurrence | null;
    initialStart?: Date;
    initialEnd?: Date;
    /** A new event starting as an all-day one (a day cell of the month view was clicked). */
    initialAllDay?: boolean;
    /** A new event's tabs (Event, Task, Appointment schedule): with it the form is drawn by `QuickCreateFaces`; without it, as the full card. */
    quickCreate?: QuickCreateConfig;
}

/**
 * The event form and everything it does: create, and edit (one occurrence, or the entire series, of a recurring event - the choice
 * Outlook's own convention offers for the same ambiguity, see `calendarMutations.ts`), plus video conferencing. It owns the form's
 * one set of values and draws them as either the quick-create popover or the full card (`layout`), so growing the one into the other
 * keeps what was typed.
 */
export default function EventEditor({
    layout,
    onExpand,
    onCancel,
    onSaved,
    onSyncWarning,
    dirtyRef,
    mailboxUid,
    folderUid,
    calendars,
    mailboxOptions,
    folderColors,
    organizerAddress,
    occurrence,
    initialStart,
    initialEnd,
    initialAllDay,
    quickCreate,
}: EventEditorProps) {
    const [deviceZone] = useState(() => deviceTimeZone());
    const [values, setValues] = useState<EventFormValues>(() => {
        let start: string;
        let end: string;
        if (occurrence?.allDay) {
            // An all-day event is stored date-only with an exclusive end (see `allDay.ts`); the form shows its
            // inclusive last day instead.
            const startKey = allDayDateKey(occurrence.startDate);
            const lastDayKey = addDaysToKey(allDayDateKey(occurrence.endDate), -1);
            start = `${startKey}T00:00`;
            end = `${lastDayKey < startKey ? startKey : lastDayKey}T00:00`;
        } else if (!occurrence && initialAllDay) {
            start = `${format(initialStart ?? new Date(), "yyyy-MM-dd")}T00:00`;
            end = start;
        } else {
            start = toDatetimeLocal(occurrence?.startDate ?? initialStart?.toISOString() ?? new Date().toISOString());
            end = toDatetimeLocal(occurrence?.endDate ?? initialEnd?.toISOString() ?? new Date(Date.now() + 30 * MS_PER_MINUTE).toISOString());
        }
        return {
            title: occurrence?.title ?? "",
            location: occurrence?.location ?? "",
            start,
            end,
            allDay: occurrence?.allDay ?? (!occurrence && !!initialAllDay),
            formZone: deviceZone,
            timezone: occurrence?.timezone ?? deviceZone,
            attendees: occurrence?.attendees ?? [],
            guestDraft: "",
            recurrenceRule: occurrence?.recurrenceRule ?? null,
            reminderMinutes: occurrence?.reminderMinutesBeforeStart?.toString() ?? "",
            busyStatus: occurrence?.busyStatus ?? "busy",
            visibility: occurrence ? visibilityOf(occurrence) : "default",
            descriptionHtml: initialDescriptionHtml(occurrence),
            ...guestPermissionsOf(occurrence ?? {}),
            autoReplyEnabled: occurrence?.autoReplyEnabled ?? false,
            autoReplyMessage: occurrence?.autoReplyMessage ?? "",
            videoEnabled: !!occurrence?.videoMeetingUid,
            targetMailboxUid: mailboxUid,
            targetFolderUid: folderUid,
        };
    });
    const { attendees, location, videoEnabled } = values;
    function update(patch: Partial<EventFormValues>) {
        setValues((prev) => ({ ...prev, ...patch }));
    }

    const targetMailboxOption = mailboxOptions?.find((option) => option.mailbox.uid === values.targetMailboxUid);
    // Create mode follows the chosen mailbox; editing an existing event always keeps the passed-in values.
    const calendarChoices = !occurrence && targetMailboxOption ? targetMailboxOption.calendars : calendars;
    const effectiveOrganizerAddress = !occurrence && targetMailboxOption ? targetMailboxOption.mailbox.primarySmtpAddress : organizerAddress;

    function handleMailboxChange(nextMailboxUid: string) {
        const firstCalendar = mailboxOptions?.find((option) => option.mailbox.uid === nextMailboxUid)?.calendars[0];
        update(firstCalendar ? { targetMailboxUid: nextMailboxUid, targetFolderUid: firstCalendar.uid } : { targetMailboxUid: nextMailboxUid });
    }

    // Video conferencing: the meeting this event is linked to (if any), the organizer's own join link for it, and
    // whatever went wrong with the last attempt to mint/cancel one. (Whether it is switched on is `values.videoEnabled`.)
    const [videoMeetingUid, setVideoMeetingUid] = useState<string | undefined>(occurrence?.videoMeetingUid);
    // `undefined` while the link is still being fetched, `null` once it is known there is none to open.
    const [organizerJoinUrl, setOrganizerJoinUrl] = useState<string | null | undefined>(undefined);
    const [videoError, setVideoError] = useState<string | null>(null);
    // The event as this modal last persisted it. Set only when a save got the event stored but could not
    // finish the video-conferencing step after it: the modal then stays open on that error, and the retry
    // must update *that* record (its uid and its new version), not re-create it or reuse the stale prop.
    const [savedEvent, setSavedEvent] = useState<CalendarEvent | null>(null);
    const [editScope, setEditScope] = useState<EditScope>("occurrence");
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // An event that already carried a meeting when it was opened (e.g. after a page reload) knows only that
    // meeting's uid - the organizer's own join link lives on the meeting, so it is fetched once here. A
    // meeting minted in this session already has its link from the create call (see
    // `applyVideoConferencing()`), which is why this deliberately reads the *prop*, not the state: it must
    // not re-fetch what was just handed to us. A failure and a meeting with no link at all are the same
    // thing to this UI - there is nothing to open either way - so both settle on `null`.
    useEffect(() => {
        const uid = occurrence?.videoMeetingUid;
        if (!uid) {
            return;
        }
        let cancelled = false;
        void getVideoMeeting(uid)
            .then((meeting) => meeting.organizerJoinUrl ?? null)
            .catch(() => null)
            .then((url) => {
                if (!cancelled) {
                    setOrganizerJoinUrl(url);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [occurrence?.videoMeetingUid]);

    // "This event only" detaches a standalone, non-repeating copy - the series' rule doesn't apply to it.
    const editingSingleOccurrence = !!occurrence?.isRecurringOccurrence && editScope === "occurrence";

    dirtyRef.current = !!(values.title.trim() || values.location.trim() || values.attendees.length > 0 || values.guestDraft.trim() || hasDescriptionText(values.descriptionHtml));

    function addGuests(text: string): string[] {
        const merged = mergeGuests(values.attendees, text);
        update({ attendees: merged.attendees, guestDraft: merged.invalid.join(" ") });
        return merged.invalid;
    }
    function updateAttendee(index: number, patch: Partial<Attendee>) {
        setValues((prev) => ({ ...prev, attendees: prev.attendees.map((a, i) => (i === index ? { ...a, ...patch } : a)) }));
    }
    function removeAttendee(index: number) {
        setValues((prev) => ({ ...prev, attendees: prev.attendees.filter((_, i) => i !== index) }));
    }
    function addResource(mailbox: Mailbox) {
        setValues((prev) => ({
            ...prev,
            attendees: [
                ...prev.attendees,
                { address: mailbox.primarySmtpAddress, displayName: mailbox.displayName, role: "resource", responseStatus: "needsAction", isOrganizer: false },
            ],
        }));
    }

    // Moving the start moves the end with it, so the event keeps its length (a Google Calendar habit, and the way to
    // reschedule without touching two fields).
    function setStart(next: string) {
        setValues((prev) => {
            const shift = prev.allDay
                ? Date.parse(`${next.slice(0, 10)}T00:00:00Z`) - Date.parse(`${prev.start.slice(0, 10)}T00:00:00Z`)
                : wallStringToMs(next, prev.formZone, deviceZone) - wallStringToMs(prev.start, prev.formZone, deviceZone);
            const endMs = prev.allDay ? Date.parse(`${prev.end.slice(0, 10)}T00:00:00Z`) : wallStringToMs(prev.end, prev.formZone, deviceZone);
            let nextEnd = prev.end;
            if (!Number.isNaN(shift + endMs)) {
                nextEnd = prev.allDay
                    ? `${new Date(endMs + shift).toISOString().slice(0, 10)}T00:00`
                    : msToWallString(endMs + shift, prev.formZone, deviceZone);
            }
            return { ...prev, start: next, end: nextEnd };
        });
    }

    // The recurrence end date is stored in the frame the series expands in (UTC for all-day, local otherwise),
    // so toggling All day re-stores the same chosen date in the new frame.
    function handleAllDayChange(nextAllDay: boolean) {
        setValues((prev) => {
            let end = prev.end;
            if (!nextAllDay) {
                // Back to a timed event: the all-day dates carry no length, so give it an hour rather than an empty span.
                const startMs = wallStringToMs(prev.start, prev.formZone, deviceZone);
                if (!(wallStringToMs(prev.end, prev.formZone, deviceZone) > startMs) && !Number.isNaN(startMs)) {
                    end = msToWallString(startMs + MS_PER_HOUR, prev.formZone, deviceZone);
                }
            }
            return {
                ...prev,
                allDay: nextAllDay,
                end,
                recurrenceRule: prev.recurrenceRule?.until
                    ? {
                          ...prev.recurrenceRule,
                          until: recurrenceUntilInstant(recurrenceUntilDateKey(prev.recurrenceRule.until, prev.allDay), nextAllDay),
                      }
                    : prev.recurrenceRule,
            };
        });
    }

    // The times the form shows are read in `formZone`: picking another zone keeps the same instants and shows them on that zone's
    // clock, and the event is stored with the zone chosen. An all-day event has no clock to convert.
    function handleTimeZoneChange(zone: string) {
        setValues((prev) => {
            if (prev.allDay) {
                return { ...prev, formZone: zone, timezone: zone };
            }
            const startMs = wallStringToMs(prev.start, prev.formZone, deviceZone);
            const endMs = wallStringToMs(prev.end, prev.formZone, deviceZone);
            return {
                ...prev,
                formZone: zone,
                timezone: zone,
                start: Number.isNaN(startMs) ? prev.start : msToWallString(startMs, zone, deviceZone),
                end: Number.isNaN(endMs) ? prev.end : msToWallString(endMs, zone, deviceZone),
            };
        });
    }

    /**
     * Brings the event's video meeting in line with the toggle, once the event itself is saved (so the
     * attendee list a new meeting's invitees are built from is the one that was just stored).
     *
     * Turning it **on** mints a meeting for the saved event's attendees - every one of them except the
     * organizer, who reaches their own meeting through ownership (`organizerJoinUrl`), not as a guest - and
     * then patches the event with the meeting's uid and the generic `VIDEO_LOCATION_PLACEHOLDER` location.
     * No join link is written onto the event: each attendee's own link is substituted into their own copy of
     * the invitation server-side.
     *
     * Turning it **off** cancels the meeting and clears the link, restoring Location to `""` only when it
     * still holds exactly the placeholder this modal wrote - anything the user has typed there since is
     * theirs and is preserved.
     *
     * **Known, deliberate limitation:** an event that already has a meeting is left completely alone, even
     * when its attendee list has just changed. `@rapidmx/meet-plugin`'s `PUT /mail/video-meetings/:id`
     * is deliberately minimal (title and cancellation only) and cannot add or remove invitees, and a private
     * meeting's personal join links are minted once at creation - so there is no way to reconcile an invitee
     * list, and silently pretending otherwise would leave a new attendee with no link and a removed one with
     * a working one. The helper text under the checkbox says so, and turning the toggle off and on again
     * reissues links for the current attendee list.
     *
     * Never throws: the event is already stored by the time this runs, so a failure here is reported inline
     * next to the checkbox and left retryable, with `videoMeetingUid` still whatever it was before.
     */
    async function applyVideoConferencing(saved: CalendarEvent, guests: Attendee[]): Promise<{ event: CalendarEvent; failed: boolean }> {
        // Off and never on, or on and already linked (see the limitation above) - nothing to do either way.
        if (videoEnabled === !!videoMeetingUid) {
            return { event: saved, failed: false };
        }
        // Detaching a single occurrence (`detachOccurrence()`, react-shared's `calendarMutations.ts`)
        // deliberately never copies the series' `videoMeetingUid` onto the new standalone event - that
        // shared meeting belongs to the series, not to the one occurrence being split off, and every other
        // occurrence still needs it live. But this component's own `videoMeetingUid` *state* was seeded
        // from the series' occurrence at mount and is untouched by the detach, so unchecking the toggle
        // while detaching would otherwise still look like "off, but state says linked" above and fall into
        // the cancel branch below - cancelling the series' shared meeting for every remaining occurrence,
        // not just this one. `saved.videoMeetingUid` is the actual just-persisted record, so when the
        // toggle is off and that record already has no meeting reference (true for every detach, checked or
        // not - see this function's own doc comment on the still-checked case being a separate, documented
        // gap), there is nothing of *this* record's to cancel.
        if (!videoEnabled && !saved.videoMeetingUid) {
            return { event: saved, failed: false };
        }
        try {
            if (videoEnabled) {
                const organizerAddressLower = saved.organizer.address.toLowerCase();
                const invitees: VideoMeetingInvitee[] = guests
                    .filter((a) => !a.isOrganizer && !!a.address.trim() && a.address.trim().toLowerCase() !== organizerAddressLower)
                    .map((a) => ({ email: a.address.trim(), displayName: a.displayName }));
                if (invitees.length === 0) {
                    setVideoError("Add at least one attendee other than yourself to add video conferencing.");
                    return { event: saved, failed: true };
                }
                const result = await createVideoMeeting({
                    mailboxUid: saved.mailboxUid,
                    title: saved.title.slice(0, MAX_MEETING_TITLE_LENGTH),
                    visibility: "private",
                    calendarEventUid: saved.uid,
                    startTime: saved.startDate,
                    endTime: saved.endDate,
                    invitees,
                });
                const patched = await updateCalendarEvent({
                    uid: saved.uid,
                    version: saved.version,
                    location: VIDEO_LOCATION_PLACEHOLDER,
                    videoMeetingUid: result.meeting.uid,
                });
                setVideoMeetingUid(result.meeting.uid);
                setOrganizerJoinUrl(result.organizerJoinUrl ?? null);
                update({ location: VIDEO_LOCATION_PLACEHOLDER });
                return { event: patched, failed: false };
            }
            await updateVideoMeeting(videoMeetingUid!, { status: "cancelled" });
            const restoredLocation = location.trim() === VIDEO_LOCATION_PLACEHOLDER ? "" : location.trim();
            // A stored event clears a field with an explicit `null` (see `EventFields`) - an omitted one would
            // leave the placeholder (and the link to the now-cancelled meeting) in place.
            const patch: EventFields = { location: restoredLocation || null, videoMeetingUid: null };
            const patched = await updateCalendarEvent({ uid: saved.uid, version: saved.version, ...(patch as Partial<CalendarEventInput>) });
            setVideoMeetingUid(undefined);
            setOrganizerJoinUrl(undefined);
            update({ location: restoredLocation });
            return { event: patched, failed: false };
        } catch (err) {
            // `videoMeetingsApi.ts`'s own doc comment: when the plugin isn't installed at all, its routes
            // simply aren't mounted and every call here fails with a plain 404 - a caller offering video
            // conferencing optionally must treat that as "not available here," not alarm the reader with
            // the raw (often server-generated, unhelpful) 404 body text.
            setVideoError(
                err instanceof ApiRequestError
                    ? err.status === 404
                        ? "Video conferencing is not available on this server."
                        : err.message
                    : "Could not update this event's video conferencing.",
            );
            return { event: saved, failed: true };
        }
    }

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);
        setVideoError(null);

        if (!values.title.trim()) {
            setError("A title is required.");
            return;
        }
        // An address typed into the guests field but not added yet is added now - or, not being one, stops the save.
        const merged = mergeGuests(values.attendees, values.guestDraft);
        if (merged.invalid.length > 0) {
            setError(`“${merged.invalid[0]}” isn’t a valid email address.`);
            return;
        }
        const tooLong = descriptionProblem(values.descriptionHtml);
        if (tooLong) {
            setError(tooLong);
            return;
        }
        if (values.guestDraft) {
            update({ attendees: merged.attendees, guestDraft: "" });
        }
        let startDate: string;
        let endDate: string;
        const { start, end, allDay } = values;
        if (allDay) {
            const startKey = start.slice(0, 10);
            const lastDayKey = end.slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(startKey) || !/^\d{4}-\d{2}-\d{2}$/.test(lastDayKey)) {
                setError("Pick a start and an end date.");
                return;
            }
            if (lastDayKey < startKey) {
                setError("The end date can't be before the start date.");
                return;
            }
            startDate = allDayInstant(startKey);
            endDate = allDayInstant(addDaysToKey(lastDayKey, 1));
        } else {
            const startMs = wallStringToMs(start, values.formZone, deviceZone);
            const endMs = wallStringToMs(end, values.formZone, deviceZone);
            if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
                setError("Pick a start and an end date and time.");
                return;
            }
            if (endMs <= startMs) {
                setError("The end time must be after the start time.");
                return;
            }
            startDate = new Date(startMs).toISOString();
            endDate = new Date(endMs).toISOString();
        }

        // Only a stored event is updated in place, where a cleared field must be sent as `null`; creating
        // (a new event, or the detached copy of one occurrence) just omits it.
        const updatingInPlace = !!occurrence && !editingSingleOccurrence;
        const cleared = updatingInPlace ? null : undefined;
        const fields: EventFields = {
            title: values.title.trim(),
            location: values.location.trim() || cleared,
            startDate,
            endDate,
            allDay,
            timezone: values.timezone,
            attendees: merged.attendees,
            recurrenceRule: editingSingleOccurrence ? undefined : (values.recurrenceRule ?? cleared),
            reminderMinutesBeforeStart: values.reminderMinutes.trim() ? Number(values.reminderMinutes) : cleared,
            busyStatus: values.busyStatus,
            ...dialogFields(values, occurrence),
            autoReplyEnabled: values.autoReplyEnabled,
            autoReplyMessage: values.autoReplyEnabled ? values.autoReplyMessage : cleared,
        };

        setSaving(true);
        try {
            let saved: CalendarEvent;
            let detachedSyncFailed = false;
            if (savedEvent) {
                // A retry after the event was stored but its video meeting couldn't be (see `savedEvent`):
                // update exactly the record the first attempt left behind, whichever branch below created it.
                // A series' own exception/detached-occurrence re-pointing already ran on that attempt and has
                // nothing left to shift - the dates being sent again are the ones it moved everything to.
                saved = await updateCalendarEvent({ uid: savedEvent.uid, version: savedEvent.version, ...(fields as Partial<CalendarEventInput>) });
            } else if (!occurrence) {
                // The organizer is only ever set on create - an edit keeps the event's own organizer.
                saved = await createCalendarEvent({
                    mailboxUid: values.targetMailboxUid,
                    folderUid: values.targetFolderUid,
                    ...fields,
                    organizer: { address: effectiveOrganizerAddress, type: "to" },
                } as CalendarEventInput);
            } else if (editingSingleOccurrence) {
                saved = await detachOccurrence(occurrence, fields as Partial<CalendarEventInput>);
            } else if (occurrence.isRecurringOccurrence) {
                const series = await saveEventSeries(occurrence, (await toSeriesFields(occurrence, fields)) as Partial<CalendarEventInput>);
                saved = series;
                detachedSyncFailed = !!series.detachedOccurrenceSyncFailed;
            } else {
                saved = await updateCalendarEvent({ uid: occurrence.uid, version: occurrence.version, ...(fields as Partial<CalendarEventInput>) });
            }
            const video = await applyVideoConferencing(saved, merged.attendees);
            if (video.failed) {
                // The event itself is saved - keep the modal open on the inline error so the video meeting
                // can be retried (or the toggle put back) rather than closing over it.
                setSavedEvent(video.event);
                return;
            }
            if (detachedSyncFailed) {
                // The series itself was saved - say so, and leave closing to the user once they've read it.
                onSyncWarning();
                return;
            }
            onSaved();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not save this event.");
        } finally {
            setSaving(false);
        }
    }

    // Same scheme allow-list `calendarReminders.ts#joinMeetingUrl()` already applies to a reminder's own
    // `location` field - reused here rather than duplicated so a video-conferencing plugin (or a stray
    // manual edit of `videoMeetingUid`'s otherwise-plugin-owned join link) can't smuggle a `javascript:`/
    // `file:`/other non-http(s) URL into `window.open()`. `undefined` (still loading) and `null` (fetch
    // came back with nothing to join) both fail validation the same way as a bad scheme would - the button
    // stays disabled either way, and the two are told apart below purely from `organizerJoinUrl` itself.
    const joinUrl = joinMeetingUrl(organizerJoinUrl);

    const timeZones = useMemo(() => timeZoneOptions(values.formZone, values.timezone, deviceZone), [values.formZone, values.timezone, deviceZone]);
    const startMs = values.allDay ? Number.NaN : wallStringToMs(values.start, values.formZone, deviceZone);
    const calendarFolderUid = occurrence ? occurrence.folderUid : values.targetFolderUid;

    const controller: EventFormController = {
        occurrence,
        values,
        update,
        setStart,
        setEnd: (next) => update({ end: next }),
        onAllDayChange: handleAllDayChange,
        onTimeZoneChange: handleTimeZoneChange,
        timeZones,
        organizerAddress: effectiveOrganizerAddress,
        deviceZone,
        startWeekday: startWeekdayCode(
            values.allDay ? values.start : Number.isNaN(startMs) ? "" : new Date(startMs).toISOString(),
            values.allDay,
            values.timezone,
        ),
        editingSingleOccurrence,
        addGuests,
        updateAttendee,
        removeAttendee,
        addResource,
        guestAddresses: attendees.map((a) => a.address.toLowerCase()),
        mailboxOptions,
        onMailboxChange: handleMailboxChange,
        calendarChoices,
        calendarName: calendarChoices?.find((cal) => cal.uid === calendarFolderUid)?.name,
        calendarColor: folderColors?.[calendarFolderUid],
        videoMeetingUid,
        joinUrl,
        organizerJoinUrl,
        videoError,
        editScope,
        setEditScope,
        showEditScope: !!occurrence?.isRecurringOccurrence,
        error,
        saving,
        onSubmit: (event) => void handleSubmit(event),
        // Once something was stored, leaving is a save as far as the calendar behind is concerned: it has to reload.
        onCancel: () => (savedEvent ? onSaved() : onCancel()),
    };

    // A new event has the tabs, whose Event face is the quick popover or the full card; an existing event is always the full card.
    return quickCreate ? (
        <QuickCreateFaces c={controller} layout={layout} onExpand={onExpand} config={quickCreate} dirtyRef={dirtyRef} organizerAddress={effectiveOrganizerAddress} />
    ) : (
        <EventExpandedForm c={controller} />
    );
}
