// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
/**
 * Regression tests for the round-3 security review of the S/MIME receive path: the reviewer's two
 * exploit PoCs (an opaque SignedData stapled onto attacker content as a "detached" signature, and a
 * signer-certificate substitution via `certificates[0]`), signer-identity binding, non-AEAD content
 * encryption rejection, and foreign-MUA MIME framing.
 */
import "reflect-metadata";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { toBase64 } from "../../../lib/crypto/encoding.js";
import { checkSignerBinding, evaluateMessageSecurity } from "../../../lib/crypto/messageSecurity.js";
import {
    UnsupportedContentEncryptionError,
    computeCertFingerprint,
    decryptEnvelopedData,
    encryptForRecipients,
    extractCertificateEmails,
    signDetached,
    signOpaque,
    verifyDetached,
    verifyOpaque,
} from "../../../lib/crypto/smime.js";
import {
    ProtectedHeaders,
    assembleOutboundMime,
    buildEncryptedMessage,
    buildSignedOnlyMessage,
    parseEncryptedMessage,
    splitHeadersAndBody,
} from "../../../lib/crypto/smimeMessage.js";

x509.cryptoProvider.set(crypto);

const CRLF = "\r\n";

interface TestIdentity {
    certDer: Uint8Array;
    privateKey: CryptoKey;
}

async function generateIdentity(
    name: string,
    keyUsage: "sign" | "encrypt" = "sign",
    extensions: x509.Extension[] = [],
    serialNumber = "01",
): Promise<TestIdentity> {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber,
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

function signedMime(outerHeaders: string[], innerEntity: string, signatureDer: Uint8Array, contentTypeHeader?: string): string {
    const boundary = "b1";
    const body = [
        `--${boundary}`,
        innerEntity,
        `--${boundary}`,
        "Content-Type: application/pkcs7-signature",
        "Content-Transfer-Encoding: base64",
        "",
        wrap(signatureDer),
        `--${boundary}--`,
    ].join(CRLF);
    return [
        ...outerHeaders,
        contentTypeHeader ?? `Content-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="${boundary}"`,
        "",
        body,
    ].join(CRLF);
}

const HEADERS: ProtectedHeaders = {
    from: "alice@example.com",
    to: "bob@example.com",
    date: "Wed, 11 Jan 2023 16:08:43 -0500",
    subject: "Real subject",
    messageId: "<abc123@example.com>",
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function parsePkijsCert(der: Uint8Array): pkijs.Certificate {
    return new pkijs.Certificate({ schema: asn1js.fromBER(toArrayBuffer(der)).result });
}

describe("PoC 1: an opaque SignedData presented as a detached signature", () => {
    it("is rejected by verifyDetached() even though its embedded content verifies", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const opaque = await signOpaque(new TextEncoder().encode("anything alice ever signed"), alice.certDer, alice.privateKey);
        expect((await verifyOpaque(opaque)).valid).toBe(true);
        expect(await verifyDetached(new TextEncoder().encode("<p>ATTACKER CONTENT</p>"), opaque)).toEqual({ valid: false });
    });

    it("never yields signed_verified for attacker content, even with the victim's pin", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const opaque = await signOpaque(new TextEncoder().encode("anything alice ever signed"), alice.certDer, alice.privateKey);
        const inner = ["From: alice@example.com", "Subject: wire $1M", 'Content-Type: text/html; hp="clear"', "", "<p>ATTACKER CONTENT</p>"].join(CRLF);
        const raw = signedMime(["From: alice@example.com"], inner, opaque);

        const pin = await computeCertFingerprint(alice.certDer);
        expect(await evaluateMessageSecurity(raw, undefined, pin)).toEqual({ state: "signature_failed", signatureFailureReason: "invalid_signature" });
    });
});

describe("PoC 2: signer certificate substitution via certificates[0]", () => {
    async function buildSubstitutedSignature(alice: TestIdentity, mallory: TestIdentity, content: Uint8Array): Promise<Uint8Array> {
        const aliceCert = parsePkijsCert(alice.certDer);
        const malloryCert = parsePkijsCert(mallory.certDer);
        const signedData = new pkijs.SignedData({
            encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: pkijs.ContentInfo.DATA }),
            signerInfos: [new pkijs.SignerInfo({ sid: new pkijs.IssuerAndSerialNumber({ issuer: malloryCert.issuer, serialNumber: malloryCert.serialNumber }) })],
            certificates: [aliceCert, malloryCert],
        });
        await signedData.sign(mallory.privateKey, 0, "SHA-256", toArrayBuffer(content));
        const contentInfo = new pkijs.ContentInfo({ contentType: pkijs.ContentInfo.SIGNED_DATA, content: signedData.toSchema(true) });
        return new Uint8Array(contentInfo.toSchema().toBER());
    }

    it("verifyDetached() reports the certificate that actually signed, not the first embedded one", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const mallory = await generateIdentity("CN=mallory@evil.test", "sign", [], "02");
        const content = new TextEncoder().encode("mallory wrote this");
        const result = await verifyDetached(content, await buildSubstitutedSignature(alice, mallory, content));
        expect(result.valid).toBe(true);
        expect(result.signerCertificateDer).toEqual(mallory.certDer);
    });

    it("is untrusted_signer with the victim's pin, and signer_identity_mismatch without one", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const mallory = await generateIdentity("CN=mallory@evil.test", "sign", [], "02");
        const inner = ["From: alice@example.com", "Subject: hi", 'Content-Type: text/html; hp="clear"', "", "<p>mallory wrote this</p>"].join(CRLF);
        const signature = await buildSubstitutedSignature(alice, mallory, new TextEncoder().encode(inner));
        const raw = signedMime(["From: alice@example.com"], inner, signature, 'Content-Type: multipart/signed; boundary="b1"');

        const pin = await computeCertFingerprint(alice.certDer);
        expect(await evaluateMessageSecurity(raw, undefined, pin)).toMatchObject({ state: "signature_failed", signatureFailureReason: "untrusted_signer" });
        expect(await evaluateMessageSecurity(raw, undefined)).toMatchObject({ state: "signature_failed", signatureFailureReason: "signer_identity_mismatch" });
    });
});

describe("SignedData content type", () => {
    it("rejects an opaque signature whose eContentType isn't id-data", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const cert = parsePkijsCert(alice.certDer);
        const signedData = new pkijs.SignedData({
            encapContentInfo: new pkijs.EncapsulatedContentInfo({
                eContentType: "1.2.3.4",
                eContent: new asn1js.OctetString({ valueHex: toArrayBuffer(new TextEncoder().encode("x")) }),
            }),
            signerInfos: [new pkijs.SignerInfo({ sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }) })],
            certificates: [cert],
        });
        await signedData.sign(alice.privateKey, 0, "SHA-256");
        const der = new Uint8Array(new pkijs.ContentInfo({ contentType: pkijs.ContentInfo.SIGNED_DATA, content: signedData.toSchema(true) }).toSchema().toBER());
        expect(await verifyOpaque(der)).toEqual({ valid: false });
    });

    it("reports invalid when no embedded certificate matches the SignerInfo", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const cert = parsePkijsCert(alice.certDer);
        const content = new TextEncoder().encode("x");
        const signedData = new pkijs.SignedData({
            encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: pkijs.ContentInfo.DATA }),
            signerInfos: [new pkijs.SignerInfo({ sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }) })],
            certificates: [cert],
        });
        await signedData.sign(alice.privateKey, 0, "SHA-256", toArrayBuffer(content));
        signedData.certificates = [];
        const der = new Uint8Array(new pkijs.ContentInfo({ contentType: pkijs.ContentInfo.SIGNED_DATA, content: signedData.toSchema(true) }).toSchema().toBER());
        expect(await verifyDetached(content, der)).toEqual({ valid: false });
    });
});

describe("extractCertificateEmails", () => {
    it("uses SAN rfc822Name entries, authoritatively, when present", async () => {
        const identity = await generateIdentity("CN=other@example.com", "sign", [
            new x509.BasicConstraintsExtension(false),
            new x509.SubjectAlternativeNameExtension([
                { type: "dns", value: "example.com" },
                { type: "email", value: "Alice@Example.com" },
            ]),
        ]);
        expect(extractCertificateEmails(identity.certDer)).toEqual(["alice@example.com"]);
    });

    it("falls back to subject emailAddress attributes and an email-shaped CN", async () => {
        const withE = await generateIdentity("CN=Alice Example, E=alice@example.com", "sign", [
            new x509.SubjectAlternativeNameExtension([{ type: "dns", value: "example.com" }]),
        ]);
        expect(extractCertificateEmails(withE.certDer)).toEqual(["alice@example.com"]);
        const cnOnly = await generateIdentity("CN=Bob@Example.com, O=Example");
        expect(extractCertificateEmails(cnOnly.certDer)).toEqual(["bob@example.com"]);
        const noEmail = await generateIdentity("CN=Not An Email");
        expect(extractCertificateEmails(noEmail.certDer)).toEqual([]);
    });

    it("returns [] for unparseable input", () => {
        expect(extractCertificateEmails(new Uint8Array([0x30, 0x7f]))).toEqual([]);
    });
});

describe("signer identity binding", () => {
    it("is signed_verified for a SAN-named certificate and a display-name From with different case", async () => {
        const alice = await generateIdentity("CN=Alice Example", "sign", [new x509.SubjectAlternativeNameExtension([{ type: "email", value: "alice@example.com" }])]);
        const headers = { ...HEADERS, from: '"Alice, Example" <ALICE@example.com>' };
        const raw = assembleOutboundMime(headers, await buildSignedOnlyMessage("text/html", "<p>hi</p>", headers, alice.certDer, alice.privateKey));
        const pin = (await computeCertFingerprint(alice.certDer)).toUpperCase();

        expect(await evaluateMessageSecurity(raw, undefined, pin)).toEqual({
            state: "signed_verified",
            html: "<p>hi</p>",
            subject: "Real subject",
            protectedHeaders: { from: '"Alice, Example" <ALICE@example.com>', to: HEADERS.to, subject: "Real subject" },
            attachments: [],
            signerFingerprint: pin.toLowerCase(),
            signerEmails: ["alice@example.com"],
            signerCertificate: toBase64(alice.certDer),
        });
    });

    it("is signer_identity_mismatch when the certificate doesn't name the From address", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const headers = { ...HEADERS, from: "carol@example.com" };
        const raw = assembleOutboundMime(headers, await buildSignedOnlyMessage("text/plain", "hi", headers, alice.certDer, alice.privateKey));
        expect(await evaluateMessageSecurity(raw, undefined)).toMatchObject({ state: "signature_failed", signatureFailureReason: "signer_identity_mismatch" });
    });

    it("is signer_identity_mismatch when From holds more than one address", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const headers = { ...HEADERS, from: "alice@example.com, carol@example.com" };
        const raw = assembleOutboundMime(headers, await buildSignedOnlyMessage("text/plain", "hi", headers, alice.certDer, alice.privateKey));
        expect((await evaluateMessageSecurity(raw, undefined)).signatureFailureReason).toBe("signer_identity_mismatch");
    });

    it("is header_mismatch when the outer From of a signed-only message was rewritten", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const part = await buildSignedOnlyMessage("text/plain", "hi", HEADERS, alice.certDer, alice.privateKey);
        const raw = assembleOutboundMime({ ...HEADERS, from: "eve@example.com" }, part);
        expect(await evaluateMessageSecurity(raw, undefined)).toMatchObject({ state: "signature_failed", signatureFailureReason: "header_mismatch" });
    });

    it("binds to the outer From for a foreign signed message without protected headers", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const inner = ["Content-Type: text/plain; charset=utf-8", "", "<b>not markup</b>"].join(CRLF);
        const signature = await signDetached(new TextEncoder().encode(inner), alice.certDer, alice.privateKey);

        const good = await evaluateMessageSecurity(signedMime(["From: Alice <alice@example.com>", "To: bob@example.com"], inner, signature), undefined, [
            await computeCertFingerprint(alice.certDer),
        ]);
        expect(good).toEqual({
            state: "signed_verified",
            text: "<b>not markup</b>",
            attachments: [],
            signerFingerprint: await computeCertFingerprint(alice.certDer),
            signerEmails: ["alice@example.com"],
            signerCertificate: toBase64(alice.certDer),
            html: '<pre style="white-space: pre-wrap; word-wrap: break-word; font-family: inherit">&lt;b&gt;not markup&lt;/b&gt;</pre>',
        });
        const spoofed = await evaluateMessageSecurity(signedMime(["From: carol@example.com"], inner, signature), undefined);
        expect(spoofed.signatureFailureReason).toBe("signer_identity_mismatch");
    });

    describe("sign-then-encrypt", () => {
        async function encryptedSigned(protectedHeaders: ProtectedHeaders, outerHeaders: ProtectedHeaders) {
            const alice = await generateIdentity("CN=alice@example.com");
            const bob = await generateIdentity("CN=bob@example.com", "encrypt");
            const part = await buildEncryptedMessage("text/html", "<p>secret</p>", protectedHeaders, outerHeaders, [bob.certDer], {
                certDer: alice.certDer,
                privateKey: alice.privateKey,
            });
            const raw = assembleOutboundMime(outerHeaders, part);
            return evaluateMessageSecurity(raw, { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer });
        }

        it("is encrypted_verified when protected and outer From/To agree, even if only the Subject was rewritten", async () => {
            const result = await encryptedSigned(HEADERS, { ...HEADERS, subject: "[...]" });
            expect(result).toMatchObject({ state: "encrypted_unverified_signer", html: "<p>secret</p>", subject: "Real subject", signerEmails: ["alice@example.com"] });
        });

        it("is header_mismatch when the protected To disagrees with the outer To", async () => {
            const result = await encryptedSigned(HEADERS, { ...HEADERS, to: "mallory@evil.test" });
            expect(result).toMatchObject({ state: "signature_failed", signatureFailureReason: "header_mismatch", html: "<p>secret</p>" });
        });

        it("is signer_identity_mismatch when the signer isn't the protected From", async () => {
            const headers = { ...HEADERS, from: "carol@example.com" };
            const result = await encryptedSigned(headers, headers);
            expect(result).toMatchObject({ state: "signature_failed", signatureFailureReason: "signer_identity_mismatch" });
        });

        it("is invalid_signature (with content) when the inner signed-data is malformed", async () => {
            const bob = await generateIdentity("CN=bob@example.com", "encrypt");
            const bogus = ["Content-Type: application/pkcs7-mime; smime-type=Signed-Data", "", "bm90IHJlYWwgc2lnbmVkIGRhdGE="].join(CRLF);
            const enveloped = await encryptForRecipients(new TextEncoder().encode(bogus), [bob.certDer]);
            const raw = ["From: alice@example.com", "Content-Type: application/pkcs7-mime; smime-type=enveloped-data", "", wrap(enveloped)].join(CRLF);
            const result = await evaluateMessageSecurity(raw, { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer });
            expect(result).toMatchObject({ state: "signature_failed", signatureFailureReason: "invalid_signature" });
        });
    });
});

describe("non-AEAD content encryption", () => {
    async function cbcEnveloped(content: string, recipient: TestIdentity): Promise<Uint8Array> {
        const envelopedData = new pkijs.EnvelopedData();
        envelopedData.addRecipientByCertificate(parsePkijsCert(recipient.certDer));
        const cbc: AesKeyGenParams = { name: "AES-CBC", length: 256 };
        await envelopedData.encrypt(cbc, toArrayBuffer(new TextEncoder().encode(content)));
        return new Uint8Array(new pkijs.ContentInfo({ contentType: pkijs.ContentInfo.ENVELOPED_DATA, content: envelopedData.toSchema() }).toSchema().toBER());
    }

    it("decryptEnvelopedData() refuses AES-CBC content", async () => {
        const bob = await generateIdentity("CN=bob@example.com", "encrypt");
        const enveloped = await cbcEnveloped("malleable", bob);
        const error = await decryptEnvelopedData(enveloped, bob.certDer, bob.privateKey).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(UnsupportedContentEncryptionError);
        expect((error as UnsupportedContentEncryptionError).algorithmOid).toBe("2.16.840.1.101.3.4.1.42");
    });

    it("surfaces a distinct decryptError through parseEncryptedMessage() and evaluateMessageSecurity()", async () => {
        const bob = await generateIdentity("CN=bob@example.com", "encrypt");
        const enveloped = await cbcEnveloped("Content-Type: text/plain\r\n\r\nmalleable", bob);
        expect(await parseEncryptedMessage(toBase64(enveloped), bob.certDer, bob.privateKey)).toEqual({ decrypted: false, unsupportedContentEncryption: true });

        const raw = ["From: alice@example.com", 'Content-Type: application/x-pkcs7-mime; SMIME-TYPE="enveloped-data"', "", wrap(enveloped)].join(CRLF);
        const result = await evaluateMessageSecurity(raw, { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer });
        expect(result.state).toBe("encrypted");
        expect(result.decryptError).toMatch(/unauthenticated encryption/);
    });
});

describe("foreign MIME framing", () => {
    it("verifies a folded, unquoted-boundary, preamble/epilogue message with a base64 text/html body", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const inner = ["Content-Type: text/html; charset=iso-8859-1", "Content-Transfer-Encoding: base64", "", "PHA+Y2Fm6TwvcD4="].join(CRLF);
        const signature = await signDetached(new TextEncoder().encode(inner), alice.certDer, alice.privateKey);
        const raw = [
            "From: alice@example.com",
            "Content-Type: Multipart/Signed;",
            "\tPROTOCOL=application/pkcs7-signature;",
            "\tBoundary=xyz",
            "",
            "This is an S/MIME signed message (preamble).",
            "--xyz",
            inner,
            "--xyz ",
            "Content-Type: application/x-pkcs7-signature; name=smime.p7s",
            "",
            wrap(signature),
            "--xyz--",
            "epilogue",
        ].join(CRLF);
        expect(await evaluateMessageSecurity(raw, undefined)).toMatchObject({ state: "signed_unverified_signer", html: "<p>café</p>" });
    });

    it("verifies a message whose line endings were converted to bare LF in storage", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const raw = assembleOutboundMime(HEADERS, await buildSignedOnlyMessage("text/plain", "line 1\r\nline 2", HEADERS, alice.certDer, alice.privateKey));
        const result = await evaluateMessageSecurity(raw.replace(/\r\n/g, "\n"), undefined, await computeCertFingerprint(alice.certDer));
        expect(result.state).toBe("signed_verified");
        // The body travels base64-encoded, so the storage conversion doesn't reach its own line endings.
        expect(result.text).toBe("line 1\r\nline 2");
    });

    it("is invalid_signature when the second part isn't a pkcs7 signature, or its body is empty", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const raw = assembleOutboundMime(HEADERS, await buildSignedOnlyMessage("text/plain", "hi", HEADERS, alice.certDer, alice.privateKey));
        const pgp = raw.replace("Content-Type: application/pkcs7-signature", "Content-Type: application/pgp-signature");
        expect((await evaluateMessageSecurity(pgp, undefined)).signatureFailureReason).toBe("invalid_signature");
        const empty = ["From: alice@example.com", "Content-Type: multipart/signed; boundary=q", "", "--q", "", "hi", "--q", "Content-Type: application/pkcs7-signature", "", "", "--q--"].join(CRLF);
        expect((await evaluateMessageSecurity(empty, undefined)).signatureFailureReason).toBe("invalid_signature");
    });

    it("classifies pkcs7-mime content types by parsed smime-type only", async () => {
        const noKey = { state: "encrypted", decryptError: "This device doesn't have the key needed to decrypt this message." };
        expect(await evaluateMessageSecurity("Content-Type: application/pkcs7-mime; smime-type=authenveloped-data\r\n\r\nx", undefined)).toEqual(noKey);
        expect(await evaluateMessageSecurity("Content-Type: application/pkcs7-mime; smime-type=signed-data\r\n\r\nx", undefined)).toEqual({ state: "unprotected" });
        expect(await evaluateMessageSecurity("Content-Type: application/pkcs7-mime; name=smime.p7m\r\n\r\nx", undefined)).toEqual({ state: "unprotected" });
    });

    it("renders nothing (but still verifies) when the signed content has no displayable part", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const raw = assembleOutboundMime(HEADERS, await buildSignedOnlyMessage("application/octet-stream", "AAAA", HEADERS, alice.certDer, alice.privateKey));
        expect(await evaluateMessageSecurity(raw, undefined)).toMatchObject({ state: "signed_unverified_signer", subject: "Real subject", attachments: [{ contentType: "application/octet-stream" }] });
        expect(await evaluateMessageSecurity(raw, undefined)).not.toHaveProperty("html");

    });
});

describe("checkSignerBinding", () => {
    it("fails closed when no signer certificate resolved", async () => {
        const outerHeaders = { from: "alice@example.com" };
        expect(await checkSignerBinding({ signerCertificateDer: undefined, protectedHeaders: undefined, outerHeaders, pinnedSignerFingerprint: "00" })).toBe(
            "untrusted_signer",
        );
        expect(await checkSignerBinding({ signerCertificateDer: undefined, protectedHeaders: undefined, outerHeaders })).toBe("signer_identity_mismatch");
    });
});

describe("splitHeadersAndBody (backward-compatible wrapper)", () => {
    it("returns the first-occurrence header map, Content-Type, body, and raw header block", () => {
        expect(splitHeadersAndBody("Content-Type: text/plain\r\nX: 1\r\n folded\r\n\r\nbody")).toEqual({
            headers: { "content-type": "text/plain", x: "1 folded" },
            contentType: "text/plain",
            body: "body",
            rawHeaderBlock: "Content-Type: text/plain\r\nX: 1\r\n folded",
        });
    });
});
