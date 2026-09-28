// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ESCROW_KDF_LABEL,
    PasswordWrapReplaceError,
    RECOVERY_CODE_COUNT,
    RECOVERY_KDF_LABEL,
    buildEscrowWrap,
    buildPasswordWrap,
    buildRecoveryWraps,
    consumeRecoveryCode,
    replacePasswordWrap,
} from "../../../lib/crypto/masterKeyWraps.js";
import { fromBase64 } from "../../../lib/crypto/encoding.js";
import { KeysLockedError, buildAad, generateMasterKey, openWithKey } from "../../../lib/crypto/masterKey.js";
import { MASTER_KEY_AAD_PURPOSE } from "../../../lib/crypto/keySession.js";
import { RECOVERY_KDF_LABEL as RECOVERY_KDF_LABEL_SOURCE, deriveFromRecoveryCode } from "../../../lib/crypto/recoveryCode.js";
import { ApiRequestError } from "../../../lib/util/api.js";
import type { KeyVault, MasterKeyWrap } from "../../../lib/crypto/keyvaultApi.js";
import { deriveFromPassword } from "../../../lib/crypto/passwordUnlock.js";
import { decryptEnvelopedData } from "../../../lib/crypto/smime.js";

const { getKeyVault, addMasterKeyWrap, removeMasterKeyWrap } = vi.hoisted(() => ({
    getKeyVault: vi.fn(),
    addMasterKeyWrap: vi.fn(),
    removeMasterKeyWrap: vi.fn(),
}));
vi.mock("../../../lib/crypto/keyvaultApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/crypto/keyvaultApi.js")>()),
    getKeyVault,
    addMasterKeyWrap,
    removeMasterKeyWrap,
}));

afterEach(() => {
    vi.resetAllMocks();
});

x509.cryptoProvider.set(crypto);

const MAILBOX_UID = "mb1";
// Argon2id is intentionally slow (memory-hard) - use lighter parameters than the real default so this
// suite stays fast, while still exercising the real hash-wasm computation end to end (same convention
// as passwordUnlock.test.ts).
const FAST_PARAMS = { memorySize: 8, iterations: 1, parallelism: 1 };

describe("buildPasswordWrap", () => {
    it("produces a wrap that unwraps back to the same MK with the same password", async () => {
        const mk = generateMasterKey();
        const wrap = await buildPasswordWrap(MAILBOX_UID, mk, "a good password", FAST_PARAMS);

        const { wrappingKey } = await deriveFromPassword("a good password", fromBase64(wrap.salt), FAST_PARAMS);
        const opened = await openWithKey(wrappingKey, { ciphertext: wrap.ciphertext, nonce: wrap.nonce }, buildAad(MAILBOX_UID, MASTER_KEY_AAD_PURPOSE));
        expect(opened).toEqual(mk);
    });

    it("fails to unwrap with the wrong password", async () => {
        const mk = generateMasterKey();
        const wrap = await buildPasswordWrap(MAILBOX_UID, mk, "a good password", FAST_PARAMS);

        const { wrappingKey } = await deriveFromPassword("the wrong password", fromBase64(wrap.salt), FAST_PARAMS);
        await expect(
            openWithKey(wrappingKey, { ciphertext: wrap.ciphertext, nonce: wrap.nonce }, buildAad(MAILBOX_UID, MASTER_KEY_AAD_PURPOSE)),
        ).rejects.toThrow();
    });

    it("uses a fresh random salt each call", async () => {
        const mk = generateMasterKey();
        const a = await buildPasswordWrap(MAILBOX_UID, mk, "same password", FAST_PARAMS);
        const b = await buildPasswordWrap(MAILBOX_UID, mk, "same password", FAST_PARAMS);
        expect(a.salt).not.toBe(b.salt);
    });

    it("defaults to this module's recommended Argon2id parameters when none are given", async () => {
        const mk = generateMasterKey();
        const wrap = await buildPasswordWrap(MAILBOX_UID, mk, "a good password");
        expect(wrap.kdf).toBe("argon2id:m=65536,t=3,p=4");
    });
});

describe("buildRecoveryWraps", () => {
    it("defaults to 8 distinct codes, each unwrapping back to the same MK", async () => {
        const mk = generateMasterKey();
        const { wraps, codes } = await buildRecoveryWraps(MAILBOX_UID, mk);

        expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
        expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
        expect(wraps).toHaveLength(RECOVERY_CODE_COUNT);

        for (let i = 0; i < wraps.length; i++) {
            const wrappingKey = await deriveFromRecoveryCode(codes[i], fromBase64(wraps[i].salt));
            const opened = await openWithKey(
                wrappingKey,
                { ciphertext: wraps[i].ciphertext, nonce: wraps[i].nonce },
                buildAad(MAILBOX_UID, MASTER_KEY_AAD_PURPOSE),
            );
            expect(opened).toEqual(mk);
        }
    });

    it("assigns sequence-based methodIds, not derived from the code itself", async () => {
        const mk = generateMasterKey();
        const { wraps } = await buildRecoveryWraps(MAILBOX_UID, mk, 3);
        expect(wraps.map((w) => w.methodId)).toEqual(["recovery-1", "recovery-2", "recovery-3"]);
    });

    it("respects a custom count", async () => {
        const mk = generateMasterKey();
        const { wraps, codes } = await buildRecoveryWraps(MAILBOX_UID, mk, 2);
        expect(wraps).toHaveLength(2);
        expect(codes).toHaveLength(2);
    });
});

async function generateEscrowScopeIdentity(): Promise<{ certDer: Uint8Array; privateKey: CryptoKey }> {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]));
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "01",
        name: "CN=Escrow Scope",
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 86_400_000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys,
    });
    // Same re-import-under-ECDH technique smime.test.ts's own generateTestIdentity() uses for its
    // "encrypt" identities - a holder's own offline tooling would do the same to unwrap this.
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    return { certDer: new Uint8Array(cert.rawData), privateKey };
}

describe("buildEscrowWrap", () => {
    it("produces a wrap a holder can unwrap back to the same MK using the scope's own certificate/private key", async () => {
        const mk = generateMasterKey();
        const scope = await generateEscrowScopeIdentity();

        const wrap = await buildEscrowWrap(mk, "scope-1", scope.certDer);

        expect(wrap.method).toBe("escrow");
        expect(wrap.escrowScopeId).toBe("scope-1");
        expect(wrap.kdf).toBe(ESCROW_KDF_LABEL);

        const opened = await decryptEnvelopedData(fromBase64(wrap.ciphertext), scope.certDer, scope.privateKey);
        expect(opened).toEqual(mk);
    });

    it("cannot be unwrapped with a different scope's certificate/private key", async () => {
        const mk = generateMasterKey();
        const scope = await generateEscrowScopeIdentity();
        const otherScope = await generateEscrowScopeIdentity();

        const wrap = await buildEscrowWrap(mk, "scope-1", scope.certDer);

        await expect(decryptEnvelopedData(fromBase64(wrap.ciphertext), otherScope.certDer, otherScope.privateKey)).rejects.toThrow();
    });
});

describe("RECOVERY_KDF_LABEL", () => {
    it("is re-exported unchanged from recoveryCode.ts", () => {
        expect(RECOVERY_KDF_LABEL).toBe("hkdf-sha256");
        expect(RECOVERY_KDF_LABEL).toBe(RECOVERY_KDF_LABEL_SOURCE);
    });
});

describe("consumeRecoveryCode", () => {
    it("removes exactly the used recovery wrap by methodId", async () => {
        const vault: KeyVault = { wrappedKeys: [], masterKeyWraps: [], masterKeyGeneration: 0 };
        removeMasterKeyWrap.mockResolvedValue(vault);
        await expect(consumeRecoveryCode(MAILBOX_UID, "recovery-3")).resolves.toBe(vault);
        expect(removeMasterKeyWrap).toHaveBeenCalledWith(MAILBOX_UID, "recovery", "recovery-3");
    });

    it("refuses without a request when methodId is empty", async () => {
        await expect(consumeRecoveryCode(MAILBOX_UID, "")).rejects.toThrow(/methodId is required/);
        expect(removeMasterKeyWrap).not.toHaveBeenCalled();
    });

    it("surfaces restapi's last-own-wrap 409 unchanged", async () => {
        const conflict = new ApiRequestError("This is the mailbox's last master key wrap", 409);
        removeMasterKeyWrap.mockRejectedValue(conflict);
        await expect(consumeRecoveryCode(MAILBOX_UID, "recovery-1")).rejects.toBe(conflict);
    });
});

describe("replacePasswordWrap", () => {
    const stub = (method: MasterKeyWrap["method"], extra: Partial<MasterKeyWrap> = {}): MasterKeyWrap => ({
        method,
        ciphertext: `${method}-c`,
        nonce: "n",
        salt: "s",
        kdf: "k",
        schemeVersion: 1,
        createdAt: 1,
        ...extra,
    });
    const oldPassword = stub("password");
    /** No default generation: an omitted (or `undefined`) one is a vault from a server that doesn't report it. */
    const vaultWith = (wraps: MasterKeyWrap[], masterKeyGeneration?: number): KeyVault => ({
        wrappedKeys: [],
        masterKeyWraps: wraps,
        ...(masterKeyGeneration !== undefined ? { masterKeyGeneration } : {}),
    });

    async function expectOpensWith(wrap: MasterKeyWrap, password: string, mk: Uint8Array): Promise<void> {
        const { wrappingKey } = await deriveFromPassword(password, fromBase64(wrap.salt), FAST_PARAMS);
        const opened = await openWithKey(wrappingKey, { ciphertext: wrap.ciphertext, nonce: wrap.nonce }, buildAad(MAILBOX_UID, MASTER_KEY_AAD_PURPOSE));
        expect(opened).toEqual(mk);
    }

    it("removes the old password wrap, then adds a new one of the session master key with the expected generation", async () => {
        const mk = generateMasterKey();
        const order: string[] = [];
        getKeyVault.mockResolvedValue(vaultWith([oldPassword, stub("recovery", { methodId: "recovery-2" }), stub("escrow", { escrowScopeId: "s1" })], 4));
        removeMasterKeyWrap.mockImplementation(async () => {
            order.push("remove");
            return vaultWith([]);
        });
        const finalVault = vaultWith([stub("recovery")]);
        addMasterKeyWrap.mockImplementation(async () => {
            order.push("add");
            return finalVault;
        });

        await expect(replacePasswordWrap(MAILBOX_UID, { masterKey: mk }, "new password", 4, FAST_PARAMS)).resolves.toBe(finalVault);

        expect(order).toEqual(["remove", "add"]);
        expect(removeMasterKeyWrap).toHaveBeenCalledWith(MAILBOX_UID, "password");
        const [uid, newWrap, generation] = addMasterKeyWrap.mock.calls[0] as [string, MasterKeyWrap, number];
        expect(uid).toBe(MAILBOX_UID);
        expect(generation).toBe(4);
        expect(newWrap).toMatchObject({ method: "password", kdf: "argon2id:m=8,t=1,p=1" });
        expect(newWrap).not.toHaveProperty("methodId");
        await expectOpensWith(newWrap, "new password", mk);
    });

    it("omits the generation when the caller doesn't pass one, and just adds when there is no password wrap yet", async () => {
        const mk = generateMasterKey();
        getKeyVault.mockResolvedValue(vaultWith([stub("passkey", { methodId: "cred-1" })], undefined));
        addMasterKeyWrap.mockResolvedValue(vaultWith([]));

        await replacePasswordWrap(MAILBOX_UID, { masterKey: mk }, "pw", undefined, FAST_PARAMS);

        expect(removeMasterKeyWrap).not.toHaveBeenCalled();
        expect(addMasterKeyWrap).toHaveBeenCalledWith(MAILBOX_UID, expect.objectContaining({ method: "password" }), undefined);
    });

    it.each<[string, KeyVault, number | undefined, string]>([
        ["the password is the only own wrap (escrow doesn't count)", vaultWith([oldPassword, stub("escrow", { escrowScopeId: "s1" })]), undefined, "no_other_unlock_method"],
        ["the password is the vault's only wrap", vaultWith([oldPassword], 4), 4, "no_other_unlock_method"],
        ["the vault holds two password wraps", vaultWith([oldPassword, stub("password"), stub("recovery")]), undefined, "multiple_password_wraps"],
        ["the master key generation moved on", vaultWith([oldPassword, stub("recovery")], 5), 4, "master_key_rotated"],
        ["the server reports no generation but one was expected", vaultWith([oldPassword, stub("recovery")], undefined), 3, "master_key_rotated"],
    ])("refuses without writing when %s", async (_label, vault, expected, reason) => {
        getKeyVault.mockResolvedValue(vault);
        const err = await replacePasswordWrap(MAILBOX_UID, { masterKey: generateMasterKey() }, "pw", expected, FAST_PARAMS).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PasswordWrapReplaceError);
        expect(err).toMatchObject({ name: "PasswordWrapReplaceError", reason });
        expect((err as PasswordWrapReplaceError).restored).toBeUndefined();
        expect(removeMasterKeyWrap).not.toHaveBeenCalled();
        expect(addMasterKeyWrap).not.toHaveBeenCalled();
    });

    it("throws KeysLockedError without any request for destroyed keys, or keys destroyed while reading the vault", async () => {
        const destroyed = { masterKey: new Uint8Array(32), destroyed: true };
        await expect(replacePasswordWrap(MAILBOX_UID, destroyed, "pw", undefined, FAST_PARAMS)).rejects.toBeInstanceOf(KeysLockedError);
        expect(getKeyVault).not.toHaveBeenCalled();

        const zeroed = { masterKey: new Uint8Array(32) };
        await expect(replacePasswordWrap(MAILBOX_UID, zeroed, "pw", undefined, FAST_PARAMS)).rejects.toBeInstanceOf(KeysLockedError);
        expect(getKeyVault).not.toHaveBeenCalled();

        const live: { masterKey: Uint8Array; destroyed?: boolean } = { masterKey: generateMasterKey() };
        getKeyVault.mockImplementation(async () => {
            live.destroyed = true;
            return vaultWith([oldPassword, stub("recovery")]);
        });
        await expect(replacePasswordWrap(MAILBOX_UID, live, "pw", undefined, FAST_PARAMS)).rejects.toBeInstanceOf(KeysLockedError);
        expect(removeMasterKeyWrap).not.toHaveBeenCalled();
        expect(addMasterKeyWrap).not.toHaveBeenCalled();
    });

    it("rethrows a failed remove as-is, never adding", async () => {
        getKeyVault.mockResolvedValue(vaultWith([oldPassword, stub("recovery")], 4));
        const failure = new ApiRequestError("gone", 404);
        removeMasterKeyWrap.mockRejectedValue(failure);
        await expect(replacePasswordWrap(MAILBOX_UID, { masterKey: generateMasterKey() }, "pw", 4, FAST_PARAMS)).rejects.toBe(failure);
        expect(addMasterKeyWrap).not.toHaveBeenCalled();
    });

    it("re-adds the removed wrap (only its own fields, with the generation read) when the add fails", async () => {
        const serverShaped = { ...oldPassword, _id: "db-internal" } as MasterKeyWrap;
        getKeyVault.mockResolvedValue(vaultWith([serverShaped, stub("recovery")], 4));
        removeMasterKeyWrap.mockResolvedValue(vaultWith([stub("recovery")]));
        const rotated = new ApiRequestError("rotated", 409);
        addMasterKeyWrap.mockRejectedValueOnce(rotated).mockResolvedValueOnce(vaultWith([]));

        const err = await replacePasswordWrap(MAILBOX_UID, { masterKey: generateMasterKey() }, "pw", undefined, FAST_PARAMS).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(PasswordWrapReplaceError);
        expect(err).toMatchObject({ reason: "add_failed", restored: true, cause: rotated });
        expect(addMasterKeyWrap).toHaveBeenCalledTimes(2);
        expect(addMasterKeyWrap.mock.calls[1]).toEqual([MAILBOX_UID, oldPassword, 4]);
    });

    it("reports restored: false when putting the old wrap back fails too", async () => {
        const withIds = stub("password", { methodId: "legacy", escrowScopeId: "odd" });
        getKeyVault.mockResolvedValue(vaultWith([withIds, stub("passkey")], undefined));
        removeMasterKeyWrap.mockResolvedValue(vaultWith([]));
        const addFailure = new TypeError("network down");
        addMasterKeyWrap.mockRejectedValue(addFailure);

        const err = await replacePasswordWrap(MAILBOX_UID, { masterKey: generateMasterKey() }, "pw", 0, FAST_PARAMS).catch((e: unknown) => e);

        expect(err).toMatchObject({ reason: "add_failed", restored: false, cause: addFailure });
        expect(addMasterKeyWrap.mock.calls[1]).toEqual([MAILBOX_UID, withIds, undefined]);
    });

    it("rethrows a failed add as-is when there was no old wrap to restore", async () => {
        getKeyVault.mockResolvedValue(vaultWith([stub("recovery")]));
        const failure = new ApiRequestError("too many wraps", 400);
        addMasterKeyWrap.mockRejectedValue(failure);
        await expect(replacePasswordWrap(MAILBOX_UID, { masterKey: generateMasterKey() }, "pw", undefined, FAST_PARAMS)).rejects.toBe(failure);
        expect(addMasterKeyWrap).toHaveBeenCalledTimes(1);
    });

    it("defaults to the recommended Argon2id parameters", async () => {
        getKeyVault.mockResolvedValue(vaultWith([]));
        addMasterKeyWrap.mockResolvedValue(vaultWith([]));
        await replacePasswordWrap(MAILBOX_UID, { masterKey: generateMasterKey() }, "pw");
        expect((addMasterKeyWrap.mock.calls[0] as [string, MasterKeyWrap])[1].kdf).toBe("argon2id:m=65536,t=3,p=4");
    });
});
