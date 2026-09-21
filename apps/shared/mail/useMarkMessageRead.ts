///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useRef } from "react";
import type { Message } from "@rapidmx/react-shared/mail/mailApi.js";
import { useMailShell } from "../components/mail/layout/MailShell.js";
import { setReadState } from "./messageReadState.js";

/**
 * Marks a message read when it is opened in a reading pane, through `setReadState()`: the row and the folder badge change at
 * once. `onPatched` is handed each copy of the message as it changes (the optimistic one, then the server's, or the original
 * again if the server refused).
 *
 * Replaces `@rapidmx/react-shared`'s `useMarkMessageRead`, which waits for the server before telling anyone and drops that
 * answer if the message changes meanwhile - which the optimistic copy itself does. A message is asked for once each time it is
 * opened: one the reader then marks unread stays unread while it is open, and one whose request failed is not retried in a loop
 * (its own revert changes it again), only when it is opened again.
 */
export function useMarkMessageRead(message: Message | null, onPatched: (updated: Message, previous?: Message) => void): void {
    const { trackMessageChange } = useMailShell();
    const openUidRef = useRef<string | undefined>(undefined);
    const requestedRef = useRef<Set<string>>(new Set());
    const latestRef = useRef({ onPatched, trackMessageChange });
    latestRef.current = { onPatched, trackMessageChange };

    useEffect(() => {
        if (message?.uid !== openUidRef.current) {
            // Another message (or none) is open now: whatever was asked about the last one is over.
            openUidRef.current = message?.uid;
            requestedRef.current.clear();
        }
        if (!message || requestedRef.current.has(message.uid)) {
            return;
        }
        // Every opening is asked about once - a message that is already read included, so that marking it unread while it is open (the
        // keyboard's Ctrl+U) doesn't make this run again and read it straight back.
        requestedRef.current.add(message.uid);
        if (message.flags.read === true) {
            return;
        }
        void setReadState(message, true, {
            patch: (updated, previous) => latestRef.current.onPatched(updated, previous),
            track: (previous, next) => latestRef.current.trackMessageChange(previous, next),
        });
    }, [message]);
}
