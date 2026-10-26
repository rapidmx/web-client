///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Calendar events the server made from invitations that reached a zero-access mailbox keep their title, location and description only
 * sealed to the mailbox's zero-access key (`CalendarEvent.sealedContent`; the row's `title` is `[...]`). These are opened here with the
 * mailbox's unlocked keys so the calendar shows the real ones; while the mailbox is locked the event keeps its placeholder. The
 * decryption code is loaded only when a sealed event is actually seen.
 */
import type { CalendarEvent } from "../../../lib/calendar/calendarApi.js";
import { getUnlockedKeys, subscribeKeySession } from "../../../lib/crypto/keySession.js";
import { fromBase64 } from "../../../lib/crypto/encoding.js";
import { markSealedContentOpened } from "../../../lib/calendar/protectedEvents.js";
import { onSigningOut } from "../components/mail/compose/composeFlushRegistry.js";

/** What `sealedContent.sealed` decrypts to. */
interface SealedEventFields {
    title?: unknown;
    location?: unknown;
    description?: unknown;
    descriptionHtml?: unknown;
}

/** Opened fields by sealed text - the same sealed content always opens to the same fields. Cleared with `clearSealedEvents()`. */
const opened: Map<string, Partial<CalendarEvent>> = new Map();

/** Forgets every opened event (a mailbox locking, sign-out, or the test seam). */
export function clearSealedEvents(): void {
    opened.clear();
}

let watchingKeys = false;

/** Opened fields go when keys are locked, so nothing opened outlives its key session. Subscribed when the first sealed event is seen,
 * not on import. */
function forgetOnLock(): void {
    if (watchingKeys) {
        return;
    }
    watchingKeys = true;
    subscribeKeySession((event) => {
        if (event.state === "locked") {
            clearSealedEvents();
        }
    });
}

async function openFields(event: CalendarEvent): Promise<Partial<CalendarEvent> | undefined> {
    const sealed: string = event.sealedContent!.sealed;
    // Checked before the cache: a locked mailbox's events show their placeholders, whatever was opened before.
    const keys = getUnlockedKeys(event.mailboxUid)?.zeroAccessKeys;
    if (!keys?.length) {
        return undefined;
    }
    const known = opened.get(sealed);
    if (known) {
        return known;
    }
    try {
        const { decryptEnvelopedDataWithKeys } = await import("../../../lib/crypto/smime.js");
        const fields = JSON.parse(new TextDecoder().decode(await decryptEnvelopedDataWithKeys(fromBase64(sealed), keys))) as SealedEventFields;
        const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
        const result: Partial<CalendarEvent> = {
            // An empty sealed title is no title: a newer revision without SUMMARY over a row that keeps its title sealed field by field
            // (`sealedFields.title`) is sealed with an empty one, and the title opened from that copy (or the row's own) shows instead.
            // Left out here, not copied from `event`, as the cache is shared by every row with this sealed content.
            ...(text(fields.title) ? { title: text(fields.title) } : {}),
            location: text(fields.location),
            description: text(fields.description) ?? null,
            descriptionHtml: text(fields.descriptionHtml) ?? null,
        };
        // The mailbox locked while this was opened: the lock's clear has already run, so it is neither kept nor shown.
        if (!getUnlockedKeys(event.mailboxUid)) {
            return undefined;
        }
        opened.set(sealed, result);
        return result;
    } catch {
        return undefined;
    }
}

/** `events` with every sealed one this device can open shown with its real title, location and description (and marked opened,
 * `isSealedContentOpened()`). Never rejects. */
export async function openSealedEvents(events: CalendarEvent[]): Promise<CalendarEvent[]> {
    if (!events.some((event) => event.sealedContent)) {
        return events;
    }
    forgetOnLock();
    return Promise.all(
        events.map(async (event) => {
            if (!event.sealedContent) {
                return event;
            }
            const fields = await openFields(event);
            if (!fields) {
                return event;
            }
            // Marked, so a reply or change request names it by its real title (`invitationContentOf()`). An empty sealed title with no
            // per-field copy to show instead (an invitation without SUMMARY) is an untitled event: opened, it never shows the row's `[...]`.
            const untitled = fields.title === undefined && !event.sealedFields?.title ? { title: "" } : {};
            return markSealedContentOpened({ ...event, ...fields, ...untitled });
        }),
    );
}

/** `openSealedEvents()` for one event. */
export async function openSealedEvent(event: CalendarEvent): Promise<CalendarEvent> {
    return (await openSealedEvents([event]))[0];
}

onSigningOut(clearSealedEvents);
