// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { toBase64 } from "../../../lib/crypto/encoding.js";
import type { KeyVault, ZeroAccessKey } from "../../../lib/crypto/keyvaultApi.js";
import { ZERO_ACCESS_PRIVATE_KEY_AAD_PURPOSE } from "../../../lib/crypto/keySession.js";
import { buildAad, generateMasterKey, openWithKey } from "../../../lib/crypto/masterKey.js";
import { ensureZeroAccessKey, provisionZeroAccessKey } from "../../../lib/crypto/zeroAccessKey.js";

const { enrollKey, getKeyVault, getUnlockedKeys, addZeroAccessKey } = vi.hoisted(() => ({
    enrollKey: vi.fn(),
    getKeyVault: vi.fn(),
    getUnlockedKeys: vi.fn(),
    addZeroAccessKey: vi.fn(),
}));
vi.mock("../../../lib/crypto/keyvaultApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/crypto/keyvaultApi.js")>()),
    enrollKey,
    getKeyVault,
}));
vi.mock("../../../lib/crypto/keySession.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/crypto/keySession.js")>()),
    getUnlockedKeys,
    addZeroAccessKey,
}));

const MAILBOX_UID = "mb1";
const ADDRESS = "alice@example.com";

const zeroAccessKey = (fingerprint: string, fields: Partial<ZeroAccessKey> = {}): ZeroAccessKey => ({
    publicKey: toBase64(new Uint8Array([7, 8, 9])),
    type: "x509",
    useType: "zero-access",
    fingerprint,
    notBefore: 1,
    notAfter: 2,
    ...fields,
});

/** What restapi answers to the enrollment: the new wrapped key appended last, its certificate on `zeroAccessKeys`. */
function enrolledVault(fingerprint = "za-new"): KeyVault {
    return {
        wrappedKeys: [
            { ciphertext: "c", nonce: "n", algorithm: "AES-256-GCM", fingerprint: "enc", useType: "encrypt" },
            { ciphertext: "c", nonce: "n", algorithm: "AES-256-GCM", fingerprint: "za-old", useType: "zero-access" },
            { ciphertext: "c", nonce: "n", algorithm: "AES-256-GCM", fingerprint, useType: "zero-access" },
        ],
        masterKeyWraps: [],
        masterKeyGeneration: 3,
        zeroAccessKeys: [zeroAccessKey("za-old", { revokedAt: 1 }), zeroAccessKey(fingerprint)],
    };
}

afterEach(() => {
    vi.clearAllMocks();
});

describe("provisionZeroAccessKey", () => {
    it("enrolls a zero-access key sealed under the master key and returns it ready to decrypt with", async () => {
        const mk = generateMasterKey();
        enrollKey.mockResolvedValue(enrolledVault());

        const { vault, key } = await provisionZeroAccessKey(MAILBOX_UID, ADDRESS, mk, 3);

        expect(vault.masterKeyGeneration).toBe(3);
        const input = enrollKey.mock.calls[0][1];
        expect(enrollKey.mock.calls[0][0]).toBe(MAILBOX_UID);
        expect(input.useType).toBe("zero-access");
        expect(input.csr).toContain("CERTIFICATE REQUEST");
        expect(input.expectedMasterKeyGeneration).toBe(3);
        expect(input.masterKeyWraps).toBeUndefined();
        // The sealed private key opens under the master key with the zero-access purpose, and only with it.
        const raw = await openWithKey(mk, input.wrappedKey, buildAad(MAILBOX_UID, ZERO_ACCESS_PRIVATE_KEY_AAD_PURPOSE));
        expect(raw.length).toBeGreaterThan(0);
        await expect(openWithKey(mk, input.wrappedKey, buildAad(MAILBOX_UID, "encrypt-private-key"))).rejects.toThrow();

        expect(key.fingerprint).toBe("za-new");
        expect(Array.from(key.certDer)).toEqual([7, 8, 9]);
        expect(key.privateKey.algorithm.name).toBe("ECDH");
        expect(key.privateKey.extractable).toBe(false);
    });

    it("omits expectedMasterKeyGeneration when none is given", async () => {
        enrollKey.mockResolvedValue(enrolledVault());

        await provisionZeroAccessKey(MAILBOX_UID, ADDRESS, generateMasterKey());

        expect("expectedMasterKeyGeneration" in enrollKey.mock.calls[0][1]).toBe(false);
    });

    it("throws when the server does not return the enrolled key", async () => {
        enrollKey.mockResolvedValueOnce({ wrappedKeys: [], masterKeyWraps: [] });
        await expect(provisionZeroAccessKey(MAILBOX_UID, ADDRESS, generateMasterKey())).rejects.toThrow("did not return");

        enrollKey.mockResolvedValueOnce({ ...enrolledVault(), zeroAccessKeys: undefined });
        await expect(provisionZeroAccessKey(MAILBOX_UID, ADDRESS, generateMasterKey())).rejects.toThrow("did not return");
    });
});

describe("ensureZeroAccessKey", () => {
    const unlocked = (fields: object = {}) => ({ masterKey: generateMasterKey(), ...fields });

    it("does nothing for a mailbox that isn't unlocked", async () => {
        getUnlockedKeys.mockReturnValue(undefined);

        expect(await ensureZeroAccessKey(MAILBOX_UID, ADDRESS)).toBe(false);
        expect(getKeyVault).not.toHaveBeenCalled();
    });

    it("does nothing when the session already holds a zero-access key", async () => {
        getUnlockedKeys.mockReturnValue(unlocked({ zeroAccessKeys: [{ fingerprint: "za" }] }));

        expect(await ensureZeroAccessKey(MAILBOX_UID, ADDRESS)).toBe(false);
        expect(getKeyVault).not.toHaveBeenCalled();
    });

    it("does nothing when the vault already holds an unrevoked zero-access key, or holds no keys at all", async () => {
        getUnlockedKeys.mockReturnValue(unlocked());
        getKeyVault.mockResolvedValueOnce({ wrappedKeys: [{}], masterKeyWraps: [], zeroAccessKeys: [zeroAccessKey("za")] });
        expect(await ensureZeroAccessKey(MAILBOX_UID, ADDRESS)).toBe(false);

        getKeyVault.mockResolvedValueOnce({ wrappedKeys: [], masterKeyWraps: [] });
        expect(await ensureZeroAccessKey(MAILBOX_UID, ADDRESS)).toBe(false);

        expect(enrollKey).not.toHaveBeenCalled();
    });

    it("provisions a key for a vault without one (or only revoked ones), under the session's master key and the vault's generation", async () => {
        const session = unlocked();
        getUnlockedKeys.mockReturnValue(session);
        getKeyVault.mockResolvedValue({ wrappedKeys: [{}], masterKeyWraps: [], masterKeyGeneration: 3, zeroAccessKeys: [zeroAccessKey("za-old", { revokedAt: 1 })] });
        enrollKey.mockResolvedValue(enrolledVault());

        expect(await ensureZeroAccessKey(MAILBOX_UID, ADDRESS)).toBe(true);

        expect(enrollKey.mock.calls[0][1].expectedMasterKeyGeneration).toBe(3);
        expect(addZeroAccessKey).toHaveBeenCalledWith(MAILBOX_UID, session, expect.objectContaining({ fingerprint: "za-new" }));
    });

    it("joins a provision already in flight for the same mailbox instead of enrolling twice", async () => {
        getUnlockedKeys.mockReturnValue(unlocked());
        getKeyVault.mockResolvedValue({ wrappedKeys: [{}], masterKeyWraps: [] });
        enrollKey.mockResolvedValue(enrolledVault());

        const [first, second] = await Promise.all([ensureZeroAccessKey(MAILBOX_UID, ADDRESS), ensureZeroAccessKey(MAILBOX_UID, ADDRESS)]);

        expect(first).toBe(true);
        expect(second).toBe(true);
        expect(enrollKey).toHaveBeenCalledTimes(1);
    });

    it("rejects when the enrollment fails, and tries again on the next call", async () => {
        getUnlockedKeys.mockReturnValue(unlocked());
        getKeyVault.mockResolvedValue({ wrappedKeys: [{}], masterKeyWraps: [] });
        enrollKey.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(enrolledVault());

        await expect(ensureZeroAccessKey(MAILBOX_UID, ADDRESS)).rejects.toThrow("offline");
        expect(await ensureZeroAccessKey(MAILBOX_UID, ADDRESS)).toBe(true);
    });
});
