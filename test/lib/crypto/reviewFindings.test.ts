// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
/**
 * Regression tests for the lib/ review findings about received-message security: unauthenticated protected headers
 * (H6), a replayed signed-only message's outer Date (H5), and an `authenveloped-data` message that was classified as
 * encrypted but reported as "no key" (H17).
 */
import "reflect-metadata";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { toBase64 } from "../../../lib/crypto/encoding.js";
import { evaluateMessageSecurity } from "../../../lib/crypto/messageSecurity.js";
import { computeCertFingerprint } from "../../../lib/crypto/smime.js";
import { ProtectedHeaders, applyBaselineOuterHeaders, assembleOutboundMime, buildEncryptedMessage, buildSignedOnlyMessage } from "../../../lib/crypto/smimeMessage.js";

x509.cryptoProvider.set(crypto);

const CRLF = "\r\n";

interface TestIdentity {
    certDer: Uint8Array;
    privateKey: CryptoKey;
}

async function generateIdentity(name: string, keyUsage: "sign" | "encrypt" = "sign"): Promise<TestIdentity> {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "01",
        name,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 86_400_000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys,
    });
    let privateKey = keys.privateKey;
    if (keyUsage === "encrypt") {
        const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
        privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    }
    return { certDer: new Uint8Array(cert.rawData), privateKey };
}

const HEADERS: ProtectedHeaders = {
    from: "alice@example.com",
    to: "bob@example.com",
    date: "Wed, 11 Jan 2023 16:08:43 -0500",
    subject: "Real subject",
    messageId: "<abc123@example.com>",
};

describe("H6: protected headers are only exposed once a signature over them verified", () => {
    it("exposes none for an encrypted message nobody signed, however it names its recipients", async () => {
        const bob = await generateIdentity("CN=bob@example.com", "encrypt");
        const forged = { ...HEADERS, from: "ceo@corp.example", to: "bob@example.com, hidden@evil.example" };
        const part = await buildEncryptedMessage("text/plain", "hi", forged, applyBaselineOuterHeaders(HEADERS), [bob.certDer]);
        const raw = assembleOutboundMime(applyBaselineOuterHeaders(HEADERS), part);

        const result = await evaluateMessageSecurity(raw, { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer });
        expect(result).toMatchObject({ state: "encrypted", text: "hi" });
        expect(result).not.toHaveProperty("protectedHeaders");
    });

    it("exposes none when the signature failed or the signer key changed, and all of them once it verified", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const bob = await generateIdentity("CN=bob@example.com", "encrypt");
        const outer = applyBaselineOuterHeaders(HEADERS);
        const part = await buildEncryptedMessage("text/plain", "hi", HEADERS, outer, [bob.certDer], { certDer: alice.certDer, privateKey: alice.privateKey });
        const unlocked = { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer };
        const pin = await computeCertFingerprint(alice.certDer);

        const raw = assembleOutboundMime(outer, part);
        expect(await evaluateMessageSecurity(raw, unlocked, pin)).toMatchObject({ state: "encrypted_verified", protectedHeaders: { from: "alice@example.com", to: "bob@example.com" } });
        const changed = await evaluateMessageSecurity(raw, unlocked, "00ff");
        expect(changed).toMatchObject({ state: "signature_failed", signatureFailureReason: "signer_key_changed" });
        expect(changed).not.toHaveProperty("protectedHeaders");

        const tampered = assembleOutboundMime({ ...outer, to: "mallory@evil.example" }, part);
        const mismatch = await evaluateMessageSecurity(tampered, unlocked, pin);
        expect(mismatch).toMatchObject({ state: "signature_failed", signatureFailureReason: "header_mismatch" });
        expect(mismatch).not.toHaveProperty("protectedHeaders");
    });
});

describe("H5: a signed-only message's outer Date is compared with the signed one", () => {
    async function signed() {
        const alice = await generateIdentity("CN=alice@example.com");
        const raw = assembleOutboundMime(HEADERS, await buildSignedOnlyMessage("text/plain", "hi", HEADERS, alice.certDer, alice.privateKey));
        return { raw, pin: await computeCertFingerprint(alice.certDer) };
    }

    it("is header_mismatch when the message was replayed with another outer Date", async () => {
        const { raw, pin } = await signed();
        const replayed = raw.replace("Date: Wed, 11 Jan 2023 16:08:43 -0500", "Date: Tue, 01 Oct 2030 09:00:00 +0000");
        expect(replayed).not.toBe(raw);
        expect(await evaluateMessageSecurity(replayed, undefined, pin)).toMatchObject({ state: "signature_failed", signatureFailureReason: "header_mismatch" });
    });

    it("accepts the same instant written another way", async () => {
        const { raw, pin } = await signed();
        const sameInstant = raw.replace("Date: Wed, 11 Jan 2023 16:08:43 -0500", "Date: Wed, 11 Jan 2023 21:08:43 +0000");
        expect((await evaluateMessageSecurity(sameInstant, undefined, pin)).state).toBe("signed_verified");
    });

    it("is header_mismatch when the replayed message's outer Date was garbled or dropped", async () => {
        const { raw, pin } = await signed();
        const unreadable = raw.replace("Date: Wed, 11 Jan 2023 16:08:43 -0500", "Date: sometime last week");
        expect(await evaluateMessageSecurity(unreadable, undefined, pin)).toMatchObject({ state: "signature_failed", signatureFailureReason: "header_mismatch" });
        const absent = raw.replace("Date: Wed, 11 Jan 2023 16:08:43 -0500\r\n", "");
        expect(absent).not.toBe(raw);
        expect(await evaluateMessageSecurity(absent, undefined, pin)).toMatchObject({ state: "signature_failed", signatureFailureReason: "header_mismatch" });
    });
});

describe("H17: an authenveloped-data message", () => {
    it("is reported as an unsupported format, not as a missing key", async () => {
        const bob = await generateIdentity("CN=bob@example.com", "encrypt");
        const contentInfo = new pkijs.ContentInfo({ contentType: "1.2.840.113549.1.9.16.1.23", content: new asn1js.Sequence() });
        const der = new Uint8Array(contentInfo.toSchema().toBER());
        const raw = ["From: alice@example.com", "Content-Type: application/pkcs7-mime; smime-type=authenveloped-data", "", toBase64(der)].join(CRLF);

        const result = await evaluateMessageSecurity(raw, { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer });
        expect(result.state).toBe("encrypted");
        expect(result.decryptError).toMatch(/encryption format/);
        expect(result.decryptError).not.toMatch(/doesn't have the key/);
    });
});
