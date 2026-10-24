// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// OpenPGP messages end to end: built with `pgpMessage.ts`, read back through `messageSecurity.ts` with real OpenPGP.js keys.
import * as openpgp from "openpgp";
import { describe, expect, it } from "vitest";
import { evaluateMessageSecurity } from "../../../lib/crypto/messageSecurity.js";
import { generateOpenPgpKey, readSecretKey } from "../../../lib/crypto/openpgp.js";
import { buildPgpEncryptedMessage, buildPgpSignedOnlyMessage } from "../../../lib/crypto/pgpMessage.js";
import { applyBaselineOuterHeaders, assembleOutboundMime, type ProtectedHeaders } from "../../../lib/crypto/smimeMessage.js";

const headers: ProtectedHeaders = {
    from: "alice@rapidmx.example",
    to: "bob@proton.example",
    date: new Date("2026-10-24T10:00:00Z").toUTCString(),
    subject: "Quarterly numbers",
    messageId: "<m1@rapidmx.example>",
};

async function identity(address: string, version: 4 | 6 = 4) {
    const generated = await generateOpenPgpKey(address, "Test", version);
    const privateKey = await readSecretKey(generated.secretKey);
    return { generated, privateKey, unlocked: { openPgpKeys: [{ fingerprint: generated.fingerprint, privateKey }] } };
}

describe("PGP/MIME messages", () => {
    it("encrypts and signs to the recipient, who reads it verified with the sender's pinned key", async () => {
        const alice = await identity("alice@rapidmx.example");
        const bob = await identity("bob@proton.example");
        const part = await buildPgpEncryptedMessage(
            "text/plain; charset=utf-8",
            "The numbers are in.",
            headers,
            applyBaselineOuterHeaders(headers),
            [bob.privateKey.toPublic(), alice.privateKey.toPublic()],
            alice.privateKey,
        );
        const raw = assembleOutboundMime(applyBaselineOuterHeaders(headers), part);
        expect(raw).toContain('Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"');
        expect(raw).toContain("Subject: [...]");

        const pins = { fingerprints: [alice.generated.fingerprint], openPgpKeys: [alice.generated.publicKey] };
        const verified = await evaluateMessageSecurity(raw, bob.unlocked, pins, "bob@proton.example");
        expect(verified).toMatchObject({
            state: "encrypted_verified",
            text: "The numbers are in.",
            subject: "Quarterly numbers",
            signerFingerprint: alice.generated.fingerprint,
            signerEmails: ["alice@rapidmx.example"],
            signerKeyType: "openpgp",
            headerTamperDetected: false,
            notAddressedToReader: false,
        });

        // Without the sender's key the content still opens; the signature just can't be checked.
        expect(await evaluateMessageSecurity(raw, bob.unlocked)).toMatchObject({ state: "encrypted", text: "The numbers are in.", signerKeyUnknown: true });
        // The sender reads their own copy (encrypt to self), signed by their own key.
        expect((await evaluateMessageSecurity(raw, alice.unlocked)).state).toBe("encrypted_verified");
        // Someone without the key can't open it.
        const eve = await identity("eve@example.com");
        expect((await evaluateMessageSecurity(raw, eve.unlocked)).decryptError).toBeTruthy();
        expect((await evaluateMessageSecurity(raw, undefined)).state).toBe("encrypted");
    });

    it("works between a v4 key and a v6 key, both ways", async () => {
        const alice = await identity("alice@rapidmx.example");
        const bob = await identity("bob@proton.example", 6);
        const outer = applyBaselineOuterHeaders(headers);
        const raw = assembleOutboundMime(outer, await buildPgpEncryptedMessage("text/plain", "Mixed versions", headers, outer, [bob.privateKey.toPublic(), alice.privateKey.toPublic()], alice.privateKey));
        const pins = { fingerprints: [], openPgpKeys: [alice.generated.publicKey] };
        expect(await evaluateMessageSecurity(raw, bob.unlocked, pins)).toMatchObject({ state: "encrypted_verified", text: "Mixed versions" });

        const reply = { ...headers, from: "bob@proton.example", to: "alice@rapidmx.example" };
        const replyOuter = applyBaselineOuterHeaders(reply);
        const back = assembleOutboundMime(replyOuter, await buildPgpEncryptedMessage("text/plain", "Got it", reply, replyOuter, [alice.privateKey.toPublic()], bob.privateKey));
        expect(await evaluateMessageSecurity(back, alice.unlocked, { fingerprints: [], openPgpKeys: [bob.generated.publicKey] })).toMatchObject({
            state: "encrypted_verified",
            text: "Got it",
        });
    });

    it("signs a message with the public key attached, which a new correspondent sees as signed by an untrusted key", async () => {
        const alice = await identity("alice@rapidmx.example");
        const part = await buildPgpSignedOnlyMessage("text/plain; charset=utf-8", "Hello Bob", headers, alice.privateKey, alice.generated.armoredPublicKey);
        const raw = assembleOutboundMime(headers, part);
        expect(raw).toMatch(/multipart\/signed; protocol="application\/pgp-signature"; micalg=pgp-sha\d+/);

        const fresh = await evaluateMessageSecurity(raw, undefined);
        expect(fresh).toMatchObject({ state: "signed_unverified_signer", text: "Hello Bob", signerKeyType: "openpgp", signerFingerprint: alice.generated.fingerprint });
        // Its certificate is what "Trust this key" pins.
        const certificate = await openpgp.readKey({ binaryKey: Buffer.from(fresh.signerCertificate!, "base64") });
        expect(certificate.getFingerprint()).toBe(alice.generated.fingerprint);

        const pinned = { fingerprints: [], openPgpKeys: [alice.generated.publicKey] };
        expect((await evaluateMessageSecurity(raw, undefined, pinned)).state).toBe("signed_verified");

        // A sender who has a different key pinned appears to have changed keys.
        const old = await identity("alice@rapidmx.example");
        const changed = await evaluateMessageSecurity(raw, undefined, { fingerprints: [], openPgpKeys: [old.generated.publicKey] });
        expect(changed).toMatchObject({ state: "signature_failed", signatureFailureReason: "signer_key_changed" });

        // Tampering with the signed part breaks the signature.
        expect((await evaluateMessageSecurity(raw.replace("Hello Bob", "Hello Eve").replace(/SGVsbG8gQm9i/, "SGVsbG8gRXZl"), undefined, pinned)).state).toBe("signature_failed");
    });

    it("refuses a signer whose key doesn't name the sender", async () => {
        const mallory = await identity("mallory@example.com");
        const part = await buildPgpSignedOnlyMessage("text/plain", "Hi", headers, mallory.privateKey);
        const raw = assembleOutboundMime(headers, part);
        const result = await evaluateMessageSecurity(raw, undefined, { fingerprints: [], openPgpKeys: [mallory.generated.publicKey] });
        expect(result).toMatchObject({ state: "signature_failed", signatureFailureReason: "signer_identity_mismatch" });
    });

    it("reads inline encrypted and cleartext-signed messages", async () => {
        const alice = await identity("alice@rapidmx.example");
        const bob = await identity("bob@proton.example");
        const armored = await openpgp.encrypt({
            message: await openpgp.createMessage({ text: "inline secret" }),
            encryptionKeys: bob.privateKey.toPublic(),
            signingKeys: alice.privateKey,
        });
        const inline = ["From: alice@rapidmx.example", "To: bob@proton.example", "Subject: hi", "Content-Type: text/plain", "", armored].join("\r\n");
        expect(await evaluateMessageSecurity(inline, bob.unlocked, { fingerprints: [], openPgpKeys: [alice.generated.publicKey] })).toMatchObject({
            state: "encrypted_verified",
            text: "inline secret",
        });
        expect((await evaluateMessageSecurity(inline, alice.unlocked)).decryptError).toBeTruthy();

        const cleartext = await openpgp.sign({ message: await openpgp.createCleartextMessage({ text: "signed words" }), signingKeys: alice.privateKey });
        const signed = ["From: alice@rapidmx.example", "To: bob@proton.example", "Subject: hi", "", cleartext].join("\r\n");
        expect(await evaluateMessageSecurity(signed, undefined, { fingerprints: [], openPgpKeys: [alice.generated.publicKey] })).toMatchObject({
            state: "signed_verified",
            text: "signed words",
        });
        expect(await evaluateMessageSecurity(signed, undefined)).toMatchObject({ state: "unprotected", signerKeyUnknown: true });
    });

    it("reads an unsigned encrypted message, and one signed by a key only attached to it", async () => {
        const alice = await identity("alice@rapidmx.example");
        const bob = await identity("bob@proton.example");
        const outer = applyBaselineOuterHeaders(headers);
        const unsigned = assembleOutboundMime(outer, await buildPgpEncryptedMessage("text/plain", "No signature", headers, outer, [bob.privateKey.toPublic()]));
        expect(await evaluateMessageSecurity(unsigned, bob.unlocked, undefined, "bob@proton.example")).toMatchObject({ state: "encrypted", text: "No signature" });

        const attached = assembleOutboundMime(
            outer,
            await buildPgpEncryptedMessage("text/plain", "Signed, key attached", headers, outer, [bob.privateKey.toPublic()], alice.privateKey, alice.generated.armoredPublicKey),
        );
        expect(await evaluateMessageSecurity(attached, bob.unlocked)).toMatchObject({
            state: "encrypted_unverified_signer",
            text: "Signed, key attached",
            signerFingerprint: alice.generated.fingerprint,
            signerKeyType: "openpgp",
        });
        const old = await identity("alice@rapidmx.example");
        expect(await evaluateMessageSecurity(attached, bob.unlocked, { fingerprints: [], openPgpKeys: [old.generated.publicKey] })).toMatchObject({
            state: "signature_failed",
            signatureFailureReason: "signer_key_changed",
            text: "Signed, key attached",
        });
    });

    it("flags outer headers that don't match the protected ones, and mail not addressed to the reader", async () => {
        const alice = await identity("alice@rapidmx.example");
        const bob = await identity("bob@proton.example");
        const outer = applyBaselineOuterHeaders(headers);
        const raw = assembleOutboundMime(outer, await buildPgpEncryptedMessage("text/plain", "Hi", headers, outer, [bob.privateKey.toPublic()], alice.privateKey));
        const pins = { fingerprints: [], openPgpKeys: [alice.generated.publicKey] };

        expect((await evaluateMessageSecurity(raw, bob.unlocked, pins, "carol@proton.example")).notAddressedToReader).toBe(true);
        const tampered = raw.replace("To: bob@proton.example", "To: eve@example.com");
        expect(tampered).not.toBe(raw);
        expect((await evaluateMessageSecurity(tampered, bob.unlocked, pins)).headerTamperDetected).toBe(true);
    });

    it("reports a PGP/MIME message that won't decrypt or verify", async () => {
        const bob = await identity("bob@proton.example");
        const broken = [
            "From: alice@rapidmx.example",
            "To: bob@proton.example",
            'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"',
            "",
            "--b",
            "Content-Type: application/pgp-encrypted",
            "",
            "Version: 1",
            "--b",
            "Content-Type: application/octet-stream",
            "",
            "-----BEGIN PGP MESSAGE-----",
            "",
            "bm90IGEgbWVzc2FnZQ==",
            "-----END PGP MESSAGE-----",
            "--b--",
            "",
        ].join("\r\n");
        expect(await evaluateMessageSecurity(broken, bob.unlocked)).toMatchObject({ state: "encrypted", decryptError: expect.any(String) });

        const badSignature = [
            "From: alice@rapidmx.example",
            'Content-Type: multipart/signed; protocol="application/pgp-signature"; micalg=pgp-sha256; boundary="b"',
            "",
            "--b",
            "Content-Type: text/plain",
            "",
            "Hello",
            "--b",
            "Content-Type: application/pgp-signature",
            "",
            "-----BEGIN PGP SIGNATURE-----",
            "",
            "bm90IGEgc2lnbmF0dXJl",
            "-----END PGP SIGNATURE-----",
            "--b--",
            "",
        ].join("\r\n");
        expect((await evaluateMessageSecurity(badSignature, undefined)).state).toBe("signature_failed");
    });
});
