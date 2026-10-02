// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { toBase64 } from "../../../lib/crypto/encoding.js";
import { generateKeyPairWithCsr, exportPrivateKeyPkcs8 } from "../../../lib/crypto/keys.js";
import {
    type KeySessionEvent,
    ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE,
    KeysLockedError,
    MASTER_KEY_AAD_PURPOSE,
    SIGNING_PRIVATE_KEY_AAD_PURPOSE,
    UnopenableEncryptionKeyError,
    destroyUnlockedKeys,
    getUnlockedKeys,
    subscribeKeySession,
    unlockWithPassword,
    unlockWithRecoveryCode,
} from "../../../lib/crypto/keySession.js";
import { buildRecoveryWraps } from "../../../lib/crypto/masterKeyWraps.js";
import { buildAad, generateMasterKey, openWithKey, sealWithKey } from "../../../lib/crypto/masterKey.js";
import { argon2idKdfLabel, deriveFromPassword, generateSalt } from "../../../lib/crypto/passwordUnlock.js";
import type { KeyVault, MasterKeyWrap, PublicKey } from "../../../lib/crypto/keyvaultApi.js";

const { getKeyVault } = vi.hoisted(() => ({ getKeyVault: vi.fn() }));
vi.mock("../../../lib/crypto/keyvaultApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/crypto/keyvaultApi.js")>()),
    getKeyVault,
}));

const FAST_PARAMS = { memorySize: 8, iterations: 1, parallelism: 1 };
const MAILBOX_UID = "mb1";
const PASSWORD = "a fine password";

/** Builds a real KeyVault + Mailbox.keys pair the way KeyEnrollmentGate's own enrollment flow does,
 * so this test proves unlockWithPassword() is genuinely compatible with what enrollment produces —
 * not just internally self-consistent with its own assumptions about wrap format. */
async function enrollForTest(
    useTypes: ("sign" | "encrypt")[],
    mailboxUid: string = MAILBOX_UID,
): Promise<{ vault: KeyVault; mailboxKeys: PublicKey[]; mk: Uint8Array }> {
    const mk = generateMasterKey();
    const mkAad = buildAad(mailboxUid, MASTER_KEY_AAD_PURPOSE);
    const salt = generateSalt();
    const { wrappingKey } = await deriveFromPassword(PASSWORD, salt, FAST_PARAMS);
    const sealed = await sealWithKey(wrappingKey, mk, mkAad);
    const passwordWrap: MasterKeyWrap = {
        method: "password",
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        salt: toBase64(salt),
        kdf: argon2idKdfLabel(FAST_PARAMS),
        schemeVersion: 1,
        createdAt: Date.now(),
    };

    const mailboxKeys: PublicKey[] = [];
    const wrappedKeys: KeyVault["wrappedKeys"] = [];
    for (const useType of useTypes) {
        const { keyPair } = await generateKeyPairWithCsr("alice@example.com", useType);
        const privateRaw = await exportPrivateKeyPkcs8(keyPair.privateKey);
        const purpose = useType === "sign" ? SIGNING_PRIVATE_KEY_AAD_PURPOSE : ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE;
        const sealedPriv = await sealWithKey(mk, privateRaw, buildAad(mailboxUid, purpose));
        const fingerprint = `fp-${useType}`;
        mailboxKeys.push({
            publicKey: toBase64(new Uint8Array([1, 2, 3])), // placeholder DER - not exercised by unlock itself
            type: "x509",
            useType,
            fingerprint,
            notBefore: Date.now() - 1000,
            notAfter: Date.now() + 1_000_000,
        });
        wrappedKeys.push({ ciphertext: sealedPriv.ciphertext, nonce: sealedPriv.nonce, algorithm: "AES-256-GCM", fingerprint, useType });
    }

    return { vault: { wrappedKeys, masterKeyWraps: [passwordWrap] }, mailboxKeys, mk };
}

afterEach(() => {
    destroyUnlockedKeys();
    vi.clearAllMocks();
});

describe("unlockWithPassword", () => {
    it("unlocks the master key and the encryption private key for a real (encrypt-only) enrollment", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["encrypt"]);
        getKeyVault.mockResolvedValue(vault);

        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);

        const unlocked = getUnlockedKeys(MAILBOX_UID);
        expect(unlocked).toBeDefined();
        expect(unlocked!.masterKey.length).toBe(32);
        expect(unlocked!.encryptionPrivateKey).toBeDefined();
        expect(unlocked!.encryptionPrivateKey!.algorithm.name).toBe("ECDH");
        expect(unlocked!.encryptionFingerprint).toBe("fp-encrypt");
        expect(unlocked!.signingPrivateKey).toBeUndefined();
    });

    it("also unlocks a signing key when one is enrolled", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["sign", "encrypt"]);
        getKeyVault.mockResolvedValue(vault);

        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);

        const unlocked = getUnlockedKeys(MAILBOX_UID)!;
        expect(unlocked.signingPrivateKey).toBeDefined();
        expect(unlocked.signingPrivateKey!.algorithm.name).toBe("ECDSA");
        expect(unlocked.signingFingerprint).toBe("fp-sign");
        expect(unlocked.encryptionPrivateKey).toBeDefined();
    });

    it("throws when no password wrap is enrolled", async () => {
        const { vault } = await enrollForTest(["encrypt"]);
        getKeyVault.mockResolvedValue({ ...vault, masterKeyWraps: [] });

        await expect(unlockWithPassword(MAILBOX_UID, [], PASSWORD)).rejects.toThrow(/no password unlock method/i);
    });

    it("throws with the wrong password (AEAD authentication failure)", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["encrypt"]);
        getKeyVault.mockResolvedValue(vault);

        await expect(unlockWithPassword(MAILBOX_UID, mailboxKeys, "the wrong password")).rejects.toThrow();
        expect(getUnlockedKeys(MAILBOX_UID)).toBeUndefined();
    });

    it("throws for an unrecognized KDF label on the password wrap", async () => {
        const { vault } = await enrollForTest(["encrypt"]);
        const corrupted = { ...vault, masterKeyWraps: [{ ...vault.masterKeyWraps[0], kdf: "some-future-kdf" }] };
        getKeyVault.mockResolvedValue(corrupted);

        await expect(unlockWithPassword(MAILBOX_UID, [], PASSWORD)).rejects.toThrow(/unrecognized kdf/i);
    });

    it("refuses, with a clean error and before deriving anything, a password wrap whose KDF cost is unreasonable", async () => {
        const { vault } = await enrollForTest(["encrypt"]);
        const hostile = { ...vault, masterKeyWraps: [{ ...vault.masterKeyWraps[0], kdf: "argon2id:m=4294967295,t=999,p=4" }] };
        getKeyVault.mockResolvedValue(hostile);

        await expect(unlockWithPassword(MAILBOX_UID, [], PASSWORD)).rejects.toThrow(/unrecognized kdf/i);
    });

    it("skips a public key with no matching wrapped private key, rather than throwing", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["encrypt"]);
        // A published key with no corresponding vault entry - e.g. published by a different device
        // this one hasn't synced with yet.
        const orphanKey: PublicKey = { ...mailboxKeys[0], fingerprint: "fp-orphan" };
        getKeyVault.mockResolvedValue(vault);

        await unlockWithPassword(MAILBOX_UID, [orphanKey], PASSWORD);
        const unlocked = getUnlockedKeys(MAILBOX_UID)!;
        expect(unlocked.encryptionPrivateKey).toBeUndefined();
        expect(unlocked.masterKey.length).toBe(32);
    });

    it("prefers the most recently issued active key when a mailbox has more than one of the same useType", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["encrypt"]);
        const older: PublicKey = { ...mailboxKeys[0], fingerprint: "fp-older", notBefore: Date.now() - 100_000 };
        getKeyVault.mockResolvedValue(vault);

        await unlockWithPassword(MAILBOX_UID, [older, mailboxKeys[0]], PASSWORD);
        expect(getUnlockedKeys(MAILBOX_UID)!.encryptionFingerprint).toBe("fp-encrypt");
    });

    it("ignores a revoked key even if it would otherwise be the most recent", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["encrypt"]);
        const revoked: PublicKey = { ...mailboxKeys[0], fingerprint: "fp-revoked", notBefore: Date.now(), revokedAt: Date.now() };
        getKeyVault.mockResolvedValue(vault);

        await unlockWithPassword(MAILBOX_UID, [revoked, mailboxKeys[0]], PASSWORD);
        expect(getUnlockedKeys(MAILBOX_UID)!.encryptionFingerprint).toBe("fp-encrypt");
    });

    it("ignores an expired key", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["encrypt"]);
        const expired: PublicKey = { ...mailboxKeys[0], fingerprint: "fp-expired", notBefore: Date.now(), notAfter: Date.now() - 1000 };
        getKeyVault.mockResolvedValue(vault);

        await unlockWithPassword(MAILBOX_UID, [expired, mailboxKeys[0]], PASSWORD);
        expect(getUnlockedKeys(MAILBOX_UID)!.encryptionFingerprint).toBe("fp-encrypt");
    });
});

describe("getUnlockedKeys / destroyUnlockedKeys", () => {
    it("returns undefined for a mailbox that was never unlocked", () => {
        expect(getUnlockedKeys("never-unlocked")).toBeUndefined();
    });

    it("destroys just one mailbox's keys when called with an argument", async () => {
        const a = await enrollForTest(["encrypt"], "mb-a");
        const b = await enrollForTest(["encrypt"], "mb1");
        getKeyVault.mockImplementation((mailboxUid: string) => Promise.resolve(mailboxUid === "mb-a" ? a.vault : b.vault));
        await unlockWithPassword("mb-a", a.mailboxKeys, PASSWORD);
        await unlockWithPassword("mb1", b.mailboxKeys, PASSWORD);

        destroyUnlockedKeys("mb-a");
        expect(getUnlockedKeys("mb-a")).toBeUndefined();
        expect(getUnlockedKeys("mb1")).toBeDefined();
    });

    it("destroys every mailbox's keys when called with no argument", async () => {
        const a = await enrollForTest(["encrypt"], "mb-a");
        const b = await enrollForTest(["encrypt"], "mb1");
        getKeyVault.mockImplementation((mailboxUid: string) => Promise.resolve(mailboxUid === "mb-a" ? a.vault : b.vault));
        await unlockWithPassword("mb-a", a.mailboxKeys, PASSWORD);
        await unlockWithPassword("mb1", b.mailboxKeys, PASSWORD);

        destroyUnlockedKeys();
        expect(getUnlockedKeys("mb-a")).toBeUndefined();
        expect(getUnlockedKeys("mb1")).toBeUndefined();
    });

    it("zeroes the master key bytes in place when keys are destroyed", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["encrypt"]);
        getKeyVault.mockResolvedValue(vault);
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        const held = getUnlockedKeys(MAILBOX_UID)!;
        expect(held.masterKey.some((b) => b !== 0)).toBe(true);

        destroyUnlockedKeys(MAILBOX_UID);
        expect(held.masterKey.length).toBe(32);
        expect(held.masterKey.every((b) => b === 0)).toBe(true);
    });

    it("zeroes every mailbox's master key on a destroy-all", async () => {
        const a = await enrollForTest(["encrypt"], "mb-a");
        const b = await enrollForTest(["encrypt"], "mb1");
        getKeyVault.mockImplementation((mailboxUid: string) => Promise.resolve(mailboxUid === "mb-a" ? a.vault : b.vault));
        await unlockWithPassword("mb-a", a.mailboxKeys, PASSWORD);
        await unlockWithPassword("mb1", b.mailboxKeys, PASSWORD);
        const heldA = getUnlockedKeys("mb-a")!;
        const heldB = getUnlockedKeys("mb1")!;

        destroyUnlockedKeys();
        expect(heldA.masterKey.every((x) => x === 0)).toBe(true);
        expect(heldB.masterKey.every((x) => x === 0)).toBe(true);
    });

    // Round-4 review: a stale `UnlockedKeys` holder kept sealing/opening under the zeroed master key with no
    // error (AES-GCM accepts any 32 bytes), and kept using the private keys after a lock.
    it("marks a destroyed UnlockedKeys object, drops its private keys, and makes its master key throw KeysLockedError", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["sign", "encrypt"]);
        getKeyVault.mockResolvedValue(vault);
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        const held = getUnlockedKeys(MAILBOX_UID)!;
        expect(held.destroyed).toBeUndefined();
        const sealed = await sealWithKey(held.masterKey, new Uint8Array([1, 2, 3]), buildAad(MAILBOX_UID, "test"));

        destroyUnlockedKeys(MAILBOX_UID);

        expect(held.destroyed).toBe(true);
        expect(held.signingPrivateKey).toBeUndefined();
        expect(held.encryptionPrivateKey).toBeUndefined();
        await expect(sealWithKey(held.masterKey, new Uint8Array([1]), buildAad(MAILBOX_UID, "test"))).rejects.toBeInstanceOf(KeysLockedError);
        await expect(openWithKey(held.masterKey, sealed, buildAad(MAILBOX_UID, "test"))).rejects.toMatchObject({ name: "KeysLockedError" });
    });

    it("does not zero the previous master key when a re-unlock replaces a session", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["encrypt"]);
        getKeyVault.mockResolvedValue(vault);
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        const first = getUnlockedKeys(MAILBOX_UID)!;
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);

        expect(getUnlockedKeys(MAILBOX_UID)).not.toBe(first);
        expect(first.masterKey.some((x) => x !== 0)).toBe(true);
    });

    it("imports the active unlocked private keys non-extractable, like the retained ones", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["sign", "encrypt"]);
        getKeyVault.mockResolvedValue(vault);
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        const unlocked = getUnlockedKeys(MAILBOX_UID)!;
        expect(unlocked.signingPrivateKey!.extractable).toBe(false);
        expect(unlocked.encryptionPrivateKey!.extractable).toBe(false);
    });

    it("refuses to export the active unlocked private keys' raw bytes", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["sign", "encrypt"]);
        getKeyVault.mockResolvedValue(vault);
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        const unlocked = getUnlockedKeys(MAILBOX_UID)!;
        await expect(crypto.subtle.exportKey("pkcs8", unlocked.signingPrivateKey!)).rejects.toThrow();
        await expect(crypto.subtle.exportKey("pkcs8", unlocked.encryptionPrivateKey!)).rejects.toThrow();
    });

    it("zeroes the unwrapped master key when unwrapping a private key fails partway", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["encrypt"]);
        // A private-key wrap sealed under the right AAD but garbage ciphertext - the master key itself
        // opens fine, then the private key's AEAD check fails.
        const corrupted: KeyVault = {
            ...vault,
            wrappedKeys: [{ ...vault.wrappedKeys[0], ciphertext: toBase64(new Uint8Array(64)) }],
        };
        getKeyVault.mockResolvedValue(corrupted);
        const fills = vi.spyOn(Uint8Array.prototype, "fill");

        await expect(unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD)).rejects.toThrow();
        expect(getUnlockedKeys(MAILBOX_UID)).toBeUndefined();
        const zeroFills = fills.mock.calls
            .map((args, i) => ({ value: args[0], target: fills.mock.contexts[i] as Uint8Array }))
            .filter(({ value, target }) => value === 0 && target.length === 32);
        expect(zeroFills.length).toBe(1);
        expect(zeroFills[0].target.every((x) => x === 0)).toBe(true);
        fills.mockRestore();
    });
});

describe("subscribeKeySession", () => {
    it("notifies on unlock and on destroy, with the mailbox and new state", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["encrypt"]);
        getKeyVault.mockResolvedValue(vault);
        const listener = vi.fn();
        const unsubscribe = subscribeKeySession(listener);

        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        expect(listener).toHaveBeenLastCalledWith({ mailboxUid: MAILBOX_UID, state: "unlocked" } satisfies KeySessionEvent);

        destroyUnlockedKeys(MAILBOX_UID);
        expect(listener).toHaveBeenLastCalledWith({ mailboxUid: MAILBOX_UID, state: "locked" });
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
    });

    it("fires one locked event per mailbox on destroy-all, and nothing when there was nothing to destroy", async () => {
        const a = await enrollForTest(["encrypt"], "mb-a");
        const b = await enrollForTest(["encrypt"], "mb1");
        getKeyVault.mockImplementation((mailboxUid: string) => Promise.resolve(mailboxUid === "mb-a" ? a.vault : b.vault));
        await unlockWithPassword("mb-a", a.mailboxKeys, PASSWORD);
        await unlockWithPassword("mb1", b.mailboxKeys, PASSWORD);

        const listener = vi.fn();
        const unsubscribe = subscribeKeySession(listener);
        destroyUnlockedKeys();
        expect(listener.mock.calls.map(([e]) => e)).toEqual([
            { mailboxUid: "mb-a", state: "locked" },
            { mailboxUid: "mb1", state: "locked" },
        ]);

        listener.mockClear();
        destroyUnlockedKeys();
        destroyUnlockedKeys("never-unlocked");
        expect(listener).not.toHaveBeenCalled();
        unsubscribe();
    });

    it("does not notify on a failed unlock", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["encrypt"]);
        getKeyVault.mockResolvedValue(vault);
        const listener = vi.fn();
        const unsubscribe = subscribeKeySession(listener);

        await expect(unlockWithPassword(MAILBOX_UID, mailboxKeys, "the wrong password")).rejects.toThrow();
        expect(listener).not.toHaveBeenCalled();
        unsubscribe();
    });

    it("stops notifying after unsubscribe, and accepts a zero-argument listener", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["encrypt"]);
        getKeyVault.mockResolvedValue(vault);
        let calls = 0;
        const unsubscribe = subscribeKeySession(() => {
            calls++;
        });
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        expect(calls).toBe(1);

        unsubscribe();
        destroyUnlockedKeys();
        expect(calls).toBe(1);
    });

    it("still delivers to every listener when one throws, surfacing the error asynchronously", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["encrypt"]);
        getKeyVault.mockResolvedValue(vault);
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);

        const boom = new Error("listener failed");
        const rethrown: unknown[] = [];
        const microtaskSpy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((cb) => {
            try {
                cb();
            } catch (err) {
                rethrown.push(err);
            }
        });
        const second = vi.fn();
        const unsubA = subscribeKeySession(() => {
            throw boom;
        });
        const unsubB = subscribeKeySession(second);

        destroyUnlockedKeys(MAILBOX_UID);
        expect(second).toHaveBeenCalledWith({ mailboxUid: MAILBOX_UID, state: "locked" });
        expect(getUnlockedKeys(MAILBOX_UID)).toBeUndefined();
        expect(rethrown).toEqual([boom]);

        microtaskSpy.mockRestore();
        unsubA();
        unsubB();
    });
});

// Round-5 review: lockout support, stale objects surviving a lock, and an in-flight unlock restoring keys.
describe("unlockWithPassword - round 5", () => {
    function corruptWrap(vault: KeyVault, useType: "sign" | "encrypt"): KeyVault {
        return {
            ...vault,
            wrappedKeys: vault.wrappedKeys.map((k) => (k.useType === useType ? { ...k, ciphertext: toBase64(new Uint8Array(64)) } : k)),
        };
    }

    it("still unlocks when the signing key won't open, reporting it in unopenableKeys", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["sign", "encrypt"]);
        getKeyVault.mockResolvedValue(corruptWrap(vault, "sign"));

        const result = await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);

        expect(result).toEqual({ unopenableKeys: ["fp-sign"] });
        const unlocked = getUnlockedKeys(MAILBOX_UID)!;
        expect(unlocked.signingPrivateKey).toBeUndefined();
        expect(unlocked.signingFingerprint).toBeUndefined();
        expect(unlocked.encryptionPrivateKey).toBeDefined();
    });

    it("skips a signing key whose wrap opens but isn't a valid PKCS#8 key", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["sign", "encrypt"]);
        const unlockedVault = await (async () => {
            // Re-seal garbage bytes under the real master key by unlocking once to recover it.
            getKeyVault.mockResolvedValue(vault);
            await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
            const mk = new Uint8Array(getUnlockedKeys(MAILBOX_UID)!.masterKey);
            destroyUnlockedKeys();
            const sealed = await sealWithKey(mk, new Uint8Array([9, 9, 9]), buildAad(MAILBOX_UID, SIGNING_PRIVATE_KEY_AAD_PURPOSE));
            return { ...vault, wrappedKeys: vault.wrappedKeys.map((k) => (k.useType === "sign" ? { ...k, ...sealed } : k)) };
        })();
        getKeyVault.mockResolvedValue(unlockedVault);

        await expect(unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD)).resolves.toEqual({ unopenableKeys: ["fp-sign"] });
    });

    it("returns an empty unopenableKeys when everything opens", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["sign", "encrypt"]);
        getKeyVault.mockResolvedValue(vault);
        await expect(unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD)).resolves.toEqual({ unopenableKeys: [] });
    });

    it("fails with UnopenableEncryptionKeyError (not a wrong-password error) when the encryption key won't open", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["sign", "encrypt"]);
        getKeyVault.mockResolvedValue(corruptWrap(vault, "encrypt"));

        const err = await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UnopenableEncryptionKeyError);
        expect((err as UnopenableEncryptionKeyError).fingerprint).toBe("fp-encrypt");
        expect((err as UnopenableEncryptionKeyError).cause).toBeDefined();
        expect(getUnlockedKeys(MAILBOX_UID)).toBeUndefined();

        const wrong = await unlockWithPassword(MAILBOX_UID, mailboxKeys, "the wrong password").catch((e: unknown) => e);
        expect(wrong).not.toBeInstanceOf(UnopenableEncryptionKeyError);
    });

    it("destroys every object handed out for a mailbox, including ones a re-unlock replaced", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["sign", "encrypt"]);
        getKeyVault.mockResolvedValue(vault);
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        const first = getUnlockedKeys(MAILBOX_UID)!;
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        const second = getUnlockedKeys(MAILBOX_UID)!;
        const listener = vi.fn();
        const unsubscribe = subscribeKeySession(listener);

        destroyUnlockedKeys(MAILBOX_UID);

        for (const held of [first, second]) {
            expect(held.destroyed).toBe(true);
            expect(held.masterKey.every((b) => b === 0)).toBe(true);
            expect(held.signingPrivateKey).toBeUndefined();
            expect(held.encryptionPrivateKey).toBeUndefined();
        }
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
    });

    it.each([
        ["this mailbox", () => destroyUnlockedKeys(MAILBOX_UID)],
        ["every mailbox", () => destroyUnlockedKeys()],
    ])("throws KeysLockedError and zeroes the master key when %s is locked mid-unlock", async (_label, lock) => {
        const { vault, mailboxKeys } = await enrollForTest(["sign", "encrypt"]);
        let release!: () => void;
        getKeyVault.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = () => resolve(vault);
                }),
        );
        const fills = vi.spyOn(Uint8Array.prototype, "fill");
        const pending = unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        await Promise.resolve();
        lock();
        release();

        await expect(pending).rejects.toBeInstanceOf(KeysLockedError);
        expect(getUnlockedKeys(MAILBOX_UID)).toBeUndefined();
        const zeroed = fills.mock.contexts.filter((target, i) => fills.mock.calls[i][0] === 0 && (target as Uint8Array).length === 32);
        expect(zeroed.length).toBe(1);
        expect((zeroed[0] as Uint8Array).every((b) => b === 0)).toBe(true);
        fills.mockRestore();
    });

    it("a lock of another mailbox doesn't cancel an in-flight unlock", async () => {
        const { vault, mailboxKeys } = await enrollForTest(["encrypt"]);
        let release!: () => void;
        getKeyVault.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = () => resolve(vault);
                }),
        );
        const pending = unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        await Promise.resolve();
        destroyUnlockedKeys("some-other-mailbox");
        release();

        await expect(pending).resolves.toEqual({ unopenableKeys: [] });
        expect(getUnlockedKeys(MAILBOX_UID)).toBeDefined();
    });
});

describe("destroyUnlockedKeys - round 6: replaced objects are held weakly", () => {
    /** Stands in for `WeakRef` so a test can simulate the garbage collector reclaiming an object. */
    class FakeWeakRef<T extends object> {
        static created: FakeWeakRef<object>[] = [];
        target: T | undefined;
        constructor(target: T) {
            this.target = target;
            FakeWeakRef.created.push(this);
        }
        deref(): T | undefined {
            return this.target;
        }
    }

    afterEach(() => {
        FakeWeakRef.created = [];
        vi.unstubAllGlobals();
    });

    it("tracks each handed-out object only through a weak reference, destroying the reachable ones on lock", async () => {
        vi.stubGlobal("WeakRef", FakeWeakRef);
        const { vault, mailboxKeys } = await enrollForTest(["sign", "encrypt"]);
        getKeyVault.mockResolvedValue(vault);
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        const first = getUnlockedKeys(MAILBOX_UID)!;
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        const second = getUnlockedKeys(MAILBOX_UID)!;
        expect(FakeWeakRef.created.map((ref) => ref.target)).toEqual([first, second]);

        // Nothing references `first` any more, so the collector reclaims it; the next unlock drops its dead handle.
        const firstMasterKey = first.masterKey;
        FakeWeakRef.created[0].target = undefined;
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        const third = getUnlockedKeys(MAILBOX_UID)!;

        // `second` is still referenced (by this test) when the lock comes; `third` is the live session.
        const secondRef = FakeWeakRef.created.find((ref) => ref.target === second)!;
        destroyUnlockedKeys(MAILBOX_UID);

        for (const held of [second, third]) {
            expect(held.destroyed).toBe(true);
            expect(held.masterKey.every((b) => b === 0)).toBe(true);
            expect(held.signingPrivateKey).toBeUndefined();
        }
        expect(secondRef.target).toBe(second);
        // The store no longer held `first` at all - it didn't keep that master key alive until the lock.
        expect(first.destroyed).toBeUndefined();
        expect(firstMasterKey.some((b) => b !== 0)).toBe(true);
        expect(getUnlockedKeys(MAILBOX_UID)).toBeUndefined();
    });

    it("skips an object collected before the lock, destroying the rest", async () => {
        vi.stubGlobal("WeakRef", FakeWeakRef);
        const { vault, mailboxKeys } = await enrollForTest(["sign"]);
        getKeyVault.mockResolvedValue(vault);
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        const current = getUnlockedKeys(MAILBOX_UID)!;
        const replaced = FakeWeakRef.created[0].target as typeof current;
        FakeWeakRef.created[0].target = undefined;

        destroyUnlockedKeys();

        expect(current.destroyed).toBe(true);
        expect(replaced.destroyed).toBeUndefined();
        expect(getUnlockedKeys(MAILBOX_UID)).toBeUndefined();
    });

    it("falls back to strong references where WeakRef doesn't exist, still destroying every object on lock", async () => {
        vi.stubGlobal("WeakRef", undefined);
        const { vault, mailboxKeys } = await enrollForTest(["sign"]);
        getKeyVault.mockResolvedValue(vault);
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        const first = getUnlockedKeys(MAILBOX_UID)!;
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        const second = getUnlockedKeys(MAILBOX_UID)!;

        destroyUnlockedKeys();

        expect(first.destroyed).toBe(true);
        expect(second.destroyed).toBe(true);
        expect(first.masterKey.every((b) => b === 0)).toBe(true);
    });

    it("uses the runtime's real WeakRef by default", async () => {
        const created: object[] = [];
        const RealWeakRef = (globalThis as unknown as { WeakRef: new (target: object) => { deref(): object | undefined } }).WeakRef;
        vi.stubGlobal(
            "WeakRef",
            class extends RealWeakRef {
                constructor(target: object) {
                    super(target);
                    created.push(target);
                }
            },
        );
        const { vault, mailboxKeys } = await enrollForTest(["encrypt"]);
        getKeyVault.mockResolvedValue(vault);
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);

        expect(created).toEqual([getUnlockedKeys(MAILBOX_UID)]);
    });
});

describe("unlockWithRecoveryCode", () => {
    const REJECTED = "That recovery code didn't unlock this mailbox.";
    const WRONG_CODE = "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG";

    /** An enrolled vault plus `count` real recovery wraps of its master key (after the password wrap). */
    async function enrollWithRecovery(useTypes: ("sign" | "encrypt")[], count = 3) {
        const enrolled = await enrollForTest(useTypes);
        const { wraps, codes } = await buildRecoveryWraps(MAILBOX_UID, enrolled.mk, count);
        const vault: KeyVault = { ...enrolled.vault, masterKeyWraps: [...enrolled.vault.masterKeyWraps, ...wraps] };
        getKeyVault.mockResolvedValue(vault);
        return { ...enrolled, vault, codes, wraps };
    }

    it("opens the master key and private keys with any enrolled code, reporting which wrap and how many remain", async () => {
        const { mailboxKeys, codes, mk } = await enrollWithRecovery(["sign", "encrypt"]);
        const listener = vi.fn();
        const unsubscribe = subscribeKeySession(listener);

        for (const [i, code] of codes.entries()) {
            const result = await unlockWithRecoveryCode(MAILBOX_UID, mailboxKeys, code);
            expect(result).toEqual({ unopenableKeys: [], recoveryMethodId: `recovery-${i + 1}`, remainingRecoveryCodes: 2 });
            const unlocked = getUnlockedKeys(MAILBOX_UID)!;
            expect(unlocked.masterKey).toEqual(mk);
            expect(unlocked.signingPrivateKey!.algorithm.name).toBe("ECDSA");
            expect(unlocked.encryptionPrivateKey!.algorithm.name).toBe("ECDH");
            expect(unlocked.encryptionFingerprint).toBe("fp-encrypt");
        }
        expect(listener).toHaveBeenCalledTimes(3);
        expect(listener).toHaveBeenLastCalledWith({ mailboxUid: MAILBOX_UID, state: "unlocked" });
        unsubscribe();
    });

    it("accepts lowercase, spaced and undashed variants of a code", async () => {
        const { mailboxKeys, codes } = await enrollWithRecovery(["encrypt"], 2);
        const code = codes[1];
        for (const variant of [code.toLowerCase(), ` ${code.replace(/-/g, " ")} `, code.replace(/-/g, "")]) {
            await expect(unlockWithRecoveryCode(MAILBOX_UID, mailboxKeys, variant)).resolves.toMatchObject({ recoveryMethodId: "recovery-2", remainingRecoveryCodes: 1 });
        }
    });

    it("rejects a wrong code, an empty code, and a vault with no recovery wraps with the same generic error", async () => {
        const { vault, mailboxKeys } = await enrollWithRecovery(["encrypt"], 2);
        const listener = vi.fn();
        const unsubscribe = subscribeKeySession(listener);

        const wrong = await unlockWithRecoveryCode(MAILBOX_UID, mailboxKeys, WRONG_CODE).catch((e: unknown) => e);
        const empty = await unlockWithRecoveryCode(MAILBOX_UID, mailboxKeys, "").catch((e: unknown) => e);
        getKeyVault.mockResolvedValue({ ...vault, masterKeyWraps: vault.masterKeyWraps.filter((w) => w.method !== "recovery") });
        const none = await unlockWithRecoveryCode(MAILBOX_UID, mailboxKeys, WRONG_CODE).catch((e: unknown) => e);

        for (const err of [wrong, empty, none]) {
            expect(err).toBeInstanceOf(Error);
            expect(err).not.toBeInstanceOf(KeysLockedError);
            expect(err).not.toBeInstanceOf(UnopenableEncryptionKeyError);
            expect((err as Error).message).toBe(REJECTED);
        }
        expect(getUnlockedKeys(MAILBOX_UID)).toBeUndefined();
        expect(listener).not.toHaveBeenCalled();
        unsubscribe();
    });

    it("never tries a recovery wrap with a foreign KDF, and moves past a corrupt one", async () => {
        const { vault, mailboxKeys, codes } = await enrollWithRecovery(["encrypt"], 2);
        const [first, second] = vault.masterKeyWraps.filter((w) => w.method === "recovery");
        getKeyVault.mockResolvedValue({
            ...vault,
            masterKeyWraps: [vault.masterKeyWraps[0], { ...first, kdf: "argon2id:m=8,t=1,p=1" }, { ...first, methodId: "recovery-x", salt: "!" }, second],
        });

        await expect(unlockWithRecoveryCode(MAILBOX_UID, mailboxKeys, codes[0])).rejects.toThrow(REJECTED);
        await expect(unlockWithRecoveryCode(MAILBOX_UID, mailboxKeys, codes[1])).resolves.toEqual({
            unopenableKeys: [],
            recoveryMethodId: "recovery-2",
            remainingRecoveryCodes: 2,
        });
    });

    it("omits recoveryMethodId for a recovery wrap stored without one, and reports no remaining codes for a sole wrap", async () => {
        const { vault, mailboxKeys, codes, wraps } = await enrollWithRecovery(["encrypt"], 1);
        const withoutId = { ...wraps[0] };
        delete withoutId.methodId;
        getKeyVault.mockResolvedValue({ ...vault, masterKeyWraps: [vault.masterKeyWraps[0], withoutId] });

        const result = await unlockWithRecoveryCode(MAILBOX_UID, mailboxKeys, codes[0]);
        expect(result).toEqual({ unopenableKeys: [], remainingRecoveryCodes: 0 });
        expect(result).not.toHaveProperty("recoveryMethodId");
    });

    it("shares unlockWithPassword's unopenable-key handling", async () => {
        const { vault, mailboxKeys, codes } = await enrollWithRecovery(["sign", "encrypt"], 1);
        const corrupt = (useType: "sign" | "encrypt"): KeyVault => ({
            ...vault,
            wrappedKeys: vault.wrappedKeys.map((k) => (k.useType === useType ? { ...k, ciphertext: toBase64(new Uint8Array(64)) } : k)),
        });

        getKeyVault.mockResolvedValue(corrupt("sign"));
        await expect(unlockWithRecoveryCode(MAILBOX_UID, mailboxKeys, codes[0])).resolves.toEqual({
            unopenableKeys: ["fp-sign"],
            recoveryMethodId: "recovery-1",
            remainingRecoveryCodes: 0,
        });
        destroyUnlockedKeys();

        getKeyVault.mockResolvedValue(corrupt("encrypt"));
        const err = await unlockWithRecoveryCode(MAILBOX_UID, mailboxKeys, codes[0]).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UnopenableEncryptionKeyError);
        expect(getUnlockedKeys(MAILBOX_UID)).toBeUndefined();
    });

    it.each([
        ["this mailbox", () => destroyUnlockedKeys(MAILBOX_UID)],
        ["every mailbox", () => destroyUnlockedKeys()],
    ])("throws KeysLockedError and zeroes the opened master key when %s is locked mid-unlock", async (_label, lock) => {
        const { vault, mailboxKeys, codes, mk } = await enrollWithRecovery(["sign", "encrypt"], 2);
        let release!: () => void;
        getKeyVault.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = () => resolve(vault);
                }),
        );
        const listener = vi.fn();
        const unsubscribe = subscribeKeySession(listener);
        const fills = vi.spyOn(Uint8Array.prototype, "fill");

        const pending = unlockWithRecoveryCode(MAILBOX_UID, mailboxKeys, codes[1]);
        await Promise.resolve();
        lock();
        release();

        await expect(pending).rejects.toBeInstanceOf(KeysLockedError);
        expect(getUnlockedKeys(MAILBOX_UID)).toBeUndefined();
        expect(listener).not.toHaveBeenCalled();
        // The opened master key (a fresh copy equal to `mk` before zeroing) was zeroed - not just the wrapping keys.
        const zeroedTargets = fills.mock.contexts.filter((target, i) => fills.mock.calls[i][0] === 0 && (target as Uint8Array).length === 32) as Uint8Array[];
        expect(zeroedTargets.every((t) => t.every((b) => b === 0))).toBe(true);
        // One wrapping key per tried wrap (2) plus the master key.
        expect(zeroedTargets.length).toBe(3);
        expect(mk.some((b) => b !== 0)).toBe(true);
        fills.mockRestore();
        unsubscribe();
    });

    it("leaves unlockWithPassword working on the same vault", async () => {
        const { mailboxKeys } = await enrollWithRecovery(["encrypt"], 1);
        await expect(unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD)).resolves.toEqual({ unopenableKeys: [] });
    });
});
