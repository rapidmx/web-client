///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useState } from "react";
import { Attachment, Message, listAttachments, setMessageRead } from "./mailApi.js";

/** Loads a message's attachments (only when it actually has any) — shared by every place a message is read. */
export function useMessageAttachments(message: Message | null): Attachment[] {
    const [attachments, setAttachments] = useState<Attachment[]>([]);

    useEffect(() => {
        if (!message || !message.hasAttachments) {
            setAttachments([]);
            return;
        }
        listAttachments(message.folderUid, message.uid)
            .then(setAttachments)
            .catch(() => setAttachments([]));
        // Only the fields the fetch actually depends on — not the whole `message` object, which gets a new
        // reference on every metadata-only patch (e.g. `useMarkMessageRead`'s `onUpdated(updated)`, or a
        // star/flag/label change wired to the same state) and would otherwise trigger a needless re-fetch.
        // `folderUid` IS included: `moveMessage()`/`archiveMessage()` change it while preserving uid/hasAttachments
        // (the same "new object reference, same uid" shape as a metadata-only patch), and dropping it would leave
        // a stale fetch pointed at the message's old folder after a move — folder changes are rare enough that
        // including it doesn't reintroduce the over-fetching this dependency array was narrowed to avoid.
    }, [message?.uid, message?.hasAttachments, message?.folderUid]);

    return attachments;
}

/**
 * Marks a message read the first time it's viewed. `onUpdated` receives the server's updated copy — the
 * desktop reading pane patches its in-memory message list with it; the mobile detail route (which has no
 * list to patch) just replaces its own local `message` state. Best-effort: a failed update shouldn't block
 * reading the message, matching this app's existing `handleSelect` behavior.
 */
export function useMarkMessageRead(message: Message | null, onUpdated: (updated: Message) => void): void {
    useEffect(() => {
        if (!message || message.flags.read) {
            return;
        }
        let cancelled = false;
        setMessageRead(message, true)
            .then((updated) => {
                if (!cancelled) {
                    onUpdated(updated);
                }
            })
            .catch(() => {
                // Best-effort — see doc comment above.
            });
        return () => {
            cancelled = true;
        };
    }, [message]);
}
