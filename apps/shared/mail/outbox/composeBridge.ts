///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { Attachment, Message } from "@rapidmx/react-shared/mail/mailApi.js";
import type { PublicKey } from "@rapidmx/react-shared/crypto/keyvaultApi.js";

/**
 * A compose window to re-open around a message that was already composed: a failed send's "Open draft". The message keeps its uid - the
 * server draft it was assembled into - and everything the sender had typed comes back exactly as it was, including what could not have
 * been read back from the server (the plain text of a message that was encrypted before it was stored).
 */
export interface ResumeCompose {
    /** The server draft the window continues - it must be in Drafts (a message that is in Outbox is moved back first). */
    draft: Message;
    mailboxUid: string;
    to: string;
    cc: string;
    bcc: string;
    subject: string;
    html: string;
    attachments: Attachment[];
    requestReceipt: boolean;
    signEnabled: boolean;
    encryptRequested: boolean;
}

/** What the app frame's compose provider offers to code that has no React context (a pop-up's action, a push-event handler). */
export interface ComposeOpenerInput {
    mailboxUid?: string;
    resume?: ResumeCompose;
}

let opener: ((input: ComposeOpenerInput) => void) | undefined;
let unlocker: ((mailboxUid: string, keys: PublicKey[]) => Promise<void>) | undefined;

/** Registered by `ComposeProvider`; returns the function that unregisters it. */
export function registerComposeOpener(open: (input: ComposeOpenerInput) => void): () => void {
    opener = open;
    return () => {
        if (opener === open) {
            opener = undefined;
        }
    };
}

/** Opens a compose window from outside React. `false` when no compose provider is mounted (nothing was opened). */
export function openComposeFromOutside(input: ComposeOpenerInput): boolean {
    if (!opener) {
        return false;
    }
    opener(input);
    return true;
}

/** Registered by the unlock prompt's owner; returns the function that unregisters it. */
export function registerUnlockOpener(unlock: (mailboxUid: string, keys: PublicKey[]) => Promise<void>): () => void {
    unlocker = unlock;
    return () => {
        if (unlocker === unlock) {
            unlocker = undefined;
        }
    };
}

/** Opens the existing unlock prompt from outside React. Resolves once the keys are unlocked; rejects when the user dismissed it (or there is no prompt). */
export function requestUnlockFromOutside(mailboxUid: string, keys: PublicKey[]): Promise<void> {
    return unlocker ? unlocker(mailboxUid, keys) : Promise.reject(new Error("No unlock prompt is available."));
}
