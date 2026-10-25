///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Recipient suggestions that include contacts zero-access encryption protects. Their names are sealed (restapi `specs/search.md` §3 *What
 * It Covers*), so the server's contact search finds them only by address; this matches their opened names on the device and puts them
 * first. Names are opened only - never the rest of a contact - and kept for ten minutes, and only while the mailbox is unlocked: its lock
 * (and signing out) forgets them, as does a search that finds it locked. Reading them never holds up the server's suggestions: what isn't read by the time those arrive (plus
 * `PROTECTED_NAMES_WAIT_MS`) is left to the next keystroke.
 */
import { type Contact, listContacts, PINNED_FINGERPRINT_PAGE_SIZE } from "../../../../../lib/contacts/contactsApi.js";
import { getUnlockedKeys, subscribeKeySession } from "../../../../../lib/crypto/keySession.js";
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
import { onSigningOut } from "./composeFlushRegistry.js";

/** How long a mailbox's protected contact names are kept: reading them is a crawl of the whole address book. */
export const PROTECTED_NAMES_TTL_MS = 10 * 60_000;

/** How long suggestions wait, once the server's have arrived, for the protected contacts still being read. */
export const PROTECTED_NAMES_WAIT_MS = 250;

/** At most this many contacts are read per contacts folder. */
const MAX_PAGES = 20;

const cache = new Map<string, { loadedAt: number; contacts: Promise<Contact[]> }>();

/** Forgets every mailbox's names (signing out, or the test seam). */
export function clearProtectedContactNames(): void {
    cache.clear();
}

onSigningOut(clearProtectedContactNames);

let watchingKeys = false;

/** A mailbox's names go the moment it locks, so nothing opened outlives its key session. Subscribed with the first crawl, not on import. */
function forgetOnLock(): void {
    if (watchingKeys) {
        return;
    }
    watchingKeys = true;
    subscribeKeySession(({ mailboxUid, state }) => {
        if (state === "locked") {
            cache.delete(mailboxUid);
        }
    });
}

/** `mailboxUid`'s protected contacts with their names opened. */
async function loadProtectedContacts(mailboxUid: string, client: ApiClient | undefined): Promise<Contact[]> {
    const found: Contact[] = [];
    // The folders side by side, each one's pages in turn.
    await Promise.all(
        (await listFolders(mailboxUid, client))
            .filter((f) => f.type === "contacts")
            .map(async (folder) => {
                for (let page = 0; page < MAX_PAGES; page++) {
                    const batch = await listContacts(folder.uid, { limit: PINNED_FINGERPRINT_PAGE_SIZE, page }, client);
                    found.push(...batch.filter((contact) => isProtectedRecord(contact)));
                    if (batch.length < PINNED_FINGERPRINT_PAGE_SIZE) {
                        break;
                    }
                }
            }),
    );
    return openSealedRecords(found, ["displayName"]);
}

function protectedContacts(mailboxUid: string, client: ApiClient | undefined): Promise<Contact[]> {
    let entry = cache.get(mailboxUid);
    if (!entry || Date.now() - entry.loadedAt > PROTECTED_NAMES_TTL_MS) {
        forgetOnLock();
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

/** `fetchRecipientSuggestions()` with the composing mailbox's protected contacts matched by name on the device, first - those read by the
 * time the server's suggestions are in (plus `PROTECTED_NAMES_WAIT_MS`): a first search of a large address book shows the server's alone
 * rather than waiting for the crawl, which goes on for the next keystroke. A failure to read them only leaves them out. */
export async function fetchSuggestionsWithProtectedContacts(
    query: string,
    options: ContactSuggestionOptions = {},
    client?: ApiClient,
): Promise<RecipientSuggestion[]> {
    const local: Promise<RecipientSuggestion[]> = options.mailboxUid ? searchProtectedContactNames(options.mailboxUid, query, client).catch(() => []) : Promise.resolve([]);
    const server = await fetchRecipientSuggestions(query, options, client);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = await Promise.race([local, new Promise<RecipientSuggestion[]>((resolve) => (timer = setTimeout(() => resolve([]), PROTECTED_NAMES_WAIT_MS)))]);
    clearTimeout(timer);
    return mergeRecipientSuggestions(ready, server, options.limit ?? RECIPIENT_SUGGESTION_DEFAULT_LIMIT);
}
