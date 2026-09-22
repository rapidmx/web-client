///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RecipientEncryptionStatus, decideMessageEncryption } from "@rapidmx/react-shared/crypto/composeSecurity.js";
import type { EncryptionPolicy } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { evaluateEncryptionRequirement } from "../../components/mail/compose/encryptionRequirement.js";

/** Signed/encrypted bodies are built client-side from the editor's HTML verbatim, so an inline image (an uploaded attachment previewed via
 * its content URL, or a `cid:` reference) would never be carried - only `assembleDraft()`'s server-side plaintext path rewrites those into
 * real MIME parts. */
export const INLINE_IMAGE_PATTERN = /<img\b[^>]*\bsrc\s*=\s*["']?(?:cid:|[^"'\s>]*\/mail\/attachments\/[^"'\s>]+\/content)/i;

export const KEYS_LOCKED_SIGN_MESSAGE =
    "This message can't be signed right now - your signing key is locked or your mailbox details couldn't be loaded. Unlock and send again, or send it without signing.";
export const KEYS_LOCKED_ENCRYPT_MESSAGE =
    "This message can't be encrypted right now - your encryption key is locked. Unlock and send again, or send it without encryption.";
export const BCC_ENCRYPTED_MESSAGE = "Bcc recipients can't be used with encrypted messages. Remove Bcc recipients or turn off encryption.";
export const LOOKUP_UNAVAILABLE_MESSAGE =
    "Your recipients' encryption keys couldn't be checked, so this message can't be encrypted right now. Try again, or send it without encryption.";
/** The plain sentence for recipients an encrypted message can't reach (no key on file, or the policy prohibits it). */
export function recipientsBlockedMessage(blocked: RecipientEncryptionStatus[]): string {
    const reason = blocked[0]?.prohibitedReason ? ` — ${blocked[0].prohibitedReason}` : " has no encryption key on file";
    return `This message can’t be encrypted for everyone: ${blocked.map((r) => r.address).join(", ")}${reason}. Remove ${blocked.length > 1 ? "these recipients" : "this recipient"} from To/Cc/Bcc, or send the whole message in plaintext.`;
}
export const MAILBOX_UNAVAILABLE_MESSAGE =
    "Your mailbox details couldn't be loaded, so this message can't be encrypted right now. Try again, or send it without encryption.";
export const ATTACHMENTS_UNSUPPORTED_MESSAGE = "A signed or encrypted message cannot include file attachments yet - remove them before sending.";
export const INLINE_IMAGES_UNSUPPORTED_MESSAGE = "A signed or encrypted message cannot include inline images yet - remove them before sending.";

/** Why a send is refused *before* anything is sent: signing/encryption was asked for (or applies) but cannot happen right now. Never a silent
 * downgrade to plaintext - the sender explicitly picks the override. */
export interface SendBlock {
    kind: "signing-locked" | "encryption-locked" | "lookup-failed" | "mailbox-unavailable" | "bcc" | "recipients";
    message: string;
    /** The button that sends it anyway, without encryption (and without signing when that is what was blocked). */
    overrideLabel: string;
    /** The cause is keys that are enrolled but not unlocked in this tab: an Unlock action helps. */
    keysLocked: boolean;
    /** `recipients`: who has no key (or is not allowed one). */
    blockedRecipients?: RecipientEncryptionStatus[];
}

export type SendDecision =
    | { action: "plain" }
    | { action: "sign" }
    | { action: "encrypt"; sign: boolean }
    | { action: "blocked"; block: SendBlock }
    /** Not sendable as composed, and no override helps: fix the message. */
    | { action: "rejected"; message: string };

export interface SendDecisionInput {
    /** The sender's explicit choice to skip every encryption/signing check (an override button): it never encrypts, and still signs if it can. */
    forcePlaintext: boolean;
    /** The "sign" checkbox. */
    signEnabled: boolean;
    /** The signing option was shown at some point this compose session (the keys were unlocked): losing the keys then blocks, never silently unsigns. */
    offeredSign: boolean;
    encryptRequested: boolean;
    policy: EncryptionPolicy | undefined;
    mailboxLoaded: boolean;
    hasEncryptionKey: boolean;
    keys: {
        /** Signing is possible now: enabled, mailbox loaded (for the protected headers), signing key unlocked. */
        canSign: boolean;
        /** The encryption key is unlocked. */
        canEncryptSelf: boolean;
        /** Any key material is unlocked in this tab. */
        unlocked: boolean;
    };
    /** Every recipient (To, Cc and Bcc), resolved; `undefined` where the lookup failed - or, with `lookupsComplete: false`, was not made. */
    recipients: (RecipientEncryptionStatus | undefined)[];
    /** Whether the lookups were all *attempted*: `false` for the early check a compose window makes from what it already knows. */
    lookupsComplete: boolean;
    hasBcc: boolean;
    hasAttachments: boolean;
    hasInlineImages: boolean;
}

/**
 * How a message may go out, decided from the facts alone (no requests, no React): plain, signed, encrypted, refused with an override the sender
 * can choose, or rejected outright. Used twice with the same rules - by the compose window, from what it already knows, to catch a problem
 * *before* it closes (`lookupsComplete: false`), and by the background send, once its recipient lookups are in.
 *
 * Encryption follows `evaluateEncryptionRequirement()` - fail open: only a message the user asked to encrypt, or one the loaded policy
 * encrypts, is encrypted; everything unknown is plain and sends. The one place unknown blocks is a message the user *explicitly* asked to
 * encrypt whose recipients' keys could not be looked up: they asked for encryption, and it cannot be delivered.
 */
export function decideSend(input: SendDecisionInput): SendDecision {
    const { keys } = input;
    const attachmentsAreAProblem = (encrypting: boolean) => (encrypting || keys.canSign) && input.hasAttachments;
    const imagesAreAProblem = (encrypting: boolean) => (encrypting || keys.canSign) && input.hasInlineImages;

    if (input.forcePlaintext) {
        if (attachmentsAreAProblem(false)) {
            return { action: "rejected", message: ATTACHMENTS_UNSUPPORTED_MESSAGE };
        }
        if (imagesAreAProblem(false)) {
            return { action: "rejected", message: INLINE_IMAGES_UNSUPPORTED_MESSAGE };
        }
        return keys.canSign ? { action: "sign" } : { action: "plain" };
    }

    if (input.signEnabled && input.offeredSign && !keys.canSign) {
        return {
            action: "blocked",
            block: { kind: "signing-locked", message: KEYS_LOCKED_SIGN_MESSAGE, overrideLabel: "Send without signing or encryption", keysLocked: !keys.unlocked },
        };
    }

    if (input.encryptRequested && !input.mailboxLoaded) {
        // Asked for explicitly, and there is nothing to encrypt with (the sender's address and keys come from the mailbox).
        return { action: "blocked", block: { kind: "mailbox-unavailable", message: MAILBOX_UNAVAILABLE_MESSAGE, overrideLabel: "Send without encryption", keysLocked: false } };
    }

    const requirement = evaluateEncryptionRequirement({
        encryptRequested: input.encryptRequested,
        policy: input.policy,
        mailboxLoaded: input.mailboxLoaded,
        hasEncryptionKey: input.hasEncryptionKey,
        recipients: input.recipients,
    });
    const encrypting = requirement.required;

    if (encrypting) {
        const statuses = input.recipients.filter((status): status is RecipientEncryptionStatus => !!status);
        const allResolved = statuses.length === input.recipients.length;
        if (!allResolved && input.lookupsComplete) {
            // Only reachable for an explicit request (a policy requirement needs every status): the sender asked for encryption and the
            // recipients' keys could not be checked.
            return { action: "blocked", block: { kind: "lookup-failed", message: LOOKUP_UNAVAILABLE_MESSAGE, overrideLabel: "Send without encryption", keysLocked: false } };
        }
        if (!keys.canEncryptSelf) {
            return { action: "blocked", block: { kind: "encryption-locked", message: KEYS_LOCKED_ENCRYPT_MESSAGE, overrideLabel: "Send without encryption", keysLocked: !keys.unlocked } };
        }
        if (allResolved) {
            const decision = decideMessageEncryption(statuses);
            if (!decision.canEncryptAll) {
                return {
                    action: "blocked",
                    block: { kind: "recipients", message: recipientsBlockedMessage(decision.blockedRecipients), overrideLabel: "Send without encryption", keysLocked: false, blockedRecipients: decision.blockedRecipients },
                };
            }
        }
        if (input.hasBcc) {
            return { action: "blocked", block: { kind: "bcc", message: BCC_ENCRYPTED_MESSAGE, overrideLabel: "Send without encryption", keysLocked: false } };
        }
    }

    if (attachmentsAreAProblem(encrypting)) {
        return { action: "rejected", message: ATTACHMENTS_UNSUPPORTED_MESSAGE };
    }
    if (imagesAreAProblem(encrypting)) {
        return { action: "rejected", message: INLINE_IMAGES_UNSUPPORTED_MESSAGE };
    }
    return encrypting ? { action: "encrypt", sign: keys.canSign } : keys.canSign ? { action: "sign" } : { action: "plain" };
}
