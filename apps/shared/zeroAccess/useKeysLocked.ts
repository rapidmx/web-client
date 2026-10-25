///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useRef } from "react";
import { subscribeKeySession } from "../../../lib/crypto/keySession.js";

/**
 * Calls `onLocked` with the mailbox whenever a mailbox's keys lock (the idle timeout, a lock from settings, signing out) - for a page that
 * holds records it opened with them in its state: the opened-value caches are cleared on a lock, but a page's state is not, so it reloads
 * (the reloaded records keep their placeholders) and closes what shows opened content. The latest `onLocked` is called; subscribed once.
 */
export function useKeysLocked(onLocked: (mailboxUid: string) => void): void {
    const latest = useRef(onLocked);
    latest.current = onLocked;
    useEffect(
        () =>
            subscribeKeySession(({ mailboxUid, state }) => {
                if (state === "locked") {
                    latest.current(mailboxUid);
                }
            }),
        [],
    );
}
