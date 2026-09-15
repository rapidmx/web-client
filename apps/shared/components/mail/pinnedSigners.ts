///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The trusted signing-key fingerprints for a received message's sender, for `evaluateMessageSecurity()`'s
 * `pinnedSignerFingerprints`: the keys key discovery already pinned on the contacts in the reading mailbox's own
 * contacts folder(s). Reads only stored contacts - never triggers a Discovery lookup, which must not happen on
 * message receipt.
 *
 * `MessageDetailPane` renders once per opened message (and once per message in a thread), so each mailbox's
 * contact list is fetched once and reused for `CONTACTS_CACHE_TTL_MS`; a failed load isn't cached. Any failure
 * leaves the caller with no pins, which `evaluateMessageSecurity()` reports as an unverified signer - never as
 * verified.
 *
 * The cache is dropped (`clearPinnedSignerCache()`) whenever a key session locks (subscribed on first use), on sign-out
 * (`AppShell`), and after the reader adds, edits or deletes contacts (the contacts pages) - so a contact removed
 * because its key was revoked doesn't keep vouching for signatures until the TTL runs out.
 */
import {
    Contact,
    PINNED_FINGERPRINT_MAX_PAGES,
    PINNED_FINGERPRINT_PAGE_SIZE,
    SignerKeyState,
    listContacts,
    pinnedSigningFingerprintsFor,
    signerKeyStateFor,
} from "@rapidmx/react-shared/contacts/contactsApi.js";
import { keyPinnedSince } from "../contacts/contactKeys.js";
import { listFolders } from "@rapidmx/react-shared/mail/mailApi.js";
import { subscribeKeySession } from "@rapidmx/react-shared/crypto/keySession.js";

/** How long one mailbox's loaded contact list is reused before it is fetched again. */
export const CONTACTS_CACHE_TTL_MS = 60_000;

const contactsCache = new Map<string, { loadedAt: number; contacts: Promise<Contact[]> }>();

/** Forgets every cached contact list - on sign-out, a key-session lock, after the reader changes their contacts, and
 * in tests. */
export function clearPinnedSignerCache(): void {
    contactsCache.clear();
}

let lockSubscribed = false;

/** Subscribes (once, lazily - a module-level subscription would run in every page that merely imports this) to key
 * session changes, clearing the cache whenever any mailbox's keys are locked. */
function subscribeToLocksOnce(): void {
    if (lockSubscribed) {
        return;
    }
    lockSubscribed = true;
    subscribeKeySession((event) => {
        if (event.state === "locked") {
            clearPinnedSignerCache();
        }
    });
}

async function loadMailboxContacts(mailboxUid: string): Promise<Contact[]> {
    const folders = await listFolders(mailboxUid);
    const contacts: Contact[] = [];
    for (const folder of folders.filter((f) => f.type === "contacts")) {
        for (let page = 0; page < PINNED_FINGERPRINT_MAX_PAGES; page++) {
            const batch = await listContacts(folder.uid, { limit: PINNED_FINGERPRINT_PAGE_SIZE, page });
            contacts.push(...batch);
            if (batch.length < PINNED_FINGERPRINT_PAGE_SIZE) {
                break;
            }
        }
    }
    return contacts;
}

/** `mailboxUid`'s contacts, from the cache when fresh. Rejects if they can't be loaded. */
function cachedMailboxContacts(mailboxUid: string): Promise<Contact[]> {
    subscribeToLocksOnce();
    let entry = contactsCache.get(mailboxUid);
    if (!entry || Date.now() - entry.loadedAt > CONTACTS_CACHE_TTL_MS) {
        const created = { loadedAt: Date.now(), contacts: loadMailboxContacts(mailboxUid) };
        contactsCache.set(mailboxUid, created);
        created.contacts.catch(() => {
            if (contactsCache.get(mailboxUid) === created) {
                contactsCache.delete(mailboxUid);
            }
        });
        entry = created;
    }
    return entry.contacts;
}

/** The sender `address`'s pinned signing fingerprints from `mailboxUid`'s contacts. Rejects if they can't be loaded. */
export async function getPinnedSignerFingerprints(mailboxUid: string, address: string): Promise<string[]> {
    return pinnedSigningFingerprintsFor(await cachedMailboxContacts(mailboxUid), address);
}

/** A sender's signing-key state (`signerKeyStateFor()`) plus what a key-changed notice needs to show and link. */
export interface SenderKeyState extends SignerKeyState {
    /** The contact holding the first pinned signing key, else the one holding the conflict, else the first match. */
    contactUid?: string;
    /** When the first pinned signing key started being trusted - see `keyPinnedSince()`. */
    pinnedSince?: number;
}

/** The sender `address`'s signing-key state from `mailboxUid`'s (cached) contacts, for a "signing key changed" comparison
 * or to spot a recorded conflict. Reads stored contacts only. Rejects if they can't be loaded. */
export async function getSignerKeyState(mailboxUid: string, address: string): Promise<SenderKeyState> {
    const contacts = await cachedMailboxContacts(mailboxUid);
    const state = signerKeyStateFor(contacts, address);
    const wanted = address.trim().toLowerCase();
    const matching = contacts.filter((contact) => contact.emails.some((email) => email.address.trim().toLowerCase() === wanted));
    // `signerKeyStateFor()` keeps the contacts' own key objects, so the holder is found by identity.
    const pinned = state.pinned[0];
    const holder = matching.find((candidate) => (candidate.keys ?? []).includes(pinned));
    const contact =
        holder ??
        matching.find((candidate) => (candidate.keyConflicts ?? []).some((conflict) => conflict.useType === "sign")) ??
        matching[0];
    return {
        ...state,
        ...(contact ? { contactUid: contact.uid } : {}),
        ...(holder ? { pinnedSince: keyPinnedSince(holder, pinned) } : {}),
    };
}
