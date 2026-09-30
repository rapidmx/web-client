///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Typed wrappers over `@rapidmx/restapi`'s `/mail/contacts` REST surface — see `mailApi.ts`'s own header
 * comment for the shared ACL/authorization model every wrapper file here follows. */

import { ApiClient, ApiRequestError, apiUrl, withClient, withCsrfHeader } from "../util/api.js";
import { ListParams, buildQuery } from "../util/apiQuery.js";
import {
    type EncryptionPreference,
    type KeyConflict,
    type PreviousKey,
    type PublicKey,
    type RejectedKey,
    signingKeyFingerprints,
} from "../crypto/keyvaultApi.js";

export type ContactAddressKind = "home" | "work" | "other";

export interface ContactEmail {
    address: string;
    type: ContactAddressKind;
}

export interface ContactPhone {
    phoneNumber: string;
    type: ContactAddressKind;
}

export interface ContactPostalAddress {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    type: ContactAddressKind;
}

export interface Contact {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    mailboxUid: string;
    folderUid: string;
    /** The `ContactList` (group) this contact belongs to, if any. */
    contactListUid?: string;
    displayName: string;
    givenName?: string;
    surname?: string;
    emails: ContactEmail[];
    phones: ContactPhone[];
    addresses: ContactPostalAddress[];
    company?: string;
    jobTitle?: string;
    notes?: string;
    photoBlobKey?: string;
    sourceUid?: string;
    /** Whether the caller has starred/favorited this contact. Absent is equivalent to `false`. */
    favorite?: boolean;
    /** Free-form category labels (Outlook-style colored categories) applied to this contact, if any. */
    categories?: string[];
    /** Present (and `true`) only when fetched via `listDeletedContacts()` — a soft-deleted `RecoverableBaseEntity`
     * record still exists server-side so it can be restored, per `@rapidmx/restapi`'s own soft-delete model. */
    deleted?: boolean;
    /** This contact's known encryption preference, per `specs/end-to-end_encryption.md` — discovered
     * via `crypto/keyvaultApi.ts`'s `lookupKeys()` at compose time, never fetched on message receipt
     * (that would leak read timing to the sender's server). */
    encryptPreference?: EncryptionPreference;
    /** This contact's pinned public keys. Trust is TOFU (trust-on-first-use) — see `keyConflicts` for what
     * happens when a newly observed key differs from one of these. */
    keys?: PublicKey[];
    /** Observed keys that conflict with the currently pinned key of the same `useType`, at most one per `useType` —
     * each blocks silent acceptance until the user resolves it (`keyvaultApi.ts`'s `resolveKeyConflict()`, the spec's
     * Key Conflict Handling). The pinned `keys` are retained unchanged while a conflict is set. */
    keyConflicts?: KeyConflict[];
    /** Keys that were pinned before and replaced (by the user accepting a conflict, or by restapi's automatic
     * same-issuer renewal of an expired or revoked key), newest first, at most 5 per `useType`. Signing keys here
     * still count as trusted signers — see `signingKeyFingerprints()`. */
    previousKeys?: PreviousKey[];
    /** Keys the user rejected when resolving a conflict. */
    rejectedKeys?: RejectedKey[];
}

/** Lists a folder's contacts, alphabetically by display name. Never includes soft-deleted contacts — see
 * `listDeletedContacts()` for those. */
export function listContacts(folderUid: string, params: ListParams = {}, client?: ApiClient): Promise<Contact[]> {
    return withClient(client, `/mail/contacts?${buildQuery(params, { folderUid, sort: JSON.stringify({ displayName: "ASC" }) })}`);
}

function contactsMatching(contacts: Contact[], address: string): Contact[] {
    const wanted = address.trim().toLowerCase();
    return contacts.filter((contact) => contact.emails.some((email) => email.address.trim().toLowerCase() === wanted));
}

/** The trusted signing-key fingerprints of every contact in `contacts` with an email equal (case-insensitively) to
 * `address`: each contact's pinned `keys` and its `previousKeys`, so mail signed before a key rotation still verifies -
 * see `keyvaultApi.ts`'s `signingKeyFingerprints()` for the rules (expired and superseded keys kept, compromised or reasonless revoked keys excluded). De-duplicated;
 * `[]` when no contact matches or none has a trusted signing key. */
export function pinnedSigningFingerprintsFor(contacts: Contact[], address: string): string[] {
    return [...new Set(contactsMatching(contacts, address).flatMap((contact) => signingKeyFingerprints(contact.keys, contact.previousKeys)))];
}

/** Page size and page cap for `fetchPinnedSigningFingerprints()` and `fetchSignerKeyState()` (500 is restapi's own
 * `limit` cap). */
export const PINNED_FINGERPRINT_PAGE_SIZE = 500;
export const PINNED_FINGERPRINT_MAX_PAGES = 20;

/** Every contact in `folderUids`, paged (`PINNED_FINGERPRINT_PAGE_SIZE`, at most `PINNED_FINGERPRINT_MAX_PAGES` pages
 * per folder). A plain contacts read - never a Discovery lookup. */
export async function listContactsInFolders(folderUids: string[], client?: ApiClient): Promise<Contact[]> {
    const contacts: Contact[] = [];
    for (const folderUid of folderUids) {
        for (let page = 0; page < PINNED_FINGERPRINT_MAX_PAGES; page++) {
            const batch = await listContacts(folderUid, { limit: PINNED_FINGERPRINT_PAGE_SIZE, page }, client);
            contacts.push(...batch);
            if (batch.length < PINNED_FINGERPRINT_PAGE_SIZE) {
                break;
            }
        }
    }
    return contacts;
}

/**
 * Fetches the trusted signing-key fingerprints (pinned and previous - see `pinnedSigningFingerprintsFor()`) for a
 * message sender's `address` from the contacts in `folderUids` (the reader's contacts folders), for
 * `evaluateMessageSecurity()`'s `pinnedSignerFingerprints`. Reads only what is already stored on the reader's own
 * contacts - never triggers a Discovery lookup, which must not happen on message receipt (it would leak read timing to
 * the sender's server). Pages through each folder (`PINNED_FINGERPRINT_PAGE_SIZE`, at most
 * `PINNED_FINGERPRINT_MAX_PAGES` pages per folder). A caller rendering many messages should cache the contact list and
 * use `pinnedSigningFingerprintsFor()` instead.
 */
export async function fetchPinnedSigningFingerprints(folderUids: string[], address: string, client?: ApiClient): Promise<string[]> {
    return pinnedSigningFingerprintsFor(await listContactsInFolders(folderUids, client), address);
}

/** A sender's stored signing-key state, for a key-changed comparison - see `signerKeyStateFor()`. */
export interface SignerKeyState {
    /** The currently pinned signing keys (every `useType: "sign"` key, revoked and expired ones included, so a UI can
     * show their dates and status), de-duplicated by fingerprint. */
    pinned: PublicKey[];
    /** Previously pinned signing keys, newest `replacedAt` first, de-duplicated by fingerprint. */
    previous: PreviousKey[];
    /** The first unresolved signing-key conflict found, if any. */
    conflict?: KeyConflict;
}

function uniqueByFingerprint<T extends PublicKey>(keys: T[]): T[] {
    const seen = new Set<string>();
    return keys.filter((key) => {
        const fingerprint = key.fingerprint.toLowerCase();
        if (seen.has(fingerprint)) {
            return false;
        }
        seen.add(fingerprint);
        return true;
    });
}

/** The signing-key state of every contact in `contacts` with an email equal (case-insensitively) to `address`, merged -
 * what a UI needs to compare a `signer_key_changed` message's certificate with the pinned and previous keys (their
 * fingerprints and `notBefore`/`notAfter`/`revokedAt`/`replacedAt` dates) before calling `resolveKeyConflict()`. Empty
 * `pinned`/`previous` and no `conflict` when no contact matches. */
export function signerKeyStateFor(contacts: Contact[], address: string): SignerKeyState {
    const matching = contactsMatching(contacts, address);
    const pinned = uniqueByFingerprint(matching.flatMap((contact) => (contact.keys ?? []).filter((key) => key.useType === "sign")));
    const previous = uniqueByFingerprint(
        matching.flatMap((contact) => (contact.previousKeys ?? []).filter((key) => key.useType === "sign")).sort((a, b) => b.replacedAt - a.replacedAt),
    );
    const conflict = matching.flatMap((contact) => contact.keyConflicts ?? []).find((entry) => entry.useType === "sign");
    return { pinned, previous, ...(conflict ? { conflict } : {}) };
}

/** Fetches `signerKeyStateFor()` for `address` from the contacts in `folderUids`, paging exactly like
 * `fetchPinnedSigningFingerprints()`. Reads only stored contacts - never triggers a Discovery lookup. */
export async function fetchSignerKeyState(folderUids: string[], address: string, client?: ApiClient): Promise<SignerKeyState> {
    return signerKeyStateFor(await listContactsInFolders(folderUids, client), address);
}

/**
 * Lists a folder's soft-deleted contacts
 (for an Outlook-style "Deleted" view) — `deleted` is an ordinary
 * queryable field on `Contact` (a `RecoverableBaseEntity`), so this is the same `find()` the plain listing
 * above uses, just constrained to `deleted: true` instead of the framework's own default of excluding them.
 *
 * Read-only for now — deliberately no `restoreContact()`: `@rapidmx/restapi`'s generic
 * `BaseScopedChildRoute.update()` looks the target record up via a plain `findOne()` with no
 * `includeDeleted` option, so it 404s on an already-deleted record before ever reaching the point where
 * setting `deleted: false` would matter. Restoring would need a real fix in `@rapidmx/restapi` itself
 * (passing `includeDeleted: true` into that lookup) — out of scope for this pass; the "Deleted" view here
 * is browse-only until that lands.
 */
export function listDeletedContacts(folderUid: string, params: ListParams = {}, client?: ApiClient): Promise<Contact[]> {
    return withClient(
        client,
        `/mail/contacts?${buildQuery(params, { folderUid, deleted: "true", sort: JSON.stringify({ displayName: "ASC" }) })}`,
    );
}

export function getContact(uid: string, client?: ApiClient): Promise<Contact> {
    return withClient(client, `/mail/contacts/${encodeURIComponent(uid)}`);
}

export interface ContactInput {
    mailboxUid: string;
    folderUid: string;
    contactListUid?: string;
    displayName: string;
    givenName?: string;
    surname?: string;
    emails?: ContactEmail[];
    phones?: ContactPhone[];
    addresses?: ContactPostalAddress[];
    company?: string;
    jobTitle?: string;
    notes?: string;
    favorite?: boolean;
    categories?: string[];
}

export function createContact(input: ContactInput, client?: ApiClient): Promise<Contact> {
    return withClient(client, "/mail/contacts", {
        method: "POST",
        body: JSON.stringify({ emails: [], phones: [], addresses: [], ...input }),
    });
}

export interface UpdateContactInput extends ContactInput {
    uid: string;
    version: number;
}

/** A minimal contact update: only `uid`/`version` are required, every other field is sent only if
 * present. The server merges just the fields in the body and rejects server-managed ones
 * (`dateCreated`/`dateModified`/etc.), so prefer sending only what actually changed over a whole
 * fetched `Contact`. An `UpdateContactInput` is also a valid `ContactPatch`. */
export type ContactPatch = Partial<Contact> & Pick<Contact, "uid" | "version">;

export function updateContact(patch: ContactPatch, client?: ApiClient): Promise<Contact> {
    return withClient(client, `/mail/contacts/${encodeURIComponent(patch.uid)}`, {
        method: "PUT",
        body: JSON.stringify(patch),
    });
}

/** Thin `updateContact()` wrapper for toggling favorite/star status — same pattern as `mailApi.ts`'s
 * `setMessageRead()`/`tasksApi.ts`'s `setTaskCompleted()`. Sends only `uid`/`version`/`favorite`, never
 * the rest of `contact` (the server rejects its managed fields). */
export function setContactFavorite(contact: Contact, favorite: boolean, client?: ApiClient): Promise<Contact> {
    return updateContact({ uid: contact.uid, version: contact.version, favorite }, client);
}

/**
 * The URL of a contact's own picture, or `undefined` when they have none. The version is part of it so a replaced picture is fetched again rather than
 * served from the browser's cache.
 */
export function contactPhotoUrl(contact: Pick<Contact, "uid" | "version" | "photoBlobKey">): string | undefined {
    return contact.photoBlobKey ? apiUrl(`/mail/contacts/${encodeURIComponent(contact.uid)}/photo?v=${contact.version}`) : undefined;
}

/** The picture types the server accepts for a contact, and the most bytes it takes. */
export const CONTACT_PHOTO_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
export const CONTACT_PHOTO_MAX_BYTES = 1024 * 1024;

/** Sets a contact's own picture from an image file (the file's own bytes go up, not JSON) and returns the updated contact. */
export async function uploadContactPhoto(uid: string, version: number, file: Blob): Promise<Contact> {
    const res = await fetch(apiUrl(`/mail/contacts/${encodeURIComponent(uid)}/photo?version=${version}`), {
        method: "PUT",
        credentials: "include",
        headers: withCsrfHeader({ "Content-Type": file.type }, "PUT"),
        body: file,
    });
    const contentType = res.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await res.json().catch(() => undefined) : undefined;
    if (!res.ok) {
        throw new ApiRequestError((body && (body.message || body.error)) || res.statusText || "Upload failed.", res.status, body?.code);
    }
    return body as Contact;
}

/** Removes a contact's own picture and returns the updated contact. */
export function deleteContactPhoto(uid: string, version: number, client?: ApiClient): Promise<Contact> {
    return withClient(client, `/mail/contacts/${encodeURIComponent(uid)}/photo?version=${version}`, { method: "DELETE" });
}

export function deleteContact(uid: string, version: number, client?: ApiClient): Promise<void> {
    return withClient(client, `/mail/contacts/${encodeURIComponent(uid)}?version=${version}`, { method: "DELETE" });
}

export interface ContactList {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    mailboxUid: string;
    name: string;
}

/** Lists a mailbox's contact lists (Outlook-style "Your contact lists"), alphabetically by name. */
export function listContactLists(mailboxUid: string, params: ListParams = {}, client?: ApiClient): Promise<ContactList[]> {
    return withClient(client, `/mail/contact-lists?${buildQuery(params, { mailboxUid, sort: JSON.stringify({ name: "ASC" }) })}`);
}

export function createContactList(input: { mailboxUid: string; name: string }, client?: ApiClient): Promise<ContactList> {
    return withClient(client, "/mail/contact-lists", { method: "POST", body: JSON.stringify(input) });
}

export function updateContactList(
    input: { uid: string; version: number; name: string },
    client?: ApiClient,
): Promise<ContactList> {
    return withClient(client, `/mail/contact-lists/${encodeURIComponent(input.uid)}`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

export function deleteContactList(uid: string, version: number, client?: ApiClient): Promise<void> {
    return withClient(client, `/mail/contact-lists/${encodeURIComponent(uid)}?version=${version}`, { method: "DELETE" });
}
