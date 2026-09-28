// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { fromBase64, toBase64 } from "../../../lib/crypto/encoding.js";
import { evaluateMessageSecurity } from "../../../lib/crypto/messageSecurity.js";
import { computeCertFingerprint } from "../../../lib/crypto/smime.js";
import { ProtectedHeaders, assembleOutboundMime, buildEncryptedMessage, buildSignedOnlyMessage } from "../../../lib/crypto/smimeMessage.js";

x509.cryptoProvider.set(crypto);

interface TestIdentity {
    certDer: Uint8Array;
    privateKey: CryptoKey;
}

async function generateTestIdentity(cn: string, keyUsage: "sign" | "encrypt"): Promise<TestIdentity> {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "01",
        name: `CN=${cn}`,
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

describe("evaluateMessageSecurity", () => {
    it("is unprotected for a plain message with no recognizable Content-Type", async () => {
        const rawMime = "From: alice@example.com\r\nTo: bob@example.com\r\n\r\nJust a plain message.";
        expect(await evaluateMessageSecurity(rawMime, undefined)).toEqual({ state: "unprotected" });
    });

    it("is unprotected for an ordinary text/html message", async () => {
        const rawMime = 'From: alice@example.com\r\nContent-Type: text/html\r\n\r\n<p>hi</p>';
        expect(await evaluateMessageSecurity(rawMime, undefined)).toEqual({ state: "unprotected" });
    });

    describe("signed-only (multipart/signed)", () => {
        it("is signed_verified for a real, untampered signature", async () => {
            const alice = await generateTestIdentity("alice@example.com", "sign");
            const part = await buildSignedOnlyMessage("text/plain; charset=utf-8", "Hello, Bob.", HEADERS, alice.certDer, alice.privateKey);
            const rawMime = assembleOutboundMime(HEADERS, part);

            const result = await evaluateMessageSecurity(rawMime, undefined, await computeCertFingerprint(alice.certDer));
            expect(result.state).toBe("signed_verified");
            expect(result.text).toBe("Hello, Bob.");
            expect(result.html).toBe('<pre style="white-space: pre-wrap; word-wrap: break-word; font-family: inherit">Hello, Bob.</pre>');
            expect(result.subject).toBe("Real subject");
        });

        it("is signature_failed when the signed body was tampered with in transit", async () => {
            const alice = await generateTestIdentity("alice@example.com", "sign");
            const part = await buildSignedOnlyMessage("text/plain; charset=utf-8", "Hello, Bob.", HEADERS, alice.certDer, alice.privateKey);
            const tamperedMime = assembleOutboundMime(HEADERS, part).replace(
                Buffer.from("Hello, Bob.").toString("base64"),
                Buffer.from("Hello, Eve.").toString("base64"),
            );

            expect(await evaluateMessageSecurity(tamperedMime, undefined)).toEqual({ state: "signature_failed", signatureFailureReason: "invalid_signature" });
        });

        it("is signature_failed when a pinned fingerprint is supplied and does not match the signer", async () => {
            const alice = await generateTestIdentity("alice@example.com", "sign");
            const someoneElse = await generateTestIdentity("mallory@example.com", "sign");
            const part = await buildSignedOnlyMessage("text/plain; charset=utf-8", "Hello, Bob.", HEADERS, alice.certDer, alice.privateKey);
            const rawMime = assembleOutboundMime(HEADERS, part);

            const wrongFingerprint = await computeCertFingerprint(someoneElse.certDer);
            // Alice's certificate still names From, so a pin mismatch is a key change rather than a plain untrusted signer.
            expect(await evaluateMessageSecurity(rawMime, undefined, wrongFingerprint)).toMatchObject({ state: "signature_failed", signatureFailureReason: "signer_key_changed" });
        });

        it("is signed_verified when a pinned fingerprint is supplied and matches the signer", async () => {
            const alice = await generateTestIdentity("alice@example.com", "sign");
            const part = await buildSignedOnlyMessage("text/plain; charset=utf-8", "Hello, Bob.", HEADERS, alice.certDer, alice.privateKey);
            const rawMime = assembleOutboundMime(HEADERS, part);

            const rightFingerprint = await computeCertFingerprint(alice.certDer);
            const result = await evaluateMessageSecurity(rawMime, undefined, rightFingerprint);
            expect(result.state).toBe("signed_verified");
        });
    });

    it("treats a multipart/encrypted (OpenPGP/MIME) message as encrypted, even without an unlocked key", async () => {
        const rawMime = "From: alice@example.com\r\nContent-Type: multipart/encrypted; boundary=x\r\n\r\nopaque body";
        const result = await evaluateMessageSecurity(rawMime, undefined);
        expect(result.state).toBe("encrypted");
        expect(result.decryptError).toMatch(/doesn't have the key/);
    });

    describe("encrypted (application/pkcs7-mime)", () => {
        it("is encrypted (not verified) when there is no inner signature", async () => {
            const bob = await generateTestIdentity("bob@example.com", "encrypt");
            const part = await buildEncryptedMessage("text/plain; charset=utf-8", "Secret body.", HEADERS, HEADERS, [bob.certDer]);
            const rawMime = assembleOutboundMime(HEADERS, part);

            const result = await evaluateMessageSecurity(rawMime, { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer });
            expect(result.state).toBe("encrypted");
            expect(result.text).toBe("Secret body.");
            expect(result.decryptError).toBeUndefined();
        });

        it("is encrypted with a decryptError when this device has no unlocked encryption key at all", async () => {
            const bob = await generateTestIdentity("bob@example.com", "encrypt");
            const part = await buildEncryptedMessage("text/plain; charset=utf-8", "Secret body.", HEADERS, HEADERS, [bob.certDer]);
            const rawMime = assembleOutboundMime(HEADERS, part);

            const result = await evaluateMessageSecurity(rawMime, undefined);
            expect(result.state).toBe("encrypted");
            expect(result.decryptError).toMatch(/doesn't have the key/);
            expect(result.html).toBeUndefined();
        });

        it("is encrypted with a decryptError when this device's key was never a recipient", async () => {
            const bob = await generateTestIdentity("bob@example.com", "encrypt");
            const eve = await generateTestIdentity("eve@example.com", "encrypt");
            const part = await buildEncryptedMessage("text/plain; charset=utf-8", "Secret body.", HEADERS, HEADERS, [bob.certDer]);
            const rawMime = assembleOutboundMime(HEADERS, part);

            const result = await evaluateMessageSecurity(rawMime, { encryptionPrivateKey: eve.privateKey, encryptionCertDer: eve.certDer });
            expect(result.state).toBe("encrypted");
            expect(result.decryptError).toMatch(/doesn't have the key/);
        });

        it("is encrypted_verified for a real sign-then-encrypt message decrypted with the right key", async () => {
            const alice = await generateTestIdentity("alice@example.com", "sign");
            const bob = await generateTestIdentity("bob@example.com", "encrypt");
            const part = await buildEncryptedMessage("text/plain; charset=utf-8", "Secret body.", HEADERS, HEADERS, [bob.certDer], {
                certDer: alice.certDer,
                privateKey: alice.privateKey,
            });
            const rawMime = assembleOutboundMime(HEADERS, part);

            const result = await evaluateMessageSecurity(rawMime, { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer }, [
                "0000",
                await computeCertFingerprint(alice.certDer),
            ]);
            expect(result.state).toBe("encrypted_verified");

            expect(result.text).toBe("Secret body.");
        });

        it("recovers the real subject from the protected headers, not the (possibly obscured) outer envelope", async () => {
            const bob = await generateTestIdentity("bob@example.com", "encrypt");
            const part = await buildEncryptedMessage("text/plain; charset=utf-8", "Secret body.", HEADERS, HEADERS, [bob.certDer]);
            const rawMime = assembleOutboundMime(HEADERS, part);

            const result = await evaluateMessageSecurity(rawMime, { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer });
            expect(result.subject).toBe("Real subject");
        });

        it("recovers the real subject through a sign-then-encrypt message too", async () => {
            const alice = await generateTestIdentity("alice@example.com", "sign");
            const bob = await generateTestIdentity("bob@example.com", "encrypt");
            const part = await buildEncryptedMessage("text/plain; charset=utf-8", "Secret body.", HEADERS, HEADERS, [bob.certDer], {
                certDer: alice.certDer,
                privateKey: alice.privateKey,
            });
            const rawMime = assembleOutboundMime(HEADERS, part);

            const result = await evaluateMessageSecurity(rawMime, { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer });
            expect(result.subject).toBe("Real subject");
        });

        it("reports headerTamperDetected: false when the raw MIME's outer envelope matches the HP-Outer copies", async () => {
            const bob = await generateTestIdentity("bob@example.com", "encrypt");
            const part = await buildEncryptedMessage("text/plain; charset=utf-8", "Secret body.", HEADERS, HEADERS, [bob.certDer]);
            const rawMime = assembleOutboundMime(HEADERS, part);

            const result = await evaluateMessageSecurity(rawMime, { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer });
            expect(result.headerTamperDetected).toBe(false);
        });

        it("reports headerTamperDetected: true when the raw MIME's outer Subject was rewritten after signing/encryption", async () => {
            const bob = await generateTestIdentity("bob@example.com", "encrypt");
            const part = await buildEncryptedMessage("text/plain; charset=utf-8", "Secret body.", HEADERS, HEADERS, [bob.certDer]);
            const rawMime = assembleOutboundMime(HEADERS, part).replace("Subject: Real subject", "Subject: Rewritten by an intermediary");

            const result = await evaluateMessageSecurity(rawMime, { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer });
            expect(result.state).toBe("encrypted");
            expect(result.headerTamperDetected).toBe(true);
        });

        it("downgrades a sign-then-encrypt message whose outer From was rewritten, and still reports headerTamperDetected", async () => {
            const alice = await generateTestIdentity("alice@example.com", "sign");
            const bob = await generateTestIdentity("bob@example.com", "encrypt");
            const part = await buildEncryptedMessage("text/plain; charset=utf-8", "Secret body.", HEADERS, HEADERS, [bob.certDer], {
                certDer: alice.certDer,
                privateKey: alice.privateKey,
            });
            const rawMime = assembleOutboundMime(HEADERS, part).replace("From: alice@example.com", "From: eve@example.com");

            const result = await evaluateMessageSecurity(rawMime, { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer });
            expect(result.state).toBe("signature_failed");
            expect(result.signatureFailureReason).toBe("header_mismatch");
            expect(result.headerTamperDetected).toBe(true);
        });

        it("is signature_failed for a sign-then-encrypt message whose signer doesn't match a supplied pinned fingerprint", async () => {
            const alice = await generateTestIdentity("alice@example.com", "sign");
            const bob = await generateTestIdentity("bob@example.com", "encrypt");
            const someoneElse = await generateTestIdentity("mallory@example.com", "sign");
            const part = await buildEncryptedMessage("text/plain; charset=utf-8", "Secret body.", HEADERS, HEADERS, [bob.certDer], {
                certDer: alice.certDer,
                privateKey: alice.privateKey,
            });
            const rawMime = assembleOutboundMime(HEADERS, part);

            const wrongFingerprint = await computeCertFingerprint(someoneElse.certDer);
            const result = await evaluateMessageSecurity(
                rawMime,
                { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer },
                wrongFingerprint,
            );
            expect(result.state).toBe("signature_failed");
            // Content still renders alongside the warning - a failed signature is not a reason to hide
            // the (successfully decrypted, AEAD-authenticated) body from the reader.
            expect(result.text).toBe("Secret body.");
        });
    });

    describe("signerCertificate (trust this signer)", () => {
        it("carries the base64 DER signer certificate on signed_verified and signed_unverified_signer", async () => {
            const alice = await generateTestIdentity("alice@example.com", "sign");
            const part = await buildSignedOnlyMessage("text/plain; charset=utf-8", "Hello, Bob.", HEADERS, alice.certDer, alice.privateKey);
            const rawMime = assembleOutboundMime(HEADERS, part);
            const pin = await computeCertFingerprint(alice.certDer);

            const unverified = await evaluateMessageSecurity(rawMime, undefined);
            expect(unverified).toMatchObject({ state: "signed_unverified_signer", signerFingerprint: pin, signerCertificate: toBase64(alice.certDer) });
            const verified = await evaluateMessageSecurity(rawMime, undefined, pin);
            expect(verified).toMatchObject({ state: "signed_verified", signerFingerprint: pin, signerCertificate: toBase64(alice.certDer) });
            expect(fromBase64(verified.signerCertificate!)).toEqual(alice.certDer);
        });

        it("carries it on encrypted_verified and encrypted_unverified_signer", async () => {
            const alice = await generateTestIdentity("alice@example.com", "sign");
            const bob = await generateTestIdentity("bob@example.com", "encrypt");
            const part = await buildEncryptedMessage("text/plain; charset=utf-8", "Secret body.", HEADERS, HEADERS, [bob.certDer], {
                certDer: alice.certDer,
                privateKey: alice.privateKey,
            });
            const rawMime = assembleOutboundMime(HEADERS, part);
            const unlocked = { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer };
            const pin = await computeCertFingerprint(alice.certDer);

            expect(await evaluateMessageSecurity(rawMime, unlocked)).toMatchObject({ state: "encrypted_unverified_signer", signerCertificate: toBase64(alice.certDer) });
            expect(await evaluateMessageSecurity(rawMime, unlocked, pin)).toMatchObject({ state: "encrypted_verified", signerCertificate: toBase64(alice.certDer) });
        });

        it("is never set for signature_failed other than signer_key_changed, even when the signature itself was valid", async () => {
            const mallory = await generateTestIdentity("mallory@example.com", "sign");
            const bob = await generateTestIdentity("bob@example.com", "encrypt");
            const alice = await generateTestIdentity("alice@example.com", "sign");
            const pin = await computeCertFingerprint(alice.certDer);

            // Mallory's certificate doesn't name From: with a pin that's untrusted_signer, without one an identity mismatch.
            const signed = assembleOutboundMime(HEADERS, await buildSignedOnlyMessage("text/plain", "Hi.", HEADERS, mallory.certDer, mallory.privateKey));
            const signedResult = await evaluateMessageSecurity(signed, undefined, pin);
            expect(signedResult).toMatchObject({ state: "signature_failed", signatureFailureReason: "untrusted_signer", signerFingerprint: await computeCertFingerprint(mallory.certDer) });
            expect(signedResult).not.toHaveProperty("signerCertificate");
            const unpinnedResult = await evaluateMessageSecurity(signed, undefined);
            expect(unpinnedResult).toMatchObject({ state: "signature_failed", signatureFailureReason: "signer_identity_mismatch" });
            expect(unpinnedResult).not.toHaveProperty("signerCertificate");

            const encrypted = assembleOutboundMime(
                HEADERS,
                await buildEncryptedMessage("text/plain", "Secret.", HEADERS, HEADERS, [bob.certDer], { certDer: mallory.certDer, privateKey: mallory.privateKey }),
            );
            const encryptedResult = await evaluateMessageSecurity(encrypted, { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer }, pin);
            expect(encryptedResult).toMatchObject({ state: "signature_failed", signatureFailureReason: "untrusted_signer", signerFingerprint: await computeCertFingerprint(mallory.certDer) });
            expect(encryptedResult).not.toHaveProperty("signerCertificate");

            const tampered = signed.replace(Buffer.from("Hi.").toString("base64"), Buffer.from("Yo.").toString("base64"));
            expect(await evaluateMessageSecurity(tampered, undefined)).not.toHaveProperty("signerCertificate");
        });
    });
});
