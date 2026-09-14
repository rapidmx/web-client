///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Which of the caller's accessible mailboxes they can actually create things in (send from, create
 * events/contacts/to-dos in). `listMailboxes()` returns view-only shares too, and `Mailbox` itself carries
 * no per-caller access role, so a "viewer" delegate used to be offered mailboxes every create would 403 in.
 *
 * The signal: an owned mailbox (or any mailbox, for a trusted caller) is always writable; for any other,
 * `getMyMailboxAccess()`'s `canCreate` - the server's own ACL evaluation of the exact action a create needs.
 * One request per mailbox per page load: results are cached in a module-level map, with concurrent callers
 * sharing one in-flight request. A failure (network, an older server without that route) is "unknown" and
 * isn't cached: the server still enforces access on the create itself, and hiding a usable mailbox over a
 * transient error would be worse than offering one that later errors.
 *
 * Nothing waits on these checks: pickers list every mailbox straight away and drop view-only ones as each
 * answer arrives.
 */
import { useEffect, useMemo, useState } from "react";
import type { Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import { getMyMailboxAccess } from "@rapidmx/react-shared/mail/mailboxAccessApi.js";

/** `true` writable, `false` known view-only, `undefined` couldn't tell (treated as writable). */
export type MailboxWritability = boolean | undefined;

const inFlight = new Map<string, Promise<MailboxWritability>>();
const settled = new Map<string, boolean>();

/** Forgets every cached answer - for tests, and anything that changes the caller's access mid-session. */
export function clearMailboxWritabilityCache(): void {
    inFlight.clear();
    settled.clear();
}

function isImplicitlyWritable(mailbox: Mailbox, userUid: string | undefined, trusted: boolean | undefined): boolean {
    return !!trusted || (!!userUid && mailbox.ownerUserUid === userUid);
}

/** The already-known answer for `mailbox`, without making a request. */
export function peekMailboxWritability(mailbox: Mailbox, userUid: string | undefined, trusted?: boolean): MailboxWritability {
    return isImplicitlyWritable(mailbox, userUid, trusted) ? true : settled.get(mailbox.uid);
}

/** Whether the caller can create items in `mailbox`. Never rejects. */
export function getMailboxWritability(mailbox: Mailbox, userUid: string | undefined, trusted?: boolean): Promise<MailboxWritability> {
    const known = peekMailboxWritability(mailbox, userUid, trusted);
    if (known !== undefined) {
        return Promise.resolve(known);
    }
    let request = inFlight.get(mailbox.uid);
    if (!request) {
        request = getMyMailboxAccess(mailbox.uid).then(
            (access) => {
                settled.set(mailbox.uid, access.canCreate);
                inFlight.delete(mailbox.uid);
                return access.canCreate;
            },
            () => {
                // Not cached - a later check may succeed.
                inFlight.delete(mailbox.uid);
                return undefined;
            },
        );
        inFlight.set(mailbox.uid, request);
    }
    return request;
}

/** Per-mailbox writability answers for `mailboxes`, filled in as each one arrives (already-known answers are
 * present from the first render). */
export function useMailboxWritability(mailboxes: Mailbox[], userUid: string | undefined, trusted?: boolean): Record<string, MailboxWritability> {
    const [answers, setAnswers] = useState<Record<string, MailboxWritability>>({});
    useEffect(() => {
        let cancelled = false;
        for (const mailbox of mailboxes) {
            void getMailboxWritability(mailbox, userUid, trusted).then((writable) => {
                if (!cancelled) {
                    setAnswers((prev) => ({ ...prev, [mailbox.uid]: writable }));
                }
            });
        }
        return () => {
            cancelled = true;
        };
    }, [mailboxes, userUid, trusted]);
    return useMemo(() => {
        const merged: Record<string, MailboxWritability> = {};
        for (const mailbox of mailboxes) {
            merged[mailbox.uid] = answers[mailbox.uid] ?? peekMailboxWritability(mailbox, userUid, trusted);
        }
        return merged;
    }, [answers, mailboxes, userUid, trusted]);
}

/** `mailboxes` minus any known to be view-only, always keeping `keepUid` (the picker's current/default value,
 * so the control never shows a value missing from its own options). Lists everything until told otherwise. */
export function useWritableMailboxes(mailboxes: Mailbox[], userUid: string | undefined, keepUid?: string, trusted?: boolean): Mailbox[] {
    const writability = useMailboxWritability(mailboxes, userUid, trusted);
    return useMemo(() => mailboxes.filter((mb) => mb.uid === keepUid || writability[mb.uid] !== false), [mailboxes, writability, keepUid]);
}
