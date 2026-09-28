// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import {
    ProtectedHeaders,
    applyBaselineOuterHeaders,
    assembleOutboundMime,
    buildEncryptedMessage,
    buildSignedOnlyMessage,
    parseEncryptedMessage,
    parseSignedOnlyMessage,
} from "../../../lib/crypto/smimeMessage.js";

x509.cryptoProvider.set(crypto);

interface TestIdentity {
    certDer: Uint8Array;
    privateKey: CryptoKey;
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
    if (keyUsage === "encrypt") {
        const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
        privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    }
    return { certDer: new Uint8Array(cert.rawData), privateKey };
}

const HEADERS: ProtectedHeaders = {
    from: "alice@example.com",
    to: "bob@example.com",
    cc: "carol@example.com",
    date: "Wed, 11 Jan 2023 16:08:43 -0500",
    subject: "Real subject line",
    messageId: "<abc123@example.com>",
};

describe("assembleOutboundMime", () => {
    it("serializes outer headers, MIME-Version, Content-Type, and body, in order, with a blank-line separator", () => {
        const mime = assembleOutboundMime(HEADERS, { contentType: 'text/plain; hp="clear"', body: "the body text" });
        const lines = mime.split("\r\n");
        expect(lines).toEqual([
            `From: ${HEADERS.from}`,
            `To: ${HEADERS.to}`,
            `Cc: ${HEADERS.cc}`,
            `Date: ${HEADERS.date}`,
            `Subject: ${HEADERS.subject}`,
            `Message-ID: ${HEADERS.messageId}`,
            "MIME-Version: 1.0",
            `Content-Type: text/plain; hp="clear"`,
            "",
            "the body text",
        ]);
    });

    it("omits the Cc line entirely when there is no Cc", () => {
        const noCc: ProtectedHeaders = { ...HEADERS, cc: undefined };
        const mime = assembleOutboundMime(noCc, { contentType: "text/plain", body: "x" });
        expect(mime).not.toContain("Cc:");
    });

    it("includes each of a MimePart's additionalHeaders as its own header line", () => {
        const mime = assembleOutboundMime(HEADERS, {
            contentType: "application/pkcs7-mime",
            additionalHeaders: { "Content-Transfer-Encoding": "base64", "Content-Disposition": 'attachment; filename="smime.p7m"' },
            body: "base64stuff",
        });
        expect(mime).toContain("Content-Transfer-Encoding: base64");
        expect(mime).toContain('Content-Disposition: attachment; filename="smime.p7m"');
    });

    it("never includes a Bcc line - Bcc is submission-only and must never be baked into rawMime", () => {
        const mime = assembleOutboundMime(HEADERS, { contentType: "text/plain", body: "x" });
        expect(mime.toLowerCase()).not.toContain("bcc:");
    });
});

describe("applyBaselineOuterHeaders", () => {
    it("obscures only the Subject, per RFC 9788's hcp_baseline default", () => {
        const outer = applyBaselineOuterHeaders(HEADERS);
        expect(outer.subject).toBe("[...]");
        expect(outer.from).toBe(HEADERS.from);
        expect(outer.to).toBe(HEADERS.to);
        expect(outer.date).toBe(HEADERS.date);
        expect(outer.messageId).toBe(HEADERS.messageId);
    });
});

describe("buildSignedOnlyMessage / parseSignedOnlyMessage", () => {
    it("round-trips: verifies, and recovers protected headers, body, and signer certificate", async () => {
        const alice = await generateTestIdentity("alice@example.com", "sign");
        const { contentType, body } = await buildSignedOnlyMessage("text/plain; charset=utf-8", "Hello, Bob.", HEADERS, alice.certDer, alice.privateKey);

        expect(contentType).toContain("multipart/signed");
        expect(contentType).toContain('protocol="application/pkcs7-signature"');

        const result = await parseSignedOnlyMessage(contentType, body);
        expect(result.verified).toBe(true);
        expect(result.signerCertificateDer).toEqual(alice.certDer);
        expect(result.bodyContentType).toContain("text/plain");
        expect(result.bodyContentType).toContain('hp="clear"');
        expect(result.bodyText).toBe("Hello, Bob.");
        expect(result.protectedHeaders).toEqual(HEADERS);
    });

    it("fails verification when the body was tampered with in transit", async () => {
        const alice = await generateTestIdentity("alice@example.com", "sign");
        const { contentType, body } = await buildSignedOnlyMessage("text/plain; charset=utf-8", "Hello, Bob.", HEADERS, alice.certDer, alice.privateKey);

        const encodedBody = Buffer.from("Hello, Bob.").toString("base64");
        expect(body).toContain(encodedBody);
        const tampered = body.replace(encodedBody, Buffer.from("Hello, Eve.").toString("base64"));
        const result = await parseSignedOnlyMessage(contentType, tampered);
        expect(result.verified).toBe(false);
    });

    it("base64-encodes the signed body so long lines survive MTA rewrapping", async () => {
        const alice = await generateTestIdentity("alice@example.com", "sign");
        const longHtml = `<p>${"word ".repeat(1000)}</p>`;
        const { contentType, body } = await buildSignedOnlyMessage("text/html; charset=utf-8", longHtml, HEADERS, alice.certDer, alice.privateKey);

        expect(body).toContain("Content-Transfer-Encoding: base64");
        expect(Math.max(...body.split("\r\n").map((line) => line.length))).toBeLessThanOrEqual(998);
        const result = await parseSignedOnlyMessage(contentType, body);
        expect(result.verified).toBe(true);
        expect(result.bodyText).toBe(longHtml);
    });

    it("reports unverified for a Content-Type with no boundary parameter", async () => {
        const result = await parseSignedOnlyMessage("multipart/signed; protocol=\"application/pkcs7-signature\"", "irrelevant");
        expect(result.verified).toBe(false);
    });

    it("reports unverified when the boundary produces fewer than two parts", async () => {
        const result = await parseSignedOnlyMessage('multipart/signed; boundary="B"', "--B--");
        expect(result.verified).toBe(false);
    });

    it("reports unverified when the signature part's body isn't valid base64", async () => {
        const boundary = "B";
        const body = [
            `--${boundary}`,
            "Content-Type: text/plain",
            "",
            "body text",
            `--${boundary}`,
            "Content-Type: application/pkcs7-signature",
            "",
            "not-valid-base64!!",
            `--${boundary}--`,
        ].join("\r\n");
        const result = await parseSignedOnlyMessage(`multipart/signed; boundary="${boundary}"`, body);
        expect(result.verified).toBe(false);
    });
});

const HEADERS_NO_CC: ProtectedHeaders = {
    from: "alice@example.com",
    to: "bob@example.com",
    date: "Wed, 11 Jan 2023 16:08:43 -0500",
    subject: "Real subject line",
    messageId: "<abc123@example.com>",
};

describe("parseSignedOnlyMessage header parsing", () => {
    it("omits the Cc line entirely when there is no Cc (protected or HP-Outer)", async () => {
        const alice = await generateTestIdentity("alice@example.com", "sign");
        const { contentType, body } = await buildSignedOnlyMessage(
            "text/plain; charset=utf-8",
            "no cc here",
            HEADERS_NO_CC,
            alice.certDer,
            alice.privateKey,
        );
        const result = await parseSignedOnlyMessage(contentType, body);
        expect(result.verified).toBe(true);
        expect(result.protectedHeaders?.cc).toBeUndefined();

        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        const { body: encryptedBody } = await buildEncryptedMessage(
            "text/plain",
            "no cc here either",
            HEADERS_NO_CC,
            applyBaselineOuterHeaders(HEADERS_NO_CC),
            [bob.certDer],
        );
        const encResult = await parseEncryptedMessage(encryptedBody, bob.certDer, bob.privateKey);
        expect(encResult.protectedHeaders?.cc).toBeUndefined();
    });

    it("treats an entity with no blank-line separator as all-headers, empty body", async () => {
        const alice = await generateTestIdentity("alice@example.com", "sign");
        const boundary = "B";
        // No blank-line separator anywhere in this inner entity at all.
        const innerEntity = `Content-Type: text/plain; hp="clear"`;
        const { signDetached } = await import("../../../lib/crypto/smime.js");
        const signature = await signDetached(new TextEncoder().encode(innerEntity), alice.certDer, alice.privateKey);
        const { toBase64 } = await import("../../../lib/crypto/encoding.js");
        const body = [
            `--${boundary}`,
            innerEntity,
            `--${boundary}`,
            "Content-Type: application/pkcs7-signature",
            "",
            toBase64(signature),
            `--${boundary}--`,
        ].join("\r\n");

        const result = await parseSignedOnlyMessage(`multipart/signed; boundary="${boundary}"`, body);
        expect(result.verified).toBe(true);
        expect(result.bodyText).toBe("");
    });

    it("skips a malformed header line with no colon, rather than treating it as a header", async () => {
        const alice = await generateTestIdentity("alice@example.com", "sign");
        const boundary = "B";
        const innerEntity = ["not a real header line", `Content-Type: text/plain; hp="clear"`, "", "body text"].join("\r\n");
        const { signDetached } = await import("../../../lib/crypto/smime.js");
        const signature = await signDetached(new TextEncoder().encode(innerEntity), alice.certDer, alice.privateKey);
        const { toBase64 } = await import("../../../lib/crypto/encoding.js");
        const body = [
            `--${boundary}`,
            innerEntity,
            `--${boundary}`,
            "Content-Type: application/pkcs7-signature",
            "",
            toBase64(signature),
            `--${boundary}--`,
        ].join("\r\n");

        const result = await parseSignedOnlyMessage(`multipart/signed; boundary="${boundary}"`, body);
        expect(result.verified).toBe(true);
        expect(result.bodyText).toBe("body text");
    });
});

describe("buildEncryptedMessage / parseEncryptedMessage", () => {
    it("round-trips an encrypted-only message (no inner signature)", async () => {
        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        const outerHeaders = applyBaselineOuterHeaders(HEADERS);

        const { contentType, body, additionalHeaders } = await buildEncryptedMessage(
            "text/plain; charset=utf-8",
            "Encrypted body content.",
            HEADERS,
            outerHeaders,
            [bob.certDer],
        );

        expect(contentType).toContain('smime-type="enveloped-data"');
        expect(additionalHeaders?.["Content-Transfer-Encoding"]).toBe("base64");

        const result = await parseEncryptedMessage(body, bob.certDer, bob.privateKey);
        expect(result.decrypted).toBe(true);
        expect(result.signatureVerified).toBeUndefined();
        expect(result.bodyContentType).toContain('hp="cipher"');
        expect(result.bodyText).toBe("Encrypted body content.");
        expect(result.protectedHeaders).toEqual(HEADERS);
    });

    it("round-trips a signed-then-encrypted message, verifying the inner signature", async () => {
        const alice = await generateTestIdentity("alice@example.com", "sign");
        const aliceEncrypt = await generateTestIdentity("alice@example.com", "encrypt");
        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        const outerHeaders = applyBaselineOuterHeaders(HEADERS);

        // Encrypt to self (aliceEncrypt) alongside the real recipient (bob), per the spec.
        const { body } = await buildEncryptedMessage(
            "text/plain; charset=utf-8",
            "Signed and encrypted body.",
            HEADERS,
            outerHeaders,
            [bob.certDer, aliceEncrypt.certDer],
            { certDer: alice.certDer, privateKey: alice.privateKey },
        );

        const bobResult = await parseEncryptedMessage(body, bob.certDer, bob.privateKey);
        expect(bobResult.decrypted).toBe(true);
        expect(bobResult.signatureVerified).toBe(true);
        expect(bobResult.signerCertificateDer).toEqual(alice.certDer);
        expect(bobResult.bodyText).toBe("Signed and encrypted body.");

        // The sender's own encrypt-to-self copy independently decrypts and verifies too.
        const selfResult = await parseEncryptedMessage(body, aliceEncrypt.certDer, aliceEncrypt.privateKey);
        expect(selfResult.decrypted).toBe(true);
        expect(selfResult.signatureVerified).toBe(true);
    });

    it("reports not-decrypted for base64 that doesn't decode", async () => {
        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        const result = await parseEncryptedMessage("not valid base64!!", bob.certDer, bob.privateKey);
        expect(result.decrypted).toBe(false);
    });

    it("reports not-decrypted when decrypting with a key that was never a recipient", async () => {
        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        const eve = await generateTestIdentity("eve@example.com", "encrypt");
        const outerHeaders = applyBaselineOuterHeaders(HEADERS);

        const { body } = await buildEncryptedMessage("text/plain", "secret", HEADERS, outerHeaders, [bob.certDer]);
        const result = await parseEncryptedMessage(body, eve.certDer, eve.privateKey);
        expect(result.decrypted).toBe(false);
    });

    it("reports not-decrypted when the embedded signed-data claim isn't even valid base64", async () => {
        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        const { encryptForRecipients } = await import("../../../lib/crypto/smime.js");
        const bogusEntity = ['Content-Type: application/pkcs7-mime; smime-type="signed-data"', "", "not-valid-base64!!"].join("\r\n");
        const enveloped = await encryptForRecipients(new TextEncoder().encode(bogusEntity), [bob.certDer]);
        const { toBase64 } = await import("../../../lib/crypto/encoding.js");

        const result = await parseEncryptedMessage(toBase64(enveloped), bob.certDer, bob.privateKey);
        expect(result.decrypted).toBe(false);
    });

    it("reports signatureVerified: false when the embedded signed-data is malformed", async () => {
        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        // Build a plaintext entity that claims to be signed-data but contains garbage instead of a
        // real CMS SignedData structure, then encrypt it directly (bypassing signOpaque()).
        const { encryptForRecipients } = await import("../../../lib/crypto/smime.js");
        const bogusEntity = ['Content-Type: application/pkcs7-mime; smime-type="signed-data"', "", "bm90IHJlYWwgc2lnbmVkIGRhdGE="].join(
            "\r\n",
        );
        const enveloped = await encryptForRecipients(new TextEncoder().encode(bogusEntity), [bob.certDer]);
        const { toBase64 } = await import("../../../lib/crypto/encoding.js");

        const result = await parseEncryptedMessage(toBase64(enveloped), bob.certDer, bob.privateKey);
        expect(result.decrypted).toBe(true);
        expect(result.signatureVerified).toBe(false);
    });
});

describe("parseEncryptedMessage HP-Outer tamper detection", () => {
    it("is undefined when the caller supplies no actualOuterHeaders to compare against", async () => {
        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        const outerHeaders = applyBaselineOuterHeaders(HEADERS);
        const { body } = await buildEncryptedMessage("text/plain", "hi", HEADERS, outerHeaders, [bob.certDer]);

        const result = await parseEncryptedMessage(body, bob.certDer, bob.privateKey);
        expect(result.headerTamperDetected).toBeUndefined();
    });

    it("is false when the real outer envelope matches the embedded HP-Outer field copies", async () => {
        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        const outerHeaders = applyBaselineOuterHeaders(HEADERS);
        const { body } = await buildEncryptedMessage("text/plain", "hi", HEADERS, outerHeaders, [bob.certDer]);

        const result = await parseEncryptedMessage(body, bob.certDer, bob.privateKey, outerHeaders);
        expect(result.headerTamperDetected).toBe(false);
    });

    it("is true when the real outer envelope's Subject disagrees with the embedded HP-Outer copy", async () => {
        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        const outerHeaders = applyBaselineOuterHeaders(HEADERS);
        const { body } = await buildEncryptedMessage("text/plain", "hi", HEADERS, outerHeaders, [bob.certDer]);

        const tamperedOuter = { ...outerHeaders, subject: "A completely different subject" };
        const result = await parseEncryptedMessage(body, bob.certDer, bob.privateKey, tamperedOuter);
        expect(result.headerTamperDetected).toBe(true);
    });

    it("is true when the real outer envelope drops a Cc the embedded HP-Outer copy carries", async () => {
        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        const outerHeaders = applyBaselineOuterHeaders(HEADERS);
        const { body } = await buildEncryptedMessage("text/plain", "hi", HEADERS, outerHeaders, [bob.certDer]);

        const tamperedOuter = { ...outerHeaders, cc: undefined };
        const result = await parseEncryptedMessage(body, bob.certDer, bob.privateKey, tamperedOuter);
        expect(result.headerTamperDetected).toBe(true);
    });

    it("compares correctly through a signed-then-encrypted message too", async () => {
        const alice = await generateTestIdentity("alice@example.com", "sign");
        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        const outerHeaders = applyBaselineOuterHeaders(HEADERS);
        const { body } = await buildEncryptedMessage("text/plain", "hi", HEADERS, outerHeaders, [bob.certDer], {
            certDer: alice.certDer,
            privateKey: alice.privateKey,
        });

        const matching = await parseEncryptedMessage(body, bob.certDer, bob.privateKey, outerHeaders);
        expect(matching.headerTamperDetected).toBe(false);

        const tamperedOuter = { ...outerHeaders, from: "eve@example.com" };
        const tampered = await parseEncryptedMessage(body, bob.certDer, bob.privateKey, tamperedOuter);
        expect(tampered.headerTamperDetected).toBe(true);
    });

    it("is undefined when the encrypted content carries no HP-Outer lines at all", async () => {
        const bob = await generateTestIdentity("bob@example.com", "encrypt");
        // HEADERS_NO_CC has no `outerHeaders` argument, i.e. `buildEncryptedMessage()` called without
        // an `hpOuter` - matches a hypothetical foreign S/MIME sender that never writes HP-Outer at all.
        const { encryptForRecipients } = await import("../../../lib/crypto/smime.js");
        const plaintextEntity = ["From: alice@example.com", "To: bob@example.com", 'Content-Type: text/plain; hp="cipher"', "", "hi"].join(
            "\r\n",
        );
        const enveloped = await encryptForRecipients(new TextEncoder().encode(plaintextEntity), [bob.certDer]);
        const { toBase64 } = await import("../../../lib/crypto/encoding.js");

        const result = await parseEncryptedMessage(toBase64(enveloped), bob.certDer, bob.privateKey, {
            from: "alice@example.com",
            to: "bob@example.com",
        });
        expect(result.decrypted).toBe(true);
        expect(result.headerTamperDetected).toBeUndefined();
    });
});
