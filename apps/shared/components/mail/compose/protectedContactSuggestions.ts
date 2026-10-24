///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Recipient suggestions that include contacts zero-access encryption protects. Their names are sealed (restapi `specs/search.md` §3 *What
 * It Covers*), so the server's contact search finds them only by address; this matches their opened names on the device and puts them
 * first. Names are opened only - never the rest of a contact - and kept for a minute, and only while the mailbox is unlocked: a search of a
 * locked mailbox forgets them.
 */
import { type Contact, listContacts, PINNED_FINGERPRINT_PAGE_SIZE } from "../../../../../lib/contacts/contactsApi.js";
import { getUnlockedKeys } from "../../../../../lib/crypto/keySession.js";
import {
    type ContactSuggestionOptions,
    fetchRecipientSuggestions,
    mergeRecipientSuggestions,
    RECIPIENT_SUGGESTION_DEFAULT_LIMIT,
    type RecipientSuggestion,
} from "../../../../../lib/mail/directoryApi.js";
import { listFolders } from "../../../../../lib/mail/mailApi.js";
import type { ApiClient } from "../../../../../lib/util/api.js";
import { isProtectedRecord, openSealedRecords } from "../../../../../lib/zeroAccess/sealedRecords.js";

/** How long a mailbox's protected contact names are kept. */
export const PROTECTED_NAMES_TTL_MS = 60_000;

/** At most this many contacts are read per contacts folder. */
const MAX_PAGES = 20;

const cache = new Map<string, { loadedAt: number; contacts: Promise<Contact[]> }>();

/** Forgets every mailbox's names (a mailbox locking, or the test seam). */
export function clearProtectedContactNames(): void {
    cache.clear();
}

/** `mailboxUid`'s protected contacts with their names opened. */
async function loadProtectedContacts(mailboxUid: string, client: ApiClient | undefined): Promise<Contact[]> {
    const found: Contact[] = [];
    for (const folder of (await listFolders(mailboxUid, client)).filter((f) => f.type === "contacts")) {
        for (let page = 0; page < MAX_PAGES; page++) {
            const batch = await listContacts(folder.uid, { limit: PINNED_FINGERPRINT_PAGE_SIZE, page }, client);
            found.push(...batch.filter((contact) => isProtectedRecord(contact)));
            if (batch.length < PINNED_FINGERPRINT_PAGE_SIZE) {
                break;
            }
        }
    }
    return openSealedRecords(found, ["displayName"]);
}

function protectedContacts(mailboxUid: string, client: ApiClient | undefined): Promise<Contact[]> {
    let entry = cache.get(mailboxUid);
    if (!entry || Date.now() - entry.loadedAt > PROTECTED_NAMES_TTL_MS) {
        const created = { loadedAt: Date.now(), contacts: loadProtectedContacts(mailboxUid, client) };
        created.contacts.catch(() => cache.delete(mailboxUid));
        cache.set(mailboxUid, created);
        entry = created;
    }
    return entry.contacts;
}

/** Every address of the protected contacts of `mailboxUid` whose opened name contains `query` (case-insensitively). */
export async function searchProtectedContactNames(mailboxUid: string, query: string, client?: ApiClient): Promise<RecipientSuggestion[]> {
    const wanted = query.trim().toLowerCase();
    if (wanted.length < 2) {
        return [];
    }
    if (!getUnlockedKeys(mailboxUid)?.zeroAccessKeys?.length) {
        // Locked: nothing opened is kept, and nothing could be opened now.
        cache.delete(mailboxUid);
        return [];
    }
    return (await protectedContacts(mailboxUid, client))
        .filter((contact) => contact.displayName.toLowerCase().includes(wanted))
        .flatMap((contact) => contact.emails.map((email) => ({ displayName: contact.displayName, address: email.address, kind: "contact" as const })));
}

/** `fetchRecipientSuggestions()` with the composing mailbox's protected contacts matched by name on the device, first. A failure to read
 * them only leaves them out. */
export async function fetchSuggestionsWithProtectedContacts(
    query: string,
    options: ContactSuggestionOptions = {},
    client?: ApiClient,
): Promise<RecipientSuggestion[]> {
    const [server, local] = await Promise.all([
        fetchRecipientSuggestions(query, options, client),
        options.mailboxUid ? searchProtectedContactNames(options.mailboxUid, query, client).catch(() => []) : Promise.resolve([]),
    ]);
    return mergeRecipientSuggestions(local, server, options.limit ?? RECIPIENT_SUGGESTION_DEFAULT_LIMIT);
}
