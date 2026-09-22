///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import type { RecipientEncryptionStatus } from "@rapidmx/react-shared/crypto/composeSecurity.js";
import type { EncryptionPolicy } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import {
    ATTACHMENTS_UNSUPPORTED_MESSAGE,
    BCC_ENCRYPTED_MESSAGE,
    INLINE_IMAGES_UNSUPPORTED_MESSAGE,
    INLINE_IMAGE_PATTERN,
    KEYS_LOCKED_ENCRYPT_MESSAGE,
    KEYS_LOCKED_SIGN_MESSAGE,
    LOOKUP_UNAVAILABLE_MESSAGE,
    MAILBOX_UNAVAILABLE_MESSAGE,
    SendDecisionInput,
    decideSend,
    recipientsBlockedMessage,
} from "../../../apps/shared/mail/outbox/sendDecision.js";

const AUTO: EncryptionPolicy = { encryptSameOrg: "automatic", encryptFederated: "automatic", encryptExternal: "automatic" };
const OPTIONAL: EncryptionPolicy = { encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional" };
const OK: RecipientEncryptionStatus = { address: "a@example.com", tier: "sameOrg", canEncrypt: true, autoEncrypt: true };
const NO_KEY: RecipientEncryptionStatus = { address: "b@example.com", tier: "external", canEncrypt: false, autoEncrypt: false };

function input(overrides: Partial<SendDecisionInput> = {}): SendDecisionInput {
    return {
        forcePlaintext: false,
        signEnabled: false,
        offeredSign: false,
        encryptRequested: false,
        policy: OPTIONAL,
        mailboxLoaded: true,
        hasEncryptionKey: false,
        keys: { canSign: false, canEncryptSelf: false, unlocked: false },
        recipients: [undefined],
        lookupsComplete: true,
        hasBcc: false,
        hasAttachments: false,
        hasInlineImages: false,
        ...overrides,
    };
}

describe("decideSend - plain by default (fail open)", () => {
    it("sends plain for a user with no keys, whatever loaded or not", () => {
        expect(decideSend(input())).toEqual({ action: "plain" });
        expect(decideSend(input({ policy: undefined, mailboxLoaded: false }))).toEqual({ action: "plain" });
        expect(decideSend(input({ recipients: [undefined], lookupsComplete: false }))).toEqual({ action: "plain" });
    });

    it("sends plain when the policy is unknown or the recipients' lookups failed and nothing was asked for, even with a key", () => {
        const withKey = { hasEncryptionKey: true, keys: { canSign: false, canEncryptSelf: true, unlocked: true } };
        expect(decideSend(input({ ...withKey, policy: undefined }))).toEqual({ action: "plain" });
        expect(decideSend(input({ ...withKey, policy: AUTO, recipients: [undefined] }))).toEqual({ action: "plain" });
    });

    it("signs when it can, and plain attachments are fine when nothing is signed or encrypted", () => {
        expect(decideSend(input({ signEnabled: true, offeredSign: true, keys: { canSign: true, canEncryptSelf: false, unlocked: true } }))).toEqual({ action: "sign" });
        expect(decideSend(input({ hasAttachments: true, hasInlineImages: true }))).toEqual({ action: "plain" });
    });
});

describe("decideSend - encryption that is really in play", () => {
    const keys = { canSign: false, canEncryptSelf: true, unlocked: true };

    it("encrypts a message the loaded policy applies to every recipient, signing too when it can", () => {
        expect(decideSend(input({ policy: AUTO, hasEncryptionKey: true, keys, recipients: [OK] }))).toEqual({ action: "encrypt", sign: false });
        expect(decideSend(input({ policy: AUTO, hasEncryptionKey: true, keys: { ...keys, canSign: true }, recipients: [OK] }))).toEqual({ action: "encrypt", sign: true });
    });

    it("encrypts a message the user asked to encrypt", () => {
        expect(decideSend(input({ encryptRequested: true, hasEncryptionKey: true, keys, recipients: [OK] }))).toEqual({ action: "encrypt", sign: false });
    });

    it("refuses a message it must encrypt while the key is locked, prompting an unlock only when other key material is locked too", () => {
        expect(decideSend(input({ encryptRequested: true, hasEncryptionKey: true, keys: { canSign: false, canEncryptSelf: false, unlocked: false }, recipients: [OK] }))).toEqual({
            action: "blocked",
            block: { kind: "encryption-locked", message: KEYS_LOCKED_ENCRYPT_MESSAGE, overrideLabel: "Send without encryption", keysLocked: true },
        });
        expect(decideSend(input({ encryptRequested: true, hasEncryptionKey: true, keys: { canSign: false, canEncryptSelf: false, unlocked: true }, recipients: [OK] }))).toMatchObject({
            block: { kind: "encryption-locked", keysLocked: false },
        });
    });

    it("refuses when an explicitly requested encryption cannot look its recipients up - but only once the lookups were attempted", () => {
        expect(decideSend(input({ encryptRequested: true, hasEncryptionKey: true, keys, recipients: [OK, undefined] }))).toEqual({
            action: "blocked",
            block: { kind: "lookup-failed", message: LOOKUP_UNAVAILABLE_MESSAGE, overrideLabel: "Send without encryption", keysLocked: false },
        });
        // The compose window's early check has not looked anyone up: it does not refuse for that (the background send does, once it has).
        expect(decideSend(input({ encryptRequested: true, hasEncryptionKey: true, keys, recipients: [OK, undefined], lookupsComplete: false }))).toEqual({ action: "encrypt", sign: false });
        expect(decideSend(input({ encryptRequested: true, hasEncryptionKey: true, keys: { ...keys, canEncryptSelf: false }, recipients: [undefined], lookupsComplete: false }))).toMatchObject({
            block: { kind: "encryption-locked" },
        });
    });

    it("refuses a requested encryption when the mailbox could not be loaded", () => {
        expect(decideSend(input({ encryptRequested: true, mailboxLoaded: false, hasEncryptionKey: true, keys, recipients: [OK] }))).toEqual({
            action: "blocked",
            block: { kind: "mailbox-unavailable", message: MAILBOX_UNAVAILABLE_MESSAGE, overrideLabel: "Send without encryption", keysLocked: false },
        });
    });

    it("refuses encryption for recipients that have no key, naming them, offering the override", () => {
        const decision = decideSend(input({ encryptRequested: true, hasEncryptionKey: true, keys, recipients: [OK, NO_KEY] }));
        expect(decision).toMatchObject({ action: "blocked", block: { kind: "recipients", blockedRecipients: [NO_KEY], overrideLabel: "Send without encryption" } });
        expect((decision as { block: { message: string } }).block.message).toBe(recipientsBlockedMessage([NO_KEY]));
    });

    it("refuses Bcc recipients on an encrypted message", () => {
        expect(decideSend(input({ encryptRequested: true, hasEncryptionKey: true, keys, recipients: [OK], hasBcc: true }))).toEqual({
            action: "blocked",
            block: { kind: "bcc", message: BCC_ENCRYPTED_MESSAGE, overrideLabel: "Send without encryption", keysLocked: false },
        });
    });

    it("rejects attachments and inline images on a signed or encrypted message", () => {
        expect(decideSend(input({ encryptRequested: true, hasEncryptionKey: true, keys, recipients: [OK], hasAttachments: true }))).toEqual({ action: "rejected", message: ATTACHMENTS_UNSUPPORTED_MESSAGE });
        expect(decideSend(input({ encryptRequested: true, hasEncryptionKey: true, keys, recipients: [OK], hasInlineImages: true }))).toEqual({
            action: "rejected",
            message: INLINE_IMAGES_UNSUPPORTED_MESSAGE,
        });
        const signing = { canSign: true, canEncryptSelf: false, unlocked: true };
        expect(decideSend(input({ keys: signing, hasAttachments: true }))).toEqual({ action: "rejected", message: ATTACHMENTS_UNSUPPORTED_MESSAGE });
        expect(decideSend(input({ keys: signing, hasInlineImages: true }))).toEqual({ action: "rejected", message: INLINE_IMAGES_UNSUPPORTED_MESSAGE });
    });
});

describe("decideSend - signing lost and the override", () => {
    it("refuses when the sign option was on offer and its key has locked since", () => {
        expect(decideSend(input({ signEnabled: true, offeredSign: true, keys: { canSign: false, canEncryptSelf: false, unlocked: false } }))).toEqual({
            action: "blocked",
            block: { kind: "signing-locked", message: KEYS_LOCKED_SIGN_MESSAGE, overrideLabel: "Send without signing or encryption", keysLocked: true },
        });
        expect(decideSend(input({ signEnabled: true, offeredSign: true, keys: { canSign: false, canEncryptSelf: false, unlocked: true } }))).toMatchObject({ block: { keysLocked: false } });
        // Never offered (nothing was ever unlocked) or switched off: nothing to lose.
        expect(decideSend(input({ signEnabled: true, offeredSign: false }))).toEqual({ action: "plain" });
        expect(decideSend(input({ signEnabled: false, offeredSign: true }))).toEqual({ action: "plain" });
    });

    it("the override sends plain, still signing when it can, skipping every encryption check, and still rejecting what can't be signed", () => {
        const keys = { canSign: false, canEncryptSelf: false, unlocked: false };
        expect(decideSend(input({ forcePlaintext: true, encryptRequested: true, signEnabled: true, offeredSign: true, keys, hasBcc: true }))).toEqual({ action: "plain" });
        expect(decideSend(input({ forcePlaintext: true, keys: { ...keys, canSign: true, unlocked: true } }))).toEqual({ action: "sign" });
        expect(decideSend(input({ forcePlaintext: true, keys: { ...keys, canSign: true, unlocked: true }, hasAttachments: true }))).toMatchObject({ action: "rejected" });
        expect(decideSend(input({ forcePlaintext: true, keys: { ...keys, canSign: true, unlocked: true }, hasInlineImages: true }))).toMatchObject({ action: "rejected" });
    });
});

describe("helpers", () => {
    it("words the blocked recipients: one or several, by policy or by a missing key", () => {
        expect(recipientsBlockedMessage([NO_KEY])).toBe(
            "This message can’t be encrypted for everyone: b@example.com has no encryption key on file. Remove this recipient from To/Cc/Bcc, or send the whole message in plaintext.",
        );
        expect(recipientsBlockedMessage([{ ...NO_KEY, prohibitedReason: "Policy says no." }, OK])).toBe(
            "This message can’t be encrypted for everyone: b@example.com, a@example.com — Policy says no.. Remove these recipients from To/Cc/Bcc, or send the whole message in plaintext.",
        );
    });

    it("recognises the inline images a signed message could not carry", () => {
        expect(INLINE_IMAGE_PATTERN.test('<p><img src="cid:abc"></p>')).toBe(true);
        expect(INLINE_IMAGE_PATTERN.test('<img alt="x" src="/api/mail/attachments/a1/content">')).toBe(true);
        expect(INLINE_IMAGE_PATTERN.test('<img src="https://elsewhere.example/x.png">')).toBe(false);
    });
});
