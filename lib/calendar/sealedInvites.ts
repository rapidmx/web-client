///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The calendar files of zero-access messages, as decrypted on this device (`MessageSecurityResult.calendar`). The server holds only
 * the sealed copy of such a message, so every invitation call for it (`inviteApi.ts`) sends the file along. Kept in memory for the
 * messages read most recently, and cleared on sign-out (`clearSealedInvites()`).
 */

/** How many messages' calendar files are kept. */
const MAX_SEALED_INVITES = 100;

const calendars: Map<string, string> = new Map();

/** Remembers the decrypted calendar file of zero-access message `messageUid`. */
export function rememberSealedInvite(messageUid: string, ics: string): void {
    calendars.delete(messageUid);
    calendars.set(messageUid, ics);
    while (calendars.size > MAX_SEALED_INVITES) {
        calendars.delete(calendars.keys().next().value!);
    }
}

/** The decrypted calendar file of zero-access message `messageUid`, when this device has read it. */
export function sealedInviteCalendar(messageUid: string): string | undefined {
    return calendars.get(messageUid);
}

/** Forgets every remembered calendar file (sign-out). */
export function clearSealedInvites(): void {
    calendars.clear();
}
