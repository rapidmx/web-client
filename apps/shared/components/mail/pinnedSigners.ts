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
 *
 * **Explicit-client callers get their own cache**, a `WeakMap<ApiClient, Map<...>>` alongside the default
 * global-path `Map` - the same split `useMailboxUpdateAccess.ts` already uses, for the same reason: two
 * `tauri-client` accounts must never answer each other's "who does this sender's key belong to" question from
 * one shared cache keyed only by `mailboxUid` (mailbox uids are not guaranteed unique across accounts/servers).
 */
import {
    Contact,
    PINNED_FINGERPRINT_MAX_PAGES,
    PINNED_FINGERPRINT_PAGE_SIZE,
    SignerKeyState,
    listContacts,
    pinnedSigningFingerprintsFor,
    signerKeyStateFor,
} from "../../../../lib/contacts/contactsApi.js";
import { keyPinnedSince } from "../contacts/contactKeys.js";
import { listFolders } from "../../../../lib/mail/mailApi.js";
import { subscribeKeySession } from "../../../../lib/crypto/keySession.js";
import type { ApiClient } from "../../../../lib/util/api.js";

/** How long one mailbox's loaded contact list is reused before it is fetched again. */
export const CONTACTS_CACHE_TTL_MS = 60_000;

interface ContactsCacheEntry {
    loadedAt: number;
    contacts: Promise<Contact[]>;
}

const contactsCache = new Map<string, ContactsCacheEntry>();
const contactsCacheByClient = new WeakMap<ApiClient, Map<string, ContactsCacheEntry>>();

function cacheFor(client: ApiClient | undefined): Map<string, ContactsCacheEntry> {
    if (!client) {
        return contactsCache;
    }
    let cache = contactsCacheByClient.get(client);
    if (!cache) {
        cache = new Map();
        contactsCacheByClient.set(client, cache);
    }
    return cache;
}

/** Forgets every cached contact list for the default global path - on sign-out, a key-session lock, after the
 * reader changes their contacts, and in tests. Does not clear any explicit-client cache: those are scoped to
 * their own `ApiClient` and garbage-collected with it, with no shared "the app signed out" moment to clear on. */
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

async function loadMailboxContacts(mailboxUid: string, client: ApiClient | undefined): Promise<Contact[]> {
    const folders = await listFolders(mailboxUid, client);
    const contacts: Contact[] = [];
    for (const folder of folders.filter((f) => f.type === "contacts")) {
        for (let page = 0; page < PINNED_FINGERPRINT_MAX_PAGES; page++) {
            const batch = await listContacts(folder.uid, { limit: PINNED_FINGERPRINT_PAGE_SIZE, page }, client);
            contacts.push(...batch);
            if (batch.length < PINNED_FINGERPRINT_PAGE_SIZE) {
                break;
            }
        }
    }
    return contacts;
}

/** `mailboxUid`'s contacts, from the cache when fresh. Rejects if they can't be loaded. */
function cachedMailboxContacts(mailboxUid: string, client: ApiClient | undefined): Promise<Contact[]> {
    subscribeToLocksOnce();
    const cache = cacheFor(client);
    let entry = cache.get(mailboxUid);
    if (!entry || Date.now() - entry.loadedAt > CONTACTS_CACHE_TTL_MS) {
        const created = { loadedAt: Date.now(), contacts: loadMailboxContacts(mailboxUid, client) };
        cache.set(mailboxUid, created);
        created.contacts.catch(() => {
            if (cache.get(mailboxUid) === created) {
                cache.delete(mailboxUid);
            }
        });
        entry = created;
    }
    return entry.contacts;
}

/** The sender `address`'s pinned signing fingerprints from `mailboxUid`'s contacts. Rejects if they can't be loaded. */
export async function getPinnedSignerFingerprints(mailboxUid: string, address: string, client?: ApiClient): Promise<string[]> {
    return pinnedSigningFingerprintsFor(await cachedMailboxContacts(mailboxUid, client), address);
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
export async function getSignerKeyState(mailboxUid: string, address: string, client?: ApiClient): Promise<SenderKeyState> {
    const contacts = await cachedMailboxContacts(mailboxUid, client);
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
