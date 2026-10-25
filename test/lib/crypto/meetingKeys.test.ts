// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
    deriveLiveKey,
    generateMeetingKey,
    importMeetingKey,
    meetingKeyFragment,
    readMeetingKeyFragment,
} from "../../../lib/crypto/meetingKeys.js";
import { decryptEnvelopedDataWithKeys, encryptForRecipients } from "../../../lib/crypto/smime.js";

const later = () => new Date(Date.now() + 3_600_000);

async function roundTrip(sender: CryptoKey, receiver: CryptoKey): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sender, new TextEncoder().encode("hello"));
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, receiver, sealed));
}

describe("meetingKeys", () => {
    it("makes a P-256 key with a self-signed certificate that CMS seals to and the imported key opens", async () => {
        const key = await generateMeetingKey(later());
        expect(key.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        const { decryptionKey } = await importMeetingKey(key.pkcs8, key.certificateDer, "m1");
        const sealed = await encryptForRecipients(new TextEncoder().encode('"Board meeting"'), [key.certificateDer]);
        expect(new TextDecoder().decode(await decryptEnvelopedDataWithKeys(sealed, [decryptionKey]))).toBe('"Board meeting"');
    });

    it("carries the key in a link's # part, reading it back, and rejects a missing or malformed one", async () => {
        const key = await generateMeetingKey(later());
        const fragment = meetingKeyFragment(key.pkcs8);
        expect(fragment).toMatch(/^k=[A-Za-z0-9_-]+$/);
        expect(readMeetingKeyFragment(`#${fragment}`)).toEqual(key.pkcs8);
        expect(readMeetingKeyFragment(fragment)).toEqual(key.pkcs8);
        expect(readMeetingKeyFragment("")).toBeUndefined();
        expect(readMeetingKeyFragment("#k=short")).toBeUndefined();
        expect(readMeetingKeyFragment("#k=" + "!".repeat(40))).toBeUndefined();
        // Well-formed characters, but not decodable: a length no base64 has.
        expect(readMeetingKeyFragment("#k=" + "A".repeat(17))).toBeUndefined();
    });

    it("derives the same live key from the same meeting key for the same meeting only", async () => {
        const key = await generateMeetingKey(later());
        const a = await importMeetingKey(key.pkcs8, key.certificateDer, "m1");
        const b = await importMeetingKey(key.pkcs8, key.certificateDer, "m1");
        expect(await roundTrip(a.liveKey, b.liveKey)).toBe("hello");
        const other = await importMeetingKey(key.pkcs8, key.certificateDer, "m2");
        await expect(roundTrip(a.liveKey, other.liveKey)).rejects.toThrow();
        const scalar = crypto.getRandomValues(new Uint8Array(32));
        expect(await roundTrip(await deriveLiveKey(scalar, "m1"), await deriveLiveKey(scalar, "m1"))).toBe("hello");
    });

    it("refuses a key that isn't a P-256 private key", async () => {
        const key = await generateMeetingKey(later());
        await expect(importMeetingKey(new Uint8Array([1, 2, 3]), key.certificateDer, "m1")).rejects.toThrow();
    });
});
