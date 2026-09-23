///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    Attendee,
    AttendeeResponseInput,
    AttendeeResponseStatus,
    AttendeeRole,
    BusyStatus,
    CalendarEvent,
    CalendarEventInput,
    RecurrenceRule,
    createCalendarEvent,
    getCalendarEvent,
    respondToEvent,
    updateCalendarEvent,
} from "@rapidmx/react-shared/calendar/calendarApi.js";
import {
    VideoMeetingInvitee,
    createVideoMeeting,
    getVideoMeeting,
    updateVideoMeeting,
} from "@rapidmx/react-shared/videoconf/videoMeetingsApi.js";
import { deleteEventOccurrence, deleteEventSeries, detachOccurrence, saveEventSeries } from "@rapidmx/react-shared/calendar/calendarMutations.js";
import { toDatetimeLocal } from "@rapidmx/react-shared/util/dateInput.js";
import { Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import { CalendarOccurrence, fromEventWallClock, toEventWallClock } from "@rapidmx/react-shared/calendar/recurrence.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";
import RecurrenceEditor from "./RecurrenceEditor.js";
import { addDaysToKey, allDayDateKey, allDayInstant, recurrenceUntilDateKey, recurrenceUntilInstant, startWeekdayCode } from "./allDay.js";
import ResourcePicker from "./ResourcePicker.js";
import { joinMeetingUrl } from "../../calendar/calendarReminders.js";

const INPUT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";
const SELECT_CLASS =
    "text-sm py-2 px-2 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

const ATTENDEE_ROLES: AttendeeRole[] = ["required", "optional", "resource"];
const BUSY_STATUSES: BusyStatus[] = ["busy", "free", "tentative", "oof"];
const BUSY_STATUS_LABEL: Record<BusyStatus, string> = { busy: "Busy", free: "Free", tentative: "Tentative", oof: "Out of office" };
const RESPONSE_STATUS_LABEL: Record<AttendeeResponseStatus, string> = {
    needsAction: "Awaiting response",
    accepted: "Accepted",
    declined: "Declined",
    tentative: "Tentative",
};

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

export interface EventModalProps {
    open: boolean;
    onClose: () => void;
    mailboxUid: string;
    /** The calendar folder a new event is created into (ignored when editing — an existing event keeps
     * its own `folderUid`). When `calendars` names more than one option, a "Calendar" selector lets the
     * user override this default before saving. */
    folderUid: string;
    /** Every calendar the caller could create this event into. Omitted, or a single entry, means "only
     * one calendar exists" — no selector is shown and `folderUid` is used as-is, matching this
     * component's original single-calendar behavior exactly. */
    calendars?: { uid: string; name: string }[];
    /** Every mailbox a new event could be created in, each with its own calendars. With more than one, a
     * "Mailbox" selector (create mode only) chooses the mailbox, which in turn drives the Calendar selector
     * and the organizer address; `mailboxUid`/`folderUid` are the initial selection. */
    mailboxOptions?: { mailbox: Mailbox; calendars: { uid: string; name: string }[] }[];
    organizerAddress: string;
    /** The viewing mailbox's alias addresses - an event it organizes (or an invitation to it) may name any of
     * them instead of `organizerAddress`. Defaults to that mailbox's `aliasAddresses` from `mailboxOptions`. */
    organizerAliases?: string[];
    /** `null` when creating a new event. */
    occurrence: CalendarOccurrence | null;
    /** Prefilled start/end for create mode (e.g. the day/slot the user clicked). */
    initialStart?: Date;
    initialEnd?: Date;
    onSaved: () => void;
    onDeleted: () => void;
}

type EditScope = "occurrence" | "series";

/** `CalendarEventInput` fields as sent on save. `null` explicitly clears a field on an update - an
 * omitted (`undefined`) field is dropped by `JSON.stringify` and would leave the stored value in place. */
type EventFields = { [K in keyof CalendarEventInput]?: CalendarEventInput[K] | null };

const MS_PER_MINUTE = 60_000;
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
        return rest;
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

/**
 * Create/view/edit/delete for a single calendar event. Editing or deleting a recurring event's
 * occurrence offers a choice between "this event" and "the entire series" (see
 * `calendarMutations.ts`) — Outlook's own convention for the same ambiguity.
 */
export default function EventModal({
    open,
    onClose,
    mailboxUid,
    folderUid,
    calendars,
    mailboxOptions,
    organizerAddress,
    organizerAliases,
    occurrence,
    initialStart,
    initialEnd,
    onSaved,
    onDeleted,
}: EventModalProps) {
    const [targetFolderUid, setTargetFolderUid] = useState(folderUid);
    const [targetMailboxUid, setTargetMailboxUid] = useState(mailboxUid);
    const targetMailboxOption = mailboxOptions?.find((option) => option.mailbox.uid === targetMailboxUid);
    // Create mode follows the chosen mailbox; editing an existing event always keeps the passed-in values.
    const calendarChoices = !occurrence && targetMailboxOption ? targetMailboxOption.calendars : calendars;
    const effectiveOrganizerAddress = !occurrence && targetMailboxOption ? targetMailboxOption.mailbox.primarySmtpAddress : organizerAddress;
    // Every address the viewing mailbox receives at - its primary address and its aliases, case-insensitively.
    const ownAddresses = new Set(
        [organizerAddress, ...(organizerAliases ?? mailboxOptions?.find((option) => option.mailbox.uid === mailboxUid)?.mailbox.aliasAddresses ?? [])].map(
            (address) => address.toLowerCase(),
        ),
    );
    const isOwnAddress = (address: string) => ownAddresses.has(address.toLowerCase());
    // An existing event organized by someone else is the viewing mailbox's copy of an invitation: only the
    // organizer can change it (their next update would overwrite local edits anyway), so it's read-only
    // apart from the RSVP controls.
    const isInvited =
        !!occurrence && !isOwnAddress(occurrence.organizer.address) && !occurrence.attendees.some((a) => a.isOrganizer && isOwnAddress(a.address));

    function handleMailboxChange(nextMailboxUid: string) {
        setTargetMailboxUid(nextMailboxUid);
        const firstCalendar = mailboxOptions?.find((option) => option.mailbox.uid === nextMailboxUid)?.calendars[0];
        if (firstCalendar) {
            setTargetFolderUid(firstCalendar.uid);
        }
    }
    const [title, setTitle] = useState(occurrence?.title ?? "");
    const [location, setLocation] = useState(occurrence?.location ?? "");
    // An all-day event is stored date-only with an exclusive end (see `allDay.ts`); the form shows its
    // inclusive last day instead.
    const [start, setStart] = useState(() =>
        occurrence?.allDay
            ? `${allDayDateKey(occurrence.startDate)}T00:00`
            : toDatetimeLocal(occurrence?.startDate ?? initialStart?.toISOString() ?? new Date().toISOString()),
    );
    const [end, setEnd] = useState(() => {
        if (occurrence?.allDay) {
            const startKey = allDayDateKey(occurrence.startDate);
            const lastDayKey = addDaysToKey(allDayDateKey(occurrence.endDate), -1);
            return `${lastDayKey < startKey ? startKey : lastDayKey}T00:00`;
        }
        return toDatetimeLocal(occurrence?.endDate ?? initialEnd?.toISOString() ?? new Date(Date.now() + 30 * 60_000).toISOString());
    });
    const [allDay, setAllDay] = useState(occurrence?.allDay ?? false);
    const [timezone] = useState(occurrence?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    const [attendees, setAttendees] = useState<Attendee[]>(occurrence?.attendees ?? []);
    const [recurrenceRule, setRecurrenceRule] = useState<RecurrenceRule | null>(occurrence?.recurrenceRule ?? null);
    const [reminderMinutes, setReminderMinutes] = useState(occurrence?.reminderMinutesBeforeStart?.toString() ?? "");
    const [busyStatus, setBusyStatus] = useState<BusyStatus>(occurrence?.busyStatus ?? "busy");
    const [autoReplyEnabled, setAutoReplyEnabled] = useState(occurrence?.autoReplyEnabled ?? false);
    const [autoReplyMessage, setAutoReplyMessage] = useState(occurrence?.autoReplyMessage ?? "");
    const [editScope, setEditScope] = useState<EditScope>("occurrence");
    // Video conferencing: the toggle, the meeting this event is linked to (if any), the organizer's own join
    // link for it, and whatever went wrong with the last attempt to mint/cancel one.
    const [videoEnabled, setVideoEnabled] = useState(!!occurrence?.videoMeetingUid);
    const [videoMeetingUid, setVideoMeetingUid] = useState<string | undefined>(occurrence?.videoMeetingUid);
    // `undefined` while the link is still being fetched, `null` once it is known there is none to open.
    const [organizerJoinUrl, setOrganizerJoinUrl] = useState<string | null | undefined>(undefined);
    const [videoError, setVideoError] = useState<string | null>(null);
    // The event as this modal last persisted it. Set only when a save got the event stored but could not
    // finish the video-conferencing step after it: the modal then stays open on that error, and the retry
    // must update *that* record (its uid and its new version), not re-create it or reuse the stale prop.
    const [savedEvent, setSavedEvent] = useState<CalendarEvent | null>(null);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    // A series save that moved the series but couldn't move every separately edited occurrence with it.
    const [syncWarning, setSyncWarning] = useState(false);
    const [responding, setResponding] = useState(false);
    const [resourcePickerOpen, setResourcePickerOpen] = useState(false);
    const addResourceButtonRef = useRef<HTMLButtonElement>(null);

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

    // The viewing mailbox can respond to an *existing* event it's invited to but doesn't organize —
    // `organizerAddress` (plus the aliases) are this mailbox's own addresses (see `EventModalProps`), so
    // finding one among `attendees` (and not as that attendee's own organizer flag) identifies exactly
    // that case. `@rapidmx/restapi`'s `respond()` route has no occurrence-vs-series scope of its own
    // (see `calendarApi.ts`'s `respondToEvent` doc comment) — it always acts on `occurrence.uid` as a
    // single event document, so this deliberately does not consult `editScope`.
    const myAttendeeIndex = occurrence ? attendees.findIndex((a) => isOwnAddress(a.address)) : -1;
    const canRespond = myAttendeeIndex !== -1 && !attendees[myAttendeeIndex].isOrganizer;
    // "This event only" detaches a standalone, non-repeating copy - the series' rule doesn't apply to it.
    const editingSingleOccurrence = !!occurrence?.isRecurringOccurrence && editScope === "occurrence";

    function updateAttendee(index: number, patch: Partial<Attendee>) {
        setAttendees((prev) => prev.map((a, i) => (i === index ? { ...a, ...patch } : a)));
    }
    function removeAttendee(index: number) {
        setAttendees((prev) => prev.filter((_, i) => i !== index));
    }
    function addResource(mailbox: Mailbox) {
        setAttendees((prev) => [
            ...prev,
            { address: mailbox.primarySmtpAddress, displayName: mailbox.displayName, role: "resource", responseStatus: "needsAction", isOrganizer: false },
        ]);
        setResourcePickerOpen(false);
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
    async function applyVideoConferencing(saved: CalendarEvent): Promise<{ event: CalendarEvent; failed: boolean }> {
        // Off and never on, or on and already linked (see the limitation above) - nothing to do either way.
        if (videoEnabled === !!videoMeetingUid) {
            return { event: saved, failed: false };
        }
        try {
            if (videoEnabled) {
                const organizerAddressLower = saved.organizer.address.toLowerCase();
                const invitees: VideoMeetingInvitee[] = attendees
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
                setLocation(VIDEO_LOCATION_PLACEHOLDER);
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
            setLocation(restoredLocation);
            return { event: patched, failed: false };
        } catch (err) {
            setVideoError(err instanceof ApiRequestError ? err.message : "Could not update this event's video conferencing.");
            return { event: saved, failed: true };
        }
    }

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);
        setVideoError(null);

        if (!title.trim()) {
            setError("A title is required.");
            return;
        }
        let startDate: string;
        let endDate: string;
        if (allDay) {
            const startKey = start.slice(0, 10);
            const lastDayKey = end.slice(0, 10);
            if (lastDayKey < startKey) {
                setError("The end date can't be before the start date.");
                return;
            }
            startDate = allDayInstant(startKey);
            endDate = allDayInstant(addDaysToKey(lastDayKey, 1));
        } else {
            if (new Date(end) <= new Date(start)) {
                setError("The end time must be after the start time.");
                return;
            }
            startDate = new Date(start).toISOString();
            endDate = new Date(end).toISOString();
        }

        // Only a stored event is updated in place, where a cleared field must be sent as `null`; creating
        // (a new event, or the detached copy of one occurrence) just omits it.
        const updatingInPlace = !!occurrence && !editingSingleOccurrence;
        const cleared = updatingInPlace ? null : undefined;
        const fields: EventFields = {
            title: title.trim(),
            location: location.trim() || cleared,
            startDate,
            endDate,
            allDay,
            timezone,
            attendees,
            recurrenceRule: editingSingleOccurrence ? undefined : (recurrenceRule ?? cleared),
            reminderMinutesBeforeStart: reminderMinutes.trim() ? Number(reminderMinutes) : cleared,
            busyStatus,
            autoReplyEnabled,
            autoReplyMessage: autoReplyEnabled ? autoReplyMessage : cleared,
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
                    mailboxUid: targetMailboxUid,
                    folderUid: targetFolderUid,
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
            const video = await applyVideoConferencing(saved);
            if (video.failed) {
                // The event itself is saved - keep the modal open on the inline error so the video meeting
                // can be retried (or the toggle put back) rather than closing over it.
                setSavedEvent(video.event);
                return;
            }
            if (detachedSyncFailed) {
                // The series itself was saved - say so, and leave closing to the user once they've read it.
                setSyncWarning(true);
                return;
            }
            onSaved();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not save this event.");
        } finally {
            setSaving(false);
        }
    }

    // Only ever invoked from the Delete button(s) rendered inside the `{occurrence && (...)}` block
    // below, so `occurrence` is always non-null here — no defensive null check needed.
    async function handleDelete(scope: EditScope) {
        setError(null);
        setSaving(true);
        try {
            if (occurrence!.isRecurringOccurrence && scope === "occurrence") {
                await deleteEventOccurrence(occurrence!);
            } else {
                await deleteEventSeries(occurrence!);
            }
            onDeleted();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not delete this event.");
            setSaving(false);
        }
    }

    // Only rendered inside the `{canRespond && (...)}` block below, which already requires `occurrence`
    // to be non-null (see `canRespond`'s own definition above) — same established pattern as
    // `handleDelete`'s non-null assertion.
    async function handleRespond(responseStatus: AttendeeResponseInput) {
        setError(null);
        setResponding(true);
        try {
            await respondToEvent(occurrence!.uid, responseStatus);
            // A decline soft-deletes the mailbox's own copy server-side — treat it the same as a
            // delete rather than a save so the calendar view drops it immediately.
            if (responseStatus === "declined") {
                onDeleted();
            } else {
                onSaved();
            }
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not send your response.");
            setResponding(false);
        }
    }

    // The recurrence end date is stored in the frame the series expands in (UTC for all-day, local otherwise),
    // so toggling All day re-stores the same chosen date in the new frame.
    function handleAllDayChange(nextAllDay: boolean) {
        setAllDay(nextAllDay);
        setRecurrenceRule((rule) =>
            rule?.until ? { ...rule, until: recurrenceUntilInstant(recurrenceUntilDateKey(rule.until, allDay), nextAllDay) } : rule,
        );
    }

    if (syncWarning) {
        return (
            <Modal open={open} onClose={onSaved} title="Series saved">
                <p role="alert" className="text-sm mb-4">
                    The series was saved, but some occurrences you had changed individually couldn&rsquo;t be moved with it. They
                    may now appear twice - check the calendar and delete any duplicate.
                </p>
                <Button type="button" className="!w-auto" onClick={onSaved}>
                    OK
                </Button>
            </Modal>
        );
    }

    // Same scheme allow-list `calendarReminders.ts#joinMeetingUrl()` already applies to a reminder's own
    // `location` field - reused here rather than duplicated so a video-conferencing plugin (or a stray
    // manual edit of `videoMeetingUid`'s otherwise-plugin-owned join link) can't smuggle a `javascript:`/
    // `file:`/other non-http(s) URL into `window.open()`. `undefined` (still loading) and `null` (fetch
    // came back with nothing to join) both fail validation the same way as a bad scheme would - the button
    // stays disabled either way, and the two are told apart below purely from `organizerJoinUrl` itself.
    const validatedJoinUrl = joinMeetingUrl(organizerJoinUrl);

    return (
        <Modal open={open} onClose={onClose} title={occurrence ? "Edit event" : "New event"}>
            <form onSubmit={handleSubmit} className="flex flex-col gap-1">
                {error && <Alert>{error}</Alert>}

                {canRespond && (
                    <div className="flex flex-col gap-2 mb-3 p-3 rounded-sm bg-surface-alt">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                            <span className="text-sm font-medium">Your response</span>
                            <div className="flex gap-2">
                                <Button
                                    type="button"
                                    variant="secondary"
                                    className="!w-auto"
                                    disabled={responding}
                                    onClick={() => handleRespond("accepted")}
                                >
                                    Accept
                                </Button>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    className="!w-auto"
                                    disabled={responding}
                                    onClick={() => handleRespond("tentative")}
                                >
                                    Tentative
                                </Button>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    className="!w-auto text-danger"
                                    disabled={responding}
                                    onClick={() => handleRespond("declined")}
                                >
                                    Decline
                                </Button>
                            </div>
                        </div>
                        <p className="text-xs text-text-muted">Other attendees&rsquo; responses may take a few minutes to update.</p>
                    </div>
                )}

                {isInvited && (
                    <p className="text-xs text-text-muted mb-3">
                        You were invited to this event. Only the organizer can change its details.
                    </p>
                )}

                {/* Outside the `disabled` fieldset below: joining a call is not editing the event, so it stays
                    available on an invitation's read-only copy too (where the link, like the meeting itself,
                    is only reachable by whoever holds access to its mailbox). */}
                {videoMeetingUid && (
                    <div className="flex items-center gap-3 mb-3">
                        <Button
                            type="button"
                            variant="secondary"
                            className="!w-auto"
                            disabled={!validatedJoinUrl}
                            onClick={() => window.open(validatedJoinUrl!, "_blank", "noopener,noreferrer")}
                        >
                            Join video call
                        </Button>
                        {!validatedJoinUrl && (
                            <span className="text-xs text-text-muted">
                                {organizerJoinUrl === undefined ? "Loading the join link…" : "This meeting’s join link isn’t available."}
                            </span>
                        )}
                    </div>
                )}

                <fieldset disabled={isInvited} className="flex flex-col gap-1 min-w-0">

                {!occurrence && mailboxOptions && mailboxOptions.length > 1 && (
                    <FormField label="Mailbox" htmlFor="event-mailbox">
                        <select
                            id="event-mailbox"
                            className={INPUT_CLASS}
                            value={targetMailboxUid}
                            onChange={(e) => handleMailboxChange(e.target.value)}
                        >
                            {mailboxOptions.map(({ mailbox }) => (
                                <option key={mailbox.uid} value={mailbox.uid}>
                                    {mailbox.displayName}
                                    {mailbox.ownerUserUid ? "" : " (shared)"}
                                </option>
                            ))}
                        </select>
                    </FormField>
                )}

                {!occurrence && calendarChoices && calendarChoices.length > 1 && (
                    <FormField label="Calendar" htmlFor="event-calendar">
                        <select
                            id="event-calendar"
                            className={INPUT_CLASS}
                            value={targetFolderUid}
                            onChange={(e) => setTargetFolderUid(e.target.value)}
                        >
                            {calendarChoices.map((cal) => (
                                <option key={cal.uid} value={cal.uid}>
                                    {cal.name}
                                </option>
                            ))}
                        </select>
                    </FormField>
                )}

                <FormField label="Title" htmlFor="event-title">
                    <input id="event-title" type="text" className={INPUT_CLASS} value={title} onChange={(e) => setTitle(e.target.value)} />
                </FormField>

                <FormField label="Location" htmlFor="event-location">
                    <input id="event-location" type="text" className={INPUT_CLASS} value={location} onChange={(e) => setLocation(e.target.value)} />
                </FormField>

                <div className="mb-3">
                    <label className="flex items-center gap-2 text-sm font-medium">
                        <input type="checkbox" checked={videoEnabled} onChange={(e) => setVideoEnabled(e.target.checked)} />
                        Add video conferencing
                    </label>
                    {videoEnabled && (
                        <p className="text-xs text-text-muted mt-1">
                            Changing attendees after enabling video conferencing won&rsquo;t update meeting invitees &mdash;
                            turn this off and back on to reissue links to the current attendee list.
                        </p>
                    )}
                    {videoError && (
                        <p role="alert" className="text-xs text-danger mt-1">
                            {videoError}
                        </p>
                    )}
                </div>

                <label className="flex items-center gap-2 text-sm font-medium mb-3">
                    <input type="checkbox" checked={allDay} onChange={(e) => handleAllDayChange(e.target.checked)} />
                    All day
                </label>

                <div className="grid grid-cols-2 gap-3">
                    <FormField label="Start" htmlFor="event-start">
                        <input
                            id="event-start"
                            type={allDay ? "date" : "datetime-local"}
                            className={INPUT_CLASS}
                            value={allDay ? start.slice(0, 10) : start}
                            onChange={(e) => setStart(allDay ? `${e.target.value}T00:00` : e.target.value)}
                        />
                    </FormField>
                    <FormField label="End" htmlFor="event-end">
                        <input
                            id="event-end"
                            type={allDay ? "date" : "datetime-local"}
                            className={INPUT_CLASS}
                            value={allDay ? end.slice(0, 10) : end}
                            onChange={(e) => setEnd(allDay ? `${e.target.value}T00:00` : e.target.value)}
                        />
                    </FormField>
                </div>

                <FormField label="Attendees" htmlFor="event-attendees">
                    <div id="event-attendees" className="flex flex-col gap-2">
                        {attendees.map((attendee, i) => (
                            <div key={i} className="flex gap-2">
                                <input
                                    type="email"
                                    className={`${INPUT_CLASS} flex-1`}
                                    value={attendee.address}
                                    onChange={(e) => updateAttendee(i, { address: e.target.value })}
                                    aria-label={`Attendee email ${i + 1}`}
                                />
                                <select
                                    className={SELECT_CLASS}
                                    value={attendee.role}
                                    onChange={(e) => updateAttendee(i, { role: e.target.value as AttendeeRole })}
                                    aria-label={`Attendee role ${i + 1}`}
                                >
                                    {ATTENDEE_ROLES.map((role) => (
                                        <option key={role} value={role}>
                                            {role}
                                        </option>
                                    ))}
                                </select>
                                <span className="text-xs font-medium text-text-muted shrink-0 py-1 px-2.5 rounded-pill bg-surface-alt self-center">
                                    {RESPONSE_STATUS_LABEL[attendee.responseStatus]}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => removeAttendee(i)}
                                    className="text-sm text-danger px-2"
                                    aria-label={`Remove attendee ${i + 1}`}
                                >
                                    &times;
                                </button>
                            </div>
                        ))}
                        <div className="flex gap-3 items-center">
                            <button
                                type="button"
                                onClick={() => setAttendees((prev) => [...prev, { address: "", role: "required", responseStatus: "needsAction", isOrganizer: false }])}
                                className="self-start text-xs font-medium text-primary-dark hover:underline"
                            >
                                + Add attendee
                            </button>
                            <button
                                ref={addResourceButtonRef}
                                type="button"
                                onClick={() => setResourcePickerOpen(true)}
                                className="self-start text-xs font-medium text-primary-dark hover:underline"
                            >
                                + Add room/equipment
                            </button>
                        </div>
                        {resourcePickerOpen && (
                            <ResourcePicker
                                anchorRef={addResourceButtonRef}
                                onClose={() => setResourcePickerOpen(false)}
                                onSelect={addResource}
                                excludeAddresses={attendees.map((a) => a.address.toLowerCase())}
                            />
                        )}
                    </div>
                </FormField>

                <div className="grid grid-cols-2 gap-3">
                    <FormField label="Busy status" htmlFor="event-busyStatus">
                        <select
                            id="event-busyStatus"
                            className={INPUT_CLASS}
                            value={busyStatus}
                            onChange={(e) => setBusyStatus(e.target.value as BusyStatus)}
                        >
                            {BUSY_STATUSES.map((status) => (
                                <option key={status} value={status}>
                                    {BUSY_STATUS_LABEL[status]}
                                </option>
                            ))}
                        </select>
                    </FormField>
                    <FormField label="Reminder (minutes before)" htmlFor="event-reminder">
                        <input
                            id="event-reminder"
                            type="number"
                            min={0}
                            className={INPUT_CLASS}
                            value={reminderMinutes}
                            onChange={(e) => setReminderMinutes(e.target.value)}
                            placeholder="None"
                        />
                    </FormField>
                </div>

                <div className="mb-3">
                    <label className="flex items-center gap-2 text-sm font-medium">
                        <input
                            type="checkbox"
                            checked={autoReplyEnabled}
                            onChange={(e) => setAutoReplyEnabled(e.target.checked)}
                        />
                        Send an automatic reply while this event is happening
                    </label>
                    <p className="text-xs text-text-muted mt-1">
                        Applies in addition to your mailbox&rsquo;s own Automatic Replies setting (see Settings) —
                        this event&rsquo;s message takes over for its own start/end window.
                    </p>
                    {autoReplyEnabled && (
                        <textarea
                            aria-label="Automatic reply message"
                            className={`${INPUT_CLASS} mt-2`}
                            rows={3}
                            value={autoReplyMessage}
                            onChange={(e) => setAutoReplyMessage(e.target.value)}
                            placeholder="I'm out of office and back on..."
                        />
                    )}
                </div>

                {!editingSingleOccurrence && (
                    <FormField label="Recurrence" htmlFor="event-recurrence">
                        <RecurrenceEditor
                            value={recurrenceRule}
                            onChange={setRecurrenceRule}
                            allDay={allDay}
                            startWeekday={startWeekdayCode(start, allDay, timezone)}
                        />
                    </FormField>
                )}

                {occurrence?.isRecurringOccurrence && !isInvited && (
                    <fieldset className="flex flex-col gap-1.5 text-sm mb-3">
                        <legend className="text-xs font-bold uppercase tracking-wide text-text-muted mb-1">Apply changes to</legend>
                        <label className="flex items-center gap-2">
                            <input
                                type="radio"
                                name="event-edit-scope"
                                checked={editScope === "occurrence"}
                                onChange={() => setEditScope("occurrence")}
                            />
                            This event only
                        </label>
                        <label className="flex items-center gap-2">
                            <input
                                type="radio"
                                name="event-edit-scope"
                                checked={editScope === "series"}
                                onChange={() => setEditScope("series")}
                            />
                            The entire series
                        </label>
                    </fieldset>
                )}

                </fieldset>

                <div className="flex gap-3 mt-2">
                    {!isInvited && (
                        <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                            Save
                        </Button>
                    )}
                    <Button type="button" variant="secondary" className="!w-auto" onClick={onClose}>
                        Cancel
                    </Button>
                    {occurrence &&
                        (!occurrence.isRecurringOccurrence ? (
                            <Button
                                type="button"
                                variant="secondary"
                                className="!w-auto ml-auto text-danger"
                                disabled={saving}
                                onClick={() => handleDelete("series")}
                            >
                                Delete
                            </Button>
                        ) : !confirmingDelete ? (
                            <Button
                                type="button"
                                variant="secondary"
                                className="!w-auto ml-auto text-danger"
                                disabled={saving}
                                onClick={() => setConfirmingDelete(true)}
                            >
                                Delete
                            </Button>
                        ) : (
                            <div className="flex gap-2 ml-auto">
                                <Button
                                    type="button"
                                    variant="secondary"
                                    className="!w-auto text-danger"
                                    disabled={saving}
                                    onClick={() => handleDelete("occurrence")}
                                >
                                    Delete this event
                                </Button>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    className="!w-auto text-danger"
                                    disabled={saving}
                                    onClick={() => handleDelete("series")}
                                >
                                    Delete series
                                </Button>
                            </div>
                        ))}
                </div>
            </form>
        </Modal>
    );
}
