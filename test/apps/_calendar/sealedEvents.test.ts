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

const { clearSealedEvents, openSealedEvent, openSealedEvents } = await import("../../../apps/shared/calendar/sealedEvents.js");
const { markSigningOut, clearSigningOut } = await import("../../../apps/shared/components/mail/compose/composeFlushRegistry.js");

async function zeroAccessKey() {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "0b",
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

const event = (uid: string, sealed?: string) =>
    ({ uid, mailboxUid: "mb", title: sealed ? "[...]" : `Plain ${uid}`, ...(sealed ? { sealedContent: { keyFingerprint: "fp", sealed } } : {}) }) as any;

const seal = async (fields: object, certDer: Uint8Array) => toBase64(await encryptForRecipients(new TextEncoder().encode(JSON.stringify(fields)), [certDer]));

afterEach(() => {
    clearSealedEvents();
    getUnlockedKeys.mockReset();
});

describe("openSealedEvents", () => {
    it("returns a list without sealed events as it is, loading nothing", async () => {
        const events = [event("a")];
        expect(await openSealedEvents(events)).toBe(events);
        expect(getUnlockedKeys).not.toHaveBeenCalled();
    });

    it("opens sealed events with the mailbox's unlocked zero-access keys, keeping plain ones, and remembers what it opened", async () => {
        const key = await zeroAccessKey();
        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [key] });
        const sealed = await seal({ title: "Board meeting", location: "Room 4", description: "Agenda", descriptionHtml: "<p>Agenda</p>" }, key.certDer);
        const minimal = await seal({ title: 7 }, key.certDer);

        const [plain, opened, untitled] = await openSealedEvents([event("a"), event("b", sealed), event("c", minimal)]);

        expect(plain.title).toBe("Plain a");
        expect(opened).toMatchObject({ title: "Board meeting", location: "Room 4", description: "Agenda", descriptionHtml: "<p>Agenda</p>" });
        expect(untitled).toMatchObject({ title: "[...]", location: undefined, description: null, descriptionHtml: null });

        getUnlockedKeys.mockReturnValue(undefined);
        expect((await openSealedEvent(event("b", sealed))).title).toBe("Board meeting");
    });

    it("keeps the placeholder while the mailbox is locked, or when the content won't open", async () => {
        const key = await zeroAccessKey();
        const sealed = await seal({ title: "Secret" }, key.certDer);
        getUnlockedKeys.mockReturnValue(undefined);
        expect((await openSealedEvent(event("b", sealed))).title).toBe("[...]");

        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [await zeroAccessKey()] });
        expect((await openSealedEvent(event("b", sealed))).title).toBe("[...]");
    });

    it("forgets what it opened on sign-out", async () => {
        const key = await zeroAccessKey();
        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [key] });
        const sealed = await seal({ title: "Remembered" }, key.certDer);
        await openSealedEvent(event("b", sealed));

        markSigningOut();
        clearSigningOut();
        getUnlockedKeys.mockReturnValue(undefined);
        expect((await openSealedEvent(event("b", sealed))).title).toBe("[...]");
    });
});
