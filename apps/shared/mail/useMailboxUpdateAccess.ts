///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useState } from "react";
import type { Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import { getMyMailboxAccess } from "@rapidmx/react-shared/mail/mailboxAccessApi.js";

/** What the server said about the caller's update access to a mailbox, remembered per mailbox for the page load. */
const answers = new Map<string, Promise<boolean | undefined>>();

/** Forgets every remembered answer - for the tests, and anything that changes the caller's access mid-session. */
export function clearMailboxUpdateAccessCache(): void {
    answers.clear();
}

/** Whether the caller may change things in `mailboxUid` (move, mark and flag its messages, add its filters): the server's own ACL check. Never rejects; `undefined` when it could not be asked (which is not cached). */
function fetchUpdateAccess(mailboxUid: string): Promise<boolean | undefined> {
    let answer = answers.get(mailboxUid);
    if (!answer) {
        answer = getMyMailboxAccess(mailboxUid).then(
            (access) => access.canUpdate,
            () => {
                answers.delete(mailboxUid);
                return undefined;
            },
        );
        answers.set(mailboxUid, answer);
    }
    return answer;
}

/**
 * Whether the reader may change the messages of `mailbox`: `false` only for a mailbox shared with them (`accessRole: "delegate"`) that
 * the server says they may not update - a view-only share. Everything else is `true` from the first render: the reader's own mailbox
 * needs no request, and a mailbox that is unknown (the shell has not listed it), or whose access could not be read, is treated as
 * writable - the server still refuses what is not allowed, and hiding a usable action over a failed lookup is worse than offering one
 * that then says why it failed.
 */
export function useMailboxUpdateAccess(mailbox: Mailbox | undefined): boolean {
    const uid = mailbox?.uid;
    const delegated = mailbox?.accessRole === "delegate";
    const [writable, setWritable] = useState(true);
    useEffect(() => {
        setWritable(true);
        if (!uid || !delegated) {
            return;
        }
        let cancelled = false;
        void fetchUpdateAccess(uid).then((canUpdate) => {
            if (!cancelled && canUpdate === false) {
                setWritable(false);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [uid, delegated]);
    return writable;
}
