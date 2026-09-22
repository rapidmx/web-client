///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RecipientEncryptionStatus, decideMessageEncryption } from "@rapidmx/react-shared/crypto/composeSecurity.js";
import type { EncryptionPolicy } from "@rapidmx/react-shared/crypto/keyvaultApi.js";

/**
 * Whether a message must be treated as encrypted - the one place that decides it, as a pure function of what is *known*.
 *
 * **The rule is fail open.** A message is plain, its draft is saved, and nothing about encryption is ever shown, unless encryption is
 * actually in play. Encryption is in play only when
 *
 * 1. the user asked for it ("Encrypt this message", or a reply to encrypted mail, whose quote may carry decrypted text) - that is local
 * knowledge and needs no request to have succeeded; or
 * 2. the system's encryption policy **was loaded successfully**, this sender has an encryption key (enrolled on their mailbox, or unlocked
 * in this tab), the message has recipients, **every** recipient's key lookup succeeded, and the policy auto-applies encryption to all
 * of them (`decideMessageEncryption().autoEncrypt`: policy `automatic` for their tier, both sides preferring "mutual", a key found).
 *
 * Anything that failed to load, is still loading or is slow (the policy, the mailbox, a recipient's lookup) is **unknown**, and unknown
 * counts as "not encrypted": that is what stops a gateway that flaps, a slow request, or a user who has never set encryption up from
 * ever blocking a draft, blocking Close, blocking Send or showing an "encryption can't be checked" message. What was unknown is
 * reported in `unknown`, so a caller that is about to send can give the loads a moment - and only a caller that finds out later that the
 * message *does* need encryption acts on it (see `ComposeWindow`'s transition rules).
 *
 * Why this is safe enough: the requirement only ever protects *this client's* plaintext drafts and sends from being unencrypted when the
 * server's policy says they should be; it is not the enforcement point (the keys are the user's, the server never sees them). A missing
 * policy therefore does not mean "encrypt or refuse" - it means the client cannot tell, and the honest default is the one that works.
 */
export interface EncryptionFacts {
    /** The user turned encryption on, or this compose is a reply to / forward of an encrypted message. */
    encryptRequested: boolean;
    /** The policy, once it has loaded; `undefined` while loading, failed or slow. */
    policy: EncryptionPolicy | undefined;
    /** The sender's mailbox has loaded (its enrolled keys are known). */
    mailboxLoaded: boolean;
    /** The sender has an encryption key to encrypt with: enrolled on the mailbox, unlocked in this tab, or offered earlier this session. */
    hasEncryptionKey: boolean;
    /** One entry per current recipient (To, Cc and Bcc): the resolved status, or `undefined` while that recipient's lookup is pending or failed. */
    recipients: (RecipientEncryptionStatus | undefined)[];
}

export type EncryptionReason = "requested" | "policy";

/** What was not known, and could still change the answer. */
export type UnknownFact = "mailbox" | "policy" | "recipients";

export interface EncryptionRequirement {
    /** The message must be encrypted: it is never stored as a plaintext draft and never sent in the clear. */
    required: boolean;
    reason: EncryptionReason | null;
    /** What was unknown (and so assumed "no encryption"). Empty when the answer cannot change with more loading. Never shown to the user. */
    unknown: UnknownFact[];
}

/** Any tier of `policy` auto-encrypts - only then can what is still unknown about the recipients turn a message into an encrypted one. */
export function policyCanAutoEncrypt(policy: EncryptionPolicy): boolean {
    return [policy.encryptSameOrg, policy.encryptFederated, policy.encryptExternal].includes("automatic");
}

export function evaluateEncryptionRequirement(facts: EncryptionFacts): EncryptionRequirement {
    if (facts.encryptRequested) {
        return { required: true, reason: "requested", unknown: [] };
    }
    const unknown: UnknownFact[] = [];
    if (!facts.hasEncryptionKey) {
        // Without a key nothing can be encrypted: a user who never set encryption up sees nothing at all. Whether the mailbox has one is
        // only *unknown* while it has not loaded.
        return { required: false, reason: null, unknown: facts.mailboxLoaded ? [] : ["mailbox"] };
    }
    if (!facts.policy) {
        return { required: false, reason: null, unknown: ["policy"] };
    }
    if (!policyCanAutoEncrypt(facts.policy)) {
        return { required: false, reason: null, unknown };
    }
    if (facts.recipients.length === 0) {
        // Nobody to decide by yet: plain until a recipient is added.
        return { required: false, reason: null, unknown };
    }
    const statuses = facts.recipients.filter((status): status is RecipientEncryptionStatus => !!status);
    if (statuses.length < facts.recipients.length) {
        return { required: false, reason: null, unknown: ["recipients"] };
    }
    return decideMessageEncryption(statuses).autoEncrypt ? { required: true, reason: "policy", unknown } : { required: false, reason: null, unknown };
}
