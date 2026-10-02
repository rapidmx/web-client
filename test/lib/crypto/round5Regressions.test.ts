// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
/**
 * Regression tests for the round-5 review of client-side S/MIME: a self-signed certificate naming the sender
 * being shown as "Signed & verified" (no pin, no chain), and content outside the signature (an extra
 * `multipart/signed` part, an unsigned outer Subject/Cc) shown under a verified badge.
 */
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { toBase64 } from "../../../lib/crypto/encoding.js";
import { type PublicKey, signingKeyFingerprints } from "../../../lib/crypto/keyvaultApi.js";
import { checkSignerBinding, evaluateMessageSecurity, signingKeyFingerprints as reexported } from "../../../lib/crypto/messageSecurity.js";
import { extractAttachments, parseMimeEntity } from "../../../lib/crypto/mime.js";
import { computeCertFingerprint, signDetached } from "../../../lib/crypto/smime.js";
import {
    ProtectedHeaders,
    applyBaselineOuterHeaders,
    assembleOutboundMime,
    buildEncryptedMessage,
    buildSignedOnlyMessage,
    parseSignedOnlyMessage,
} from "../../../lib/crypto/smimeMessage.js";
import {
    type Contact,
    PINNED_FINGERPRINT_MAX_PAGES,
    PINNED_FINGERPRINT_PAGE_SIZE,
    fetchPinnedSigningFingerprints,
    pinnedSigningFingerprintsFor,
} from "../../../lib/contacts/contactsApi.js";

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

/** A foreign-shaped multipart/signed message around `inner` (the exact signed text). */
async function foreignSigned(outerHeaders: string[], inner: string, signer: TestIdentity): Promise<string> {
    const signature = await signDetached(new TextEncoder().encode(inner), signer.certDer, signer.privateKey);
    return [
        ...outerHeaders,
        'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary=b1',
        "",
        "--b1",
        inner,
        "--b1",
        "Content-Type: application/pkcs7-signature",
        "Content-Transfer-Encoding: base64",
        "",
        wrap(signature),
        "--b1--",
    ].join(CRLF);
}

const HEADERS: ProtectedHeaders = {
    from: "alice@example.com",
    to: "bob@example.com",
    date: "Wed, 11 Jan 2023 16:08:43 -0500",
    subject: "Real subject",
    messageId: "<abc123@example.com>",
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("finding 1: no pin, no verified badge", () => {
    // PoC: an attacker's self-signed certificate with SAN ceo@victim.com, sent as multipart/signed with a matching From.
    async function forgery() {
        const attacker = await generateIdentity("CN=Totally The CEO", "sign", [new x509.SubjectAlternativeNameExtension([{ type: "email", value: "ceo@victim.com" }])]);
        const headers = { ...HEADERS, from: "CEO <ceo@victim.com>" };
        const raw = assembleOutboundMime(headers, await buildSignedOnlyMessage("text/plain", "Wire the money.", headers, attacker.certDer, attacker.privateKey));
        return { attacker, raw, attackerFingerprint: await computeCertFingerprint(attacker.certDer) };
    }

    it("is signed_unverified_signer (never signed_verified) for a self-signed certificate naming the sender", async () => {
        const { raw, attackerFingerprint } = await forgery();
        for (const pins of [undefined, []]) {
            const result = await evaluateMessageSecurity(raw, undefined, pins);
            expect(result).toMatchObject({ state: "signed_unverified_signer", text: "Wire the money.", signerFingerprint: attackerFingerprint, signerEmails: ["ceo@victim.com"] });
        }
    });

    it("is signer_key_changed (never verified) against the real sender's pin, and signed_verified only for a matching pin", async () => {
        const { attacker, raw, attackerFingerprint } = await forgery();
        const ceo = await generateIdentity("CN=ceo@victim.com");
        const ceoPin = await computeCertFingerprint(ceo.certDer);
        expect(await evaluateMessageSecurity(raw, undefined, [ceoPin])).toMatchObject({
            state: "signature_failed",
            signatureFailureReason: "signer_key_changed",
            signerFingerprint: attackerFingerprint,
            signerCertificate: toBase64(attacker.certDer),
        });
        expect((await evaluateMessageSecurity(raw, undefined, [ceoPin, attackerFingerprint.toUpperCase()])).state).toBe("signed_verified");
    });

    it("trusts the unlocked mailbox's own signing key, alone or next to caller pins that don't match", async () => {
        const { raw, attackerFingerprint } = await forgery();
        expect((await evaluateMessageSecurity(raw, { signingFingerprint: attackerFingerprint.toUpperCase() })).state).toBe("signed_verified");
        expect((await evaluateMessageSecurity(raw, { signingFingerprint: attackerFingerprint }, ["00ff"])).state).toBe("signed_verified");
        // The mailbox's own key not matching is not a failure by itself - just not verified.
        expect((await evaluateMessageSecurity(raw, { signingFingerprint: "00ff" })).state).toBe("signed_unverified_signer");
    });

    it("is encrypted_unverified_signer for a sign-then-encrypt message without a pin, encrypted_verified with one", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const bob = await generateIdentity("CN=bob@example.com", "encrypt");
        const part = await buildEncryptedMessage("text/html", "<p>secret</p>", HEADERS, applyBaselineOuterHeaders(HEADERS), [bob.certDer], {
            certDer: alice.certDer,
            privateKey: alice.privateKey,
        });
        const raw = assembleOutboundMime(applyBaselineOuterHeaders(HEADERS), part);
        const unlocked = { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer };
        const pin = await computeCertFingerprint(alice.certDer);

        expect(await evaluateMessageSecurity(raw, unlocked)).toMatchObject({
            state: "encrypted_unverified_signer",
            html: "<p>secret</p>",
            signerFingerprint: pin,
            signerEmails: ["alice@example.com"],
            protectedHeaders: { from: "alice@example.com", to: "bob@example.com", subject: "Real subject" },
            attachments: [],
        });
        expect((await evaluateMessageSecurity(raw, unlocked, pin)).state).toBe("encrypted_verified");
        expect((await evaluateMessageSecurity(raw, unlocked, "00ff")).signatureFailureReason).toBe("signer_key_changed");
    });

    it("signingKeyFingerprints() keeps unrevoked (even expired) signing keys, lowercased", () => {
        const key = (overrides: Partial<PublicKey>): PublicKey => ({ publicKey: "", type: "x509", useType: "sign", fingerprint: "AA", notBefore: 0, notAfter: 1, ...overrides });
        expect(signingKeyFingerprints([key({}), key({ fingerprint: "bb", revokedAt: 5 }), key({ fingerprint: "cc", useType: "encrypt" }), key({ fingerprint: "Dd", notAfter: 0 })])).toEqual(["aa", "dd"]);
        expect(signingKeyFingerprints(undefined)).toEqual([]);
        expect(reexported).toBe(signingKeyFingerprints);
    });
});

describe("finding 1: fetching a sender's pinned signing fingerprints", () => {
    const contact = (uid: string, emails: string[], keys?: PublicKey[]): Contact => ({
        uid,
        version: 0,
        dateCreated: "",
        dateModified: "",
        mailboxUid: "mb1",
        folderUid: "f1",
        displayName: uid,
        emails: emails.map((address) => ({ address, type: "work" })),
        phones: [],
        addresses: [],
        keys,
    });
    const signKey = (fingerprint: string): PublicKey => ({ publicKey: "", type: "x509", useType: "sign", fingerprint, notBefore: 0, notAfter: 1 });

    it("pinnedSigningFingerprintsFor() matches emails case-insensitively and de-duplicates", () => {
        const contacts = [contact("a", [" Alice@Example.com"], [signKey("f1")]), contact("b", ["alice@example.com"], [signKey("F1"), signKey("f2")]), contact("c", ["carol@example.com"], [signKey("f3")])];
        expect(pinnedSigningFingerprintsFor(contacts, "ALICE@example.com ")).toEqual(["f1", "f2"]);
        expect(pinnedSigningFingerprintsFor(contacts, "nobody@example.com")).toEqual([]);
        expect(pinnedSigningFingerprintsFor([contact("d", ["alice@example.com"])], "alice@example.com")).toEqual([]);
    });

    it("fetchPinnedSigningFingerprints() pages through every folder, stopping on a short page or at the page cap", async () => {
        const full = Array.from({ length: PINNED_FINGERPRINT_PAGE_SIZE }, (_, i) => contact(`x${i}`, [`x${i}@example.com`]));
        const fetchMock = mockFetch((url) => {
            if (url.includes("folderUid=f1") && url.includes("page=0")) return jsonResponse(200, full);
            if (url.includes("folderUid=f1")) return jsonResponse(200, [contact("a", ["alice@example.com"], [signKey("f1")])]);
            return jsonResponse(200, [...full.slice(1), contact("b", ["alice@example.com"], [signKey("f2")])]);
        });

        expect(await fetchPinnedSigningFingerprints(["f1", "f2"], "alice@example.com")).toEqual(["f1", "f2"]);
        const urls = fetchMock.mock.calls.map(([url]) => url as string);
        expect(urls.filter((url) => url.includes("folderUid=f1"))).toHaveLength(2);
        expect(urls.filter((url) => url.includes("folderUid=f2"))).toHaveLength(PINNED_FINGERPRINT_MAX_PAGES);
        expect(urls[0]).toContain(`limit=${PINNED_FINGERPRINT_PAGE_SIZE}&page=0`);
    });
});

describe("finding 2: content outside the signature", () => {
    it("rejects a multipart/signed body with a third, unsigned part", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const part = await buildSignedOnlyMessage("text/plain", "signed", HEADERS, alice.certDer, alice.privateKey);
        const boundary = /boundary="([^"]+)"/.exec(part.contentType)![1];
        const injected = part.body.replace(`--${boundary}--`, `--${boundary}${CRLF}Content-Type: text/html${CRLF}${CRLF}<p>unsigned</p>${CRLF}--${boundary}--`);
        expect((await parseSignedOnlyMessage(part.contentType, part.body)).verified).toBe(true);
        expect((await parseSignedOnlyMessage(part.contentType, injected)).verified).toBe(false);
        const raw = assembleOutboundMime(HEADERS, { ...part, body: injected });
        expect(await evaluateMessageSecurity(raw, undefined, await computeCertFingerprint(alice.certDer))).toEqual({
            state: "signature_failed",
            signatureFailureReason: "invalid_signature",
        });
    });

    it("is header_mismatch when a signed-only message's outer Subject or Cc differs from the signed one", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const pin = await computeCertFingerprint(alice.certDer);
        const headers = { ...HEADERS, cc: "carol@example.com", subject: "Lunch on Friday?" };
        const raw = assembleOutboundMime(headers, await buildSignedOnlyMessage("text/plain", "hi", headers, alice.certDer, alice.privateKey));
        expect(await evaluateMessageSecurity(raw, undefined, pin)).toMatchObject({
            state: "signed_verified",
            protectedHeaders: { from: "alice@example.com", to: "bob@example.com", cc: "carol@example.com", subject: "Lunch on Friday?" },
        });

        const cases = [
            raw.replace("Subject: Lunch on Friday?", "Subject: Wire $1M to account 42"),
            raw.replace("Cc: carol@example.com", "Cc: carol@example.com, mallory@evil.test"),
            raw.replace("Cc: carol@example.com\r\n", ""),
            raw.replace("Subject: Lunch on Friday?\r\n", ""),
        ];
        for (const tampered of cases) {
            expect(await evaluateMessageSecurity(tampered, undefined, pin)).toMatchObject({ state: "signature_failed", signatureFailureReason: "header_mismatch" });
        }
        // A Subject merely refolded in transit still matches.
        expect((await evaluateMessageSecurity(raw.replace("Subject: Lunch on Friday?", "Subject: Lunch on\r\n  Friday?"), undefined, pin)).state).toBe("signed_verified");
    });

    it("is header_mismatch when an encrypted message's outer Cc differs from the protected one", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const bob = await generateIdentity("CN=bob@example.com", "encrypt");
        const headers = { ...HEADERS, cc: "carol@example.com" };
        const outer = { ...applyBaselineOuterHeaders(headers), cc: "mallory@evil.test" };
        const part = await buildEncryptedMessage("text/plain", "hi", headers, outer, [bob.certDer], { certDer: alice.certDer, privateKey: alice.privateKey });
        const result = await evaluateMessageSecurity(assembleOutboundMime(outer, part), { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer }, await computeCertFingerprint(alice.certDer));
        expect(result).toMatchObject({ state: "signature_failed", signatureFailureReason: "header_mismatch", text: "hi" });
    });

    it("exposes no protectedHeaders (and compares no Subject) for a legacy sender without protected headers", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const raw = await foreignSigned(["From: alice@example.com", "To: bob@example.com", "Subject: anything"], ["Content-Type: text/plain", "", "hi"].join(CRLF), alice);
        const result = await evaluateMessageSecurity(raw, undefined, await computeCertFingerprint(alice.certDer));
        expect(result.state).toBe("signed_verified");
        expect(result).not.toHaveProperty("protectedHeaders");
        expect(result.subject).toBeUndefined();
        // checkSignerBinding() itself only compares Subject when asked, and only with protected headers present.
        const base = { signerCertificateDer: alice.certDer, outerHeaders: { from: "alice@example.com", to: "bob@example.com", subject: "x" } };
        expect(await checkSignerBinding({ ...base, protectedHeaders: { from: "alice@example.com", to: "bob@example.com", subject: "y" } })).toBeUndefined();
        expect(await checkSignerBinding({ ...base, protectedHeaders: { from: "alice@example.com", to: "bob@example.com", subject: "y" }, compareSubject: true })).toBe("header_mismatch");
        expect(await checkSignerBinding({ ...base, protectedHeaders: { from: "", to: "", subject: "y" }, compareSubject: true })).toBeUndefined();
    });

    it("is header_mismatch for a signed-only message whose outer Date was dropped or garbled, but not when the signed one is unreadable", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const signedDate = "Mon, 01 Jun 2026 15:00:00 +0000";
        const outer = { from: "alice@example.com", to: "bob@example.com", subject: "x" };
        const input = (outerDate: string | undefined, protectedDate: string | undefined) => ({
            signerCertificateDer: alice.certDer,
            compareSubject: true,
            outerHeaders: outerDate === undefined ? outer : { ...outer, date: outerDate },
            protectedHeaders: { from: "alice@example.com", to: "bob@example.com", subject: "x", date: protectedDate },
        });
        // The same instant written another way matches.
        expect(await checkSignerBinding(input("Mon, 01 Jun 2026 11:00:00 -0400", signedDate))).toBeUndefined();
        expect(await checkSignerBinding(input("Tue, 02 Jun 2026 15:00:00 +0000", signedDate))).toBe("header_mismatch");
        expect(await checkSignerBinding(input(undefined, signedDate))).toBe("header_mismatch");
        expect(await checkSignerBinding(input("garbled", signedDate))).toBe("header_mismatch");
        // Nothing signed to compare with.
        expect(await checkSignerBinding(input(undefined, undefined))).toBeUndefined();
        expect(await checkSignerBinding(input("Tue, 02 Jun 2026 15:00:00 +0000", "garbled"))).toBeUndefined();
    });

    it("lists only the attachments inside the signed entity", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const inner = [
            "From: alice@example.com",
            "To: bob@example.com",
            "Subject: Report",
            'Content-Type: multipart/mixed; boundary=m1; hp="clear"',
            "",
            "--m1",
            "Content-Type: text/plain",
            "",
            "See attached.",
            "--m1",
            'Content-Type: application/pdf; name="=?UTF-8?B?UmFwcG9ydMOp?=.pdf"',
            "Content-Disposition: attachment",
            "Content-Transfer-Encoding: base64",
            "",
            "JVBERi0=",
            "--m1",
            "Content-Type: image/png",
            "Content-ID: <logo@x>",
            "Content-Transfer-Encoding: base64",
            "",
            "iVBO",
            "--m1--",
        ].join(CRLF);
        const raw = await foreignSigned(["From: alice@example.com", "To: bob@example.com", "Subject: Report"], inner, alice);
        const result = await evaluateMessageSecurity(raw, undefined, await computeCertFingerprint(alice.certDer));
        expect(result.state).toBe("signed_verified");
        expect(result.text).toBe("See attached.");
        expect(result.attachments!.map(({ filename, contentType, disposition, contentId }) => ({ filename, contentType, disposition, contentId }))).toEqual([
            { filename: "Rapporté.pdf", contentType: "application/pdf", disposition: "attachment", contentId: undefined },
            { filename: undefined, contentType: "image/png", disposition: "inline", contentId: "logo@x" },
        ]);
        expect(new TextDecoder().decode(result.attachments![0].decode())).toBe("%PDF-");
    });
});

describe("extractAttachments", () => {
    const entity = (lines: string[]) => parseMimeEntity(lines.join(CRLF));

    it("treats a text part with a filename, a forwarded message and an inline disposition as attachments", () => {
        const found = extractAttachments(
            entity([
                "Content-Type: multipart/mixed; boundary=z",
                "",
                "--z",
                "",
                "default text/plain body, not an attachment",
                "--z",
                "Content-Type: text/plain",
                'Content-Disposition: inline; filename="notes.txt"',
                "",
                "notes",
                "--z",
                "Content-Type: message/rfc822",
                "",
                "Subject: fwd",
                "--z",
                "Content-Type: application/octet-stream",
                "Content-Transfer-Encoding: base64",
                "",
                "!!!",
                "--z--",
            ]),
        );
        expect(found.map((a) => [a.contentType, a.disposition, a.filename])).toEqual([
            ["text/plain", "inline", "notes.txt"],
            ["message/rfc822", "inline", undefined],
            ["application/octet-stream", "inline", undefined],
        ]);
        expect(new TextDecoder().decode(found[0].decode())).toBe("notes");
        expect(found[2].decode()).toBeUndefined();
    });

    it("returns nothing for a multipart with no boundary or nested past the depth cap", () => {
        expect(extractAttachments(entity(["Content-Type: multipart/mixed", "", "x"]))).toEqual([]);
        const deep = entity(["Content-Type: multipart/mixed; boundary=d", "", "--d", "Content-Type: application/pdf", "", "x", "--d--"]);
        expect(extractAttachments(deep, 8)).toEqual([]);
        expect(extractAttachments(deep, 7)).toHaveLength(1);
    });
});
