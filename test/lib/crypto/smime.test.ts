// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import {
    computeCertFingerprint,
    decryptEnvelopedData,
    encryptForRecipients,
    signDetached,
    signOpaque,
    verifyDetached,
    verifyOpaque,
} from "../../../lib/crypto/smime.js";

x509.cryptoProvider.set(crypto);

interface TestIdentity {
    certDer: Uint8Array;
    privateKey: CryptoKey;
    publicKey: CryptoKey;
}

async function generateTestIdentity(cn: string, keyUsage: "sign" | "encrypt"): Promise<TestIdentity> {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]));
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "01",
        name: `CN=${cn}`,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 86_400_000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys,
    });
    let privateKey = keys.privateKey;
    // For encryption tests, the same underlying P-256 key material is re-imported under ECDH for
    // actual key-agreement use - the same technique keys.ts documents and keys.test.ts verifies.
    if (keyUsage === "encrypt") {
        const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
        privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    }
    return { certDer: new Uint8Array(cert.rawData), privateKey, publicKey: keys.publicKey };
}

describe("signDetached / verifyDetached", () => {
    it("round-trips a real signature: verifies successfully and returns the embedded certificate", async () => {
        const alice = await generateTestIdentity("alice@example.com", "sign");
        const content = new TextEncoder().encode("This is the signed message body.");

        const signature = await signDetached(content, alice.certDer, alice.privateKey);
        const result = await verifyDetached(content, signature);

        expect(result.valid).toBe(true);
        expect(result.signerCertificateDer).toEqual(alice.certDer);
    });

    it("fails verification when the content was tampered with after signing", async () => {
        const alice = await generateTestIdentity("alice@example.com", "sign");
        const content = new TextEncoder().encode("original content");
        const signature = await signDetached(content, alice.certDer, alice.privateKey);

        const tampered = new TextEncoder().encode("tampered content");
        const result = await verifyDetached(tampered, signature);
        expect(result.valid).toBe(false);
    });

    it("reports invalid (not a thrown error) for garbage input", async () => {
        const content = new TextEncoder().encode("content");
        const result = await verifyDetached(content, new Uint8Array([1, 2, 3, 4]));
        expect(result.valid).toBe(false);
        expect(result.signerCertificateDer).toBeUndefined();
    });

    it("reports invalid for a contentType: SignedData blob whose content isn't actually a SignedData schema", async () => {
        // A ContentInfo with the right contentType OID but a content that doesn't parse as
        // SignedData (a bare empty SEQUENCE instead) - BER-valid, so ContentInfo.fromBER() itself
        // succeeds, but `new pkijs.SignedData({ schema })` throws once it inspects the shape.
        const asn1js = await import("asn1js");
        const pkijs = await import("pkijs");
        const bogusContentInfo = new pkijs.ContentInfo({
            contentType: pkijs.ContentInfo.SIGNED_DATA,
            content: new asn1js.Sequence(),
        });
        const bogusDer = new Uint8Array(bogusContentInfo.toSchema().toBER());

        const result = await verifyDetached(new TextEncoder().encode("content"), bogusDer);
        expect(result.valid).toBe(false);
    });

    it("reports invalid for a well-formed CMS structure of the wrong type (EnvelopedData, not SignedData)", async () => {
        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        const content = new TextEncoder().encode("content");
        const envelopedData = await encryptForRecipients(content, [bob.certDer]);

        const result = await verifyDetached(content, envelopedData);
        expect(result.valid).toBe(false);
    });
});

describe("signOpaque / verifyOpaque", () => {
    it("round-trips a real signature and recovers the embedded content", async () => {
        const alice = await generateTestIdentity("alice@example.com", "sign");
        const content = new TextEncoder().encode("This is the opaquely-signed content.");

        const signed = await signOpaque(content, alice.certDer, alice.privateKey);
        const result = await verifyOpaque(signed);

        expect(result.valid).toBe(true);
        expect(result.signerCertificateDer).toEqual(alice.certDer);
        expect(result.content).toEqual(content);
    });

    it("fails verification, and omits content, for a tampered signature", async () => {
        const alice = await generateTestIdentity("alice@example.com", "sign");
        const content = new TextEncoder().encode("original content");
        const signed = await signOpaque(content, alice.certDer, alice.privateKey);
        // Flip a byte deep enough in the DER to land inside the signature value itself, not just
        // re-triggering a parse failure.
        const tampered = new Uint8Array(signed);
        tampered[tampered.length - 10] ^= 0xff;

        const result = await verifyOpaque(tampered);
        expect(result.valid).toBe(false);
        expect(result.content).toBeUndefined();
    });

    it("reports invalid for garbage input", async () => {
        const result = await verifyOpaque(new Uint8Array([1, 2, 3, 4]));
        expect(result.valid).toBe(false);
    });

    it("reports invalid for a well-formed CMS structure of the wrong type (EnvelopedData, not SignedData)", async () => {
        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        const enveloped = await encryptForRecipients(new TextEncoder().encode("content"), [bob.certDer]);
        const result = await verifyOpaque(enveloped);
        expect(result.valid).toBe(false);
    });

    it("reports invalid for a contentType: SignedData blob whose content isn't actually a SignedData schema", async () => {
        const asn1js = await import("asn1js");
        const pkijs = await import("pkijs");
        const bogusContentInfo = new pkijs.ContentInfo({
            contentType: pkijs.ContentInfo.SIGNED_DATA,
            content: new asn1js.Sequence(),
        });
        const result = await verifyOpaque(new Uint8Array(bogusContentInfo.toSchema().toBER()));
        expect(result.valid).toBe(false);
    });

    it("reports invalid, with no content, when given a detached signature instead (no embedded eContent)", async () => {
        const alice = await generateTestIdentity("alice@example.com", "sign");
        const detached = await signDetached(new TextEncoder().encode("content"), alice.certDer, alice.privateKey);

        const result = await verifyOpaque(detached);
        expect(result.valid).toBe(false);
        expect(result.content).toBeUndefined();
    });
});

describe("encryptForRecipients / decryptEnvelopedData", () => {
    it("round-trips a single recipient", async () => {
        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        const content = new TextEncoder().encode("secret message body");

        const enveloped = await encryptForRecipients(content, [bob.certDer]);
        const decrypted = await decryptEnvelopedData(enveloped, bob.certDer, bob.privateKey);

        expect(new TextDecoder().decode(decrypted)).toBe("secret message body");
    });

    it("encrypt-to-self: both the recipient and the sender's own copy can independently decrypt", async () => {
        const alice = await generateTestIdentity("alice@example.com", "encrypt");
        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        const content = new TextEncoder().encode("message from alice to bob");

        // Per the spec's "Encrypt to Self": the sender's own cert is added as an additional
        // recipient so their own Sent-folder copy remains readable to them.
        const enveloped = await encryptForRecipients(content, [bob.certDer, alice.certDer]);

        const bobDecrypted = await decryptEnvelopedData(enveloped, bob.certDer, bob.privateKey);
        expect(new TextDecoder().decode(bobDecrypted)).toBe("message from alice to bob");

        const aliceDecrypted = await decryptEnvelopedData(enveloped, alice.certDer, alice.privateKey);
        expect(new TextDecoder().decode(aliceDecrypted)).toBe("message from alice to bob");
    });

    it("throws when decrypting with a key that was never a recipient", async () => {
        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        const eve = await generateTestIdentity("eve@example.com", "encrypt");
        const content = new TextEncoder().encode("not for eve");

        const enveloped = await encryptForRecipients(content, [bob.certDer]);
        await expect(decryptEnvelopedData(enveloped, eve.certDer, eve.privateKey)).rejects.toThrow();
    });

    it("throws a clear error when given a certificate that isn't valid DER/BER at all", async () => {
        const content = new TextEncoder().encode("content");
        // A single length-prefix byte claiming more data than follows - incomplete BER, not just a
        // wrong-shape-but-parseable structure (see smime.test.ts's SignedData-shape test above).
        await expect(encryptForRecipients(content, [new Uint8Array([0x30, 0x7f])])).rejects.toThrow(
            "Could not parse the certificate as valid DER/BER.",
        );
    });

    it("throws when the CMS content is not EnvelopedData", async () => {
        const alice = await generateTestIdentity("alice@example.com", "sign");
        const content = new TextEncoder().encode("content");
        const signature = await signDetached(content, alice.certDer, alice.privateKey);

        await expect(decryptEnvelopedData(signature, alice.certDer, alice.privateKey)).rejects.toThrow(
            "This CMS content is not EnvelopedData.",
        );
    });
});

describe("computeCertFingerprint", () => {
    it("is deterministic for the same certificate bytes", async () => {
        const alice = await generateTestIdentity("alice@example.com", "sign");
        expect(await computeCertFingerprint(alice.certDer)).toBe(await computeCertFingerprint(alice.certDer));
    });

    it("differs between two different certificates", async () => {
        const alice = await generateTestIdentity("alice@example.com", "sign");
        const bob = await generateTestIdentity("bob@example.com", "sign");
        expect(await computeCertFingerprint(alice.certDer)).not.toBe(await computeCertFingerprint(bob.certDer));
    });

    it("is a 64-character lowercase hex string (SHA-256)", async () => {
        const alice = await generateTestIdentity("alice@example.com", "sign");
        expect(await computeCertFingerprint(alice.certDer)).toMatch(/^[0-9a-f]{64}$/);
    });
});
