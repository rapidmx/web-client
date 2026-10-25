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
            title: text(fields.title) ?? event.title,
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

/** `events` with every sealed one this device can open shown with its real title, location and description. Never rejects. */
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
            return fields ? { ...event, ...fields } : event;
        }),
    );
}

/** `openSealedEvents()` for one event. */
export async function openSealedEvent(event: CalendarEvent): Promise<CalendarEvent> {
    return (await openSealedEvents([event]))[0];
}

onSigningOut(clearSealedEvents);
