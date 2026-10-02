///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useSyncExternalStore } from "react";
import { getUnlockedKeys, subscribeKeySession } from "../../../lib/crypto/keySession.js";
import { getMessageRawContent } from "../../../lib/mail/mailApi.js";
import { onSigningOut } from "../components/mail/compose/composeFlushRegistry.js";

/**
 * What this device has recovered of encrypted messages by decrypting them: the real subject (the server only ever holds RFC 9788's `[...]`
 * placeholder) and a short preview. Shared by every view that draws a message - the message list, the conversation list and the reading pane -
 * so a message decrypted in one shows its subject in all of them. Held in memory only, keyed by message uid, and dropped for a mailbox the moment
 * its keys are locked, exactly like the decrypted content it came from.
 */
export interface DecryptedMessage {
    mailboxUid: string;
    subject?: string;
    preview?: string;
}

const PREVIEW_MAX_LENGTH = 160;

let entries: Record<string, DecryptedMessage> = {};
/** Bumped whenever a mailbox's keys are unlocked, so a view can retry decrypting what it couldn't before. */
let unlockEpoch = 0;
const listeners = new Set<() => void>();
const inFlight = new Set<string>();

/** How long a message that could not be decrypted is left alone before it is tried again (it is also tried again after any unlock). */
const DECRYPT_RETRY_MS = 10 * 60_000;
/** How many such messages are remembered. */
const MAX_FAILED = 1000;
/** The messages whose decrypting came to nothing (fetch failed, not for this key, nothing readable), by uid: when and in which unlock epoch. */
const failed = new Map<string, { epoch: number; at: number }>();

/** Whether decrypting this message already came to nothing since the keys were last unlocked, recently enough that trying again would only repeat it. */
export function decryptFailedBefore(uid: string): boolean {
    const known = failed.get(uid);
    return !!known && known.epoch === unlockEpoch && Date.now() - known.at < DECRYPT_RETRY_MS;
}

/** Remembers that decrypting this message came to nothing, so a list that refreshes does not download and try it again each time. */
export function markDecryptFailed(uid: string): void {
    failed.delete(uid);
    if (failed.size >= MAX_FAILED) {
        failed.delete(failed.keys().next().value!);
    }
    failed.set(uid, { epoch: unlockEpoch, at: Date.now() });
}

/** Forgets everything remembered about messages that could not be decrypted (sign-out, an account switch). */
export function clearDecryptedMessages(): void {
    entries = {};
    failed.clear();
    emit();
}
onSigningOut(clearDecryptedMessages);

/** Runs `task` over `items` with at most `limit` running at once, resolving to the results in the order of `items`. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    async function worker(): Promise<void> {
        while (next < items.length) {
            const index = next++;
            results[index] = await task(items[index]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

function emit(): void {
    for (const listener of [...listeners]) {
        listener();
    }
}

subscribeKeySession(({ mailboxUid, state }) => {
    if (state === "locked") {
        const kept = Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.mailboxUid !== mailboxUid));
        if (Object.keys(kept).length !== Object.keys(entries).length) {
            entries = kept;
        }
    } else {
        unlockEpoch++;
    }
    emit();
});

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Plain text of decrypted HTML for a one-line preview. Only ever feeds text display, never markup. */
export function previewOf(html: string): string {
    return html
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;/gi, "'")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, PREVIEW_MAX_LENGTH);
}

/** Remembers what was recovered of one message. Ignored when there is nothing new to show. */
export function rememberDecrypted(uid: string, mailboxUid: string, found: { subject?: string; preview?: string }): void {
    if (!found.subject && !found.preview) {
        return;
    }
    const current = entries[uid];
    if (current && current.subject === found.subject && current.preview === found.preview) {
        return;
    }
    entries = { ...entries, [uid]: { mailboxUid, subject: found.subject, preview: found.preview } };
    emit();
}

/** Every message decrypted so far, by uid; a new object whenever any changes. */
export function useDecryptedMessages(): Record<string, DecryptedMessage> {
    return useSyncExternalStore(subscribe, () => entries);
}

/** A number that changes whenever a mailbox is unlocked - a dependency for effects that decrypt what they can. */
export function useUnlockEpoch(): number {
    return useSyncExternalStore(subscribe, () => unlockEpoch);
}

/**
 * Decrypts one message to recover its subject and preview, when its mailbox's keys are unlocked and it isn't already known. Best effort: a
 * message that can't be fetched or opened is simply left as it was. Never prompts.
 */
export async function decryptForDisplay(uid: string, mailboxUid: string): Promise<void> {
    const unlocked = getUnlockedKeys(mailboxUid);
    if (!unlocked || entries[uid] || inFlight.has(uid) || decryptFailedBefore(uid)) {
        return;
    }
    inFlight.add(uid);
    try {
        const rawMime = await getMessageRawContent(uid);
        const { evaluateMessageSecurity } = await import("../../../lib/crypto/messageSecurity.js");
        const security = await evaluateMessageSecurity(rawMime, unlocked);
        // A lock while this ran: the result must not go back on screen.
        if (getUnlockedKeys(mailboxUid) === unlocked) {
            rememberDecrypted(uid, mailboxUid, { subject: security.subject, preview: security.html ? previewOf(security.html) : security.text?.slice(0, PREVIEW_MAX_LENGTH) });
            if (!security.subject && !security.html && !security.text) {
                markDecryptFailed(uid);
            }
        }
    } catch {
        // Left as the placeholder - and not fetched again until the next unlock.
        markDecryptFailed(uid);
    } finally {
        inFlight.delete(uid);
    }
}
