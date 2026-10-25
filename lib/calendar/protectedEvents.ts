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

/** `current`'s content with `changes` applied, for the server to invite with - `undefined` unless `current` is protected and was opened on
 * this device (its values are otherwise placeholders). */
export function invitationContentOf(current: CalendarEvent | undefined, changes: Record<string, unknown> = {}): InvitationContent | undefined {
    if (!isProtectedRecord(current) || !isOpenedRecord(current)) {
        return undefined;
    }
    const value = (field: (typeof EVENT_CONTENT_FIELDS)[number]): string => text(field in changes ? changes[field] : current![field]);
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
