// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    classifyRecipientTier,
    decideMessageEncryption,
    isLikelyMailingList,
    resolveRecipientEncryption,
} from "../../../lib/crypto/composeSecurity.js";
import type { EncryptionPolicy, KeyLookupResult, PublicKey } from "../../../lib/crypto/keyvaultApi.js";

const ALL_AUTOMATIC: EncryptionPolicy = { encryptSameOrg: "automatic", encryptFederated: "automatic", encryptExternal: "automatic" };
const ALL_OPTIONAL: EncryptionPolicy = { encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional" };
const ALL_PROHIBITED: EncryptionPolicy = { encryptSameOrg: "prohibited", encryptFederated: "prohibited", encryptExternal: "prohibited" };

function activeKey(useType: "sign" | "encrypt", fingerprint = "fp"): PublicKey {
    return { publicKey: "base64der", type: "x509", useType, fingerprint, notBefore: Date.now() - 1000, notAfter: Date.now() + 1_000_000 };
}

describe("classifyRecipientTier", () => {
    it("is sameOrg when the domains match", () => {
        expect(classifyRecipientTier("alice@example.com", "bob@example.com", false)).toBe("sameOrg");
    });

    it("is federated when domains differ but keys were discovered", () => {
        expect(classifyRecipientTier("alice@example.com", "bob@other.com", true)).toBe("federated");
    });

    it("is external when domains differ and no keys were discovered", () => {
        expect(classifyRecipientTier("alice@example.com", "bob@other.com", false)).toBe("external");
    });

    it("is case-insensitive on the domain comparison", () => {
        expect(classifyRecipientTier("alice@Example.com", "bob@EXAMPLE.COM", false)).toBe("sameOrg");
    });
});

describe("resolveRecipientEncryption", () => {
    const lookupWithKey = (preferMutual: boolean): KeyLookupResult => ({
        keys: [activeKey("encrypt")],
        encryptPreference: { preferEncrypt: preferMutual ? "mutual" : "nopreference" },
    });

    it("cannot encrypt when the recipient has no usable key, regardless of policy", () => {
        const status = resolveRecipientEncryption("a@x.com", true, ALL_AUTOMATIC, "b@x.com", { keys: [] });
        expect(status.canEncrypt).toBe(false);
        expect(status.autoEncrypt).toBe(false);
        expect(status.prohibitedReason).toBeUndefined();
    });

    it("cannot encrypt when the lookup itself is undefined (discovery never ran or failed)", () => {
        const status = resolveRecipientEncryption("a@x.com", true, ALL_AUTOMATIC, "b@other.com", undefined);
        expect(status.canEncrypt).toBe(false);
        expect(status.tier).toBe("external");
    });

    it("auto-encrypts under automatic policy when both parties prefer mutual", () => {
        const status = resolveRecipientEncryption("a@x.com", true, ALL_AUTOMATIC, "b@x.com", lookupWithKey(true));
        expect(status.canEncrypt).toBe(true);
        expect(status.autoEncrypt).toBe(true);
    });

    it("does not auto-encrypt under automatic policy when only the recipient prefers mutual", () => {
        const status = resolveRecipientEncryption("a@x.com", false, ALL_AUTOMATIC, "b@x.com", lookupWithKey(true));
        expect(status.canEncrypt).toBe(true);
        expect(status.autoEncrypt).toBe(false);
    });

    it("does not auto-encrypt under automatic policy when only the sender prefers mutual", () => {
        const status = resolveRecipientEncryption("a@x.com", true, ALL_AUTOMATIC, "b@x.com", lookupWithKey(false));
        expect(status.canEncrypt).toBe(true);
        expect(status.autoEncrypt).toBe(false);
    });

    it("allows but never auto-defaults encryption under optional policy, even when both prefer mutual", () => {
        const status = resolveRecipientEncryption("a@x.com", true, ALL_OPTIONAL, "b@x.com", lookupWithKey(true));
        expect(status.canEncrypt).toBe(true);
        expect(status.autoEncrypt).toBe(false);
    });

    it("classifies a discovered different-domain recipient as federated and applies the federated policy tier", () => {
        const status = resolveRecipientEncryption("a@x.com", true, ALL_AUTOMATIC, "b@other.com", lookupWithKey(true));
        expect(status.tier).toBe("federated");
        expect(status.canEncrypt).toBe(true);
        expect(status.autoEncrypt).toBe(true);
    });

    it("blocks encryption outright under prohibited policy and explains why, even with a usable key", () => {
        const status = resolveRecipientEncryption("a@x.com", true, ALL_PROHIBITED, "b@x.com", lookupWithKey(true));
        expect(status.canEncrypt).toBe(false);
        expect(status.autoEncrypt).toBe(false);
        expect(status.prohibitedReason).toMatch(/policy/i);
    });
});

describe("decideMessageEncryption", () => {
    it("is false/false for no recipients", () => {
        expect(decideMessageEncryption([])).toEqual({ autoEncrypt: false, canEncryptAll: false, blockedRecipients: [] });
    });

    it("auto-encrypts and allows-all when every recipient independently qualifies", () => {
        const recipients = [
            { address: "b@x.com", tier: "sameOrg" as const, canEncrypt: true, autoEncrypt: true },
            { address: "c@x.com", tier: "sameOrg" as const, canEncrypt: true, autoEncrypt: true },
        ];
        expect(decideMessageEncryption(recipients)).toEqual({ autoEncrypt: true, canEncryptAll: true, blockedRecipients: [] });
    });

    it("does not auto-encrypt when only some recipients qualify, but still allows manual encryption if all can be encrypted to", () => {
        const recipients = [
            { address: "b@x.com", tier: "sameOrg" as const, canEncrypt: true, autoEncrypt: true },
            { address: "c@x.com", tier: "external" as const, canEncrypt: true, autoEncrypt: false },
        ];
        const decision = decideMessageEncryption(recipients);
        expect(decision.autoEncrypt).toBe(false);
        expect(decision.canEncryptAll).toBe(true);
        expect(decision.blockedRecipients).toEqual([]);
    });

    it("reports blocked recipients (all-or-nothing case) when at least one cannot be encrypted to", () => {
        const blocked = { address: "c@x.com", tier: "external" as const, canEncrypt: false, autoEncrypt: false };
        const recipients = [{ address: "b@x.com", tier: "sameOrg" as const, canEncrypt: true, autoEncrypt: true }, blocked];
        const decision = decideMessageEncryption(recipients);
        expect(decision.canEncryptAll).toBe(false);
        expect(decision.blockedRecipients).toEqual([blocked]);
    });
});

describe("isLikelyMailingList", () => {
    it("is true when a List-Id is present", () => {
        expect(isLikelyMailingList({ listId: "<foo.example.com>" })).toBe(true);
    });

    it("is true when a List-Unsubscribe is present", () => {
        expect(isLikelyMailingList({ listUnsubscribe: "<mailto:x@example.com>" })).toBe(true);
    });

    it("is false when neither is present", () => {
        expect(isLikelyMailingList({})).toBe(false);
    });
});
