// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
/**
 * Regression tests for the round-4 review of the crypto/MIME code: destroyed master keys being used
 * silently, duplicate address headers showing a forged sender as verified (PoC `sec.mts`), a malformed SAN
 * throwing out of message evaluation (PoC `sec.mts`), header injection and non-ASCII header encoding on the
 * send path, byte-preserving (binary string) parsing of 8bit content, and the reader-addressing flag.
 */
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { toBase64 } from "../../../lib/crypto/encoding.js";
import { KeysLockedError as SessionKeysLockedError } from "../../../lib/crypto/keySession.js";
import { KeysLockedError, assertKeyMaterialUsable, buildAad, generateMasterKey, hkdfDerive, openWithKey, sealWithKey } from "../../../lib/crypto/masterKey.js";
import { buildEscrowWrap, buildPasswordWrap, buildRecoveryWraps } from "../../../lib/crypto/masterKeyWraps.js";
import { checkSignerBinding, evaluateMessageSecurity } from "../../../lib/crypto/messageSecurity.js";
import { bytesToBinaryString } from "../../../lib/crypto/mime.js";
import { computeCertFingerprint, extractCertificateEmails, signDetached } from "../../../lib/crypto/smime.js";
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

const CRLF = "\r\n";

interface TestIdentity {
    certDer: Uint8Array;
    privateKey: CryptoKey;
}

async function generateIdentity(name: string, keyUsage: "sign" | "encrypt" = "sign", extensions: x509.Extension[] = []): Promise<TestIdentity> {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "01",
        name,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 86_400_000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys,
        extensions,
    });
    let privateKey = keys.privateKey;
    if (keyUsage === "encrypt") {
        const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
        privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    }
    return { certDer: new Uint8Array(cert.rawData), privateKey };
}

const wrap = (bytes: Uint8Array) => toBase64(bytes).match(/.{1,76}/g)!.join(CRLF);

/** A foreign-shaped multipart/signed message around `innerBytes` (the exact signed bytes), as a binary string. */
async function foreignSignedMessage(outerHeaders: string[], innerBytes: Uint8Array, signer: TestIdentity): Promise<string> {
    const signature = await signDetached(innerBytes, signer.certDer, signer.privateKey);
    const head = [...outerHeaders, 'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary=b1', "", "--b1", ""].join(CRLF);
    const tail = [
        "",
        "--b1",
        "Content-Type: application/pkcs7-signature",
        "Content-Transfer-Encoding: base64",
        "",
        wrap(signature),
        "--b1--",
    ].join(CRLF);
    return head + bytesToBinaryString(innerBytes) + tail;
}

const HEADERS: ProtectedHeaders = {
    from: "alice@example.com",
    to: "bob@example.com",
    date: "Wed, 11 Jan 2023 16:08:43 -0500",
    subject: "Real subject",
    messageId: "<abc123@example.com>",
};

describe("finding 1: destroyed (all-zero) key material", () => {
    const aad = buildAad("mb1", "test");

    it("sealWithKey/openWithKey/hkdfDerive throw KeysLockedError for an all-zero or empty key", async () => {
        const zero = new Uint8Array(32);
        await expect(sealWithKey(zero, new Uint8Array([1]), aad)).rejects.toBeInstanceOf(KeysLockedError);
        await expect(openWithKey(zero, { ciphertext: "AAAA", nonce: "AAAAAAAAAAAAAAAA" }, aad)).rejects.toBeInstanceOf(KeysLockedError);
        await expect(hkdfDerive(zero, new Uint8Array(16), "wrap")).rejects.toBeInstanceOf(KeysLockedError);
        await expect(hkdfDerive(new Uint8Array(), new Uint8Array(16), "wrap")).rejects.toBeInstanceOf(KeysLockedError);
        expect(() => assertKeyMaterialUsable(generateMasterKey())).not.toThrow();
    });

    it("refuses to seal a destroyed master key as plaintext, and keySession re-exports the same error class", async () => {
        const err = await sealWithKey(generateMasterKey(), new Uint8Array(32), aad).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SessionKeysLockedError);
        expect((err as Error).message).toMatch(/locked/i);
        // A 32-byte non-zero plaintext, and a zero plaintext of any other length, still seal normally.
        await expect(sealWithKey(generateMasterKey(), generateMasterKey(), aad)).resolves.toHaveProperty("ciphertext");
        await expect(sealWithKey(generateMasterKey(), new Uint8Array(16), aad)).resolves.toHaveProperty("ciphertext");
    });

    it("never builds a password, recovery, or escrow wrap of a destroyed master key", async () => {
        const zero = new Uint8Array(32);
        const escrow = await generateIdentity("CN=escrow@example.com", "encrypt");
        await expect(buildPasswordWrap("mb1", zero, "pw", { memorySize: 8, iterations: 1, parallelism: 1 })).rejects.toBeInstanceOf(KeysLockedError);
        await expect(buildRecoveryWraps("mb1", zero, 1)).rejects.toBeInstanceOf(KeysLockedError);
        await expect(buildEscrowWrap(zero, "scope-1", escrow.certDer)).rejects.toBeInstanceOf(KeysLockedError);
    });
});

describe("finding 3: duplicate From/To/Cc/Sender headers", () => {
    // PoC sec.mts: a second outer `From:` inserted before `To:` - the first (checked) From is Alice's, a client
    // displaying the last one shows the CEO, and the result was still signed_verified.
    it("is header_mismatch when the outer envelope repeats From", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const raw = assembleOutboundMime(HEADERS, await buildSignedOnlyMessage("text/plain; charset=utf-8", "hello", HEADERS, alice.certDer, alice.privateKey));
        const forged = raw.replace("To: bob@example.com", "From: ceo@example.com\r\nTo: bob@example.com");
        expect(await evaluateMessageSecurity(forged, undefined)).toMatchObject({ state: "signature_failed", signatureFailureReason: "header_mismatch" });
    });

    it("is header_mismatch when the signed (protected) headers repeat From, even though the signature is valid", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const inner = new TextEncoder().encode(
            ["From: alice@example.com", "From: ceo@example.com", "To: bob@example.com", 'Content-Type: text/plain; hp="clear"', "", "hi"].join(CRLF),
        );
        const raw = await foreignSignedMessage(["From: alice@example.com", "To: bob@example.com"], inner, alice);
        expect(await evaluateMessageSecurity(raw, undefined)).toMatchObject({ state: "signature_failed", signatureFailureReason: "header_mismatch" });
    });

    it("counts Sender, To, and Cc case-insensitively too, but not other repeated fields", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const base = { signerCertificateDer: alice.certDer, protectedHeaders: undefined, outerHeaders: { from: "alice@example.com" } };
        const field = (name: string, value = "x@example.com") => ({ name, value });
        for (const repeated of ["SENDER", "to", "Cc"]) {
            expect(await checkSignerBinding({ ...base, outerFields: [field("From"), field(repeated), field(repeated)] })).toBe("header_mismatch");
            expect(await checkSignerBinding({ ...base, protectedFields: [field(repeated), field(repeated)] })).toBe("header_mismatch");
        }
        expect(await checkSignerBinding({ ...base, outerFields: [field("From", "alice@example.com"), field("Received"), field("Received")] })).toBeUndefined();
    });

    it("is header_mismatch for a repeated protected To inside a signed-then-encrypted message", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const bob = await generateIdentity("CN=bob@example.com", "encrypt");
        const part = await buildEncryptedMessage("text/plain", "hi", HEADERS, applyBaselineOuterHeaders(HEADERS), [bob.certDer], {
            certDer: alice.certDer,
            privateKey: alice.privateKey,
        });
        const parsed = await parseEncryptedMessage(part.body, bob.certDer, bob.privateKey);
        expect(parsed.protectedHeaderFields?.filter((f) => f.name === "To")).toHaveLength(1);
        const result = await checkSignerBinding({
            signerCertificateDer: parsed.signerCertificateDer,
            protectedHeaders: parsed.protectedHeaders,
            outerHeaders: { from: HEADERS.from, to: HEADERS.to },
            protectedFields: [...parsed.protectedHeaderFields!, { name: "To", value: "mallory@example.com" }],
        });
        expect(result).toBe("header_mismatch");
    });
});

describe("finding 10: malformed SubjectAlternativeName", () => {
    // PoC sec.mts: `extension.parsedValue` is undefined for an unparseable SAN, and `.altNames` threw a
    // TypeError out of evaluateMessageSecurity() (which the caller then treated as unprotected).
    it("extracts no emails and evaluates to signature_failed instead of throwing", async () => {
        const mallory = await generateIdentity("CN=mallory@example.com", "sign", [new x509.Extension("2.5.29.17", false, new Uint8Array([0xff, 0xff, 0x01]))]);
        expect(extractCertificateEmails(mallory.certDer)).toEqual([]);
        const headers = { ...HEADERS, from: "mallory@example.com" };
        const raw = assembleOutboundMime(headers, await buildSignedOnlyMessage("text/plain", "hello", headers, mallory.certDer, mallory.privateKey));
        expect(await evaluateMessageSecurity(raw, undefined)).toMatchObject({ state: "signature_failed", signatureFailureReason: "signer_identity_mismatch", signerEmails: [] });
    });
});

describe("finding 11: notAddressedToReader", () => {
    it("is false when the reader is in protected To or Cc, true otherwise, and absent without a reader address", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const headers = { ...HEADERS, to: "Bob <bob@example.com>", cc: "carol@example.com" };
        const raw = assembleOutboundMime(headers, await buildSignedOnlyMessage("text/plain", "hi", headers, alice.certDer, alice.privateKey));

        expect((await evaluateMessageSecurity(raw, undefined, undefined, "BOB@example.com")).notAddressedToReader).toBe(false);
        expect((await evaluateMessageSecurity(raw, undefined, undefined, " carol@example.com ")).notAddressedToReader).toBe(false);
        const replayed = await evaluateMessageSecurity(raw, undefined, await computeCertFingerprint(alice.certDer), "dave@example.com");
        expect(replayed).toMatchObject({ state: "signed_verified", notAddressedToReader: true });
        expect(await evaluateMessageSecurity(raw, undefined)).not.toHaveProperty("notAddressedToReader");
    });

    it("is set for a decrypted message too, and absent when nothing protected names any recipient", async () => {
        const bob = await generateIdentity("CN=bob@example.com", "encrypt");
        const part = await buildEncryptedMessage("text/plain", "hi", HEADERS, applyBaselineOuterHeaders(HEADERS), [bob.certDer]);
        const raw = assembleOutboundMime(applyBaselineOuterHeaders(HEADERS), part);
        const unlocked = { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer };
        expect(await evaluateMessageSecurity(raw, unlocked, undefined, "eve@example.com")).toMatchObject({ state: "encrypted", notAddressedToReader: true });

        const alice = await generateIdentity("CN=alice@example.com");
        const inner = new TextEncoder().encode(["Content-Type: text/plain", "", "no protected headers"].join(CRLF));
        const foreign = await foreignSignedMessage(["From: alice@example.com", "To: bob@example.com"], inner, alice);
        expect(await evaluateMessageSecurity(foreign, undefined, undefined, "eve@example.com")).not.toHaveProperty("notAddressedToReader");
    });
});

describe("finding 7: header injection and non-ASCII headers on the send path", () => {
    it("never lets a CR/LF in Subject, a display name, Date, Message-ID, or Content-Type start a new header", async () => {
        const headers: ProtectedHeaders = {
            from: "Alice\r\nBcc: spy@example.com <alice@example.com>",
            to: "bob@example.com\nX-Evil: 1",
            cc: "carol@example.com\r\n\r\nbody-injection",
            date: `${HEADERS.date}\r\nX-Date: 1`,
            subject: "hi\r\nBcc: victim@example.com",
            messageId: "<a@b>\rX-Id: 1",
        };
        const alice = await generateIdentity("CN=alice@example.com");
        const part = await buildSignedOnlyMessage("text/plain\r\nX-Type: 1", "body", headers, alice.certDer, alice.privateKey);
        const raw = assembleOutboundMime(headers, { ...part, additionalHeaders: { "X-Extra": "a\r\nX-Injected: 1" } });
        const headerNames = raw
            .split(/\r\n\r\n/)[0]
            .split(CRLF)
            .filter((line) => !/^[ \t]/.test(line))
            .map((line) => line.slice(0, line.indexOf(":")));
        expect(headerNames).toEqual(["From", "To", "Cc", "Date", "Subject", "Message-ID", "MIME-Version", "Content-Type", "X-Extra"]);
        expect(raw).not.toMatch(/\r\n(Bcc|X-Evil|X-Date|X-Id|X-Type|X-Injected):/);

        const parsed = await parseSignedOnlyMessage(part.contentType, part.body);
        expect(parsed.verified).toBe(true);
        expect(parsed.protectedHeaderFields!.map((f) => f.name)).toEqual(["From", "To", "Cc", "Date", "Subject", "Message-ID", "Content-Type", "Content-Transfer-Encoding"]);
    });

    it("RFC 2047-encodes a non-ASCII Subject and display names, and still verifies and decodes them on receipt", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const headers: ProtectedHeaders = { ...HEADERS, from: '"Zoë, Alice" <alice@example.com>', to: "Jürgen <bob@example.com>", subject: "Réunion ☕ — ordre du jour" };
        const raw = assembleOutboundMime(headers, await buildSignedOnlyMessage("text/plain; charset=utf-8", "salut", headers, alice.certDer, alice.privateKey));
        expect(raw.split("\r\n\r\n")[0]).not.toMatch(/[^\x20-\x7e\r\n\t]/);
        expect(await evaluateMessageSecurity(raw, undefined, await computeCertFingerprint(alice.certDer), "bob@example.com")).toMatchObject({
            state: "signed_verified",
            html: expect.stringContaining("salut"),
            text: "salut",
            subject: "Réunion ☕ — ordre du jour",
            protectedHeaders: { from: '=?UTF-8?B?Wm/DqywgQWxpY2U=?= <alice@example.com>', subject: "Réunion ☕ — ordre du jour" },
            notAddressedToReader: false,
        });
    });

    it("keeps HP-Outer comparison exact for encoded headers (no false tamper) and still detects a rewrite", async () => {
        const bob = await generateIdentity("CN=bob@example.com", "encrypt");
        const headers: ProtectedHeaders = { ...HEADERS, from: "Zoë <alice@example.com>", subject: "Réunion ☕" };
        const outer = applyBaselineOuterHeaders(headers);
        const raw = assembleOutboundMime(outer, await buildEncryptedMessage("text/plain; charset=utf-8", "café ☕", headers, outer, [bob.certDer]));
        const unlocked = { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer };
        expect(await evaluateMessageSecurity(raw, unlocked)).toMatchObject({ state: "encrypted", headerTamperDetected: false, subject: "Réunion ☕", text: "café ☕" });

        const rewritten = raw.replace(/^From: .*$/m, "From: Mallory <alice@example.com>");
        expect((await evaluateMessageSecurity(rewritten, unlocked)).headerTamperDetected).toBe(true);
    });
});

describe("finding 13: byte-preserving (binary string) parsing of 8bit content", () => {
    it("verifies and charset-decodes an 8bit UTF-8 signed part held as a binary string", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const inner = new TextEncoder().encode(["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", "café ☕"].join(CRLF));
        const raw = await foreignSignedMessage(["From: alice@example.com", "To: bob@example.com"], inner, alice);
        expect(await evaluateMessageSecurity(raw, undefined, await computeCertFingerprint(alice.certDer))).toMatchObject({ state: "signed_verified", text: "café ☕" });
    });

    it("verifies an 8bit ISO-8859-1 part whose bytes aren't valid UTF-8 (res.text() would have replaced them)", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const header = new TextEncoder().encode(["Content-Type: text/html; charset=iso-8859-1", "Content-Transfer-Encoding: 8bit", "", "<p>caf"].join(CRLF));
        const inner = new Uint8Array([...header, 0xe9, ...new TextEncoder().encode("</p>")]);
        const raw = await foreignSignedMessage(["From: alice@example.com", "To: bob@example.com"], inner, alice);
        expect(await evaluateMessageSecurity(raw, undefined)).toMatchObject({ state: "signed_unverified_signer", html: "<p>café</p>", attachments: [] });
        // What the pre-fix `res.text()` path produced: the byte replaced by U+FFFD, so the signature can't verify.
        const lossy = new TextDecoder().decode(new Uint8Array([...header, 0xe9, ...new TextEncoder().encode("</p>")]));
        expect(lossy).toContain("�");
    });

    it("still verifies a message a legacy caller already decoded as UTF-8 text", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const innerText = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", "café"].join(CRLF);
        const binary = await foreignSignedMessage(["From: alice@example.com", "To: bob@example.com"], new TextEncoder().encode(innerText), alice);
        const decoded = new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
        expect(decoded).toContain("café");
        expect(await evaluateMessageSecurity(decoded, undefined, [await computeCertFingerprint(alice.certDer)])).toMatchObject({ state: "signed_verified", text: "café" });
    });

    it("decodes a raw 8-bit UTF-8 protected Subject from a foreign sender", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const inner = new TextEncoder().encode(["From: alice@example.com", "To: bob@example.com", "Subject: Grüße", "Content-Type: text/plain", "", "hi"].join(CRLF));
        const outerSubject = bytesToBinaryString(new TextEncoder().encode("Subject: Grüße"));
        const raw = await foreignSignedMessage(["From: alice@example.com", "To: bob@example.com", outerSubject], inner, alice);
        expect((await evaluateMessageSecurity(raw, undefined)).subject).toBe("Grüße");

    });
});
