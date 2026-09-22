///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import type { RecipientEncryptionStatus } from "@rapidmx/react-shared/crypto/composeSecurity.js";
import type { EncryptionPolicy } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { EncryptionFacts, evaluateEncryptionRequirement, policyCanAutoEncrypt } from "../../../apps/shared/components/mail/compose/encryptionRequirement.js";

const AUTO: EncryptionPolicy = { encryptSameOrg: "automatic", encryptFederated: "automatic", encryptExternal: "automatic" };
const OPTIONAL: EncryptionPolicy = { encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional" };
const NEVER: EncryptionPolicy = { encryptSameOrg: "prohibited", encryptFederated: "prohibited", encryptExternal: "prohibited" };

function status(address: string, overrides: Partial<RecipientEncryptionStatus> = {}): RecipientEncryptionStatus {
    return { address, tier: "sameOrg", canEncrypt: true, autoEncrypt: true, ...overrides };
}

const ENCRYPTABLE = status("a@example.com");
const NO_KEY = status("b@example.com", { canEncrypt: false, autoEncrypt: false });

function facts(overrides: Partial<EncryptionFacts> = {}): EncryptionFacts {
    return { encryptRequested: false, policy: AUTO, mailboxLoaded: true, hasEncryptionKey: true, recipients: [ENCRYPTABLE], ...overrides };
}

describe("evaluateEncryptionRequirement - fail open", () => {
    it("is plain and shows nothing for a user with no encryption key, whatever the policy, the lookups or their state", () => {
        for (const policy of [AUTO, OPTIONAL, NEVER, undefined]) {
            for (const recipients of [[], [ENCRYPTABLE], [undefined], [ENCRYPTABLE, undefined]]) {
                expect(evaluateEncryptionRequirement(facts({ hasEncryptionKey: false, policy, recipients }))).toEqual({ required: false, reason: null, unknown: [] });
            }
        }
    });

    it("only says the mailbox is unknown while it has not loaded (a key may be enrolled on it)", () => {
        expect(evaluateEncryptionRequirement(facts({ hasEncryptionKey: false, mailboxLoaded: false }))).toEqual({ required: false, reason: null, unknown: ["mailbox"] });
    });

    it("is plain when the policy has not loaded - loading, failed or slow are the same: unknown, assumed unencrypted", () => {
        expect(evaluateEncryptionRequirement(facts({ policy: undefined }))).toEqual({ required: false, reason: null, unknown: ["policy"] });
        expect(evaluateEncryptionRequirement(facts({ policy: undefined, recipients: [] }))).toEqual({ required: false, reason: null, unknown: ["policy"] });
    });

    it("is plain, with nothing unknown, when the loaded policy never auto-applies (optional / prohibited) whatever the recipients", () => {
        for (const policy of [OPTIONAL, NEVER]) {
            for (const recipients of [[], [ENCRYPTABLE], [undefined], [NO_KEY]]) {
                expect(evaluateEncryptionRequirement(facts({ policy, recipients }))).toEqual({ required: false, reason: null, unknown: [] });
            }
        }
    });

    it("is plain while there are no recipients to decide by, even under an automatic policy", () => {
        expect(evaluateEncryptionRequirement(facts({ recipients: [] }))).toEqual({ required: false, reason: null, unknown: [] });
    });

    it("is plain, with the recipients unknown, while any lookup is pending or failed - even if the others would encrypt", () => {
        expect(evaluateEncryptionRequirement(facts({ recipients: [undefined] }))).toEqual({ required: false, reason: null, unknown: ["recipients"] });
        expect(evaluateEncryptionRequirement(facts({ recipients: [ENCRYPTABLE, undefined] }))).toEqual({ required: false, reason: null, unknown: ["recipients"] });
    });

    it("requires encryption only when the policy loaded, the sender has a key, and every recipient auto-encrypts", () => {
        expect(evaluateEncryptionRequirement(facts())).toEqual({ required: true, reason: "policy", unknown: [] });
        expect(evaluateEncryptionRequirement(facts({ recipients: [ENCRYPTABLE, status("c@example.com")] }))).toMatchObject({ required: true, reason: "policy" });
    });

    it("does not require it when some recipient does not auto-encrypt (no key, or no mutual preference)", () => {
        expect(evaluateEncryptionRequirement(facts({ recipients: [ENCRYPTABLE, NO_KEY] }))).toEqual({ required: false, reason: null, unknown: [] });
        expect(evaluateEncryptionRequirement(facts({ recipients: [status("d@example.com", { autoEncrypt: false })] }))).toMatchObject({ required: false });
    });

    it("requires it when the user asked, needing no load at all (a reply to encrypted mail included)", () => {
        for (const policy of [AUTO, OPTIONAL, NEVER, undefined]) {
            for (const mailboxLoaded of [true, false]) {
                for (const hasEncryptionKey of [true, false]) {
                    expect(evaluateEncryptionRequirement(facts({ encryptRequested: true, policy, mailboxLoaded, hasEncryptionKey, recipients: [undefined] }))).toEqual({
                        required: true,
                        reason: "requested",
                        unknown: [],
                    });
                }
            }
        }
    });
});

describe("policyCanAutoEncrypt", () => {
    it("is true when any tier is automatic", () => {
        expect(policyCanAutoEncrypt(AUTO)).toBe(true);
        expect(policyCanAutoEncrypt({ ...OPTIONAL, encryptExternal: "automatic" })).toBe(true);
        expect(policyCanAutoEncrypt({ ...OPTIONAL, encryptSameOrg: "automatic" })).toBe(true);
        expect(policyCanAutoEncrypt({ ...OPTIONAL, encryptFederated: "automatic" })).toBe(true);
        expect(policyCanAutoEncrypt(OPTIONAL)).toBe(false);
        expect(policyCanAutoEncrypt(NEVER)).toBe(false);
    });
});
