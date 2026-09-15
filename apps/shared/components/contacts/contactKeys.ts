///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Display and error helpers for a contact's pinned keys and key changes (`KeyChangeReview`, `ContactDetailPane`,
 * `MessageDetailPane`). */
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import type { Contact } from "@rapidmx/react-shared/contacts/contactsApi.js";
import { PinnedKeyChangedError, type KeyConflict, type PublicKey } from "@rapidmx/react-shared/crypto/keyvaultApi.js";

export const KEY_CHANGE_STALE_MESSAGE = "This contact's keys changed while you were looking; reload to see the latest.";
export const KEY_CHANGE_INVALID_MESSAGE =
    "The new key isn't a valid, current certificate for this address, so it can't be accepted. Nothing was changed.";
export const KEY_CHANGE_FORBIDDEN_MESSAGE = "You don't have permission to change this contact's keys.";
export const KEY_CHANGE_NOT_FOUND_MESSAGE =
    "There's no key change to resolve for this address any more. It may already have been resolved, or the contact was removed.";
export const KEY_CHANGE_GENERIC_MESSAGE = "Couldn't update this contact's keys. Try again.";

/** The error text for a failed `resolveKeyConflict()` other than `PinnedKeyChangedError` (which the caller reloads
 * on and reports with `KEY_CHANGE_STALE_MESSAGE`). */
export function keyChangeErrorMessage(err: unknown): string {
    if (err instanceof PinnedKeyChangedError) {
        return KEY_CHANGE_STALE_MESSAGE;
    }
    if (err instanceof ApiRequestError && err.status === 400) {
        return KEY_CHANGE_INVALID_MESSAGE;
    }
    if (err instanceof ApiRequestError && err.status === 403) {
        return KEY_CHANGE_FORBIDDEN_MESSAGE;
    }
    if (err instanceof ApiRequestError && err.status === 404) {
        return KEY_CHANGE_NOT_FOUND_MESSAGE;
    }
    return KEY_CHANGE_GENERIC_MESSAGE;
}

/** Groups a fingerprint into 4-character blocks (`ab12 cd34 ...`), ignoring any separators it came with, so it can be
 * read out and compared over another channel. */
export function groupFingerprint(fingerprint: string): string {
    const compact = fingerprint.replace(/[\s:]/g, "").toLowerCase();
    return compact.match(/.{1,4}/g)?.join(" ") ?? compact;
}

/** Whether two fingerprints name the same key (case and separators ignored). */
export function sameFingerprint(a: string | undefined, b: string | undefined): boolean {
    return a !== undefined && b !== undefined && a.replace(/[\s:]/g, "").toLowerCase() === b.replace(/[\s:]/g, "").toLowerCase();
}

/** A revoked key's label: `"superseded"` for a routine replacement, `"revoked"` for a compromised key or one revoked
 * with no reason; `undefined` when the key isn't revoked. */
export function revocationLabel(key: PublicKey): "superseded" | "revoked" | undefined {
    if (!key.revokedAt) {
        return undefined;
    }
    return key.revocationReason === "superseded" ? "superseded" : "revoked";
}

/** Where a key conflict was observed, for display. */
export function conflictSourceLabel(source: KeyConflict["source"]): string {
    return source === "header" ? "from an incoming message" : "by key discovery";
}

/** restapi records `keysFirstSeen` on a contact but react-shared's `Contact` type doesn't carry it. */
type ContactWithFirstSeen = Pick<Contact, "previousKeys"> & { keysFirstSeen?: number };

/** When `key` (one of `contact`'s pinned keys) started being trusted: when it replaced the newest previous key of its
 * use, else the contact's `keysFirstSeen`, else the key's own `notBefore`. */
export function keyPinnedSince(contact: ContactWithFirstSeen, key: PublicKey): number {
    const replaced = (contact.previousKeys ?? []).filter((previous) => previous.useType === key.useType).map((previous) => previous.replacedAt);
    if (replaced.length > 0) {
        return Math.max(...replaced);
    }
    return contact.keysFirstSeen ?? key.notBefore;
}

export function formatDate(ms: number): string {
    return new Date(ms).toLocaleDateString();
}
