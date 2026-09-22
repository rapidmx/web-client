///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { SendRequest } from "./sendJob.js";

/**
 * The module-level state of the background send (`sendJob.ts`), kept in a module with no imports of its own: a test setup can reset it after each
 * test without loading the send code (and everything that code imports) before a test file has had the chance to mock it.
 */

/** Registered by the frame: puts an optimistic +1 on the Outbox count for `mailboxUid`, at once, and says how to settle or take it back. */
export interface OutboxCountTracker {
    settle(): void;
    revert(): void;
}

export const sendState: {
    countTracker: ((mailboxUid: string) => OutboxCountTracker) | undefined;
    /** Called after the server accepted a message into Outbox - the frame reads the folders back (the Outbox may not have existed before). */
    queuedListener: ((mailboxUid: string) => void) | undefined;
    /** What is kept of each message the server accepted, so a later failure reported by push event can offer "Open draft" and "Retry" with
     * the content intact (a message that was encrypted before it was stored can't be read back from the server). Bounded; this tab's only. */
    retained: Map<string, SendRequest>;
    /** "Message sent" confirmations close together are one pop-up counting up. */
    sentBurst: { count: number; at: number };
} = { countTracker: undefined, queuedListener: undefined, retained: new Map(), sentBurst: { count: 0, at: 0 } };

/** Forgets everything - for a test. */
export function resetSendJobs(): void {
    sendState.countTracker = undefined;
    sendState.queuedListener = undefined;
    sendState.retained.clear();
    sendState.sentBurst = { count: 0, at: 0 };
}
