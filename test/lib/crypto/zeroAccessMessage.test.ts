// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Reading a message the server sealed at rest (zero-access): `evaluateMessageSecurity()` opens the stored S/MIME message with the
// mailbox's zero-access keys and evaluates the original inside. The fixture was sealed by restapi itself; the other cases seal
// client-side with `encryptForRecipients()`, the same CMS construction.
import "reflect-metadata";
import { readFileSync } from "node:fs";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { toBase64 } from "../../../lib/crypto/encoding.js";
import { evaluateMessageSecurity, openZeroAccessMessage, openZeroAccessSummary } from "../../../lib/crypto/messageSecurity.js";
import { computeCertFingerprint, encryptForRecipients } from "../../../lib/crypto/smime.js";
import { type ProtectedHeaders, assembleOutboundMime, buildSignedOnlyMessage } from "../../../lib/crypto/smimeMessage.js";

x509.cryptoProvider.set(crypto);

const fixture = JSON.parse(readFileSync(new URL("./fixtures/zeroAccessSealed.json", import.meta.url), "utf-8"));
const b64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "base64"));

async function fixtureKey() {
    const privateKey = await crypto.subtle.importKey("pkcs8", b64(fixture.privateKeyPkcs8), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    return { certDer: b64(fixture.certificate), privateKey };
}

async function identity(cn: string, usage: "sign" | "encrypt") {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "02",
        name: `CN=${cn}`,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 86_400_000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys,
    });
    let privateKey = keys.privateKey;
    if (usage === "encrypt") {
        const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
        privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    }
    return { certDer: new Uint8Array(cert.rawData), privateKey };
}

/** `original` sealed the way the server stores a zero-access message: S/MIME enveloped-data to `certDer`, `Subject: [...]` outside. */
async function sealAtRest(original: string, certDer: Uint8Array): Promise<string> {
    const der = await encryptForRecipients(new Uint8Array(Buffer.from(original, "latin1")), [certDer]);
    return [
        "From: bob@example.org",
        "Subject: [...]",
        "MIME-Version: 1.0",
        'Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"',
        "Content-Transfer-Encoding: base64",
        "",
        toBase64(der),
    ].join("\r\n");
}

const HEADERS: ProtectedHeaders = { from: "alice@example.com", to: "bob@example.com", date: "Wed, 11 Jan 2023 16:08:43 -0500", subject: "Signed subject", messageId: "<signed@example.com>" };

describe("evaluateMessageSecurity - sealed at rest", () => {
    const sealedFixture = () => Buffer.from(fixture.sealedMessage, "base64").toString("latin1");

    it("is protected_at_rest for a server-sealed message that arrived unprotected, with its real subject and body", async () => {
        const result = await evaluateMessageSecurity(sealedFixture(), { zeroAccessKeys: [await fixtureKey()] });

        expect(result.state).toBe("protected_at_rest");
        expect(result.zeroAccess).toBe(true);
        expect(result.subject).toBe("Quarterly numbers");
        expect(result.text).toContain("The numbers are up.");
        expect(result.attachments).toEqual([]);
    });

    it("can't open it while the keys are locked, or with someone else's key - it then reads as an encrypted message", async () => {
        const locked = await evaluateMessageSecurity(sealedFixture(), undefined);
        expect(locked.state).toBe("encrypted");
        expect(locked.decryptError).toBeDefined();

        const stranger = await identity("eve@example.com", "encrypt");
        const wrongKey = await evaluateMessageSecurity(sealedFixture(), { zeroAccessKeys: [stranger] });
        expect(wrongKey.state).toBe("encrypted");
        expect(wrongKey.zeroAccess).toBeUndefined();
    });

    it("keeps a sealed original's own signature state, marked zeroAccess", async () => {
        const za = await identity("za@example.com", "encrypt");
        const alice = await identity("alice@example.com", "sign");
        const part = await buildSignedOnlyMessage("text/plain; charset=utf-8", "Signed hello.", HEADERS, alice.certDer, alice.privateKey);
        const sealed = await sealAtRest(assembleOutboundMime(HEADERS, part), za.certDer);

        const result = await evaluateMessageSecurity(sealed, { zeroAccessKeys: [za] }, await computeCertFingerprint(alice.certDer));

        expect(result.state).toBe("signed_verified");
        expect(result.zeroAccess).toBe(true);
        expect(result.subject).toBe("Signed subject");
        expect(result.text).toBe("Signed hello.");
    });

    it("falls back to the original's own Subject header when its evaluation recovered none", async () => {
        const za = await identity("za@example.com", "encrypt");
        const recipient = await identity("bob@example.com", "encrypt");
        // An end-to-end encrypted original, sealed again at rest, read on a device without the end-to-end key.
        const e2e = await encryptForRecipients(new Uint8Array(Buffer.from("Subject: inner\r\n\r\nsecret")), [recipient.certDer]);
        const original = ["From: alice@example.com", "Subject: =?utf-8?Q?Caf=C3=A9?=", 'Content-Type: application/pkcs7-mime; smime-type=enveloped-data', "", toBase64(e2e)].join("\r\n");

        const result = await evaluateMessageSecurity(await sealAtRest(original, za.certDer), { zeroAccessKeys: [za] });

        expect(result.state).toBe("encrypted");
        expect(result.zeroAccess).toBe(true);
        expect(result.subject).toBe("Café");
    });

    it("has no subject to fall back to when the original carries none", async () => {
        const za = await identity("za@example.com", "encrypt");
        const result = await evaluateMessageSecurity(await sealAtRest("Content-Type: text/plain\r\n\r\nno subject here", za.certDer), { zeroAccessKeys: [za] });

        expect(result.state).toBe("protected_at_rest");
        expect(result.subject).toBeUndefined();
    });

    it("leaves an encrypted body that isn't base64 to the end-to-end path", async () => {
        const za = await identity("za@example.com", "encrypt");
        const result = await evaluateMessageSecurity("Content-Type: application/pkcs7-mime; smime-type=enveloped-data\r\n\r\n!!!", { zeroAccessKeys: [za] });
        expect(result.state).toBe("encrypted");
        expect(result.zeroAccess).toBeUndefined();
    });
});

describe("openZeroAccessSummary", () => {
    it("opens a server-sealed summary", async () => {
        expect(await openZeroAccessSummary(fixture.sealedSummary, [await fixtureKey()])).toEqual({ subject: "Quarterly numbers", preview: "The numbers are up." });
    });

    it("is undefined without keys, for the wrong key, for garbage, and for a payload that isn't a summary", async () => {
        const za = await identity("za@example.com", "encrypt");
        expect(await openZeroAccessSummary(fixture.sealedSummary, undefined)).toBeUndefined();
        expect(await openZeroAccessSummary(fixture.sealedSummary, [])).toBeUndefined();
        expect(await openZeroAccessSummary(fixture.sealedSummary, [za])).toBeUndefined();
        expect(await openZeroAccessSummary("bm90IGNtcw==", [za])).toBeUndefined();
        const notSummary = toBase64(await encryptForRecipients(new Uint8Array(Buffer.from(JSON.stringify({ subject: 1 }))), [za.certDer]));
        expect(await openZeroAccessSummary(notSummary, [za])).toBeUndefined();
        const nullJson = toBase64(await encryptForRecipients(new Uint8Array(Buffer.from("null")), [za.certDer]));
        expect(await openZeroAccessSummary(nullJson, [za])).toBeUndefined();
    });
});

describe("zero-access invitations and sources", () => {
    const ICS = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:meet-1\r\nSUMMARY:Planning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    const invitation = [
        "From: boss@example.org",
        "Subject: Invitation: Planning",
        "MIME-Version: 1.0",
        'Content-Type: multipart/alternative; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "You are invited.",
        "--b",
        "Content-Type: text/calendar; method=REQUEST; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(ICS).toString("base64"),
        "--b--",
        "",
    ].join("\r\n");

    it("hands back the calendar file of a sealed invitation, which the server can't read", async () => {
        const za = await identity("za@example.com", "encrypt");
        const result = await evaluateMessageSecurity(await sealAtRest(invitation, za.certDer), { zeroAccessKeys: [za] });

        expect(result.state).toBe("protected_at_rest");
        expect(result.calendar).toBe(ICS);
    });

    it("has no calendar file for a sealed message without one", async () => {
        const result = await evaluateMessageSecurity(Buffer.from(fixture.sealedMessage, "base64").toString("latin1"), { zeroAccessKeys: [await fixtureKey()] });
        expect(result.calendar).toBeUndefined();
    });

    it("opens a sealed message's original source, and nothing for anything else", async () => {
        const za = await identity("za@example.com", "encrypt");
        const sealed = await sealAtRest(invitation, za.certDer);

        expect(await openZeroAccessMessage(sealed, { zeroAccessKeys: [za] })).toBe(invitation);
        expect(await openZeroAccessMessage(sealed, undefined)).toBeUndefined();
        expect(await openZeroAccessMessage(invitation, { zeroAccessKeys: [za] })).toBeUndefined();
        expect(await openZeroAccessMessage("no headers at all", { zeroAccessKeys: [za] })).toBeUndefined();
    });
});
