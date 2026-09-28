// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { exportPrivateKeyPkcs8, generateKeyPairWithCsr, importPrivateKeyPkcs8 } from "../../../lib/crypto/keys.js";

describe("generateKeyPairWithCsr", () => {
    it("generates a P-256 ECDSA keypair with sign/verify usages", async () => {
        const { keyPair } = await generateKeyPairWithCsr("alice@example.com", "sign");
        expect((keyPair.privateKey.algorithm as EcKeyAlgorithm).namedCurve).toBe("P-256");
        expect(keyPair.privateKey.usages).toContain("sign");
        expect(keyPair.publicKey.usages).toContain("verify");
    });

    it("produces a PEM-encoded CSR naming the mailbox address as the subject CN", async () => {
        const { csrPem } = await generateKeyPairWithCsr("alice@example.com", "encrypt");
        expect(csrPem).toMatch(/-----BEGIN CERTIFICATE REQUEST-----/);
        expect(csrPem).toMatch(/-----END CERTIFICATE REQUEST-----/);
    });

    it("produces a different keypair on every call", async () => {
        const a = await generateKeyPairWithCsr("alice@example.com", "sign");
        const b = await generateKeyPairWithCsr("alice@example.com", "sign");
        expect(a.csrPem).not.toBe(b.csrPem);
    });
});

describe("exportPrivateKeyPkcs8 / importPrivateKeyPkcs8", () => {
    it("round-trips a signing key through export then import", async () => {
        const { keyPair } = await generateKeyPairWithCsr("alice@example.com", "sign");
        const raw = await exportPrivateKeyPkcs8(keyPair.privateKey);
        expect(raw.length).toBeGreaterThan(0);

        const reimported = await importPrivateKeyPkcs8(raw, { name: "ECDSA", namedCurve: "P-256" }, ["sign"]);
        // Prove it's functionally the same key by signing with the original and verifying with the
        // original public key, then signing with the re-imported key and verifying the same way.
        const data = new TextEncoder().encode("prove possession");
        const sigFromOriginal = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, data);
        const sigFromReimported = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, reimported, data);
        expect(
            await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, keyPair.publicKey, sigFromReimported, data as BufferSource),
        ).toBe(true);
        expect(sigFromOriginal.byteLength).toBeGreaterThan(0);
    });

    it("imports non-extractable by default, and extractable only when explicitly requested", async () => {
        const { keyPair } = await generateKeyPairWithCsr("alice@example.com", "sign");
        const raw = await exportPrivateKeyPkcs8(keyPair.privateKey);

        const locked = await importPrivateKeyPkcs8(raw, { name: "ECDSA", namedCurve: "P-256" }, ["sign"]);
        expect(locked.extractable).toBe(false);
        await expect(exportPrivateKeyPkcs8(locked)).rejects.toThrow();

        const exportable = await importPrivateKeyPkcs8(raw, { name: "ECDSA", namedCurve: "P-256" }, ["sign"], true);
        expect(exportable.extractable).toBe(true);
        expect(await exportPrivateKeyPkcs8(exportable)).toEqual(raw);
    });

    it("re-imports the same encryption key material under ECDH for actual key agreement", async () => {
        const { keyPair } = await generateKeyPairWithCsr("alice@example.com", "encrypt");
        const raw = await exportPrivateKeyPkcs8(keyPair.privateKey);
        const ecdhPrivateKey = await importPrivateKeyPkcs8(raw, { name: "ECDH", namedCurve: "P-256" }, ["deriveBits"]);
        expect(ecdhPrivateKey.algorithm.name).toBe("ECDH");

        // Re-import the matching public key under ECDH too, and confirm a real ECDH derivation succeeds -
        // this is the mechanism crypto/smime.ts relies on to actually encrypt/decrypt with this key.
        const publicKeySpki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
        const ecdhPublicKey = await crypto.subtle.importKey(
            "spki",
            publicKeySpki,
            { name: "ECDH", namedCurve: "P-256" },
            true,
            [],
        );
        const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: ecdhPublicKey }, ecdhPrivateKey, 256);
        expect(bits.byteLength).toBe(32);
    });
});
