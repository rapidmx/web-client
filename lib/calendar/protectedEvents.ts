///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Writes to an event of a calendar zero-access encryption protects (restapi `specs/search.md` §3 *What It Covers*, *Calendar invitations*).
 * The server stores its title, location and description sealed, with placeholders in their place, so it can't tell what changed or invite
 * with them by itself. A write therefore sends only the content fields that differ from what this device shows, and - when the event was
 * opened here - the whole content as `invitationContent`, which the server invites with and never stores. A content field of an opened
 * event that held a value and is emptied is named in `clearedFields`, the only way restapi applies an empty sealed field as a clear.
 */
import type { CalendarEvent } from "./calendarApi.js";
import { isOpenedRecord, isProtectedRecord } from "../zeroAccess/sealedRecords.js";
import { KeysLockedError } from "../crypto/masterKey.js";

/** The fields zero-access encryption seals on an event. */
export const EVENT_CONTENT_FIELDS = ["title", "location", "description", "descriptionHtml"] as const;

/** What the server composes a protected event's invitations with. */
export interface InvitationContent {
    title: string;
    location?: string;
    description?: string;
    descriptionHtml?: string;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Set on an event made from a zero-access invitation (`sealedContent`) whose sealed content was opened on this device
 * (`apps/shared/calendar/sealedEvents.ts`). A symbol, so it survives a spread copy (an occurrence) and is never sent. */
const CONTENT_OPENED = Symbol("openedSealedContent");

/** `event` marked as holding its opened `sealedContent` (its real title, location and description). */
export function markSealedContentOpened<T extends CalendarEvent>(event: T): T {
    return { ...event, [CONTENT_OPENED]: true };
}

/** Whether `event`'s `sealedContent` was opened on this device: its title, location and description are the real ones. */
export function isSealedContentOpened(event: CalendarEvent | undefined): boolean {
    return !!event && (event as any)[CONTENT_OPENED] === true;
}

/** Whether `event` shows its real content: nothing of it is sealed, or every sealed part (`sealedFields`, `sealedContent`) was opened. */
function shownOpened(event: CalendarEvent): boolean {
    return (!isProtectedRecord(event) || isOpenedRecord(event)) && (!event.sealedContent || isSealedContentOpened(event));
}

/** `current`'s content with `changes` applied, for the server to invite (or name a reply or change request) with - `undefined` unless
 * `current` is protected (`sealedFields`) or made from a zero-access invitation (`sealedContent`) and was opened on this device (its values
 * are otherwise placeholders). */
export function invitationContentOf(current: CalendarEvent | undefined, changes: Record<string, unknown> = {}): InvitationContent | undefined {
    if (!current || !(isProtectedRecord(current) || current.sealedContent) || !shownOpened(current)) {
        return undefined;
    }
    const value = (field: (typeof EVENT_CONTENT_FIELDS)[number]): string => text(field in changes ? changes[field] : current[field]);
    const title = value("title");
    if (!title) {
        return undefined;
    }
    const optional = (field: (typeof EVENT_CONTENT_FIELDS)[number]): string | undefined => value(field) || undefined;
    return { title, location: optional("location"), description: optional("description"), descriptionHtml: optional("descriptionHtml") };
}

/**
 * `input` as written to `current`: unchanged when `current` isn't protected. Otherwise without the content fields whose values `current`
 * already shows (a placeholder is "unchanged" too, so a locked device's write never overwrites the sealed value), and with
 * `invitationContent` when `current` was opened - and `clearedFields` naming the sealed ones it empties.
 */
export function protectedEventWrite<T extends object>(current: CalendarEvent | undefined, input: T): T {
    if (current?.sealedContent) {
        return sealedContentWrite(current, input);
    }
    if (!isProtectedRecord(current)) {
        return input;
    }
    const changes: Record<string, unknown> = { ...(input as Record<string, unknown>) };
    const clearedFields: string[] = [];
    for (const field of EVENT_CONTENT_FIELDS) {
        if (!(field in changes)) {
            continue;
        }
        if (text(changes[field]) === text(current![field])) {
            delete changes[field];
        } else if (!text(changes[field]) && current!.sealedFields![field] !== undefined && isOpenedRecord(current)) {
            clearedFields.push(field);
        }
    }
    if (clearedFields.length > 0) {
        changes.clearedFields = clearedFields;
    }
    const invitationContent = invitationContentOf(current, changes);
    return (invitationContent ? { ...changes, invitationContent } : changes) as T;
}

/**
 * `input` as written to `current`, an event made from a zero-access invitation (`sealedContent`). restapi seals its whole content again
 * from the content fields a write sends (`BaseCalendarEventRoute.keepSealed()`), dropping one the write leaves out, since it can't read the
 * sealed value to keep it. So a write that sends any of them sends them all: those it leaves out (the event dialog sends an unchanged
 * description not at all) are filled in with what `current` shows opened - the description and its HTML as one, as the dialog sends them.
 * This holds too for a row that also keeps its title sealed field by field (`sealedFields.title`), whose sealed content's title is empty.
 * Shown with placeholders (its mailbox is locked), the placeholders it would send back are left out, so nothing is sealed again, and a
 * changed content field is refused (`KeysLockedError`) before anything is sent: the rest of the content can't be sent with it. Opened, a
 * write whose location, description or description HTML differs from the one shown raises `sequence` past `current`'s, the only way
 * restapi learns it changed.
 */
function sealedContentWrite<T extends object>(current: CalendarEvent, input: T): T {
    const given = input as Record<string, unknown>;
    if (!EVENT_CONTENT_FIELDS.some((field) => given[field] !== undefined)) {
        return input;
    }
    const changes: Record<string, unknown> = { ...given };
    if (!shownOpened(current)) {
        for (const field of EVENT_CONTENT_FIELDS) {
            if (field in changes && text(changes[field]) === text(current[field])) {
                delete changes[field];
            }
        }
        if (EVENT_CONTENT_FIELDS.some((field) => changes[field] !== undefined)) {
            throw new KeysLockedError("This event is protected and your mailbox is locked. Unlock it to change its title, location or description.");
        }
        return changes as T;
    }
    for (const field of ["title", "location"] as const) {
        if (changes[field] === undefined) {
            changes[field] = current[field] ?? null;
        }
    }
    if (changes.description === undefined && changes.descriptionHtml === undefined) {
        changes.description = current.description ?? null;
        changes.descriptionHtml = current.descriptionHtml ?? null;
    }
    // restapi can't compare a location or description sealed whole (it holds placeholders), so a real change raises the sequence here: an
    // organizer-owned meeting then invites again, as for a readable event's new location or description. A description field the write
    // doesn't send is compared no more than restapi compares it for a readable event. An unchanged one leaves it alone.
    const descriptionChanged = (["description", "descriptionHtml"] as const).some(
        (field) => changes[field] !== undefined && text(changes[field]) !== text(current[field])
    );
    if (descriptionChanged || text(changes.location) !== text(current.location)) {
        changes.sequence = (current.sequence ?? 0) + 1;
    }
    const invitationContent = isProtectedRecord(current) ? invitationContentOf(current, changes) : undefined;
    return (invitationContent ? { ...changes, invitationContent } : changes) as T;
}
