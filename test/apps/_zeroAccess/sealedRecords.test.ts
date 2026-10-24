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

const { getUnlockedKeys } = vi.hoisted(() => ({ getUnlockedKeys: vi.fn() }));
vi.mock("../../../lib/crypto/keySession.js", () => ({ getUnlockedKeys }));

const { clearSealedRecords, isProtectedRecord, openSealedRecord, openSealedRecords } = await import("../../../apps/shared/zeroAccess/sealedRecords.js");
const { markSigningOut, clearSigningOut } = await import("../../../apps/shared/components/mail/compose/composeFlushRegistry.js");

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
        expect(isProtectedRecord(opened)).toBe(true);
        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [] });
        // Locked again: the placeholders show, even for values opened before.
        expect((await openSealedRecord(record)).displayName).toBe("jane@example.com");
    });

    it("keeps the placeholders while the mailbox is locked, or when a field won't open, and forgets everything at sign-out", async () => {
        const key = await zeroAccessKey();
        const other = await zeroAccessKey();
        const record = { mailboxUid: "mb", title: "[...]", sealedFields: { title: await seal("Secret", key.certDer) } };

        getUnlockedKeys.mockReturnValue(undefined);
        expect((await openSealedRecord(record)).title).toBe("[...]");
        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [other] });
        expect((await openSealedRecord(record)).title).toBe("[...]");

        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [key] });
        expect((await openSealedRecord(record)).title).toBe("Secret");
        markSigningOut();
        clearSigningOut();
        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [other] });
        expect((await openSealedRecord(record)).title).toBe("[...]");
    });
});
