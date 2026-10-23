// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The server side of zero-access encryption (@rapidmx/restapi's ZeroAccessSealer) builds its CMS with the same pkijs
// construction as `smime.ts`. This proves the client opens what the server actually produces - a stored zero-access message,
// a sealed summary and a sealed index entry - with its existing decryption, from a fixture the server generated.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decryptEnvelopedDataWithKeys } from "../../../lib/crypto/smime.js";
import { parseEncryptedMessageWithKeys } from "../../../lib/crypto/smimeMessage.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/zeroAccessSealed.json", import.meta.url), "utf-8"));
const fromBase64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "base64"));

async function key() {
    const privateKey = await crypto.subtle.importKey("pkcs8", fromBase64(fixture.privateKeyPkcs8), { name: "ECDH", namedCurve: "P-256" }, false, [
        "deriveBits",
    ]);
    return { certDer: fromBase64(fixture.certificate), privateKey };
}

describe("server-sealed zero-access content", () => {
    it("decrypts a stored message to the original MIME, byte for byte", async () => {
        const sealed = Buffer.from(fixture.sealedMessage, "base64").toString("latin1");
        const [header, body] = sealed.split("\r\n\r\n");
        expect(header).toContain("Subject: [...]");
        expect(header).toContain("smime-type=enveloped-data");

        const plain = await decryptEnvelopedDataWithKeys(fromBase64(body.replace(/\r\n/g, "")), [await key()]);
        expect(Buffer.from(plain).equals(Buffer.from(fixture.raw, "base64"))).toBe(true);

        const parsed = await parseEncryptedMessageWithKeys(body, [await key()]);
        expect(parsed.decrypted).toBe(true);
    });

    it("decrypts a sealed summary", async () => {
        const plain = await decryptEnvelopedDataWithKeys(fromBase64(fixture.sealedSummary), [await key()]);
        expect(JSON.parse(new TextDecoder().decode(plain))).toEqual({ subject: "Quarterly numbers", preview: "The numbers are up." });
    });

    it("decrypts and gunzips a sealed index document", async () => {
        const plain = await decryptEnvelopedDataWithKeys(fromBase64(fixture.sealedIndexDocument), [await key()]);
        const document = JSON.parse(gunzipSync(Buffer.from(plain)).toString("utf-8"));
        expect(document).toMatchObject({ v: 1, messageUid: "m1", subject: "Quarterly numbers", body: "The numbers are up." });
    });
});
