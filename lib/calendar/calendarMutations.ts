///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Higher-level calendar mutations shared by the event modal (edit/delete) and the grid views'
 * drag-and-drop handlers (move/resize) — both need the exact same "this occurrence vs. the entire
 * series" logic for a recurring event, so it lives here once rather than being duplicated.
 *
 * A recurring event has no per-occurrence record server-side — `@rapidmx/restapi` stores only the
 * master `CalendarEvent` plus its `RecurrenceRule` (see `recurrence.ts`'s header comment). Changing
 * (or deleting) a single occurrence is therefore always a two-part operation: add that occurrence's
 * original start to the master's `recurrenceRule.exceptions` (so it stops being generated), and, for
 * an edit (not a delete), separately create a new standalone `CalendarEvent` carrying the edited
 * fields, with `recurrenceId` set to that original occurrence's start for traceability — mirroring
 * how `CalendarEvent.recurrenceId` is documented to work.
 */

import {
    CalendarEvent,
    CalendarEventInput,
    UpdateCalendarEventInput,
    createCalendarEvent,
    deleteCalendarEvent,
    getCalendarEvent,
    listCalendarEvents,
    updateCalendarEvent,
} from "./calendarApi.js";
import { CalendarOccurrence, fromEventWallClock, toEventWallClock } from "./recurrence.js";
import { ApiClient } from "../util/api.js";

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before,
 * and threads the same `client` through to every `calendarApi.ts` call it makes internally. */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function positiveModulo(value: number, modulus: number): number {
    return ((value % modulus) + modulus) % modulus;
}

function addException(event: CalendarEvent, occurrenceStart: string, client?: ApiClient): Promise<CalendarEvent> {
    const rule = event.recurrenceRule!;
    return updateCalendarEvent(
        {
            uid: event.uid,
            version: event.version,
            recurrenceRule: { ...rule, exceptions: [...rule.exceptions, occurrenceStart] },
        },
        client,
    );
}

/** `saveEventSeries()`'s result: the saved master, plus whether its detached occurrences could be kept in
 * step with a rescheduled series. */
export type SeriesSaveResult = CalendarEvent & {
    /** `true` when the series' start moved but at least one detached occurrence (a separate event sharing
     * the master's `icalUid`, with a `recurrenceId`) couldn't be re-pointed at its occurrence's new start -
     * that occurrence may then show up twice (the detached copy plus a regenerated one). The master itself
     * was saved. Absent when nothing needed re-pointing or every update succeeded. */
    detachedOccurrenceSyncFailed?: boolean;
};

/**
 * Applies edited `fields` to every occurrence of a recurring event's series (the master record).
 *
 * `fields.startDate` must be the *master's* new start (web-client's `toSeriesFields()` computes it). When
 * it moves the series (or changes its `timezone`/`allDay`), every occurrence moves by the same wall-clock
 * delta, so everything that identifies an occurrence by its original start moves with it: the rule's
 * `exceptions` (else a deleted occurrence reappears and a different one vanishes) and the `recurrenceId` of
 * each detached occurrence in the master's folder (else the server-side reminder/iTIP logic, which matches
 * overrides by `recurrenceId`, no longer pairs them). Detached occurrences keep their own edited times. The
 * master is saved first; re-pointing detached occurrences is best-effort, reported through
 * `detachedOccurrenceSyncFailed` rather than thrown. Series edits that don't move the start make one PUT.
 */
export async function saveEventSeries(
    occurrence: CalendarOccurrence,
    fields: Partial<CalendarEventInput>,
    client?: ApiClient,
): Promise<SeriesSaveResult> {
    const update: UpdateCalendarEventInput = { uid: occurrence.uid, version: occurrence.version, ...fields };
    // A shift can be needed even without an explicit startDate: changing timezone or allDay reinterprets the
    // master's existing (unchanged) instant onto a different wall clock, exactly as the doc comment above
    // promises - so all three fields, not just startDate, gate entry into the shift path below.
    if (fields.startDate === undefined && fields.timezone === undefined && fields.allDay === undefined) {
        return updateCalendarEvent(update, client);
    }
    const master = await getCalendarEvent(occurrence.uid, client);
    const newTimezone = fields.timezone ?? master.timezone;
    const newAllDay = fields.allDay ?? master.allDay;
    const oldStartWall = toEventWallClock(Date.parse(master.startDate), master.timezone, master.allDay);
    const newStartInstant = Date.parse(fields.startDate ?? master.startDate);
    const deltaWallMs = toEventWallClock(newStartInstant, newTimezone, newAllDay) - oldStartWall;
    if (deltaWallMs === 0 && newTimezone === master.timezone && newAllDay === master.allDay) {
        return updateCalendarEvent(update, client);
    }
    // An occurrence is identified by its nominal wall-clock start (the rule's date + the master's time of day),
    // not by the instant's own wall time: one that fell in a DST gap was pushed forward (02:30 -> 03:30 EDT),
    // so shifting that pushed wall time would miss the occurrence the moved rule generates on that date.
    const masterTimeOfDay = positiveModulo(oldStartWall, MS_PER_DAY);
    const nominalWall = (instantMs: number): number => {
        const wall = toEventWallClock(instantMs, master.timezone, master.allDay);
        const dayStart = wall - positiveModulo(wall, MS_PER_DAY);
        const candidates = [dayStart + masterTimeOfDay, dayStart - MS_PER_DAY + masterTimeOfDay];
        // An instant the rule couldn't have generated (e.g. a hand-edited exception) shifts by its own wall time.
        return candidates.find((candidate) => fromEventWallClock(candidate, master.timezone, master.allDay) === instantMs) ?? wall;
    };
    const shift = (instant: string) => new Date(fromEventWallClock(nominalWall(Date.parse(instant)) + deltaWallMs, newTimezone, newAllDay)).toISOString();

    const rule = fields.recurrenceRule ?? master.recurrenceRule;
    if (rule) {
        update.recurrenceRule = { ...rule, exceptions: rule.exceptions.map(shift) };
    }
    const saved = await updateCalendarEvent(update, client);

    let detachedOccurrenceSyncFailed = false;
    try {
        const detached = (await listCalendarEvents(master.folderUid, client)).filter(
            (event) => event.icalUid === master.icalUid && event.uid !== master.uid && event.recurrenceId,
        );
        for (const event of detached) {
            try {
                // `recurrenceId` isn't part of `CalendarEventInput`, but restapi's update accepts it (the same
                // way `detachOccurrence()` sends it on create).
                await updateCalendarEvent(
                    { uid: event.uid, version: event.version, recurrenceId: shift(event.recurrenceId!) } as UpdateCalendarEventInput,
                    client,
                );
            } catch {
                detachedOccurrenceSyncFailed = true;
            }
        }
    } catch {
        detachedOccurrenceSyncFailed = true;
    }
    return detachedOccurrenceSyncFailed ? { ...saved, detachedOccurrenceSyncFailed } : saved;
}

/**
 * Applies edited `fields` to just this one occurrence of a recurring event, detaching it into its own
 * standalone (non-recurring) event and excluding the original occurrence from the series.
 *
 * The detached event is created *first*, and only then is the original occurrence excluded from the
 * master — so a failure part-way never makes the occurrence silently disappear. If adding the
 * exception fails, the just-created detached event is deleted again (best-effort) and the original
 * error is rethrown. The detached event keeps the master's `icalUid` and records the occurrence's
 * original start as its `recurrenceId` (the RFC5545 way of identifying a modified instance), and never
 * carries the series' `recurrenceRule` — even if `fields` includes one (e.g. the event modal's full
 * field set).
 */
export async function detachOccurrence(
    occurrence: CalendarOccurrence,
    fields: Partial<CalendarEventInput>,
    client?: ApiClient,
): Promise<CalendarEvent> {
    const originalStart = occurrence.recurrenceId!;
    // `icalUid`/`recurrenceId` aren't part of `CalendarEventInput`, but `@rapidmx/restapi`'s
    // `CalendarEvent` model accepts both on create (and `createCalendarEvent` already sends `icalUid`).
    const input: CalendarEventInput & { icalUid: string; recurrenceId: string } = {
        mailboxUid: occurrence.mailboxUid,
        folderUid: occurrence.folderUid,
        title: occurrence.title,
        location: occurrence.location,
        startDate: occurrence.startDate,
        endDate: occurrence.endDate,
        allDay: occurrence.allDay,
        timezone: occurrence.timezone,
        organizer: occurrence.organizer,
        attendees: occurrence.attendees,
        status: occurrence.status,
        busyStatus: occurrence.busyStatus,
        reminderMinutesBeforeStart: occurrence.reminderMinutesBeforeStart,
        autoReplyEnabled: occurrence.autoReplyEnabled,
        autoReplyMessage: occurrence.autoReplyMessage,
        // A detached occurrence keeps what the series says about its description, visibility and guests (an absent value is the default).
        description: occurrence.description ?? undefined,
        descriptionHtml: occurrence.descriptionHtml ?? undefined,
        visibility: occurrence.visibility ?? undefined,
        guestsCanModify: occurrence.guestsCanModify ?? undefined,
        guestsCanInviteOthers: occurrence.guestsCanInviteOthers ?? undefined,
        guestsCanSeeGuestList: occurrence.guestsCanSeeGuestList ?? undefined,
        ...fields,
        recurrenceRule: undefined,
        icalUid: occurrence.icalUid,
        recurrenceId: originalStart,
    };
    const created = await createCalendarEvent(input, client);
    try {
        await addException(occurrence, originalStart, client);
    } catch (err) {
        await deleteCalendarEvent(created.uid, created.version, client).catch(() => undefined);
        throw err;
    }
    return created;
}

/** Deletes an entire recurring series (or a genuinely non-recurring event) outright. */
export function deleteEventSeries(occurrence: CalendarOccurrence, client?: ApiClient): Promise<void> {
    return deleteCalendarEvent(occurrence.uid, occurrence.version, client);
}

/** Removes just this one occurrence from a recurring series, leaving the rest of the series intact. */
export function deleteEventOccurrence(occurrence: CalendarOccurrence, client?: ApiClient): Promise<CalendarEvent> {
    return addException(occurrence, occurrence.recurrenceId!, client);
}

/**
 * Moves `occurrence` by `deltaMs` (drag-to-move on a grid), preserving its original duration. A
 * recurring occurrence is always detached into its own standalone event — matching Outlook's own
 * drag behavior, which never silently reschedules an entire series from a single dragged instance;
 * moving the whole series is only ever done explicitly, via the event modal's "entire series" option.
 */
export function moveOccurrence(occurrence: CalendarOccurrence, deltaMs: number, client?: ApiClient): Promise<CalendarEvent> {
    const fields = {
        startDate: new Date(new Date(occurrence.startDate).getTime() + deltaMs).toISOString(),
        endDate: new Date(new Date(occurrence.endDate).getTime() + deltaMs).toISOString(),
    };
    return occurrence.isRecurringOccurrence
        ? detachOccurrence(occurrence, fields, client)
        : updateCalendarEvent({ uid: occurrence.uid, version: occurrence.version, ...fields }, client);
}

/**
 * Resizes `occurrence`'s end time (drag-to-resize on a week/day grid), keeping its start fixed and
 * clamping to a 15-minute minimum duration so a resize can never invert start/end. Same
 * always-detaches-a-recurring-occurrence reasoning as `moveOccurrence` above.
 */
export function resizeOccurrenceEnd(occurrence: CalendarOccurrence, newEndDate: Date, client?: ApiClient): Promise<CalendarEvent> {
    const start = new Date(occurrence.startDate);
    const minEnd = new Date(start.getTime() + 15 * 60_000);
    const endDate = (newEndDate.getTime() > minEnd.getTime() ? newEndDate : minEnd).toISOString();
    return occurrence.isRecurringOccurrence
        ? detachOccurrence(occurrence, { endDate }, client)
        : updateCalendarEvent({ uid: occurrence.uid, version: occurrence.version, endDate }, client);
}
