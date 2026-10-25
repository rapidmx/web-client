// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { certificateHoldsKey } from "../../../lib/crypto/keyPairMatch.js";

x509.cryptoProvider.set(crypto);

async function keyWithCertificate() {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "0d",
        name: "CN=za",
        notBefore: new Date(Date.now() - 1000),
        notAfter: new Date(Date.now() + 86_400_000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys,
    });
    return { certDer: new Uint8Array(cert.rawData), pkcs8: new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey)) };
}

/** A DER element: `tag`, then its length (long form from 128 bytes), then `content`. */
function der(tag: number, ...content: Uint8Array[]): Uint8Array {
    const body = new Uint8Array(content.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of content) {
        body.set(part, offset);
        offset += part.length;
    }
    const length = body.length < 0x80 ? [body.length] : body.length < 0x100 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 0xff];
    return new Uint8Array([tag, ...length, ...body]);
}

/** The elements inside the constructed element at the start of `bytes`. */
function inside(bytes: Uint8Array): Uint8Array[] {
    const lengthByte = bytes[1];
    const header = lengthByte & 0x80 ? 2 + (lengthByte & 0x7f) : 2;
    const parts: Uint8Array[] = [];
    for (let offset = header; offset < bytes.length; ) {
        const first = bytes[offset + 1];
        const size = first & 0x80 ? [...bytes.subarray(offset + 2, offset + 2 + (first & 0x7f))].reduce((total, b) => total * 256 + b, 0) : first;
        const end = offset + (first & 0x80 ? 2 + (first & 0x7f) : 2) + size;
        parts.push(bytes.subarray(offset, end));
        offset = end;
    }
    return parts;
}

describe("certificateHoldsKey", () => {
    it("is true for a certificate of the key, and false for another key's", async () => {
        const mine = await keyWithCertificate();
        const other = await keyWithCertificate();
        expect(await certificateHoldsKey(mine.certDer, mine.pkcs8)).toBe(true);
        expect(await certificateHoldsKey(other.certDer, mine.pkcs8)).toBe(false);
    });

    it("reads a version 1 certificate, which has no explicit version", async () => {
        const mine = await keyWithCertificate();
        const [tbs, ...rest] = inside(mine.certDer);
        const [, ...fields] = inside(tbs);
        const v1 = der(0x30, der(0x30, ...fields), ...rest);
        expect(await certificateHoldsKey(v1, mine.pkcs8)).toBe(true);
    });

    it("is false for anything that isn't a certificate it can read", async () => {
        const mine = await keyWithCertificate();
        // Not DER; truncated; a length too long to be real; too few fields; a field where the key should be that isn't one.
        expect(await certificateHoldsKey(new Uint8Array([4, 5, 6]), mine.pkcs8)).toBe(false);
        expect(await certificateHoldsKey(mine.certDer.subarray(0, 40), mine.pkcs8)).toBe(false);
        expect(await certificateHoldsKey(new Uint8Array([0x30, 0x85, 1, 1, 1, 1, 1]), mine.pkcs8)).toBe(false);
        expect(await certificateHoldsKey(new Uint8Array([0x30, 0x80]), mine.pkcs8)).toBe(false);
        expect(await certificateHoldsKey(der(0x30, der(0x30, der(0x02, new Uint8Array([1])))), mine.pkcs8)).toBe(false);
        expect(await certificateHoldsKey(der(0x30, der(0x30, ...Array.from({ length: 6 }, () => der(0x02, new Uint8Array([1])))) ), mine.pkcs8)).toBe(false);
        expect(await certificateHoldsKey(new Uint8Array(0), mine.pkcs8)).toBe(false);
        // A private key that isn't one.
        expect(await certificateHoldsKey(mine.certDer, new Uint8Array([1, 2, 3]))).toBe(false);
    });
});
