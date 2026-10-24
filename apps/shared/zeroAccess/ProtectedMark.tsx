///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { isProtectedRecord, type SealedRecord } from "../../../lib/zeroAccess/sealedRecords.js";

/** A small lock beside a calendar event, contact or task whose details zero-access encryption protects (`sealedFields`) - nothing for
 * one it doesn't. Never says "end-to-end": the server sees what is saved while it saves it (restapi `specs/search.md` §3). */
export default function ProtectedMark({ record }: { record: SealedRecord }) {
    if (!isProtectedRecord(record)) {
        return null;
    }
    return (
        <span className="ml-1 text-text-muted text-xs" role="img" aria-label="Protected by zero-access encryption" title="Protected by zero-access encryption">
            &#128274;
        </span>
    );
}
