// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { fromBase64, toBase64 } from "../../../lib/crypto/encoding.js";
import {
    MASTER_KEY_LENGTH_BYTES,
    buildAad,
    generateMasterKey,
    hkdfDerive,
    openWithKey,
    sealWithKey,
} from "../../../lib/crypto/masterKey.js";

describe("generateMasterKey", () => {
    it("produces 32 random bytes that differ between calls", () => {
        const a = generateMasterKey();
        const b = generateMasterKey();
        expect(a.length).toBe(MASTER_KEY_LENGTH_BYTES);
        expect(b.length).toBe(MASTER_KEY_LENGTH_BYTES);
        expect(toBase64(a)).not.toBe(toBase64(b));
    });
});

describe("buildAad", () => {
    it("binds mailboxUid and purpose together", () => {
        const aad = buildAad("mb1", "wrap");
        expect(new TextDecoder().decode(aad)).toBe("mb1:wrap");
    });
});

describe("sealWithKey / openWithKey", () => {
    const key = generateMasterKey();
    const aad = buildAad("mb1", "sign-private-key");
    const plaintext = new TextEncoder().encode("super secret private key material");

    it("round-trips plaintext through seal then open", async () => {
        const sealed = await sealWithKey(key, plaintext, aad);
        const opened = await openWithKey(key, sealed, aad);
        expect(new TextDecoder().decode(opened)).toBe("super secret private key material");
    });

    it("produces a fresh random nonce every call, even for identical input", async () => {
        const sealedA = await sealWithKey(key, plaintext, aad);
        const sealedB = await sealWithKey(key, plaintext, aad);
        expect(sealedA.nonce).not.toBe(sealedB.nonce);
        expect(sealedA.ciphertext).not.toBe(sealedB.ciphertext);
    });

    it("fails to open under the wrong key", async () => {
        const sealed = await sealWithKey(key, plaintext, aad);
        await expect(openWithKey(generateMasterKey(), sealed, aad)).rejects.toThrow();
    });

    it("fails to open with mismatched AAD (replay-across-account protection)", async () => {
        const sealed = await sealWithKey(key, plaintext, aad);
        await expect(openWithKey(key, sealed, buildAad("mb2", "sign-private-key"))).rejects.toThrow();
    });

    it("fails to open tampered ciphertext", async () => {
        const sealed = await sealWithKey(key, plaintext, aad);
        const tampered = { ...sealed, ciphertext: toBase64(fromBase64(sealed.ciphertext).map((b, i) => (i === 0 ? b ^ 0xff : b))) };
        await expect(openWithKey(key, tampered, aad)).rejects.toThrow();
    });
});

describe("hkdfDerive", () => {
    it("is deterministic for the same ikm/salt/info", async () => {
        const ikm = new TextEncoder().encode("input keying material");
        const salt = new TextEncoder().encode("a salt value");
        const a = await hkdfDerive(ikm, salt, "wrap");
        const b = await hkdfDerive(ikm, salt, "wrap");
        expect(toBase64(a)).toBe(toBase64(b));
    });

    it("produces independent output for different info strings, from the same ikm/salt", async () => {
        const ikm = new TextEncoder().encode("input keying material");
        const salt = new TextEncoder().encode("a salt value");
        const wrapKey = await hkdfDerive(ikm, salt, "wrap");
        const authProof = await hkdfDerive(ikm, salt, "auth-proof");
        expect(toBase64(wrapKey)).not.toBe(toBase64(authProof));
    });

    it("respects a custom output length", async () => {
        const ikm = new TextEncoder().encode("ikm");
        const salt = new TextEncoder().encode("salt");
        const derived = await hkdfDerive(ikm, salt, "wrap", 16);
        expect(derived.length).toBe(16);
    });

    // Confirms the parameter wiring (salt/info/hash placement, UTF-8 encoding of the `info` string) matches
    // a direct `crypto.subtle` HKDF call built the same way by hand - this is Web Platform's own certified
    // HKDF implementation, so this test is about this wrapper's correctness, not re-validating HKDF itself.
    it("matches a direct crypto.subtle HKDF derivation built the same way", async () => {
        const ikm = new TextEncoder().encode("input keying material");
        const salt = new TextEncoder().encode("a salt value");
        const baseKey = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
        const expected = new Uint8Array(
            await crypto.subtle.deriveBits(
                {
                    name: "HKDF",
                    hash: "SHA-256",
                    salt: salt as BufferSource,
                    info: new TextEncoder().encode("wrap") as BufferSource,
                },
                baseKey,
                32 * 8,
            ),
        );
        const actual = await hkdfDerive(ikm, salt, "wrap");
        expect(toBase64(actual)).toBe(toBase64(expected));
    });
});
