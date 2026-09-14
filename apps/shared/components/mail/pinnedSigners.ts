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
 */
import {
    Contact,
    PINNED_FINGERPRINT_MAX_PAGES,
    PINNED_FINGERPRINT_PAGE_SIZE,
    listContacts,
    pinnedSigningFingerprintsFor,
} from "@rapidmx/react-shared/contacts/contactsApi.js";
import { listFolders } from "@rapidmx/react-shared/mail/mailApi.js";

/** How long one mailbox's loaded contact list is reused before it is fetched again. */
export const CONTACTS_CACHE_TTL_MS = 60_000;

const contactsCache = new Map<string, { loadedAt: number; contacts: Promise<Contact[]> }>();

/** Forgets every cached contact list - for tests, and after the reader changes their contacts. */
export function clearPinnedSignerCache(): void {
    contactsCache.clear();
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

/** The sender `address`'s pinned signing fingerprints from `mailboxUid`'s contacts. Rejects if they can't be loaded. */
export async function getPinnedSignerFingerprints(mailboxUid: string, address: string): Promise<string[]> {
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
    return pinnedSigningFingerprintsFor(await entry.contacts, address);
}
