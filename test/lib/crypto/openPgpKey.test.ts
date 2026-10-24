// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as openpgp from "openpgp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyVault, WrappedPrivateKey } from "../../../lib/crypto/keyvaultApi.js";
import { OPENPGP_PRIVATE_KEY_AAD_PURPOSE } from "../../../lib/crypto/keySession.js";
import { buildAad, generateMasterKey, openWithKey, sealWithKey } from "../../../lib/crypto/masterKey.js";
import { ensureOpenPgpKey, exportOpenPgpSecretKey, provisionOpenPgpKey } from "../../../lib/crypto/openPgpKey.js";
import { generateOpenPgpKey } from "../../../lib/crypto/openpgp.js";

const { enrollKey, getEncryptionPolicy, getKeyVault, recordKeyExport, getUnlockedKeys, addOpenPgpKey, openMasterKeyWithPassword } = vi.hoisted(() => ({
    enrollKey: vi.fn(),
    getEncryptionPolicy: vi.fn(),
    getKeyVault: vi.fn(),
    recordKeyExport: vi.fn(),
    getUnlockedKeys: vi.fn(),
    addOpenPgpKey: vi.fn(),
    openMasterKeyWithPassword: vi.fn(),
}));
vi.mock("../../../lib/crypto/keyvaultApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/crypto/keyvaultApi.js")>()),
    enrollKey,
    getEncryptionPolicy,
    getKeyVault,
    recordKeyExport,
}));
vi.mock("../../../lib/crypto/keySession.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/crypto/keySession.js")>()),
    getUnlockedKeys,
    addOpenPgpKey,
    openMasterKeyWithPassword,
}));

const MAILBOX_UID = "mb1";
const ADDRESS = "alice@example.com";
const AAD = buildAad(MAILBOX_UID, OPENPGP_PRIVATE_KEY_AAD_PURPOSE);

const wrapped = (fingerprint: string, fields: Partial<WrappedPrivateKey> = {}): WrappedPrivateKey => ({
    ciphertext: "c",
    nonce: "n",
    algorithm: "AES-256-GCM",
    fingerprint,
    useType: "encrypt",
    ...fields,
});

const vaultWith = (wrappedKeys: WrappedPrivateKey[]): KeyVault => ({ wrappedKeys, masterKeyWraps: [], masterKeyGeneration: 4 });

afterEach(() => {
    vi.clearAllMocks();
});

describe("provisionOpenPgpKey", () => {
    it("enrolls an OpenPGP certificate with its secret key sealed under the master key", async () => {
        const mk = generateMasterKey();
        enrollKey.mockResolvedValue(vaultWith([wrapped("enc")]));

        const { vault, key } = await provisionOpenPgpKey(MAILBOX_UID, ADDRESS, mk, 4, "Alice");

        expect(vault.masterKeyGeneration).toBe(4);
        const [mailboxUid, input] = enrollKey.mock.calls[0];
        expect(mailboxUid).toBe(MAILBOX_UID);
        expect(input).toMatchObject({ useType: "encrypt", type: "openpgp", expectedMasterKeyGeneration: 4 });
        const certificate = await openpgp.readKey({ armoredKey: input.publicKey });
        expect(certificate.getUserIDs()).toEqual([`Alice <${ADDRESS}>`]);
        expect(key.fingerprint).toBe(certificate.getFingerprint());
        expect(key.privateKey.getFingerprint()).toBe(certificate.getFingerprint());
        // The sealed secret key opens under the master key with the OpenPGP purpose, and only with it.
        const raw = await openWithKey(mk, input.wrappedKey, AAD);
        expect((await openpgp.readPrivateKey({ binaryKey: raw })).getFingerprint()).toBe(key.fingerprint);
        await expect(openWithKey(mk, input.wrappedKey, buildAad(MAILBOX_UID, "encrypt-private-key"))).rejects.toThrow();
    });

    it("leaves out the master key generation when none is given, and rejects with the enrollment's error", async () => {
        enrollKey.mockRejectedValue(new Error("conflict"));
        await expect(provisionOpenPgpKey(MAILBOX_UID, ADDRESS, generateMasterKey())).rejects.toThrow("conflict");
        expect(enrollKey.mock.calls[0][1].expectedMasterKeyGeneration).toBeUndefined();
    });
});

describe("ensureOpenPgpKey", () => {
    const unlocked = () => ({ masterKey: generateMasterKey(), encryptionKeys: [], openPgpKeys: [] });

    it("provisions a key for an unlocked mailbox that has none and adds it to the session", async () => {
        const session = unlocked();
        getUnlockedKeys.mockReturnValue(session);
        getEncryptionPolicy.mockResolvedValue({ allowOpenPgp: true });
        getKeyVault.mockResolvedValue(vaultWith([wrapped("enc")]));
        enrollKey.mockResolvedValue(vaultWith([wrapped("enc"), wrapped("pgp", { type: "openpgp" })]));

        // A second caller joins the first.
        const [first, second] = await Promise.all([ensureOpenPgpKey(MAILBOX_UID, ADDRESS, "Alice"), ensureOpenPgpKey(MAILBOX_UID, ADDRESS)]);

        expect([first, second]).toEqual([true, true]);
        expect(enrollKey).toHaveBeenCalledTimes(1);
        expect(enrollKey.mock.calls[0][1].expectedMasterKeyGeneration).toBe(4);
        expect(addOpenPgpKey).toHaveBeenCalledWith(MAILBOX_UID, session, expect.objectContaining({ fingerprint: expect.stringMatching(/^[0-9a-f]{40}$/) }));
    });

    it.each([
        ["the mailbox is locked", () => getUnlockedKeys.mockReturnValue(undefined)],
        ["it is a shared mailbox's session", () => getUnlockedKeys.mockReturnValue({ ...unlocked(), shared: true })],
        ["the session already holds an OpenPGP key", () => getUnlockedKeys.mockReturnValue({ ...unlocked(), openPgpKeys: [{ fingerprint: "f" }] })],
    ])("does nothing when %s", async (_label, arrange) => {
        arrange();
        expect(await ensureOpenPgpKey(MAILBOX_UID, ADDRESS)).toBe(false);
        expect(getEncryptionPolicy).not.toHaveBeenCalled();
    });

    it.each([
        ["the server doesn't allow OpenPGP", { allowOpenPgp: false }, [wrapped("enc")]],
        ["the policy predates OpenPGP", {}, [wrapped("enc")]],
        ["the vault isn't set up", { allowOpenPgp: true }, []],
        ["the vault already holds an OpenPGP key", { allowOpenPgp: true }, [wrapped("enc"), wrapped("pgp", { type: "openpgp" })]],
    ])("does nothing when %s", async (_label, policy, wrappedKeys) => {
        getUnlockedKeys.mockReturnValue(unlocked());
        getEncryptionPolicy.mockResolvedValue(policy);
        getKeyVault.mockResolvedValue(vaultWith(wrappedKeys));
        expect(await ensureOpenPgpKey(MAILBOX_UID, ADDRESS)).toBe(false);
        expect(enrollKey).not.toHaveBeenCalled();
    });

    it("can run again after a failure", async () => {
        getUnlockedKeys.mockReturnValue(unlocked());
        getEncryptionPolicy.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ allowOpenPgp: false });
        await expect(ensureOpenPgpKey(MAILBOX_UID, ADDRESS)).rejects.toThrow("offline");
        expect(await ensureOpenPgpKey(MAILBOX_UID, ADDRESS)).toBe(false);
    });
});

describe("exportOpenPgpSecretKey", () => {
    it("exports the newest OpenPGP key protected with the passphrase and records the export", async () => {
        const mk = generateMasterKey();
        const older = await generateOpenPgpKey(ADDRESS);
        const newer = await generateOpenPgpKey(ADDRESS);
        const seal = async (secretKey: Uint8Array, fingerprint: string) =>
            wrapped(fingerprint, { type: "openpgp", ...(await sealWithKey(mk, secretKey, AAD)) });
        const vault = vaultWith([await seal(older.secretKey, older.fingerprint), wrapped("enc"), await seal(newer.secretKey, newer.fingerprint)]);
        openMasterKeyWithPassword.mockResolvedValue({ vault, masterKey: mk });
        recordKeyExport.mockResolvedValue(undefined);

        const { armored, fingerprint } = await exportOpenPgpSecretKey(MAILBOX_UID, "master password", "file passphrase");

        expect(openMasterKeyWithPassword).toHaveBeenCalledWith(MAILBOX_UID, "master password", undefined);
        expect(fingerprint).toBe(newer.fingerprint);
        const exported = await openpgp.readPrivateKey({ armoredKey: armored });
        expect(exported.isDecrypted()).toBe(false);
        expect((await openpgp.decryptKey({ privateKey: exported, passphrase: "file passphrase" })).getFingerprint()).toBe(newer.fingerprint);
        expect(recordKeyExport).toHaveBeenCalledWith(MAILBOX_UID, [{ kind: "encrypt", fingerprint: newer.fingerprint }], undefined);
        // The master key is zeroed once the export is done.
        expect(mk.every((byte) => byte === 0)).toBe(true);
    });

    it("throws when the mailbox has no OpenPGP key", async () => {
        const mk = generateMasterKey();
        openMasterKeyWithPassword.mockResolvedValue({ vault: vaultWith([wrapped("enc")]), masterKey: mk });
        await expect(exportOpenPgpSecretKey(MAILBOX_UID, "pw", "passphrase")).rejects.toThrow("no OpenPGP key");
        expect(recordKeyExport).not.toHaveBeenCalled();
        expect(mk.every((byte) => byte === 0)).toBe(true);
    });
});
