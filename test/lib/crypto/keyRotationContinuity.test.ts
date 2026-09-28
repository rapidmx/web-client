// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
/** Key rotation continuity: previously pinned keys stay trusted signers, a pinned sender's new key is reported as
 * `signer_key_changed` with its certificate, and the client for `POST /mail/mailboxes/:id/keys/resolve`. */
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { ApiRequestError } from "../../../lib/util/api.js";
import { toBase64 } from "../../../lib/crypto/encoding.js";
import {
    type KeyConflict,
    type PreviousKey,
    type PublicKey,
    PinnedKeyChangedError,
    type ResolveKeyConflictInput,
    SignerKeyConflictError,
    findActivePublicKey,
    isTrustedForVerification,
    resolveKeyConflict,
    signingKeyFingerprints,
} from "../../../lib/crypto/keyvaultApi.js";
import { checkSignerBinding, evaluateMessageSecurity } from "../../../lib/crypto/messageSecurity.js";
import { computeCertFingerprint } from "../../../lib/crypto/smime.js";
import { type ProtectedHeaders, assembleOutboundMime, buildEncryptedMessage, buildSignedOnlyMessage } from "../../../lib/crypto/smimeMessage.js";
import {
    type Contact,
    PINNED_FINGERPRINT_MAX_PAGES,
    PINNED_FINGERPRINT_PAGE_SIZE,
    fetchPinnedSigningFingerprints,
    fetchSignerKeyState,
    pinnedSigningFingerprintsFor,
    signerKeyStateFor,
} from "../../../lib/contacts/contactsApi.js";

x509.cryptoProvider.set(crypto);

interface TestIdentity {
    certDer: Uint8Array;
    privateKey: CryptoKey;
}

async function generateIdentity(name: string, keyUsage: "sign" | "encrypt" = "sign"): Promise<TestIdentity> {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "01",
        name,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 86_400_000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys,
    });
    let privateKey = keys.privateKey;
    if (keyUsage === "encrypt") {
        const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
        privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    }
    return { certDer: new Uint8Array(cert.rawData), privateKey };
}

const HEADERS: ProtectedHeaders = {
    from: "alice@example.com",
    to: "bob@example.com",
    date: "Wed, 11 Jan 2023 16:08:43 -0500",
    subject: "Real subject",
    messageId: "<abc123@example.com>",
};

const key = (fingerprint: string, overrides: Partial<PublicKey> = {}): PublicKey => ({
    publicKey: "",
    type: "x509",
    useType: "sign",
    fingerprint,
    notBefore: 0,
    notAfter: 1,
    ...overrides,
});

const previous = (fingerprint: string, replacedAt: number, overrides: Partial<PreviousKey> = {}): PreviousKey => ({
    ...key(fingerprint),
    replacedAt,
    replacement: "automatic",
    ...overrides,
});

const contact = (uid: string, emails: string[], fields: Partial<Contact> = {}): Contact => ({
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
    ...fields,
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("signingKeyFingerprints() with previous keys", () => {
    it("counts unrevoked previous signing keys of either replacement kind as trusted, de-duplicated and lowercased", () => {
        const result = signingKeyFingerprints(
            [key("AA"), key("bb", { revokedAt: 5 })],
            [previous("cc", 3, { replacement: "user" }), previous("Dd", 2), previous("aa", 1), previous("ee", 1, { revokedAt: 4 }), previous("ff", 1, { useType: "encrypt" })],
        );
        expect(result).toEqual(["aa", "cc", "dd"]);
    });

    it("trusts keys revoked as superseded (current and previous), never compromised or reasonless revoked keys", () => {
        const result = signingKeyFingerprints(
            [
                key("cur-superseded", { revokedAt: 5, revocationReason: "superseded" }),
                key("cur-compromised", { revokedAt: 5, revocationReason: "compromised" }),
                key("cur-legacy", { revokedAt: 5 }),
                key("cur-expired", { notAfter: 0 }),
            ],
            [
                previous("prev-superseded", 3, { revokedAt: 2, revocationReason: "superseded" }),
                previous("prev-compromised", 2, { revokedAt: 2, revocationReason: "compromised", replacement: "user" }),
                previous("prev-legacy", 1, { revokedAt: 1 }),
            ],
        );
        expect(result).toEqual(["cur-superseded", "cur-expired", "prev-superseded"]);
    });

    it("isTrustedForVerification() follows the same rule, while findActivePublicKey() skips every revoked key", () => {
        const future = Date.now() + 86_400_000;
        expect(isTrustedForVerification(key("a"))).toBe(true);
        expect(isTrustedForVerification(key("a", { revokedAt: 1, revocationReason: "superseded" }))).toBe(true);
        expect(isTrustedForVerification(key("a", { revokedAt: 1, revocationReason: "compromised" }))).toBe(false);
        expect(isTrustedForVerification(key("a", { revokedAt: 1 }))).toBe(false);
        // A reason without revokedAt isn't a revocation.
        expect(isTrustedForVerification(key("a", { revocationReason: "compromised" }))).toBe(true);

        const superseded = key("superseded", { notBefore: 2, notAfter: future, revokedAt: 3, revocationReason: "superseded" });
        const older = key("older", { notBefore: 1, notAfter: future });
        expect(findActivePublicKey([superseded, older], "sign")).toBe(older);
        expect(findActivePublicKey([superseded], "sign")).toBeUndefined();
    });

    it("works with only previous keys, or neither", () => {
        expect(signingKeyFingerprints(undefined, [previous("11", 1)])).toEqual(["11"]);
        expect(signingKeyFingerprints(undefined, undefined)).toEqual([]);
    });
});

describe("pinnedSigningFingerprintsFor() / fetchPinnedSigningFingerprints() with previous keys", () => {
    it("includes the matching contacts' previous signing keys", () => {
        const contacts = [
            contact("a", ["Alice@example.com"], { keys: [key("new")], previousKeys: [previous("old", 1)] }),
            contact("b", ["carol@example.com"], { previousKeys: [previous("carol-old", 1)] }),
        ];
        expect(pinnedSigningFingerprintsFor(contacts, "alice@example.com")).toEqual(["new", "old"]);
    });

    it("fetches previous keys from stored contacts only", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [contact("a", ["alice@example.com"], { previousKeys: [previous("OLD", 1)] })]));
        expect(await fetchPinnedSigningFingerprints(["f1"], "alice@example.com")).toEqual(["old"]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toContain("/api/mail/contacts?");
    });
});

describe("signerKeyStateFor() / fetchSignerKeyState()", () => {
    const conflict: KeyConflict = { useType: "sign", observedKey: key("observed"), observedAt: 9, source: "header" };

    it("merges the matching contacts' signing keys, previous keys (newest first) and first signing conflict", () => {
        const contacts = [
            contact("a", ["alice@example.com"], {
                keys: [key("p1", { notBefore: 10, notAfter: 20, issuerCertificate: "ISSUER" }), key("enc", { useType: "encrypt" }), key("rev", { revokedAt: 15 })],
                previousKeys: [previous("old1", 5, { replacement: "user" }), previous("old-enc", 7, { useType: "encrypt" })],
                keyConflicts: [{ ...conflict, useType: "encrypt" }],
            }),
            contact("b", [" ALICE@example.com"], {
                keys: [key("P1")],
                previousKeys: [previous("old2", 8), previous("OLD1", 4)],
                keyConflicts: [conflict],
            }),
            contact("c", ["carol@example.com"], { keys: [key("carol")], keyConflicts: [{ ...conflict, observedKey: key("carol-new") }] }),
        ];

        const state = signerKeyStateFor(contacts, "alice@example.com ");
        expect(state.pinned).toEqual([key("p1", { notBefore: 10, notAfter: 20, issuerCertificate: "ISSUER" }), key("rev", { revokedAt: 15 })]);
        expect(state.previous.map((entry) => [entry.fingerprint, entry.replacedAt])).toEqual([
            ["old2", 8],
            ["old1", 5],
        ]);
        expect(state.conflict).toEqual(conflict);
    });

    it("is empty, without a conflict key, when nothing matches or the contact has no key state", () => {
        expect(signerKeyStateFor([contact("a", ["alice@example.com"])], "alice@example.com")).toEqual({ pinned: [], previous: [] });
        expect(signerKeyStateFor([], "alice@example.com")).toEqual({ pinned: [], previous: [] });
    });

    it("pages through every folder like fetchPinnedSigningFingerprints(), reading contacts only", async () => {
        const full = Array.from({ length: PINNED_FINGERPRINT_PAGE_SIZE }, (_, i) => contact(`x${i}`, [`x${i}@example.com`]));
        const fetchMock = mockFetch((url) => {
            if (url.includes("folderUid=f1") && url.includes("page=0")) return jsonResponse(200, full);
            if (url.includes("folderUid=f1")) return jsonResponse(200, [contact("a", ["alice@example.com"], { keys: [key("p1")], keyConflicts: [conflict] })]);
            return jsonResponse(200, [...full.slice(1), contact("b", ["alice@example.com"], { previousKeys: [previous("old", 1)] })]);
        });

        expect(await fetchSignerKeyState(["f1", "f2"], "alice@example.com")).toEqual({ pinned: [key("p1")], previous: [previous("old", 1)], conflict });
        const urls = fetchMock.mock.calls.map(([url]) => url as string);
        expect(urls.every((url) => url.startsWith("/api/mail/contacts?"))).toBe(true);
        expect(urls.filter((url) => url.includes("folderUid=f1"))).toHaveLength(2);
        expect(urls.filter((url) => url.includes("folderUid=f2"))).toHaveLength(PINNED_FINGERPRINT_MAX_PAGES);
    });
});

describe("resolveKeyConflict", () => {
    const lookup = {
        keys: [key("new")],
        keyConflicts: [],
        previousKeys: [previous("old", 5, { replacement: "user" })],
    };
    const accept: ResolveKeyConflictInput = { address: "alice@example.com", useType: "sign", action: "accept", expectedPinnedFingerprint: "old", certificate: "MIIB" };

    it("posts an accept with its certificate to the encoded mailbox's keys/resolve endpoint and returns the key state", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, lookup));
        const result = await resolveKeyConflict("mb/1", accept);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("/api/mail/mailboxes/mb%2F1/keys/resolve");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual(accept);
        expect(result).toEqual(lookup);
    });

    it("omits certificate when not given and sends only the contract's fields", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, lookup));
        await resolveKeyConflict("mb1", { address: "a@example.com", useType: "encrypt", action: "reject", expectedPinnedFingerprint: "ab", extra: 1 } as never);
        expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({
            address: "a@example.com",
            useType: "encrypt",
            action: "reject",
            expectedPinnedFingerprint: "ab",
        });
    });

    it("maps a 409 to PinnedKeyChangedError (still an ApiRequestError with status 409)", async () => {
        mockFetch(() => jsonResponse(409, { message: "The pinned key changed.", code: "CONFLICT" }));
        const err = await resolveKeyConflict("mb1", accept).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PinnedKeyChangedError);
        expect(err).toBeInstanceOf(ApiRequestError);
        expect(err).not.toBeInstanceOf(SignerKeyConflictError);
        expect(err).toMatchObject({ name: "PinnedKeyChangedError", status: 409, message: "The pinned key changed.", code: "CONFLICT" });
    });

    it.each([400, 403, 404])("rethrows a %i as a plain ApiRequestError", async (status) => {
        mockFetch(() => jsonResponse(status, { message: "nope" }));
        const err = await resolveKeyConflict("mb1", accept).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApiRequestError);
        expect(err).not.toBeInstanceOf(PinnedKeyChangedError);
        expect((err as ApiRequestError).status).toBe(status);
    });

    it("rethrows a non-API failure unchanged", async () => {
        const boom = new TypeError("network down");
        mockFetch(() => {
            throw boom;
        });
        await expect(resolveKeyConflict("mb1", accept)).rejects.toBe(boom);
    });
});

describe("signer_key_changed", () => {
    it("is reported with the signer certificate for a signed-only message from a pinned sender's new key", async () => {
        const oldKey = await generateIdentity("CN=alice@example.com");
        const newKey = await generateIdentity("CN=alice@example.com");
        const raw = assembleOutboundMime(HEADERS, await buildSignedOnlyMessage("text/plain", "Hi.", HEADERS, newKey.certDer, newKey.privateKey));

        const result = await evaluateMessageSecurity(raw, undefined, [await computeCertFingerprint(oldKey.certDer)]);
        expect(result).toEqual({
            state: "signature_failed",
            signatureFailureReason: "signer_key_changed",
            signerFingerprint: await computeCertFingerprint(newKey.certDer),
            signerEmails: ["alice@example.com"],
            signerCertificate: toBase64(newKey.certDer),
        });
    });

    it("is reported with the certificate and decrypted content for a sign-then-encrypt message", async () => {
        const oldKey = await generateIdentity("CN=alice@example.com");
        const newKey = await generateIdentity("CN=alice@example.com");
        const bob = await generateIdentity("CN=bob@example.com", "encrypt");
        const raw = assembleOutboundMime(
            HEADERS,
            await buildEncryptedMessage("text/plain", "Secret.", HEADERS, HEADERS, [bob.certDer], { certDer: newKey.certDer, privateKey: newKey.privateKey }),
        );

        const result = await evaluateMessageSecurity(raw, { encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer }, await computeCertFingerprint(oldKey.certDer));
        expect(result).toMatchObject({
            state: "signature_failed",
            signatureFailureReason: "signer_key_changed",
            text: "Secret.",
            signerFingerprint: await computeCertFingerprint(newKey.certDer),
            signerCertificate: toBase64(newKey.certDer),
        });
    });

    it("stays untrusted_signer without the certificate when the new key also fails the header checks", async () => {
        const oldKey = await generateIdentity("CN=alice@example.com");
        const newKey = await generateIdentity("CN=alice@example.com");
        const part = await buildSignedOnlyMessage("text/plain", "Hi.", HEADERS, newKey.certDer, newKey.privateKey);
        const raw = assembleOutboundMime({ ...HEADERS, to: "eve@example.com" }, part);
        const pin = await computeCertFingerprint(oldKey.certDer);

        const result = await evaluateMessageSecurity(raw, undefined, pin);
        expect(result).toMatchObject({ state: "signature_failed", signatureFailureReason: "untrusted_signer" });
        expect(result).not.toHaveProperty("signerCertificate");
        const unpinned = await evaluateMessageSecurity(raw, undefined);
        expect(unpinned).toMatchObject({ state: "signature_failed", signatureFailureReason: "header_mismatch" });
        expect(unpinned).not.toHaveProperty("signerCertificate");
    });

    it("checkSignerBinding() is untrusted_signer for a pin with no resolved certificate", async () => {
        const reason = await checkSignerBinding({ signerCertificateDer: undefined, protectedHeaders: undefined, outerHeaders: { from: "alice@example.com" }, pinnedSignerFingerprint: ["aa"] });
        expect(reason).toBe("untrusted_signer");
    });

    it("mail signed with a previous key still verifies once the contact's pin rotated, including a superseded one", async () => {
        const oldKey = await generateIdentity("CN=alice@example.com");
        const newKey = await generateIdentity("CN=alice@example.com");
        const raw = assembleOutboundMime(HEADERS, await buildSignedOnlyMessage("text/plain", "Before the rotation.", HEADERS, oldKey.certDer, oldKey.privateKey));
        const oldFingerprint = await computeCertFingerprint(oldKey.certDer);
        const current = key(await computeCertFingerprint(newKey.certDer));

        const variants: Partial<PreviousKey>[] = [
            { replacement: "automatic" },
            { replacement: "user" },
            { replacement: "automatic", revokedAt: 2, revocationReason: "superseded" },
        ];
        for (const overrides of variants) {
            const contacts = [contact("a", ["alice@example.com"], { keys: [current], previousKeys: [previous(oldFingerprint, 1, overrides)] })];
            expect((await evaluateMessageSecurity(raw, undefined, pinnedSigningFingerprintsFor(contacts, "alice@example.com"))).state).toBe("signed_verified");
        }
    });

    it("mail signed with a previous key revoked as compromised, or with no reason, is signer_key_changed", async () => {
        const oldKey = await generateIdentity("CN=alice@example.com");
        const newKey = await generateIdentity("CN=alice@example.com");
        const raw = assembleOutboundMime(HEADERS, await buildSignedOnlyMessage("text/plain", "Before the rotation.", HEADERS, oldKey.certDer, oldKey.privateKey));
        const oldFingerprint = await computeCertFingerprint(oldKey.certDer);
        const current = key(await computeCertFingerprint(newKey.certDer));

        for (const overrides of [{ revokedAt: 2, revocationReason: "compromised" }, { revokedAt: 2 }] as Partial<PreviousKey>[]) {
            const contacts = [contact("a", ["alice@example.com"], { keys: [current], previousKeys: [previous(oldFingerprint, 1, overrides)] })];
            expect(await evaluateMessageSecurity(raw, undefined, pinnedSigningFingerprintsFor(contacts, "alice@example.com"))).toMatchObject({
                state: "signature_failed",
                signatureFailureReason: "signer_key_changed",
                signerCertificate: toBase64(oldKey.certDer),
            });
        }
    });

    it("the user's own mail signed before their rotation verifies against their superseded key, but not a compromised one", async () => {
        const oldOwn = await generateIdentity("CN=alice@example.com");
        const newOwn = await generateIdentity("CN=alice@example.com");
        const raw = assembleOutboundMime(HEADERS, await buildSignedOnlyMessage("text/plain", "Sent last month.", HEADERS, oldOwn.certDer, oldOwn.privateKey));
        const newFingerprint = await computeCertFingerprint(newOwn.certDer);
        const oldFingerprint = await computeCertFingerprint(oldOwn.certDer);
        const unlocked = { signingFingerprint: newFingerprint };
        // The mailbox's own key set, as a reader passes it for mail from its own address: `signingKeyFingerprints(mailbox.keys)`.
        const ownPins = (revocationReason?: "superseded" | "compromised") =>
            signingKeyFingerprints([key(newFingerprint), key(oldFingerprint, { revokedAt: 2, ...(revocationReason ? { revocationReason } : {}) })]);

        // The unlocked session only knows the current key, so without the own key set the old signature isn't verified.
        expect((await evaluateMessageSecurity(raw, unlocked)).state).toBe("signed_unverified_signer");
        expect((await evaluateMessageSecurity(raw, unlocked, ownPins("superseded"))).state).toBe("signed_verified");
        for (const reason of ["compromised", undefined] as const) {
            expect(await evaluateMessageSecurity(raw, unlocked, ownPins(reason))).toMatchObject({ state: "signature_failed", signatureFailureReason: "signer_key_changed" });
        }
    });
});
