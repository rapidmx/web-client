///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { Message } from "@rapidmx/react-shared/mail/mailApi.js";

/**
 * What a message in Outbox is doing, read from the fields the server keeps on it (`scheduledSend*`):
 *
 * These are the server's own definitions (`@rapidmx/restapi`'s background send):
 *
 * - `sending`: a lease (`scheduledSendLeaseExpiresAt`) is running, or a *due* `scheduledSendTime` with no failed attempts yet - a message
 * queued for the server's worker (a background send is queued as an ordinary due message, `scheduledSendTime` = when it was queued);
 * - `retrying`: `scheduledSendAttempts > 0` with a later `scheduledSendTime` (or a lease on one): a delivery attempt failed and the server
 * will try again;
 * - `failed`: `scheduledSendError` set and no `scheduledSendTime` - the server gave up; it stays in Outbox, waiting for the user to retry
 * (the same send call again) or to open it (back to Drafts is allowed, it is not in flight);
 * - `scheduled`: a send-later message whose time has not come.
 *
 * "Due" is judged against the message's own `dateModified` as well as the clock: a background send's `scheduledSendTime` is set by the server
 * at the moment it queued the message, so a browser whose clock runs behind must not read it as a send scheduled for the future.
 */
export type OutboxItemState = "sending" | "retrying" | "failed" | "scheduled";

export interface OutboxItemStatus {
    state: OutboxItemState;
    /** Failed delivery attempts so far (`retrying`). */
    attempts: number;
    /** Why it failed (`failed`). */
    error?: string;
    /** When it will be sent or tried again (`scheduled`, `retrying`), epoch ms. */
    at?: number;
}

/** A `scheduledSendTime` this close to the message's last modification was set by the server as "now": a due message, not a scheduled one. */
export const DUE_SLACK_MS = 2_000;

export function outboxItemStatus(message: Message, now: number = Date.now()): OutboxItemStatus {
    const attempts = message.scheduledSendAttempts ?? 0;
    const lease = message.scheduledSendLeaseExpiresAt ? Date.parse(message.scheduledSendLeaseExpiresAt) : NaN;
    const at = message.scheduledSendTime ? Date.parse(message.scheduledSendTime) : NaN;
    if (message.scheduledSendError && !message.scheduledSendTime && !(lease > now)) {
        return { state: "failed", attempts, error: message.scheduledSendError };
    }
    if (lease > now) {
        return { state: attempts > 0 ? "retrying" : "sending", attempts };
    }
    if (attempts > 0) {
        return { state: "retrying", attempts, at: Number.isNaN(at) ? undefined : at };
    }
    const modified = message.dateModified ? Date.parse(message.dateModified) : NaN;
    const dueWhenModified = at - modified <= DUE_SLACK_MS;
    if (at > now && !dueWhenModified) {
        return { state: "scheduled", attempts, at };
    }
    return { state: "sending", attempts };
}

/** How many messages of each kind an Outbox folder holds. */
export interface OutboxFolderStatus {
    sending: number;
    retrying: number;
    failed: number;
    scheduled: number;
}

export const EMPTY_OUTBOX_STATUS: OutboxFolderStatus = { sending: 0, retrying: 0, failed: 0, scheduled: 0 };

export function summarizeOutbox(messages: Message[], now: number = Date.now()): OutboxFolderStatus {
    const status = { ...EMPTY_OUTBOX_STATUS };
    for (const message of messages) {
        status[outboxItemStatus(message, now).state] += 1;
    }
    return status;
}

/** The text a screen reader gets for an Outbox count, and the tooltip: "2 messages sending", "3 messages, 1 failed". */
export function outboxLabel(total: number, status: OutboxFolderStatus | undefined, pendingHere: number): string {
    const noun = `${total} ${total === 1 ? "message" : "messages"}`;
    if (status && status.failed > 0) {
        return `${noun}, ${status.failed} failed`;
    }
    const inFlight = (status ? status.sending + status.retrying : 0) + pendingHere;
    if (inFlight > 0) {
        return `${noun} sending`;
    }
    return status && status.scheduled > 0 && status.scheduled === total ? `${noun} scheduled` : noun;
}
