// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import * as pkijs from "pkijs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toBase64 } from "../../../lib/crypto/encoding.js";
import { exportKeysAsPkcs12, MIN_EXPORT_PASSPHRASE_LENGTH, NothingToExportError } from "../../../lib/crypto/keyExport.js";
import {
    ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE,
    MASTER_KEY_AAD_PURPOSE,
    SIGNING_PRIVATE_KEY_AAD_PURPOSE,
    ZERO_ACCESS_PRIVATE_KEY_AAD_PURPOSE,
} from "../../../lib/crypto/keySession.js";
import type { KeyVault, MasterKeyWrap, PublicKey, ZeroAccessKey } from "../../../lib/crypto/keyvaultApi.js";
import { buildAad, generateMasterKey, sealWithKey } from "../../../lib/crypto/masterKey.js";
import { argon2idKdfLabel, deriveFromPassword, generateSalt } from "../../../lib/crypto/passwordUnlock.js";

x509.cryptoProvider.set(crypto);

const { getKeyVault, recordKeyExport } = vi.hoisted(() => ({ getKeyVault: vi.fn(), recordKeyExport: vi.fn() }));
vi.mock("../../../lib/crypto/keyvaultApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/crypto/keyvaultApi.js")>()),
    getKeyVault,
    recordKeyExport,
}));

const FAST_PARAMS = { memorySize: 8, iterations: 1, parallelism: 1 };
const MAILBOX_UID = "mb1";
const ADDRESS = "alice@example.com";
const PASSWORD = "a fine password";
const PASSPHRASE = "export passphrase 123";

type Kind = "zero-access" | "encrypt" | "sign";

interface TestKey {
    kind: Kind;
    fingerprint: string;
    certDer: Uint8Array;
    pkcs8: Uint8Array;
    notBefore: number;
    revokedAt?: number;
}

const PURPOSE: Record<Kind, string> = {
    "zero-access": ZERO_ACCESS_PRIVATE_KEY_AAD_PURPOSE,
    encrypt: ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE,
    sign: SIGNING_PRIVATE_KEY_AAD_PURPOSE,
};

let serial = 0;

async function makeKey(kind: Kind, notBefore: number, revokedAt?: number): Promise<TestKey> {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: (++serial).toString(16).padStart(2, "0"),
        name: `CN=${ADDRESS}`,
        notBefore: new Date(Date.now() - 1000),
        notAfter: new Date(Date.now() + 86_400_000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys,
    });
    const certDer = new Uint8Array(cert.rawData);
    const fingerprint = Buffer.from(await crypto.subtle.digest("SHA-256", certDer)).toString("hex");
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
    return { kind, fingerprint, certDer, pkcs8, notBefore, ...(revokedAt ? { revokedAt } : {}) };
}

/** A vault holding `keys` the way enrollment builds one: a password wrap of the master key, and each private key sealed
 * under it with its kind's AAD purpose. `badSeal` keys are sealed under the wrong purpose, so they won't open. */
async function vaultFor(keys: TestKey[], badSeal: TestKey[] = []): Promise<{ vault: KeyVault; mailboxKeys: PublicKey[] }> {
    const mk = generateMasterKey();
    const salt = generateSalt();
    const { wrappingKey } = await deriveFromPassword(PASSWORD, salt, FAST_PARAMS);
    const sealed = await sealWithKey(wrappingKey, mk, buildAad(MAILBOX_UID, MASTER_KEY_AAD_PURPOSE));
    const passwordWrap: MasterKeyWrap = {
        method: "password",
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        salt: toBase64(salt),
        kdf: argon2idKdfLabel(FAST_PARAMS),
        schemeVersion: 1,
        createdAt: Date.now(),
    };

    const wrappedKeys: KeyVault["wrappedKeys"] = [];
    for (const key of keys) {
        const purpose = badSeal.includes(key) ? "some-other-purpose" : PURPOSE[key.kind];
        const priv = await sealWithKey(mk, key.pkcs8.slice(), buildAad(MAILBOX_UID, purpose));
        wrappedKeys.push({ ciphertext: priv.ciphertext, nonce: priv.nonce, algorithm: "AES-256-GCM", fingerprint: key.fingerprint, useType: key.kind });
    }
    const asPublic = (key: TestKey) => ({
        publicKey: toBase64(key.certDer),
        type: "x509",
        useType: key.kind,
        fingerprint: key.fingerprint,
        notBefore: key.notBefore,
        notAfter: Date.now() + 86_400_000,
        ...(key.revokedAt ? { revokedAt: key.revokedAt } : {}),
    });
    const zeroAccessKeys = keys.filter((k) => k.kind === "zero-access").map(asPublic) as ZeroAccessKey[];
    const mailboxKeys = keys.filter((k) => k.kind !== "zero-access").map(asPublic) as PublicKey[];
    return { vault: { wrappedKeys, masterKeyWraps: [passwordWrap], zeroAccessKeys }, mailboxKeys };
}

/** Opens a PKCS#12 the way a mail client would: checks the MAC, then decrypts each shrouded key bag. Returns, per key,
 * its friendly name, its PKCS#8 and its certificate, paired by `localKeyID`. */
async function openPkcs12(der: Uint8Array, passphrase: string) {
    const pfx = pkijs.PFX.fromBER(der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer);
    await pfx.parseInternalValues({ password: new TextEncoder().encode(passphrase).buffer, checkIntegrity: true });
    const safe = pfx.parsedValue!.authenticatedSafe!;
    await safe.parseInternalValues({ safeContents: [{}] });
    const byId = new Map<string, { name?: string; pkcs8?: Uint8Array; certDer?: Uint8Array }>();
    for (const bag of safe.parsedValue.safeContents[0].value.safeBags) {
        const id = Buffer.from(bag.bagAttributes!.find((a) => a.type === "1.2.840.113549.1.9.21")!.values[0].valueBlock.valueHexView).toString("hex");
        const name = bag.bagAttributes!.find((a) => a.type === "1.2.840.113549.1.9.20")!.values[0].valueBlock.value;
        const entry = byId.get(id) ?? {};
        entry.name = name;
        if (bag.bagValue instanceof pkijs.PKCS8ShroudedKeyBag) {
            await bag.bagValue.parseInternalValues({ password: new TextEncoder().encode(passphrase).buffer });
            entry.pkcs8 = new Uint8Array(bag.bagValue.parsedValue!.toSchema().toBER(false));
        } else {
            entry.certDer = new Uint8Array((bag.bagValue as pkijs.CertBag).parsedValue.toSchema().toBER(false));
        }
        byId.set(id, entry);
    }
    return [...byId.values()];
}

const input = (mailboxKeys: PublicKey[], fields: object = {}) => ({
    mailboxUid: MAILBOX_UID,
    mailboxAddress: ADDRESS,
    mailboxKeys,
    masterPassword: PASSWORD,
    exportPassphrase: PASSPHRASE,
    ...fields,
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("exportKeysAsPkcs12", () => {
    it("exports every zero-access and encryption key, but no signing key unless asked, and records the export first", async () => {
        const zaOld = await makeKey("zero-access", 1, 5);
        const zaActive = await makeKey("zero-access", 2);
        const encActive = await makeKey("encrypt", 3);
        const encOld = await makeKey("encrypt", 2);
        const encOldest = await makeKey("encrypt", 1);
        const sign = await makeKey("sign", 3);
        const { vault, mailboxKeys } = await vaultFor([zaOld, zaActive, encOldest, encOld, encActive, sign]);
        getKeyVault.mockResolvedValue(vault);

        const result = await exportKeysAsPkcs12(input(mailboxKeys));

        const order = [zaActive, zaOld, encActive, encOld, encOldest];
        expect(result.keys).toEqual(order.map((k) => ({ kind: k.kind, fingerprint: k.fingerprint })));
        expect(recordKeyExport).toHaveBeenCalledWith(MAILBOX_UID, result.keys, undefined);
        const opened = await openPkcs12(result.pkcs12, PASSPHRASE);
        expect(opened.map((e) => e.name)).toEqual([
            `RapidMX zero-access key (${ADDRESS})`,
            `RapidMX zero-access key (${ADDRESS}) 2`,
            `RapidMX encryption key (${ADDRESS})`,
            `RapidMX encryption key (${ADDRESS}) 2`,
            `RapidMX encryption key (${ADDRESS}) 3`,
        ]);
        opened.forEach((entry, i) => {
            expect(entry.pkcs8).toEqual(order[i].pkcs8);
            expect(entry.certDer).toEqual(order[i].certDer);
        });
    });

    it("adds the active signing key when asked", async () => {
        const za = await makeKey("zero-access", 1);
        const sign = await makeKey("sign", 1);
        const { vault, mailboxKeys } = await vaultFor([za, sign]);
        getKeyVault.mockResolvedValue(vault);

        const result = await exportKeysAsPkcs12(input(mailboxKeys, { includeSigningKey: true }), { baseUrl: "x" } as any);

        expect(result.keys.map((k) => k.kind)).toEqual(["zero-access", "sign"]);
        expect(getKeyVault).toHaveBeenCalledWith(MAILBOX_UID, { baseUrl: "x" });
        const opened = await openPkcs12(result.pkcs12, PASSPHRASE);
        expect(opened[1]).toMatchObject({ name: `RapidMX signing key (${ADDRESS})`, pkcs8: sign.pkcs8 });
    });

    it("skips keys it can't open, has no wrap for, or lists twice, and copes with no encryption or signing key", async () => {
        const za = await makeKey("zero-access", 2);
        const stale = await makeKey("zero-access", 1);
        const unwrapped = await makeKey("zero-access", 3);
        const { vault, mailboxKeys } = await vaultFor([za, stale], [stale]);
        vault.zeroAccessKeys = [...vault.zeroAccessKeys!, vault.zeroAccessKeys![0], { ...vault.zeroAccessKeys![0], fingerprint: unwrapped.fingerprint }];
        getKeyVault.mockResolvedValue(vault);

        const result = await exportKeysAsPkcs12(input(mailboxKeys, { includeSigningKey: true }));

        expect(result.keys).toEqual([{ kind: "zero-access", fingerprint: za.fingerprint }]);
    });

    it("caps each kind at the session's limit", async () => {
        const keys = await Promise.all(Array.from({ length: 22 }, (_, i) => makeKey("zero-access", i + 1)));
        const { vault, mailboxKeys } = await vaultFor(keys);
        getKeyVault.mockResolvedValue(vault);

        const result = await exportKeysAsPkcs12(input(mailboxKeys));

        expect(result.keys).toHaveLength(21);
        expect(result.keys[0].fingerprint).toBe(keys[21].fingerprint);
    }, 30_000);

    it("refuses a short passphrase before fetching anything", async () => {
        await expect(exportKeysAsPkcs12(input([], { exportPassphrase: "x".repeat(MIN_EXPORT_PASSPHRASE_LENGTH - 1) }))).rejects.toThrow("at least");
        expect(getKeyVault).not.toHaveBeenCalled();
    });

    it("rejects a wrong master password and records nothing", async () => {
        const { vault, mailboxKeys } = await vaultFor([await makeKey("zero-access", 1)]);
        getKeyVault.mockResolvedValue(vault);

        await expect(exportKeysAsPkcs12(input(mailboxKeys, { masterPassword: "wrong" }))).rejects.toThrow();
        expect(recordKeyExport).not.toHaveBeenCalled();
    });

    it("has nothing to export with only a signing key, and records nothing", async () => {
        const { vault, mailboxKeys } = await vaultFor([await makeKey("sign", 1)]);
        getKeyVault.mockResolvedValue(vault);

        await expect(exportKeysAsPkcs12(input(mailboxKeys, { includeSigningKey: true }))).rejects.toBeInstanceOf(NothingToExportError);
        expect(recordKeyExport).not.toHaveBeenCalled();
    });

    it("hands over no file when the server won't record the export", async () => {
        const { vault, mailboxKeys } = await vaultFor([await makeKey("encrypt", 1)]);
        delete vault.zeroAccessKeys;
        getKeyVault.mockResolvedValue(vault);
        recordKeyExport.mockRejectedValueOnce(new Error("403"));

        await expect(exportKeysAsPkcs12(input(mailboxKeys))).rejects.toThrow("403");
    });
});
