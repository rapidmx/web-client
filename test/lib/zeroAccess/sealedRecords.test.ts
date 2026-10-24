// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toBase64 } from "../../../lib/crypto/encoding.js";
import { encryptForRecipients } from "../../../lib/crypto/smime.js";

x509.cryptoProvider.set(crypto);

const { getUnlockedKeys, keySessionListeners } = vi.hoisted(() => ({ getUnlockedKeys: vi.fn(), keySessionListeners: [] as ((event: any) => void)[] }));
vi.mock("../../../lib/crypto/keySession.js", () => ({ getUnlockedKeys, subscribeKeySession: (listener: (event: any) => void) => keySessionListeners.push(listener) }));

const { clearSealedRecords, isOpenedRecord, isProtectedRecord, openSealedBytes, openSealedRecord, openSealedRecords } = await import("../../../lib/zeroAccess/sealedRecords.js");

async function zeroAccessKey() {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "0c",
        name: "CN=za",
        notBefore: new Date(Date.now() - 1000),
        notAfter: new Date(Date.now() + 86_400_000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys,
    });
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    return { fingerprint: "fp", certDer: new Uint8Array(cert.rawData), privateKey };
}

const seal = async (value: unknown, certDer: Uint8Array) => toBase64(await encryptForRecipients(new TextEncoder().encode(JSON.stringify(value)), [certDer]));

afterEach(() => {
    clearSealedRecords();
    getUnlockedKeys.mockReset();
});

describe("sealedRecords", () => {
    it("returns records without sealed fields as they are, loading nothing", async () => {
        const records = [{ mailboxUid: "mb", title: "Plain" }, { mailboxUid: "mb", sealedFields: {} }];
        expect(await openSealedRecords(records)).toBe(records);
        expect(isProtectedRecord(records[1])).toBe(false);
        expect(isProtectedRecord(undefined)).toBe(false);
        expect(getUnlockedKeys).not.toHaveBeenCalled();
    });

    it("opens every sealed field with the mailbox's unlocked keys, keeping the rest, and remembers what it opened", async () => {
        const key = await zeroAccessKey();
        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [key] });
        const record = {
            mailboxUid: "mb",
            displayName: "jane@example.com",
            favorite: true,
            sealedFields: { displayName: await seal("Jane Doe", key.certDer), phones: await seal([{ phoneNumber: "1" }], key.certDer) },
        };

        const [opened] = await openSealedRecords([record]);

        expect(opened).toMatchObject({ displayName: "Jane Doe", phones: [{ phoneNumber: "1" }], favorite: true });
        const nameOnly = await openSealedRecord({ ...record, phones: [] }, ["displayName"]);
        expect(nameOnly).toMatchObject({ displayName: "Jane Doe", phones: [] });
        expect(isProtectedRecord(opened)).toBe(true);
        // Fully opened - and still so for a copy - but not when only some fields were.
        expect(isOpenedRecord(opened)).toBe(true);
        expect(isOpenedRecord({ ...opened })).toBe(true);
        expect(JSON.stringify(opened)).not.toContain("openedSealedRecord");
        expect(isOpenedRecord(nameOnly)).toBe(false);
        expect(isOpenedRecord(record)).toBe(false);
        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [] });
        // Locked again: the placeholders show, even for values opened before.
        const locked = await openSealedRecord(record);
        expect(locked.displayName).toBe("jane@example.com");
        expect(isOpenedRecord(locked)).toBe(false);
    });

    it("keeps the placeholders while the mailbox is locked, or when a field won't open, and forgets everything when keys lock", async () => {
        const key = await zeroAccessKey();
        const other = await zeroAccessKey();
        const record = { mailboxUid: "mb", title: "[...]", sealedFields: { title: await seal("Secret", key.certDer) } };

        getUnlockedKeys.mockReturnValue(undefined);
        expect((await openSealedRecord(record)).title).toBe("[...]");
        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [other] });
        expect((await openSealedRecord(record)).title).toBe("[...]");

        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [key] });
        expect((await openSealedRecord(record)).title).toBe("Secret");
        keySessionListeners.forEach((listener) => listener({ mailboxUid: "mb", state: "unlocked" }));
        expect((await openSealedRecord(record)).title).toBe("Secret");
        keySessionListeners.forEach((listener) => listener({ mailboxUid: "mb", state: "locked" }));
        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [other] });
        expect((await openSealedRecord(record)).title).toBe("[...]");
    });

    it("opens a sealed blob with the mailbox's keys, and gives nothing while locked or for another key", async () => {
        const key = await zeroAccessKey();
        const other = await zeroAccessKey();
        const der = await encryptForRecipients(new Uint8Array([1, 2, 3]), [key.certDer]);

        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [key] });
        expect(Array.from((await openSealedBytes("mb", der))!)).toEqual([1, 2, 3]);
        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [other] });
        expect(await openSealedBytes("mb", der)).toBeUndefined();
        getUnlockedKeys.mockReturnValue(undefined);
        expect(await openSealedBytes("mb", der)).toBeUndefined();
    });
});
