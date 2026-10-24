///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Calendar events, contacts and tasks of a mailbox whose zero-access encryption covers their type keep their protected fields only
 * sealed, field by field, to the mailbox's zero-access key (`sealedFields`; the readable column holds a placeholder - restapi
 * `specs/search.md` §3 *What It Covers*). They are opened here with the mailbox's unlocked keys; while it is locked a record keeps its
 * placeholders. The decryption code is loaded only when a sealed record is actually seen.
 *
 * Writing needs nothing here: the client sends plaintext and the server seals it on arrival.
 */
import { fromBase64 } from "../crypto/encoding.js";
import { getUnlockedKeys, subscribeKeySession } from "../crypto/keySession.js";

/** A record that may carry sealed fields. */
export interface SealedRecord {
    mailboxUid: string;
    /** Protected field name -> base64 CMS of its JSON value. */
    sealedFields?: Record<string, string> | null;
}

/** Opened values by sealed text - the same sealed text always opens to the same value. Cleared with `clearSealedRecords()`. */
const opened: Map<string, unknown> = new Map();

/** Forgets every opened value (a mailbox locking, or the test seam). */
export function clearSealedRecords(): void {
    opened.clear();
}

/** Set on a record whose every sealed field was opened. A symbol, so it survives a spread copy (an occurrence of an event) and is never sent. */
const OPENED = Symbol("openedSealedRecord");

/** Whether every protected field of `record` holds its real value - opened on this device - rather than its placeholder. */
export function isOpenedRecord(record: SealedRecord | undefined): boolean {
    return !!record && (record as any)[OPENED] === true;
}

/** Whether `record` has protected fields. */
export function isProtectedRecord(record: SealedRecord | undefined): boolean {
    return !!record?.sealedFields && Object.keys(record.sealedFields).length > 0;
}

/** `record` with every sealed field (of `only`, when given) this device can open set to its value; `undefined` when it can't open them
 * (locked, or not its key). */
async function openRecord<T extends SealedRecord>(record: T, only?: readonly string[]): Promise<T | undefined> {
    const keys = getUnlockedKeys(record.mailboxUid)?.zeroAccessKeys;
    if (!keys?.length) {
        return undefined;
    }
    try {
        const values: Record<string, unknown> = {};
        for (const [name, sealed] of Object.entries(record.sealedFields!)) {
            if (only && !only.includes(name)) {
                continue;
            }
            if (!opened.has(sealed)) {
                const { decryptEnvelopedDataWithKeys } = await import("../crypto/smime.js");
                opened.set(sealed, JSON.parse(new TextDecoder().decode(await decryptEnvelopedDataWithKeys(fromBase64(sealed), keys))));
            }
            values[name] = opened.get(sealed);
        }
        return only ? { ...record, ...values } : { ...record, ...values, [OPENED]: true };
    } catch {
        return undefined;
    }
}

let watchingKeys = false;

/** Opened values go when keys are locked (which signing out does), so nothing opened outlives its key session. Subscribed when the
 * first protected record is opened, not on import. */
function forgetOnLock(): void {
    if (watchingKeys) {
        return;
    }
    watchingKeys = true;
    subscribeKeySession((event) => {
        if (event.state === "locked") {
            clearSealedRecords();
        }
    });
}

/** `records` with every protected one this device can open shown with its real values - only the fields in `only`, when given (a list
 * shows a contact's name before anyone asks for its phone numbers: each field is one decryption). Never rejects. */
export async function openSealedRecords<T extends SealedRecord>(records: T[], only?: readonly string[]): Promise<T[]> {
    if (!records.some(isProtectedRecord)) {
        return records;
    }
    forgetOnLock();
    return Promise.all(records.map(async (record) => (isProtectedRecord(record) ? ((await openRecord(record, only)) ?? record) : record)));
}

/** `der` (a blob the server sealed to `mailboxUid`'s zero-access key, e.g. a protected contact's photo) opened, or `undefined` when this
 * device can't (the mailbox is locked, or it isn't its key). */
export async function openSealedBytes(mailboxUid: string, der: Uint8Array): Promise<Uint8Array | undefined> {
    const keys = getUnlockedKeys(mailboxUid)?.zeroAccessKeys;
    if (!keys?.length) {
        return undefined;
    }
    try {
        const { decryptEnvelopedDataWithKeys } = await import("../crypto/smime.js");
        return await decryptEnvelopedDataWithKeys(der, keys);
    } catch {
        return undefined;
    }
}

/** `openSealedRecords()` for one record. */
export async function openSealedRecord<T extends SealedRecord>(record: T, only?: readonly string[]): Promise<T> {
    return (await openSealedRecords([record], only))[0];
}
