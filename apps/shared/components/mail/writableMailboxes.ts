///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Which of the caller's accessible mailboxes they can actually create things in (send from, create
 * events/contacts/to-dos in). `listMailboxes()` returns view-only shares too, and `Mailbox` itself carries
 * no per-caller access role, so a "viewer" delegate used to be offered mailboxes every create would 403 in.
 *
 * The signal: an owned mailbox is always writable; for any other, `listMailboxAccess()` is gated server-side
 * at `"update"` - which a `"manager"` delegate (`ACLAction.FULL`) or trusted admin holds and a `"viewer"`
 * (read/list only) doesn't - so a 403 there means view-only. Any *other* failure (network, an older server
 * without that route) fails open: the server still enforces access on the create itself, and hiding a
 * usable mailbox over a transient error would be worse than offering one that later errors.
 */
import { useEffect, useMemo, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import type { Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import { listMailboxAccess } from "@rapidmx/react-shared/mail/mailboxAccessApi.js";

export async function filterWritableMailboxes(mailboxes: Mailbox[], userUid: string | undefined): Promise<Mailbox[]> {
    const writable = await Promise.all(
        mailboxes.map(async (mailbox) => {
            if (userUid && mailbox.ownerUserUid === userUid) {
                return true;
            }
            try {
                await listMailboxAccess(mailbox.uid);
                return true;
            } catch (err) {
                return !(err instanceof ApiRequestError && err.status === 403);
            }
        }),
    );
    return mailboxes.filter((_, i) => writable[i]);
}

/** `mailboxes` narrowed to writable ones, always keeping `keepUid` (the picker's current/default value, so
 * the control never shows a value missing from its own options). Until the check settles it holds just the
 * caller's own mailboxes plus `keepUid`, so a picker never briefly offers a view-only mailbox. */
export function useWritableMailboxes(mailboxes: Mailbox[], userUid: string | undefined, keepUid?: string): Mailbox[] {
    const [writableUids, setWritableUids] = useState<Set<string> | undefined>(undefined);
    useEffect(() => {
        let cancelled = false;
        setWritableUids(undefined);
        void filterWritableMailboxes(mailboxes, userUid).then((result) => {
            if (!cancelled) {
                setWritableUids(new Set(result.map((mb) => mb.uid)));
            }
        });
        return () => {
            cancelled = true;
        };
    }, [mailboxes, userUid]);
    return useMemo(
        () => mailboxes.filter((mb) => mb.uid === keepUid || (writableUids ? writableUids.has(mb.uid) : !!userUid && mb.ownerUserUid === userUid)),
        [mailboxes, writableUids, userUid, keepUid],
    );
}
