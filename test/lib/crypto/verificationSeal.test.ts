// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
/** Verification seals (`verificationSeal.ts`) and the seal-aware `evaluateMessageSecurityWithSeal()`. */
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromBase64Url, toBase64Url } from "../../../lib/crypto/encoding.js";
import { type PublicKey, signingKeyFingerprints } from "../../../lib/crypto/keyvaultApi.js";
import { KeysLockedError, generateMasterKey } from "../../../lib/crypto/masterKey.js";
import { evaluateMessageSecurity, evaluateMessageSecurityWithSeal } from "../../../lib/crypto/messageSecurity.js";
import { computeCertFingerprint } from "../../../lib/crypto/smime.js";
import { type ProtectedHeaders, assembleOutboundMime, buildEncryptedMessage, buildSignedOnlyMessage } from "../../../lib/crypto/smimeMessage.js";
import {
    MAX_VERIFICATION_SEAL_LENGTH,
    VERIFICATION_SEAL_CHARSET,
    type VerificationSealInput,
    buildVerificationSeal,
    openVerificationSeal,
    rawMimeSha256,
} from "../../../lib/crypto/verificationSeal.js";

x509.cryptoProvider.set(crypto);

const MAILBOX = "mb-seal";
const MESSAGE = "msg-1";
const HASH = "ab".repeat(32);
const FINGERPRINT = "cd".repeat(32);
const GENERATION = 3;

const input = (overrides: Partial<VerificationSealInput> = {}): VerificationSealInput => ({
    messageUid: MESSAGE,
    rawSha256: HASH,
    signerFingerprint: FINGERPRINT,
    state: "signed_verified",
    verifiedAt: 1_700_000_000_000,
    masterKeyGeneration: GENERATION,
    ...overrides,
});

/** A bare unlocked session: a master key and no private keys (typed as the session shape the evaluators accept). */
const keys = (): { masterKey: Uint8Array; destroyed?: boolean; signingFingerprint?: string } => ({ masterKey: generateMasterKey() });

/** Re-encodes a seal's payload through `edit`, keeping its tag. */
function editPayload(seal: string, edit: (payload: Record<string, unknown>) => unknown): string {
    const [version, payload, tag] = seal.split(".");
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Record<string, unknown>;
    return `${version}.${toBase64Url(new TextEncoder().encode(JSON.stringify(edit(decoded))))}.${tag}`;
}

const rawPayload = (text: string): string => toBase64Url(new TextEncoder().encode(text));

afterEach(() => {
    vi.restoreAllMocks();
});

describe("rawMimeSha256()", () => {
    it("hashes a binary string and its bytes alike, as lowercase hex", async () => {
        const bytes = new Uint8Array([0x61, 0x62, 0x63, 0xff, 0x80]);
        const binary = String.fromCharCode(...bytes);
        expect(await rawMimeSha256(binary)).toBe(await rawMimeSha256(bytes));
        expect(await rawMimeSha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });

    it("hashes a string that can't be a binary string as UTF-8", async () => {
        expect(await rawMimeSha256("€")).toBe(await rawMimeSha256(new TextEncoder().encode("€")));
    });
});

describe("buildVerificationSeal() / openVerificationSeal()", () => {
    it("round-trips, in the v1 format, within the charset and size limit", async () => {
        const unlocked = keys();
        const seal = await buildVerificationSeal(MAILBOX, unlocked, input({ signerFingerprint: FINGERPRINT.toUpperCase(), rawSha256: HASH.toUpperCase() }));
        expect(seal).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
        expect(VERIFICATION_SEAL_CHARSET.test(seal)).toBe(true);
        expect(seal.length).toBeLessThan(MAX_VERIFICATION_SEAL_LENGTH);
        expect(JSON.parse(new TextDecoder().decode(fromBase64Url(seal.split(".")[1])))).toEqual({
            v: 1,
            mb: MAILBOX,
            id: MESSAGE,
            g: GENERATION,
            h: HASH,
            fp: FINGERPRINT,
            st: "signed_verified",
            t: 1_700_000_000_000,
        });

        const opened = { signerFingerprint: FINGERPRINT, state: "signed_verified", verifiedAt: 1_700_000_000_000, masterKeyGeneration: GENERATION };
        expect(await openVerificationSeal(MAILBOX, unlocked, MESSAGE, seal, HASH)).toEqual(opened);
        expect(await openVerificationSeal(MAILBOX, unlocked, MESSAGE, seal, HASH.toUpperCase())).toEqual(opened);

        const encrypted = await buildVerificationSeal(MAILBOX, unlocked, input({ state: "encrypted_verified", verifiedAt: 0, masterKeyGeneration: 0 }));
        expect(await openVerificationSeal(MAILBOX, unlocked, MESSAGE, encrypted, HASH, 0)).toMatchObject({ state: "encrypted_verified", verifiedAt: 0, masterKeyGeneration: 0 });
    });

    it("binds the master key generation: covered by the MAC and checked against the expected generation", async () => {
        const unlocked = keys();
        const seal = await buildVerificationSeal(MAILBOX, unlocked, input());
        expect(await openVerificationSeal(MAILBOX, unlocked, MESSAGE, seal, HASH, GENERATION)).toMatchObject({ masterKeyGeneration: GENERATION });
        expect(await openVerificationSeal(MAILBOX, unlocked, MESSAGE, seal, HASH, GENERATION + 1)).toBeUndefined();
        expect(await openVerificationSeal(MAILBOX, unlocked, MESSAGE, seal, HASH, 0)).toBeUndefined();

        // A payload whose generation was rewritten fails the MAC, whether or not a generation is expected.
        const bumped = editPayload(seal, (p) => ({ ...p, g: GENERATION + 1 }));
        expect(await openVerificationSeal(MAILBOX, unlocked, MESSAGE, bumped, HASH)).toBeUndefined();
        expect(await openVerificationSeal(MAILBOX, unlocked, MESSAGE, bumped, HASH, GENERATION + 1)).toBeUndefined();
        // Generations are part of the tag: the same result sealed at another generation has a different tag.
        const other = await buildVerificationSeal(MAILBOX, unlocked, input({ masterKeyGeneration: GENERATION + 1 }));
        expect(other.split(".")[2]).not.toBe(seal.split(".")[2]);
    });

    it("is deterministic for the same master key and input, and differs per mailbox", async () => {
        const unlocked = keys();
        const seal = await buildVerificationSeal(MAILBOX, unlocked, input());
        expect(await buildVerificationSeal(MAILBOX, unlocked, input())).toBe(seal);
        expect((await buildVerificationSeal("mb-other", unlocked, input())).split(".")[2]).not.toBe(seal.split(".")[2]);
    });

    it("rejects a tampered payload or tag", async () => {
        const unlocked = keys();
        const seal = await buildVerificationSeal(MAILBOX, unlocked, input());
        const [version, payload, tag] = seal.split(".");
        const flippedTag = tag.slice(0, -2) + (tag[tag.length - 2] === "A" ? "B" : "A") + tag[tag.length - 1];
        const tampered = [
            editPayload(seal, (p) => ({ ...p, t: 1 })),
            editPayload(seal, (p) => ({ ...p, fp: "ee".repeat(32) })),
            editPayload(seal, (p) => ({ ...p, st: "encrypted_verified" })),
            `${version}.${payload}.${flippedTag}`,
            `${version}.${payload}.${tag.slice(0, 20)}`,
        ];
        for (const candidate of tampered) {
            expect(await openVerificationSeal(MAILBOX, unlocked, MESSAGE, candidate, HASH)).toBeUndefined();
        }
    });

    it("rejects the wrong mailbox, the wrong message and the wrong master key", async () => {
        const unlocked = keys();
        const seal = await buildVerificationSeal(MAILBOX, unlocked, input());
        expect(await openVerificationSeal("mb-other", unlocked, MESSAGE, seal, HASH)).toBeUndefined();
        expect(await openVerificationSeal(MAILBOX, unlocked, "msg-2", seal, HASH)).toBeUndefined();
        expect(await openVerificationSeal(MAILBOX, keys(), MESSAGE, seal, HASH)).toBeUndefined();

        // A seal copied onto another message with its payload uids rewritten still fails: the tag names the original.
        const moved = editPayload(seal, (p) => ({ ...p, id: "msg-2" }));
        expect(await openVerificationSeal(MAILBOX, unlocked, "msg-2", moved, HASH)).toBeUndefined();
        // And a payload whose uids disagree with the caller's is refused even though the tag covers the caller's uids.
        expect(await openVerificationSeal(MAILBOX, unlocked, MESSAGE, editPayload(seal, (p) => ({ ...p, id: "msg-2" })), HASH)).toBeUndefined();
        expect(await openVerificationSeal(MAILBOX, unlocked, MESSAGE, editPayload(seal, (p) => ({ ...p, mb: "mb-other" })), HASH)).toBeUndefined();
    });

    it("rejects a content hash mismatch", async () => {
        const unlocked = keys();
        const seal = await buildVerificationSeal(MAILBOX, unlocked, input());
        expect(await openVerificationSeal(MAILBOX, unlocked, MESSAGE, seal, "00".repeat(32))).toBeUndefined();
    });

    it("returns undefined, never throwing, for an unknown version or a malformed seal", async () => {
        const unlocked = keys();
        const seal = await buildVerificationSeal(MAILBOX, unlocked, input());
        const [, payload, tag] = seal.split(".");
        const malformed: unknown[] = [
            undefined,
            "",
            42,
            `v2.${payload}.${tag}`,
            `V1.${payload}.${tag}`,
            `v1.${payload}`,
            `v1.${payload}.${tag}.x`,
            `v1..${tag}`,
            `v1.${payload}.${tag}!`,
            `v1.${payload}+.${tag}`,
            `v1.${"A".repeat(MAX_VERIFICATION_SEAL_LENGTH)}.${tag}`,
            `v1.A.${tag}`,
            `v1.${rawPayload("not json")}.${tag}`,
            `v1.${toBase64Url(new Uint8Array([0xff, 0xfe]))}.${tag}`,
            `v1.${rawPayload("null")}.${tag}`,
            `v1.${rawPayload("1")}.${tag}`,
            `v1.${payload}.${toBase64Url(new Uint8Array(31))}`,
            editPayload(seal, (p) => ({ ...p, v: 2 })),
            editPayload(seal, (p) => ({ ...p, g: undefined })),
            editPayload(seal, (p) => ({ ...p, g: -1 })),
            editPayload(seal, (p) => ({ ...p, g: "3" })),
            editPayload(seal, (p) => ({ ...p, mb: 1 })),
            editPayload(seal, (p) => ({ ...p, id: null })),
            editPayload(seal, (p) => ({ ...p, h: 5 })),
            editPayload(seal, (p) => ({ ...p, h: "xyz" })),
            editPayload(seal, (p) => ({ ...p, fp: "" })),
            editPayload(seal, (p) => ({ ...p, fp: 3 })),
            editPayload(seal, (p) => ({ ...p, st: 3 })),
            editPayload(seal, (p) => ({ ...p, st: "signature_failed" })),
            editPayload(seal, (p) => ({ ...p, t: -1 })),
            editPayload(seal, (p) => ({ ...p, t: 1.5 })),
            editPayload(seal, (p) => ({ ...p, t: "1" })),
        ];
        for (const candidate of malformed) {
            await expect(openVerificationSeal(MAILBOX, unlocked, MESSAGE, candidate as string, HASH)).resolves.toBeUndefined();
        }
    });

    it("refuses input it can't seal, including seals over the size limit", async () => {
        const unlocked = keys();
        const invalid: [string, Partial<VerificationSealInput>][] = [
            ["", {}],
            [MAILBOX, { messageUid: "" }],
            [MAILBOX, { signerFingerprint: "" }],
            [MAILBOX, { signerFingerprint: 7 as never }],
            [MAILBOX, { rawSha256: "abc" }],
            [MAILBOX, { rawSha256: undefined }],
            [MAILBOX, { state: "signature_failed" as never }],
            [MAILBOX, { verifiedAt: -1 }],
            [MAILBOX, { verifiedAt: 1.5 }],
            [MAILBOX, { verifiedAt: Number.NaN }],
            [MAILBOX, { masterKeyGeneration: -1 }],
            [MAILBOX, { masterKeyGeneration: 1.5 }],
            [MAILBOX, { messageUid: "m".repeat(1500) }],
        ];
        for (const [mailboxUid, overrides] of invalid) {
            await expect(buildVerificationSeal(mailboxUid, unlocked, input(overrides))).rejects.toThrow(Error);
        }

        // Long but plausible uids still fit.
        const long = await buildVerificationSeal("b".repeat(300), unlocked, input({ messageUid: "m".repeat(300) }));
        expect(long.length).toBeLessThanOrEqual(MAX_VERIFICATION_SEAL_LENGTH);
        expect(VERIFICATION_SEAL_CHARSET.test(long)).toBe(true);
    });

    it("throws KeysLockedError for destroyed or zeroed keys, even for a malformed seal", async () => {
        const unlocked = keys();
        const seal = await buildVerificationSeal(MAILBOX, unlocked, input());
        unlocked.masterKey.fill(0);
        const destroyed = { ...unlocked, destroyed: true };

        await expect(buildVerificationSeal(MAILBOX, destroyed, input())).rejects.toBeInstanceOf(KeysLockedError);
        await expect(openVerificationSeal(MAILBOX, destroyed, MESSAGE, seal, HASH)).rejects.toBeInstanceOf(KeysLockedError);
        await expect(openVerificationSeal(MAILBOX, destroyed, MESSAGE, "garbage", HASH)).rejects.toBeInstanceOf(KeysLockedError);
        // Zeroed but not flagged: the derivation refuses it.
        await expect(buildVerificationSeal(MAILBOX, unlocked, input())).rejects.toBeInstanceOf(KeysLockedError);
        await expect(openVerificationSeal(MAILBOX, unlocked, MESSAGE, seal, HASH)).rejects.toBeInstanceOf(KeysLockedError);
    });

    it("throws KeysLockedError when the keys are destroyed while the seal key is derived", async () => {
        const unlocked = keys();
        const pending = buildVerificationSeal(MAILBOX, unlocked, input());
        unlocked.destroyed = true;
        await expect(pending).rejects.toBeInstanceOf(KeysLockedError);
    });
});

interface Identity {
    certDer: Uint8Array;
    privateKey: CryptoKey;
    fingerprint: string;
}

async function generateIdentity(name: string, keyUsage: "sign" | "encrypt" = "sign"): Promise<Identity> {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "01",
        name,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 86_400_000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys: pair,
    });
    let privateKey = pair.privateKey;
    if (keyUsage === "encrypt") {
        const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
        privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    }
    const certDer = new Uint8Array(cert.rawData);
    return { certDer, privateKey, fingerprint: await computeCertFingerprint(certDer) };
}

const HEADERS: ProtectedHeaders = {
    from: "alice@example.com",
    to: "bob@example.com",
    date: "Wed, 11 Jan 2023 16:08:43 -0500",
    subject: "Real subject",
    messageId: "<abc123@example.com>",
};

const signKey = (fingerprint: string, overrides: Partial<PublicKey> = {}): PublicKey => ({
    publicKey: "",
    type: "x509",
    useType: "sign",
    fingerprint,
    notBefore: 0,
    notAfter: 1,
    ...overrides,
});

async function signedMessage(signer: Identity, outer: ProtectedHeaders = HEADERS): Promise<string> {
    return assembleOutboundMime(outer, await buildSignedOnlyMessage("text/plain", "Hi.", HEADERS, signer.certDer, signer.privateKey));
}

async function encryptedMessage(signer: Identity, recipient: Identity, outer: ProtectedHeaders = HEADERS): Promise<string> {
    return assembleOutboundMime(
        outer,
        await buildEncryptedMessage("text/plain", "Secret.", HEADERS, HEADERS, [recipient.certDer], { certDer: signer.certDer, privateKey: signer.privateKey }),
    );
}

describe("evaluateMessageSecurityWithSeal()", () => {
    const options = (seal?: string, extra: object = {}) => ({
        mailboxUid: MAILBOX,
        messageUid: MESSAGE,
        masterKeyGeneration: GENERATION,
        ...(seal !== undefined ? { seal, sealGeneration: GENERATION } : {}),
        ...extra,
    });

    /** Opens a message once with its signer pinned, returning the seal the first open would store. */
    async function firstOpenSeal(raw: string, unlocked: Parameters<typeof evaluateMessageSecurityWithSeal>[1], pin: string): Promise<string> {
        const first = await evaluateMessageSecurityWithSeal(raw, unlocked, pin, undefined, options(undefined, { now: 1234 }));
        expect(first.sealToWrite?.masterKeyGeneration).toBe(GENERATION);
        return first.sealToWrite!.seal;
    }

    it("adds sealToWrite to a live signed_verified result, sealing the live signer and state", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const raw = await signedMessage(alice);
        const unlocked = keys();

        const live = await evaluateMessageSecurity(raw, unlocked, alice.fingerprint);
        const result = await evaluateMessageSecurityWithSeal(raw, unlocked, alice.fingerprint, undefined, options(undefined, { now: 1234 }));
        const { sealToWrite, ...rest } = result;
        expect(rest).toEqual(live);
        expect(sealToWrite?.masterKeyGeneration).toBe(GENERATION);
        expect(await openVerificationSeal(MAILBOX, unlocked, MESSAGE, sealToWrite?.seal, await rawMimeSha256(raw), GENERATION)).toEqual({
            signerFingerprint: alice.fingerprint,
            state: "signed_verified",
            verifiedAt: 1234,
            masterKeyGeneration: GENERATION,
        });
    });

    it("seals a live encrypted_verified result, defaulting verifiedAt to now", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const bob = await generateIdentity("CN=bob@example.com", "encrypt");
        const raw = await encryptedMessage(alice, bob);
        const unlocked = { ...keys(), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer };
        vi.spyOn(Date, "now").mockReturnValue(5678);

        const result = await evaluateMessageSecurityWithSeal(raw, unlocked, alice.fingerprint, undefined, options());
        expect(result).toMatchObject({ state: "encrypted_verified", text: "Secret." });
        expect(await openVerificationSeal(MAILBOX, unlocked, MESSAGE, result.sealToWrite?.seal, await rawMimeSha256(raw))).toEqual({
            signerFingerprint: alice.fingerprint,
            state: "encrypted_verified",
            verifiedAt: 5678,
            masterKeyGeneration: GENERATION,
        });
    });

    it("writes no seal when a valid one is stored, but does when the stored one doesn't open", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const raw = await signedMessage(alice);
        const unlocked = keys();
        const seal = await firstOpenSeal(raw, unlocked, alice.fingerprint);

        expect(await evaluateMessageSecurityWithSeal(raw, unlocked, alice.fingerprint, undefined, options(seal))).toEqual(await evaluateMessageSecurity(raw, unlocked, alice.fingerprint));
        const foreign = await buildVerificationSeal(MAILBOX, keys(), input({ rawSha256: await rawMimeSha256(raw), signerFingerprint: alice.fingerprint }));
        expect((await evaluateMessageSecurityWithSeal(raw, unlocked, alice.fingerprint, undefined, options(foreign))).sealToWrite).toBeDefined();
    });

    it("re-seals after a master key generation bump, under the current generation", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const aliceNew = await generateIdentity("CN=alice@example.com");
        const raw = await signedMessage(alice);
        const oldKeys = keys();
        const oldSeal = await firstOpenSeal(raw, oldKeys, alice.fingerprint);
        const bumped = { masterKeyGeneration: GENERATION + 1, sealGeneration: GENERATION, now: 9999 };

        // After a rekey: a new master key and generation. The old seal doesn't open, so a key-status failure stays live...
        const newKeys = keys();
        expect(await evaluateMessageSecurityWithSeal(raw, newKeys, aliceNew.fingerprint, undefined, options(oldSeal, bumped))).toMatchObject({
            state: "signature_failed",
            signatureFailureReason: "signer_key_changed",
        });
        // ...and a live verification re-seals under the current generation.
        const resealed = await evaluateMessageSecurityWithSeal(raw, newKeys, alice.fingerprint, undefined, options(oldSeal, bumped));
        expect(resealed.sealToWrite?.masterKeyGeneration).toBe(GENERATION + 1);
        expect(await openVerificationSeal(MAILBOX, newKeys, MESSAGE, resealed.sealToWrite?.seal, await rawMimeSha256(raw), GENERATION + 1)).toMatchObject({
            masterKeyGeneration: GENERATION + 1,
            verifiedAt: 9999,
        });

        // Even under the same master key, an older-generation seal isn't honoured once the generation moved on.
        expect(await evaluateMessageSecurityWithSeal(raw, oldKeys, undefined, undefined, options(oldSeal, bumped))).toMatchObject({ state: "signed_unverified_signer" });

        // A seal that opens at the current generation while the stored generation is reported older is rewritten too.
        const current = (await evaluateMessageSecurityWithSeal(raw, newKeys, alice.fingerprint, undefined, options(undefined, { masterKeyGeneration: GENERATION + 1 }))).sealToWrite!.seal;
        expect((await evaluateMessageSecurityWithSeal(raw, newKeys, alice.fingerprint, undefined, options(current, bumped))).sealToWrite?.masterKeyGeneration).toBe(GENERATION + 1);
        // Once stored with the current generation, nothing more is written, and it is honoured.
        const stored = { masterKeyGeneration: GENERATION + 1, sealGeneration: GENERATION + 1 };
        expect(await evaluateMessageSecurityWithSeal(raw, newKeys, alice.fingerprint, undefined, options(current, stored))).not.toHaveProperty("sealToWrite");
        expect(await evaluateMessageSecurityWithSeal(raw, newKeys, undefined, undefined, options(current, stored))).toMatchObject({ state: "verified_at_first_open" });
        // A stored seal without a reported generation that opens is left alone.
        expect(await evaluateMessageSecurityWithSeal(raw, newKeys, alice.fingerprint, undefined, options(current, { masterKeyGeneration: GENERATION + 1, sealGeneration: undefined }))).not.toHaveProperty("sealToWrite");
    });

    it("builds no seal without a master key, or when the seal can't be built", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const raw = await signedMessage(alice);
        const live = await evaluateMessageSecurity(raw, undefined, alice.fingerprint);

        expect(await evaluateMessageSecurityWithSeal(raw, undefined, alice.fingerprint, undefined, options())).toEqual(live);
        expect(await evaluateMessageSecurityWithSeal(raw, keys(), alice.fingerprint, undefined, { mailboxUid: MAILBOX, messageUid: "m".repeat(3000), masterKeyGeneration: GENERATION })).toEqual(live);
    });

    it("is verified_at_first_open, with the content, for a signed-only message whose signer key changed", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const aliceNew = await generateIdentity("CN=alice@example.com");
        const raw = await signedMessage(alice);
        const unlocked = keys();
        const seal = await firstOpenSeal(raw, unlocked, alice.fingerprint);

        const live = await evaluateMessageSecurity(raw, unlocked, aliceNew.fingerprint, "carol@example.com");
        expect(live).toMatchObject({ state: "signature_failed", signatureFailureReason: "signer_key_changed" });
        expect(live.text).toBeUndefined();

        const result = await evaluateMessageSecurityWithSeal(raw, unlocked, aliceNew.fingerprint, "carol@example.com", options(seal));
        expect(result).toMatchObject({
            state: "verified_at_first_open",
            verifiedAt: 1234,
            sealedState: "signed_verified",
            signerFingerprint: alice.fingerprint,
            liveState: "signature_failed",
            liveSignatureFailureReason: "signer_key_changed",
            text: "Hi.",
            subject: "Real subject",
            notAddressedToReader: true,
            signerCertificate: live.signerCertificate,
        });
        expect(result).not.toHaveProperty("signatureFailureReason");
        expect(result).not.toHaveProperty("laterCompromised");
        expect(result).not.toHaveProperty("sealToWrite");
    });

    it("is verified_at_first_open for signed_unverified_signer (the pin was deleted)", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const raw = await signedMessage(alice);
        const unlocked = keys();
        const seal = await firstOpenSeal(raw, unlocked, alice.fingerprint);

        const result = await evaluateMessageSecurityWithSeal(raw, unlocked, undefined, undefined, options(seal));
        expect(result).toMatchObject({ state: "verified_at_first_open", sealedState: "signed_verified", liveState: "signed_unverified_signer", text: "Hi." });
        expect(result).not.toHaveProperty("liveSignatureFailureReason");
    });

    it("is verified_at_first_open for encrypted_unverified_signer and an encrypted signer_key_changed", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const aliceNew = await generateIdentity("CN=alice@example.com");
        const bob = await generateIdentity("CN=bob@example.com", "encrypt");
        const raw = await encryptedMessage(alice, bob);
        const unlocked = { ...keys(), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer };
        const seal = await firstOpenSeal(raw, unlocked, alice.fingerprint);

        expect(await evaluateMessageSecurityWithSeal(raw, unlocked, [], undefined, options(seal))).toMatchObject({
            state: "verified_at_first_open",
            sealedState: "encrypted_verified",
            liveState: "encrypted_unverified_signer",
            text: "Secret.",
        });
        expect(await evaluateMessageSecurityWithSeal(raw, unlocked, aliceNew.fingerprint, undefined, options(seal))).toMatchObject({
            state: "verified_at_first_open",
            sealedState: "encrypted_verified",
            liveState: "signature_failed",
            liveSignatureFailureReason: "signer_key_changed",
            text: "Secret.",
        });
    });

    it("sets laterCompromised when the signer key is now revoked as compromised or without a reason", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const aliceNew = await generateIdentity("CN=alice@example.com");
        const raw = await signedMessage(alice);
        const unlocked = keys();
        const seal = await firstOpenSeal(raw, unlocked, alice.fingerprint);

        for (const revocation of [{ revokedAt: 2, revocationReason: "compromised" }, { revokedAt: 2 }] as Partial<PublicKey>[]) {
            const contactKeys = [signKey(aliceNew.fingerprint), signKey(alice.fingerprint.toUpperCase(), revocation)];
            // The revoked key is no longer a trusted pin, so the live result is a key change.
            const pins = signingKeyFingerprints(contactKeys);
            const result = await evaluateMessageSecurityWithSeal(raw, unlocked, pins, undefined, options(seal, { signerKeys: contactKeys }));
            expect(result).toMatchObject({ state: "verified_at_first_open", laterCompromised: true, liveSignatureFailureReason: "signer_key_changed" });
        }

        // A superseded or unrevoked record, another key's revocation, or no key records: not compromised.
        for (const signerKeys of [
            [signKey(alice.fingerprint, { revokedAt: 2, revocationReason: "superseded" })],
            [signKey(alice.fingerprint)],
            [signKey(aliceNew.fingerprint, { revokedAt: 2, revocationReason: "compromised" })],
            undefined,
        ]) {
            const result = await evaluateMessageSecurityWithSeal(raw, unlocked, aliceNew.fingerprint, undefined, options(seal, signerKeys ? { signerKeys } : {}));
            expect(result.state).toBe("verified_at_first_open");
            expect(result).not.toHaveProperty("laterCompromised");
        }
    });

    it("ignores the seal for tampering, header mismatch, untrusted_signer and a different raw MIME", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const aliceNew = await generateIdentity("CN=alice@example.com");
        const raw = await signedMessage(alice);
        const unlocked = keys();
        const seal = await firstOpenSeal(raw, unlocked, alice.fingerprint);

        // The body changed after signing.
        const tampered = raw.replace("SGku", "SGkh");
        expect(tampered).not.toBe(raw);
        const tamperedResult = await evaluateMessageSecurityWithSeal(tampered, unlocked, aliceNew.fingerprint, undefined, options(seal));
        expect(tamperedResult).toEqual(await evaluateMessageSecurity(tampered, unlocked, aliceNew.fingerprint));
        expect(tamperedResult).toMatchObject({ state: "signature_failed", signatureFailureReason: "invalid_signature" });

        // The outer To changed: header_mismatch unpinned, untrusted_signer pinned to another key.
        const readdressed = raw.replace("To: bob@example.com", "To: eve@example.com");
        expect(await evaluateMessageSecurityWithSeal(readdressed, unlocked, undefined, undefined, options(seal))).toMatchObject({ state: "signature_failed", signatureFailureReason: "header_mismatch" });
        expect(await evaluateMessageSecurityWithSeal(readdressed, unlocked, aliceNew.fingerprint, undefined, options(seal))).toMatchObject({
            state: "signature_failed",
            signatureFailureReason: "untrusted_signer",
        });

        // An unchecked header was added: the signature still verifies, but the raw MIME is no longer what was sealed.
        const extended = `X-Relay: 1\r\n${raw}`;
        expect(await evaluateMessageSecurityWithSeal(extended, unlocked, undefined, undefined, options(seal))).toMatchObject({ state: "signed_unverified_signer" });
    });

    it("ignores a seal for a different signer, the other message kind, or another master key", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const raw = await signedMessage(alice);
        const unlocked = keys();
        const rawSha256 = await rawMimeSha256(raw);
        const sealFor = (overrides: Partial<VerificationSealInput>, sealKeys = unlocked) =>
            buildVerificationSeal(MAILBOX, sealKeys, input({ rawSha256, signerFingerprint: alice.fingerprint, ...overrides }));

        for (const seal of [
            await sealFor({ signerFingerprint: "ee".repeat(32) }),
            await sealFor({ state: "encrypted_verified" }),
            await sealFor({}, keys()),
            await sealFor({ messageUid: "msg-2" }),
        ]) {
            expect(await evaluateMessageSecurityWithSeal(raw, unlocked, undefined, undefined, options(seal))).toMatchObject({ state: "signed_unverified_signer" });
        }
        // Without any seal, likewise.
        expect(await evaluateMessageSecurityWithSeal(raw, unlocked, undefined, undefined, options())).toEqual(await evaluateMessageSecurity(raw, unlocked));
    });

    it("neither seals nor honours a seal when HP-Outer tampering was detected", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const bob = await generateIdentity("CN=bob@example.com", "encrypt");
        const raw = await encryptedMessage(alice, bob, { ...HEADERS, date: "Thu, 12 Jan 2023 10:00:00 -0500" });
        const unlocked = { ...keys(), encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer };

        const verified = await evaluateMessageSecurityWithSeal(raw, unlocked, alice.fingerprint, undefined, options());
        expect(verified).toMatchObject({ state: "encrypted_verified", headerTamperDetected: true });
        expect(verified).not.toHaveProperty("sealToWrite");

        const seal = await buildVerificationSeal(MAILBOX, unlocked, input({ rawSha256: await rawMimeSha256(raw), signerFingerprint: alice.fingerprint, state: "encrypted_verified" }));
        expect(await evaluateMessageSecurityWithSeal(raw, unlocked, undefined, undefined, options(seal))).toMatchObject({ state: "encrypted_unverified_signer", headerTamperDetected: true });
    });

    it("returns unsigned results unchanged", async () => {
        const unlocked = keys();
        const seal = await buildVerificationSeal(MAILBOX, unlocked, input());
        expect(await evaluateMessageSecurityWithSeal("Subject: hi\r\n\r\nplain", unlocked, undefined, undefined, options(seal))).toEqual({ state: "unprotected" });
        const bob = await generateIdentity("CN=bob@example.com", "encrypt");
        const raw = assembleOutboundMime(HEADERS, await buildEncryptedMessage("text/plain", "Unsigned.", HEADERS, HEADERS, [bob.certDer]));
        const withKeys = { ...unlocked, encryptionPrivateKey: bob.privateKey, encryptionCertDer: bob.certDer };
        expect(await evaluateMessageSecurityWithSeal(raw, withKeys, undefined, undefined, options(seal))).toEqual(await evaluateMessageSecurity(raw, withKeys));
    });

    it("throws KeysLockedError for destroyed keys, before or during evaluation", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const raw = await signedMessage(alice);
        const unlocked = keys();
        const seal = await firstOpenSeal(raw, unlocked, alice.fingerprint);

        await expect(evaluateMessageSecurityWithSeal(raw, { ...unlocked, destroyed: true }, undefined, undefined, options(seal))).rejects.toBeInstanceOf(KeysLockedError);

        const building = evaluateMessageSecurityWithSeal(raw, unlocked, alice.fingerprint, undefined, options());
        unlocked.destroyed = true;
        await expect(building).rejects.toBeInstanceOf(KeysLockedError);
    });

    it("leaves evaluateMessageSecurity() without seal fields (backward compatible)", async () => {
        const alice = await generateIdentity("CN=alice@example.com");
        const raw = await signedMessage(alice);
        const unlocked = keys();
        for (const pins of [alice.fingerprint, undefined]) {
            const result = await evaluateMessageSecurity(raw, unlocked, pins);
            for (const field of ["sealToWrite", "verifiedAt", "sealedState", "liveState", "liveSignatureFailureReason", "laterCompromised"]) {
                expect(result).not.toHaveProperty(field);
            }
        }
        expect((await evaluateMessageSecurity(raw, unlocked, alice.fingerprint)).state).toBe("signed_verified");
    });
});
