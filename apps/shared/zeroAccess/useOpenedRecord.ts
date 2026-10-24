///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useState } from "react";
import { isProtectedRecord, openSealedRecord, type SealedRecord } from "../../../lib/zeroAccess/sealedRecords.js";

/**
 * `record` with all its protected fields opened (`openSealedRecord()`), for a view that shows or edits every field - a list opens only
 * what it shows. `ready` is false while a protected record is still being opened; `record` is the one given meanwhile, and the given one
 * again when it can't be opened (the mailbox is locked).
 */
export function useOpenedRecord<T extends SealedRecord>(record: T | undefined): { record: T | undefined; ready: boolean } {
    const [opened, setOpened] = useState<{ from: T; record: T } | undefined>(undefined);
    const protectedRecord = isProtectedRecord(record);
    useEffect(() => {
        if (!record || !protectedRecord) {
            return;
        }
        let cancelled = false;
        void openSealedRecord(record).then((result) => {
            if (!cancelled) {
                setOpened({ from: record, record: result });
            }
        });
        return () => {
            cancelled = true;
        };
    }, [record, protectedRecord]);
    if (!record || !protectedRecord) {
        return { record, ready: true };
    }
    return opened?.from === record ? { record: opened.record, ready: true } : { record, ready: false };
}
