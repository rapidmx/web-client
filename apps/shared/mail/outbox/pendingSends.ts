///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useSyncExternalStore } from "react";
import { registerComposeFlush } from "../../components/mail/compose/composeFlushRegistry.js";

/**
 * The messages this tab has been asked to send whose *client-side* work is not finished: assembling (and encrypting/signing, which takes
 * a moment) and the request that hands them to the server. Once the server has answered `202 queued` a message is safe - the server
 * owns it, and the Outbox folder's own count, list and push events say the rest - so it leaves this set.
 *
 * What this is for: the Outbox indicator counts these at once (before the server has heard of the message), a message in this set is
 * why the tab asks "Leave site?" (`beforeunload`) and why Sign Out waits a moment before ending the session, and a second Send of the same
 * draft is refused while it is here.
 */
export type PendingStage = "preparing" | "queuing";

export interface PendingSend {
    /** The draft's uid: one send per draft at a time. */
    draftUid: string;
    mailboxUid: string;
    subject: string;
    /** Every recipient's address. */
    recipients: string[];
    stage: PendingStage;
    /** A send-later message: it goes to Outbox and waits for its time, rather than being relayed. */
    scheduled: boolean;
    startedAt: number;
}

const NO_SENDS: readonly PendingSend[] = [];
let pending: PendingSend[] = [];
let snapshot: readonly PendingSend[] = pending;
const listeners = new Set<() => void>();
let stopFlush: (() => void) | undefined;
let waiters: (() => void)[] = [];

function emit(): void {
    snapshot = [...pending];
    for (const listener of [...listeners]) {
        listener();
    }
}

/** `beforeunload`: leaving now would lose a message the server has not received. */
function handleBeforeUnload(event: BeforeUnloadEvent): void {
    // Only installed while something is pending (see `syncGuards()`).
    event.preventDefault();
    event.returnValue = "";
}

/** Installs the `beforeunload` prompt and the sign-out wait while a send is pending, and takes them away when none is. Only ever called from a browser. */
function syncGuards(): void {
    if (pending.length > 0 && !stopFlush) {
        window.addEventListener("beforeunload", handleBeforeUnload);
        // Sign Out flushes compose windows before it ends the session; a message still being prepared is waited for there too.
        stopFlush = registerComposeFlush(() => whenSettled(20_000));
    } else if (pending.length === 0 && stopFlush) {
        window.removeEventListener("beforeunload", handleBeforeUnload);
        stopFlush();
        stopFlush = undefined;
    }
    if (pending.length === 0) {
        const done = waiters;
        waiters = [];
        for (const resolve of done) {
            resolve();
        }
    }
}

/** Whether a send of this draft is under way in this tab. */
export function isSendPending(draftUid: string): boolean {
    return pending.some((entry) => entry.draftUid === draftUid);
}

/** Starts tracking a send. `false` (and nothing tracked) when this draft is already being sent - the caller must not send it again. */
export function beginPendingSend(entry: Omit<PendingSend, "stage" | "startedAt">): boolean {
    if (isSendPending(entry.draftUid)) {
        return false;
    }
    pending.push({ ...entry, stage: "preparing", startedAt: Date.now() });
    syncGuards();
    emit();
    return true;
}

export function setPendingStage(draftUid: string, stage: PendingStage): void {
    pending = pending.map((entry) => (entry.draftUid === draftUid ? { ...entry, stage } : entry));
    emit();
}

/** The server has the message (or the attempt failed and is now the user's to resolve): it is no longer this tab's work. */
export function finishPendingSend(draftUid: string): void {
    pending = pending.filter((entry) => entry.draftUid !== draftUid);
    syncGuards();
    emit();
}

export function getPendingSends(): readonly PendingSend[] {
    return snapshot;
}

export function subscribePendingSends(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** How many messages of `mailboxUid` are still being handed to the server: what the Outbox pill adds to its server count at once. */
export function pendingCountFor(mailboxUid: string, sends: readonly PendingSend[] = snapshot): number {
    return sends.filter((entry) => entry.mailboxUid === mailboxUid).length;
}

/** Resolves (to whether everything settled) when no send is pending, or after `timeoutMs`. */
export function whenSettled(timeoutMs: number): Promise<boolean> {
    if (pending.length === 0) {
        return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
            waiters = waiters.filter((waiter) => waiter !== done);
            resolve(false);
        }, timeoutMs);
        function done() {
            clearTimeout(timer);
            resolve(true);
        }
        waiters.push(done);
    });
}

/** The messages being sent, for a component. */
export function usePendingSends(): readonly PendingSend[] {
    return useSyncExternalStore(subscribePendingSends, getPendingSends, () => NO_SENDS);
}

/** Forgets everything - for a test. */
export function resetPendingSends(): void {
    pending = [];
    waiters = [];
    syncGuards();
    emit();
}
