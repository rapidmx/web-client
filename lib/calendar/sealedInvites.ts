///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The calendar files of zero-access messages, as decrypted on this device (`MessageSecurityResult.calendar`). The server holds only
 * the sealed copy of such a message, so every invitation call for it (`inviteApi.ts`) sends the file along. Kept in memory for the
 * messages read most recently, only while their mailbox is unlocked: its lock forgets them (telling `onSealedInvitesForgotten()`
 * listeners, so what was read with them goes too), and so does sign-out (`clearSealedInvites()`).
 */
import { getUnlockedKeys, subscribeKeySession } from "../crypto/keySession.js";

/** How many messages' calendar files are kept. */
const MAX_SEALED_INVITES = 100;

const calendars: Map<string, { mailboxUid: string; ics: string }> = new Map();
const forgottenListeners = new Set<(messageUids: string[]) => void>();

let watchingKeys = false;

/** A mailbox's files go the moment it locks, so nothing opened outlives its key session. Subscribed on the first file, not on import. */
function forgetOnLock(): void {
    if (watchingKeys) {
        return;
    }
    watchingKeys = true;
    subscribeKeySession(({ mailboxUid, state }) => {
        if (state !== "locked") {
            return;
        }
        const forgotten: string[] = [];
        for (const [messageUid, entry] of calendars) {
            if (entry.mailboxUid === mailboxUid) {
                calendars.delete(messageUid);
                forgotten.push(messageUid);
            }
        }
        if (forgotten.length) {
            forgottenListeners.forEach((listener) => listener(forgotten));
        }
    });
}

/** Remembers the decrypted calendar file of zero-access message `messageUid` of `mailboxUid` - not while that mailbox is locked (a
 * pane still drawing what it decrypted before the lock). */
export function rememberSealedInvite(messageUid: string, ics: string, mailboxUid: string): void {
    if (!getUnlockedKeys(mailboxUid)) {
        return;
    }
    forgetOnLock();
    calendars.delete(messageUid);
    calendars.set(messageUid, { mailboxUid, ics });
    while (calendars.size > MAX_SEALED_INVITES) {
        calendars.delete(calendars.keys().next().value!);
    }
}

/** The decrypted calendar file of zero-access message `messageUid`, when this device has read it and its mailbox is unlocked. */
export function sealedInviteCalendar(messageUid: string): string | undefined {
    const entry = calendars.get(messageUid);
    return entry && getUnlockedKeys(entry.mailboxUid) ? entry.ics : undefined;
}

/** Calls `listener` with the messages whose files a mailbox's lock forgot. Returns the unsubscribe. */
export function onSealedInvitesForgotten(listener: (messageUids: string[]) => void): () => void {
    forgottenListeners.add(listener);
    return () => forgottenListeners.delete(listener);
}

/** Forgets every remembered calendar file (sign-out). */
export function clearSealedInvites(): void {
    calendars.clear();
}
