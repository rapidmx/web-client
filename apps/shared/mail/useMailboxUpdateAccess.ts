///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useState } from "react";
import type { Mailbox } from "../../../lib/mail/mailApi.js";
import { getMyMailboxAccess } from "../../../lib/mail/mailboxAccessApi.js";
import type { ApiClient } from "../../../lib/util/api.js";
import { useApiClient } from "../../../lib/util/apiClientContext.js";

/** What the server said about the caller's update access to a mailbox, remembered per mailbox for the page load - for the
 * default global client (no `ApiClientContext.Provider` above the caller). */
const answers = new Map<string, Promise<boolean | undefined>>();

/** The same, per explicit `ApiClient` instance (each of `tauri-client`'s accounts has its own), so two accounts never
 * answer each other's question even if their mailbox uids ever collided. A `WeakMap` so an account's cache is dropped
 * with its `ApiClient` rather than growing forever. */
const clientAnswers = new WeakMap<ApiClient, Map<string, Promise<boolean | undefined>>>();

/** The cache to use for `client` (`answers` itself for the default, undefined case). */
function cacheFor(client: ApiClient | undefined): Map<string, Promise<boolean | undefined>> {
    if (!client) {
        return answers;
    }
    let cache = clientAnswers.get(client);
    if (!cache) {
        cache = new Map();
        clientAnswers.set(client, cache);
    }
    return cache;
}

/** Forgets every remembered answer of the default global client - for the tests, and anything that changes the caller's
 * access mid-session. An explicit `ApiClient`'s own cache is scoped to that instance and needs no separate clearing. */
export function clearMailboxUpdateAccessCache(): void {
    answers.clear();
}

/** Whether the caller may change things in `mailboxUid` (move, mark and flag its messages, add its filters): the server's own ACL check. Never rejects; `undefined` when it could not be asked (which is not cached). */
function fetchUpdateAccess(mailboxUid: string, client: ApiClient | undefined): Promise<boolean | undefined> {
    const cache = cacheFor(client);
    let answer = cache.get(mailboxUid);
    if (!answer) {
        answer = getMyMailboxAccess(mailboxUid, client).then(
            (access) => access.canUpdate,
            () => {
                cache.delete(mailboxUid);
                return undefined;
            },
        );
        cache.set(mailboxUid, answer);
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
    const client = useApiClient();
    const uid = mailbox?.uid;
    const delegated = mailbox?.accessRole === "delegate";
    const [writable, setWritable] = useState(true);
    useEffect(() => {
        setWritable(true);
        if (!uid || !delegated) {
            return;
        }
        let cancelled = false;
        void fetchUpdateAccess(uid, client).then((canUpdate) => {
            if (!cancelled && canUpdate === false) {
                setWritable(false);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [uid, delegated, client]);
    return writable;
}
