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
import { fromBase64 } from "../../../lib/crypto/encoding.js";
import { getUnlockedKeys } from "../../../lib/crypto/keySession.js";
import { onSigningOut } from "../components/mail/compose/composeFlushRegistry.js";

/** A record that may carry sealed fields. */
export interface SealedRecord {
    mailboxUid: string;
    /** Protected field name -> base64 CMS of its JSON value. */
    sealedFields?: Record<string, string> | null;
}

/** Opened values by sealed text - the same sealed text always opens to the same value. Cleared with `clearSealedRecords()`. */
const opened: Map<string, unknown> = new Map();

/** Forgets every opened value (sign-out, or the test seam). */
export function clearSealedRecords(): void {
    opened.clear();
}

/** Whether `record` has protected fields. */
export function isProtectedRecord(record: SealedRecord | undefined): boolean {
    return !!record?.sealedFields && Object.keys(record.sealedFields).length > 0;
}

/** `record` with every sealed field this device can open set to its value; `undefined` when it can't open them (locked, or not its key). */
async function openRecord<T extends SealedRecord>(record: T): Promise<T | undefined> {
    const keys = getUnlockedKeys(record.mailboxUid)?.zeroAccessKeys;
    if (!keys?.length) {
        return undefined;
    }
    try {
        const values: Record<string, unknown> = {};
        for (const [name, sealed] of Object.entries(record.sealedFields!)) {
            if (!opened.has(sealed)) {
                const { decryptEnvelopedDataWithKeys } = await import("../../../lib/crypto/smime.js");
                opened.set(sealed, JSON.parse(new TextDecoder().decode(await decryptEnvelopedDataWithKeys(fromBase64(sealed), keys))));
            }
            values[name] = opened.get(sealed);
        }
        return { ...record, ...values };
    } catch {
        return undefined;
    }
}

/** `records` with every protected one this device can open shown with its real values. Never rejects. */
export async function openSealedRecords<T extends SealedRecord>(records: T[]): Promise<T[]> {
    if (!records.some(isProtectedRecord)) {
        return records;
    }
    return Promise.all(records.map(async (record) => (isProtectedRecord(record) ? ((await openRecord(record)) ?? record) : record)));
}

/** `openSealedRecords()` for one record. */
export async function openSealedRecord<T extends SealedRecord>(record: T): Promise<T> {
    return (await openSealedRecords([record]))[0];
}

onSigningOut(clearSealedRecords);
