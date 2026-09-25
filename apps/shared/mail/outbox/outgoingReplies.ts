///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useSyncExternalStore } from "react";
import type { Message } from "@rapidmx/react-shared/mail/mailApi.js";
import type { MailAddressLike } from "@rapidmx/react-shared/mail/mailAddress.js";
import type { NotificationAction } from "../../notifications/store.js";
import type { SendRequest } from "./sendJob.js";

/**
 * A reply (or forward) this tab has sent, as the open conversation shows it until the server's own copy is in the thread.
 *
 * This is a *view* of the background send that is already there, not a second state machine: `startSend()` (`sendJob.ts`) opens an entry, and the
 * places that already report how a send went close it - the client-side failure (`notifyFailure()`), the server's own outcome (`handleSendEvent()`
 * in `sendOutcomes.ts`: `send-succeeded`, `send-failed`) and a synchronous send. The Outbox indicator, the pop-ups and this entry therefore agree,
 * because they are all told by the same code at the same moment.
 *
 * Why the message has to be shown from here for a while: a message the server accepted is in Outbox, which has no `conversationId` yet - it is
 * resolved when the message is relayed and filed in Sent Items (`ScheduledSendJob`), keeping the same `uid`. Until then no fetch of the
 * conversation can return it, so the thread pane draws it from what was composed.
 *
 * `sending` covers everything up to the server's answer (assembling, the request, the queue in Outbox); `failed` is a send that did not go and is
 * the sender's to resolve (`actions` are the very ones the pop-up offers: Retry, Open draft ...); `sent` is a message the server has relayed and
 * that is waiting for the thread to be read again to find its Sent Items copy.
 */
export type OutgoingState = "sending" | "failed" | "sent";

export interface OutgoingReply {
    /** The draft's uid - which is also the uid of the message in Outbox and of its Sent Items copy, and so what the real message replaces this by. */
    uid: string;
    mailboxUid: string;
    /** What the message replies to (`Message.inReplyTo` / `references`): how the pane knows which conversation it belongs to. */
    inReplyTo?: string;
    references: string[];
    sender: MailAddressLike;
    to: MailAddressLike[];
    cc: MailAddressLike[];
    bcc: MailAddressLike[];
    subject: string;
    /** The composed body, as the editor wrote it. */
    html: string;
    startedAt: number;
    state: OutgoingState;
    /** `failed`: why. */
    failure?: string;
    /** `failed`: what the sender can do about it. */
    actions: NotificationAction[];
    /** `sent`: how many times the thread was read without finding the message - see `settleOutgoing()`. */
    misses: number;
}

/** The most entries kept; the oldest go first. Every entry is a message this tab sent, so this is generous. */
const MAX_TRACKED = 25;
/** A sent message that a read of its conversation has not found this many times is not part of that conversation (the server filed it elsewhere). */
export const MAX_SETTLE_MISSES = 2;

const NO_REPLIES: readonly OutgoingReply[] = [];
let replies: OutgoingReply[] = [];
let snapshot: readonly OutgoingReply[] = replies;
const listeners = new Set<() => void>();

function commit(next: OutgoingReply[]): void {
    replies = next;
    snapshot = next;
    for (const listener of [...listeners]) {
        listener();
    }
}

function update(uid: string, patch: Partial<OutgoingReply>): void {
    if (replies.some((reply) => reply.uid === uid)) {
        commit(replies.map((reply) => (reply.uid === uid ? { ...reply, ...patch } : reply)));
    }
}

/**
 * Starts showing `request`'s message in the conversation it replies to - or does nothing for a message that replies to nothing (a new message
 * starts a conversation of its own, it is never part of an open one) and for a send-later message (it is not sent yet). Called again for the same
 * message - a Retry - it starts over as `sending`.
 *
 * The thread is `request.threading` (the compose session's), else what the draft itself records: a draft opened again from "Open draft" is a
 * session with no threading of its own, but the server kept it on the message.
 */
export function trackOutgoing(request: SendRequest): void {
    const source = request.threading ?? request.draft;
    const references = source.references ?? [];
    if (request.scheduledSendTime || (!source.inReplyTo && references.length === 0)) {
        return;
    }
    const { mailbox } = request;
    const reply: OutgoingReply = {
        uid: request.draft.uid,
        mailboxUid: request.mailboxUid,
        inReplyTo: source.inReplyTo,
        references,
        // The mailbox is only unknown when the window's own load of it had not succeeded: "Me" is what a sender is called then.
        sender: mailbox ? { address: mailbox.primarySmtpAddress, displayName: mailbox.displayName } : { address: "Me" },
        to: request.to,
        cc: request.cc,
        bcc: request.bcc,
        subject: request.subject,
        html: request.html,
        startedAt: Date.now(),
        state: "sending",
        actions: [],
        misses: 0,
    };
    commit([...replies.filter((existing) => existing.uid !== reply.uid), reply].slice(-MAX_TRACKED));
}

/** The send did not go: `failure` is why, `actions` what can be done (Retry, Open draft ...). */
export function failOutgoing(uid: string, failure: string, actions: NotificationAction[]): void {
    update(uid, { state: "failed", failure, actions });
}

/** A failed send is being tried again. */
export function markOutgoingSending(uid: string): void {
    update(uid, { state: "sending", failure: undefined, actions: [] });
}

/** The server has relayed the message: its Sent Items copy is what the conversation shows next. */
export function markOutgoingSent(uid: string): void {
    update(uid, { state: "sent" });
}

/** Stops showing a message - it went back to Drafts to be edited. */
export function forgetOutgoing(uid: string): void {
    if (replies.some((reply) => reply.uid === uid)) {
        commit(replies.filter((reply) => reply.uid !== uid));
    }
}

/** Whether `reply` continues the conversation `messages` are: it answers one of them, or its `References` chain runs through one. */
export function belongsToThread(reply: OutgoingReply, messages: readonly Pick<Message, "messageId">[]): boolean {
    return messages.some((message) => !!message.messageId && (message.messageId === reply.inReplyTo || reply.references.includes(message.messageId)));
}

/** The uids of the messages sent from here whose real copy is in `messages`, the thread as it was just read. */
export function adoptedOutgoing(mailboxUid: string, messages: readonly Message[]): string[] {
    return replies.filter((reply) => reply.mailboxUid === mailboxUid && messages.some((message) => message.uid === reply.uid)).map((reply) => reply.uid);
}

/**
 * Called with a mailbox's conversation as it was just read, `messages` being the whole thread: forgets the messages whose real copy is now in it
 * (`adoptedOutgoing()`), and gives up on a *sent* message that belongs to this thread but that the read did not find `MAX_SETTLE_MISSES` times in a
 * row - the server filed it in a conversation of its own, and it is not to be shown here. A message of another conversation is left alone.
 *
 * A pane draws the messages it has read *before* it calls this, so that there is never a moment with neither the pending card nor the real one.
 */
export function settleOutgoing(mailboxUid: string, messages: readonly Message[]): void {
    const adopted = new Set(adoptedOutgoing(mailboxUid, messages));
    const next: OutgoingReply[] = [];
    let changed = adopted.size > 0;
    for (const reply of replies) {
        if (adopted.has(reply.uid)) {
            continue;
        }
        if (reply.mailboxUid === mailboxUid && reply.state === "sent" && belongsToThread(reply, messages)) {
            changed = true;
            if (reply.misses + 1 < MAX_SETTLE_MISSES) {
                next.push({ ...reply, misses: reply.misses + 1 });
            }
        } else {
            next.push(reply);
        }
    }
    if (changed) {
        commit(next);
    }
}

export function getOutgoingReplies(): readonly OutgoingReply[] {
    return snapshot;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** The messages this tab has sent that a conversation may still need to show, oldest first. */
export function useOutgoingReplies(): readonly OutgoingReply[] {
    return useSyncExternalStore(subscribe, getOutgoingReplies, () => NO_REPLIES);
}

/** Forgets everything - for a test. */
export function resetOutgoingReplies(): void {
    commit([]);
}
