///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useState } from "react";
import { subscribeKeySession } from "../../../lib/crypto/keySession.js";
import { isProtectedRecord, openSealedRecord, type SealedRecord } from "../../../lib/zeroAccess/sealedRecords.js";

/** The record's `uid`, when it has one - a new object for the same record (a live update, the page's own reload) is the same record. */
function uidOf(record: SealedRecord | undefined): string | undefined {
    return (record as { uid?: unknown } | undefined)?.uid as string | undefined;
}

/**
 * `record` with all its protected fields opened (`openSealedRecord()`), for a view that shows or edits every field - a list opens only
 * what it shows. `ready` is false while a protected record is first being opened; `record` is the one given meanwhile, and the given one
 * again when it can't be opened (the mailbox is locked).
 *
 * A new object for the same record (same `uid`) keeps the opened one ready while it is opened in turn, so a form over it isn't unmounted by
 * a live update (its in-progress edits kept); the new one - its new `version` - takes over once opened. The record's mailbox locking drops
 * what was opened at once (nothing opened outlives its key session) and opens it again, which gives the placeholders; its unlocking opens it
 * again too.
 *
 * `open` opens it, `openSealedRecord()` unless a kind of record has its own full open (a calendar event's `fullyOpenedEvent()`, which keeps
 * the title opened from its sealed content) - a function defined once, not per render, so the record isn't opened again on every render.
 */
export function useOpenedRecord<T extends SealedRecord>(
    record: T | undefined,
    open: (record: T) => Promise<T> = openSealedRecord,
): { record: T | undefined; ready: boolean } {
    const [opened, setOpened] = useState<{ from: T; record: T } | undefined>(undefined);
    const [generation, setGeneration] = useState(0);
    const protectedRecord = isProtectedRecord(record);
    const mailboxUid = record?.mailboxUid;
    useEffect(() => {
        if (!mailboxUid || !protectedRecord) {
            return;
        }
        return subscribeKeySession((event) => {
            if (event.mailboxUid !== mailboxUid) {
                return;
            }
            if (event.state === "locked") {
                setOpened(undefined);
            }
            setGeneration((current) => current + 1);
        });
    }, [mailboxUid, protectedRecord]);
    useEffect(() => {
        if (!record || !protectedRecord) {
            return;
        }
        let cancelled = false;
        void open(record).then((result) => {
            if (!cancelled) {
                setOpened({ from: record, record: result });
            }
        });
        return () => {
            cancelled = true;
        };
    }, [record, protectedRecord, generation, open]);
    if (!record || !protectedRecord) {
        return { record, ready: true };
    }
    if (opened?.from === record) {
        return { record: opened.record, ready: true };
    }
    const uid = uidOf(record);
    return opened && uid !== undefined && uidOf(opened.from) === uid ? { record: opened.record, ready: true } : { record, ready: false };
}
