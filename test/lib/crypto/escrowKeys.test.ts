// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { generateEscrowKeyPair } from "../../../lib/crypto/escrowKeys.js";
import { fromBase64 } from "../../../lib/crypto/encoding.js";
import { buildEscrowWrap } from "../../../lib/crypto/masterKeyWraps.js";
import { computeCertFingerprint, decryptEnvelopedData } from "../../../lib/crypto/smime.js";

function pemBody(pem: string): Uint8Array {
    return fromBase64(pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, ""));
}

describe("generateEscrowKeyPair", () => {
    it("produces a self-signed certificate and a scope public key describing it", async () => {
        const now = new Date("2026-09-13T00:00:00.000Z");
        const keys = await generateEscrowKeyPair({ name: "Legal hold escrow", validDays: 365, now });

        const certificate = new x509.X509Certificate(keys.certificateDer);
        expect(certificate.subject).toBe("CN=Legal hold escrow");
        expect(certificate.issuer).toBe(certificate.subject);
        expect(await certificate.isSelfSigned()).toBe(true);
        expect(pemBody(keys.certificatePem)).toEqual(keys.certificateDer);
        expect(keys.publicKey).toEqual({
            publicKey: expect.any(String),
            type: "x509",
            fingerprint: await computeCertFingerprint(keys.certificateDer),
            notBefore: now.getTime(),
            notAfter: now.getTime() + 365 * 24 * 60 * 60 * 1000,
        });
        expect(fromBase64(keys.publicKey.publicKey)).toEqual(keys.certificateDer);
        expect(keys.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    });

    it("defaults validity to start now, and uses a new key every time", async () => {
        const before = Date.now();
        const a = await generateEscrowKeyPair({ name: "A", validDays: 1 });
        const b = await generateEscrowKeyPair({ name: "A", validDays: 1 });
        expect(a.publicKey.notBefore).toBeGreaterThanOrEqual(before - 1000);
        expect(a.publicKey.fingerprint).not.toBe(b.publicKey.fingerprint);
    });

    it("lets a holder with the downloaded private key unwrap a master key escrowed to the certificate", async () => {
        const keys = await generateEscrowKeyPair({ name: "Escrow", validDays: 30 });
        const masterKey = crypto.getRandomValues(new Uint8Array(32));
        const wrap = await buildEscrowWrap(masterKey, "scope-1", keys.certificateDer);

        const holderKey = await crypto.subtle.importKey("pkcs8", pemBody(keys.privateKeyPem) as BufferSource, { name: "ECDH", namedCurve: "P-256" }, true, [
            "deriveBits",
        ]);
        const unwrapped = await decryptEnvelopedData(fromBase64(wrap.ciphertext), keys.certificateDer, holderKey);
        expect(unwrapped).toEqual(masterKey);
    });
});
