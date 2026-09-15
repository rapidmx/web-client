///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { PinnedKeyChangedError, type PublicKey } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import {
    KEY_CHANGE_FORBIDDEN_MESSAGE,
    KEY_CHANGE_GENERIC_MESSAGE,
    KEY_CHANGE_INVALID_MESSAGE,
    KEY_CHANGE_NOT_FOUND_MESSAGE,
    KEY_CHANGE_STALE_MESSAGE,
    conflictSourceLabel,
    groupFingerprint,
    keyChangeErrorMessage,
    keyPinnedSince,
    revocationLabel,
    sameFingerprint,
} from "../../../apps/shared/components/contacts/contactKeys.js";

const key: PublicKey = { publicKey: "x", type: "x509", useType: "sign", fingerprint: "aa", notBefore: 100, notAfter: 200 };

describe("keyChangeErrorMessage", () => {
    it.each([
        [new PinnedKeyChangedError("changed"), KEY_CHANGE_STALE_MESSAGE],
        [new ApiRequestError("bad", 400), KEY_CHANGE_INVALID_MESSAGE],
        [new ApiRequestError("nope", 403), KEY_CHANGE_FORBIDDEN_MESSAGE],
        [new ApiRequestError("gone", 404), KEY_CHANGE_NOT_FOUND_MESSAGE],
        [new ApiRequestError("boom", 500), KEY_CHANGE_GENERIC_MESSAGE],
        [new Error("network"), KEY_CHANGE_GENERIC_MESSAGE],
    ])("%s", (err, expected) => {
        expect(keyChangeErrorMessage(err)).toBe(expected);
    });
});

describe("fingerprints", () => {
    it("groups into lowercase blocks of four, dropping separators", () => {
        expect(groupFingerprint("AB:12:CD:34 EF")).toBe("ab12 cd34 ef");
        expect(groupFingerprint("")).toBe("");
    });

    it("compares ignoring case and separators, never matching a missing one", () => {
        expect(sameFingerprint("AB:12", "ab12")).toBe(true);
        expect(sameFingerprint("ab12", "ab13")).toBe(false);
        expect(sameFingerprint(undefined, "ab12")).toBe(false);
        expect(sameFingerprint("ab12", undefined)).toBe(false);
    });
});

describe("revocationLabel", () => {
    it("tells a superseded key from a compromised or reasonless revoked one", () => {
        expect(revocationLabel(key)).toBeUndefined();
        expect(revocationLabel({ ...key, revokedAt: 1, revocationReason: "superseded" })).toBe("superseded");
        expect(revocationLabel({ ...key, revokedAt: 1, revocationReason: "compromised" })).toBe("revoked");
        expect(revocationLabel({ ...key, revokedAt: 1 })).toBe("revoked");
    });
});

describe("conflictSourceLabel", () => {
    it("names both sources", () => {
        expect(conflictSourceLabel("header")).toBe("from an incoming message");
        expect(conflictSourceLabel("discovery")).toBe("by key discovery");
    });
});

describe("keyPinnedSince", () => {
    it("uses the newest replacement of the same use, then keysFirstSeen, then notBefore", () => {
        const previous = (useType: "sign" | "encrypt", replacedAt: number) => ({ ...key, useType, replacedAt, replacement: "user" as const });
        expect(keyPinnedSince({ previousKeys: [previous("sign", 5), previous("sign", 9), previous("encrypt", 50)], keysFirstSeen: 1 }, key)).toBe(9);
        expect(keyPinnedSince({ previousKeys: [previous("encrypt", 50)], keysFirstSeen: 7 }, key)).toBe(7);
        expect(keyPinnedSince({}, key)).toBe(100);
    });
});
