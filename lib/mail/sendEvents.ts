///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiRequestError } from "../util/api.js";
import type { PushEvent } from "./pushClient.js";
import { describeSendFailure, SendFailure } from "./sendFailure.js";

/**
 * The outcome of a message sent in the background (`queueMessageSend()`), as the server publishes it on the sender's mailbox,
 * Outbox and Sent Items channels once it has relayed - or failed to relay - the message:
 * `{ type: <the Message model's class name>, action: "send-succeeded" | "send-failed" | "send-retrying", data: {...} }`.
 */
export type SendEventAction = "send-succeeded" | "send-failed" | "send-retrying";

export interface SendEvent {
    action: SendEventAction;
    /** The message's uid. */
    uid: string;
    mailboxUid?: string;
    subject: string;
    /** Everyone the message was addressed to, as addresses. */
    recipients: string[];
    /** Which delivery attempt this outcome is about, from 1. */
    attempt: number;
    /** `send-retrying`: when the next attempt is made (ISO 8601). */
    nextAttemptAt?: string;
    /** `send-failed` / `send-retrying`: why the attempt failed. `details` is the shape `describeSendFailure()` reads. */
    error?: { message: string; details?: unknown };
}

const ACTIONS = new Set<string>(["send-succeeded", "send-failed", "send-retrying"]);

function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/**
 * The send outcome a push event carries, or `undefined` when it is not one (another action, another type, a malformed payload).
 * Read defensively: the payload is data from the network, so every field is checked and nothing is assumed.
 */
export function parseSendEvent(event: PushEvent): SendEvent | undefined {
    if (!/^Message/.test(event.type) || !event.action || !ACTIONS.has(event.action)) {
        return undefined;
    }
    const data = event.data as Record<string, unknown> | null | undefined;
    const uid = asString(data?.uid);
    if (!data || !uid) {
        return undefined;
    }
    const recipients = Array.isArray(data.recipients) ? data.recipients.filter((r): r is string => typeof r === "string") : [];
    const attempt = typeof data.attempt === "number" && Number.isFinite(data.attempt) && data.attempt >= 1 ? Math.floor(data.attempt) : 1;
    const error = data.error as Record<string, unknown> | null | undefined;
    return {
        action: event.action as SendEventAction,
        uid,
        mailboxUid: asString(data.mailboxUid),
        subject: asString(data.subject) ?? "",
        recipients,
        attempt,
        nextAttemptAt: asString(data.nextAttemptAt),
        error: error && typeof error === "object" ? { message: asString(error.message) ?? "", details: error.details } : undefined,
    };
}

/** A send event's `error`, ready to show: the same plain message and technical lines a synchronous failure has. */
export function describeSendEventError(error: SendEvent["error"], fallback: string): SendFailure {
    if (!error) {
        return { message: fallback, lines: [] };
    }
    return describeSendFailure(new ApiRequestError(error.message || fallback, 0, undefined, error.details === undefined ? undefined : { details: error.details }), fallback);
}
