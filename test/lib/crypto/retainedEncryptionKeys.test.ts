// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
/**
 * Retained encryption keys: an unlock opens the older (superseded, expired or compromised) encryption keys still in the
 * vault, and decryption matches a message's recipient identifiers against the active and retained keys, so mail
 * encrypted to a key since replaced stays readable.
 */
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toBase64 } from "../../../lib/crypto/encoding.js";
import {
    ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE,
    KeysLockedError,
    MASTER_KEY_AAD_PURPOSE,
    MAX_RETAINED_ENCRYPTION_KEYS,
    SIGNING_PRIVATE_KEY_AAD_PURPOSE,
    UnopenableEncryptionKeyError,
    type UnlockedKeys,
    destroyUnlockedKeys,
    getUnlockedKeys,
    unlockWithPassword,
    unlockWithRecoveryCode,
} from "../../../lib/crypto/keySession.js";
import { type KeyVault, type MasterKeyWrap, type PublicKey, type WrappedPrivateKey, findActivePublicKey } from "../../../lib/crypto/keyvaultApi.js";
import { buildAad, generateMasterKey, sealWithKey } from "../../../lib/crypto/masterKey.js";
import { buildRecoveryWraps } from "../../../lib/crypto/masterKeyWraps.js";
import { evaluateMessageSecurity } from "../../../lib/crypto/messageSecurity.js";
import { argon2idKdfLabel, deriveFromPassword, generateSalt } from "../../../lib/crypto/passwordUnlock.js";
import {
    MAX_DECRYPTION_KEYS,
    MAX_TRIAL_DECRYPTIONS,
    decryptEnvelopedData,
    decryptEnvelopedDataWithKeys,
    encryptForRecipients,
} from "../../../lib/crypto/smime.js";
import { type ProtectedHeaders, assembleOutboundMime, buildEncryptedMessage, parseEncryptedMessageWithKeys } from "../../../lib/crypto/smimeMessage.js";

const { getKeyVault } = vi.hoisted(() => ({ getKeyVault: vi.fn() }));
vi.mock("../../../lib/crypto/keyvaultApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/crypto/keyvaultApi.js")>()),
    getKeyVault,
}));

x509.cryptoProvider.set(crypto);

const FAST_PARAMS = { memorySize: 8, iterations: 1, parallelism: 1 };
const MAILBOX_UID = "mb-retained";
const PASSWORD = "a fine password";
const DAY = 86_400_000;
const PLAINTEXT = new TextEncoder().encode("old secret");

const HEADERS: ProtectedHeaders = {
    from: "bob@example.com",
    to: "alice@example.com",
    date: "Wed, 11 Jan 2023 16:08:43 -0500",
    subject: "Encrypted long ago",
    messageId: "<old@example.com>",
};

interface Identity {
    keys: CryptoKeyPair;
    certDer: Uint8Array;
    pkcs8: Uint8Array;
    /** The ECDH-imported private key, as decryption uses it. */
    privateKey: CryptoKey;
}

let serialCounter = 1;

async function makeIdentity(options: { keys?: CryptoKeyPair; withSki?: boolean; serial?: string } = {}): Promise<Identity> {
    const keys = options.keys ?? (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]));
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: options.serial ?? (serialCounter++).toString(16).padStart(2, "0"),
        name: "CN=alice@example.com",
        notBefore: new Date(Date.now() - DAY),
        notAfter: new Date(Date.now() + DAY),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys,
        extensions: options.withSki ? [await x509.SubjectKeyIdentifierExtension.create(keys.publicKey)] : [],
    });
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    return { keys, certDer: new Uint8Array(cert.rawData), pkcs8, privateKey };
}

interface VaultKeySpec {
    identity: Identity;
    fingerprint: string;
    notBefore: number;
    useType?: "sign" | "encrypt";
    revokedAt?: number;
    revocationReason?: "superseded" | "compromised";
    notAfter?: number;
    /** Leave the private key out of the vault. */
    noWrap?: boolean;
    /** Store a wrap that won't open. */
    corruptWrap?: boolean;
    /** Publish an undecodable certificate. */
    badCertificate?: boolean;
}

async function buildVault(specs: VaultKeySpec[]): Promise<{ vault: KeyVault; mailboxKeys: PublicKey[]; mk: Uint8Array }> {
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
    const mailboxKeys: PublicKey[] = [];
    const wrappedKeys: WrappedPrivateKey[] = [];
    for (const spec of specs) {
        const useType = spec.useType ?? "encrypt";
        mailboxKeys.push({
            publicKey: spec.badCertificate ? "!!! not base64 !!!" : toBase64(spec.identity.certDer),
            type: "x509",
            useType,
            fingerprint: spec.fingerprint,
            notBefore: spec.notBefore,
            notAfter: spec.notAfter ?? Date.now() + DAY,
            ...(spec.revokedAt !== undefined ? { revokedAt: spec.revokedAt } : {}),
            ...(spec.revocationReason ? { revocationReason: spec.revocationReason } : {}),
        });
        if (spec.noWrap) {
            continue;
        }
        const purpose = useType === "sign" ? SIGNING_PRIVATE_KEY_AAD_PURPOSE : ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE;
        const sealedKey = await sealWithKey(mk, spec.corruptWrap ? new Uint8Array([1, 2, 3]) : spec.identity.pkcs8, buildAad(MAILBOX_UID, purpose));
        wrappedKeys.push({ ciphertext: sealedKey.ciphertext, nonce: sealedKey.nonce, algorithm: "AES-256-GCM", fingerprint: spec.fingerprint, useType });
    }
    return { vault: { wrappedKeys, masterKeyWraps: [passwordWrap] }, mailboxKeys, mk };
}

/** A mailbox that rotated twice: `compromised` (oldest), then `superseded`, then `active`. */
async function rotatedMailbox() {
    const now = Date.now();
    const [compromised, superseded, active] = await Promise.all([makeIdentity(), makeIdentity(), makeIdentity()]);
    const built = await buildVault([
        { identity: compromised, fingerprint: "fp-compromised", notBefore: now - 30 * DAY, revokedAt: now - 20 * DAY, revocationReason: "compromised" },
        { identity: superseded, fingerprint: "fp-superseded", notBefore: now - 20 * DAY, revokedAt: now - 10 * DAY, revocationReason: "superseded" },
        { identity: active, fingerprint: "fp-active", notBefore: now - 10 * DAY },
    ]);
    getKeyVault.mockResolvedValue(built.vault);
    return { ...built, compromised, superseded, active };
}

async function encryptedMimeTo(certDer: Uint8Array, body = "Hello from before the rotation."): Promise<string> {
    const outer = { ...HEADERS, subject: "[...]" };
    const part = await buildEncryptedMessage("text/plain; charset=utf-8", body, HEADERS, outer, [certDer]);
    return assembleOutboundMime(outer, part);
}

afterEach(() => {
    destroyUnlockedKeys();
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

describe("unlock opens retained encryption keys", () => {
    it("opens superseded and compromised keys with a password, newest first, keeping the active key in its own fields", async () => {
        const { mailboxKeys } = await rotatedMailbox();

        const result = await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);

        expect(result.unopenableKeys).toEqual([]);
        const unlocked = getUnlockedKeys(MAILBOX_UID)!;
        expect(unlocked.encryptionFingerprint).toBe("fp-active");
        expect(unlocked.retainedEncryptionKeys!.map((k) => k.fingerprint)).toEqual(["fp-superseded", "fp-compromised"]);
        for (const retained of unlocked.retainedEncryptionKeys!) {
            expect(retained.privateKey.algorithm.name).toBe("ECDH");
            expect(retained.privateKey.extractable).toBe(false);
            expect(retained.privateKey.usages).toEqual(["deriveBits"]);
        }
        // Encryption still only ever picks the active key.
        expect(findActivePublicKey(mailboxKeys, "encrypt")!.fingerprint).toBe("fp-active");
    });

    it("opens the same retained keys with a recovery code", async () => {
        const { vault, mailboxKeys, mk } = await rotatedMailbox();
        const { wraps, codes } = await buildRecoveryWraps(MAILBOX_UID, mk, 1);
        getKeyVault.mockResolvedValue({ ...vault, masterKeyWraps: [...vault.masterKeyWraps, ...wraps] });

        const result = await unlockWithRecoveryCode(MAILBOX_UID, mailboxKeys, codes[0]);

        expect(result.unopenableKeys).toEqual([]);
        const unlocked = getUnlockedKeys(MAILBOX_UID)!;
        expect(unlocked.encryptionFingerprint).toBe("fp-active");
        expect(unlocked.retainedEncryptionKeys!.map((k) => k.fingerprint)).toEqual(["fp-superseded", "fp-compromised"]);
    });

    it("skips and reports a retained key whose wrap won't open or whose certificate won't decode, without failing the unlock", async () => {
        const now = Date.now();
        const [broken, badCert, good, active] = await Promise.all([makeIdentity(), makeIdentity(), makeIdentity(), makeIdentity()]);
        const { vault, mailboxKeys } = await buildVault([
            { identity: broken, fingerprint: "fp-broken", notBefore: now - 3 * DAY, revokedAt: now, revocationReason: "superseded", corruptWrap: true },
            { identity: badCert, fingerprint: "fp-bad-cert", notBefore: now - 2 * DAY, notAfter: now - 1, badCertificate: true },
            { identity: good, fingerprint: "fp-good", notBefore: now - 4 * DAY, revokedAt: now, revocationReason: "superseded" },
            { identity: active, fingerprint: "fp-active", notBefore: now - DAY },
        ]);
        getKeyVault.mockResolvedValue(vault);

        const result = await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);

        expect(result.unopenableKeys).toEqual(["fp-bad-cert", "fp-broken"]);
        const unlocked = getUnlockedKeys(MAILBOX_UID)!;
        expect(unlocked.encryptionFingerprint).toBe("fp-active");
        expect(unlocked.retainedEncryptionKeys!.map((k) => k.fingerprint)).toEqual(["fp-good"]);
    });

    it("still throws UnopenableEncryptionKeyError only for the active key, dropping retained keys already opened", async () => {
        const now = Date.now();
        const [old, active] = await Promise.all([makeIdentity(), makeIdentity()]);
        const { vault, mailboxKeys } = await buildVault([
            { identity: old, fingerprint: "fp-old", notBefore: now - 2 * DAY, revokedAt: now, revocationReason: "superseded" },
            { identity: active, fingerprint: "fp-active", notBefore: now - DAY, corruptWrap: true },
        ]);
        getKeyVault.mockResolvedValue(vault);

        await expect(unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD)).rejects.toBeInstanceOf(UnopenableEncryptionKeyError);
        expect(getUnlockedKeys(MAILBOX_UID)).toBeUndefined();
    });

    it("opens retained keys when no encryption key is active, ignoring sign keys, duplicates and keys missing from the vault", async () => {
        const now = Date.now();
        const [a, b, signer, orphan] = await Promise.all([makeIdentity(), makeIdentity(), makeIdentity(), makeIdentity()]);
        const { vault, mailboxKeys } = await buildVault([
            { identity: a, fingerprint: "fp-a", notBefore: now - 2 * DAY, revokedAt: now, revocationReason: "superseded" },
            { identity: b, fingerprint: "fp-b", notBefore: now - 3 * DAY, notAfter: now - 1 },
            { identity: signer, fingerprint: "fp-sign", notBefore: now - DAY, useType: "sign", revokedAt: now, revocationReason: "superseded" },
            { identity: orphan, fingerprint: "fp-orphan", notBefore: now - DAY, revokedAt: now, noWrap: true },
        ]);
        // The same published key listed twice (e.g. a stale copy) is opened once.
        getKeyVault.mockResolvedValue(vault);

        const result = await unlockWithPassword(MAILBOX_UID, [...mailboxKeys, { ...mailboxKeys[0] }], PASSWORD);

        expect(result.unopenableKeys).toEqual([]);
        const unlocked = getUnlockedKeys(MAILBOX_UID)!;
        expect(unlocked.encryptionPrivateKey).toBeUndefined();
        expect(unlocked.signingPrivateKey).toBeUndefined();
        expect(unlocked.retainedEncryptionKeys!.map((k) => k.fingerprint)).toEqual(["fp-a", "fp-b"]);
    });

    it("leaves a single-key vault exactly as before: no retained keys", async () => {
        const active = await makeIdentity();
        const { vault, mailboxKeys } = await buildVault([{ identity: active, fingerprint: "fp-active", notBefore: Date.now() - DAY }]);
        getKeyVault.mockResolvedValue(vault);

        await expect(unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD)).resolves.toEqual({ unopenableKeys: [] });
        const unlocked = getUnlockedKeys(MAILBOX_UID)!;
        expect(unlocked.encryptionFingerprint).toBe("fp-active");
        expect("retainedEncryptionKeys" in unlocked).toBe(false);
    });

    it(`opens at most the ${MAX_RETAINED_ENCRYPTION_KEYS} most recent retained keys`, async () => {
        const now = Date.now();
        const count = MAX_RETAINED_ENCRYPTION_KEYS + 3;
        const shared = await makeIdentity();
        const specs: VaultKeySpec[] = [{ identity: shared, fingerprint: "fp-active", notBefore: now }];
        for (let i = 0; i < count; i++) {
            specs.push({ identity: shared, fingerprint: `fp-old-${i}`, notBefore: now - (i + 1) * DAY, revokedAt: now, revocationReason: "superseded" });
        }
        const { vault, mailboxKeys } = await buildVault(specs);
        getKeyVault.mockResolvedValue(vault);
        const importSpy = vi.spyOn(crypto.subtle, "importKey");

        const result = await unlockWithPassword(MAILBOX_UID, [...mailboxKeys].reverse(), PASSWORD);

        expect(result.unopenableKeys).toEqual([]);
        const retained = getUnlockedKeys(MAILBOX_UID)!.retainedEncryptionKeys!;
        expect(retained).toHaveLength(MAX_RETAINED_ENCRYPTION_KEYS);
        expect(retained.map((k) => k.fingerprint)).toEqual(Array.from({ length: MAX_RETAINED_ENCRYPTION_KEYS }, (_, i) => `fp-old-${i}`));
        // Only the bounded keys were ever imported (plus the active key) - the older ones weren't opened at all.
        const pkcs8Imports = importSpy.mock.calls.filter(([format]) => format === "pkcs8");
        expect(pkcs8Imports).toHaveLength(MAX_RETAINED_ENCRYPTION_KEYS + 1);
    });

    it("throws KeysLockedError when locked while retained keys were opening", async () => {
        const { mailboxKeys } = await rotatedMailbox();
        const original = crypto.subtle.importKey.bind(crypto.subtle);
        let imports = 0;
        vi.spyOn(crypto.subtle, "importKey").mockImplementation(((...args: Parameters<typeof crypto.subtle.importKey>) => {
            if (args[0] === "pkcs8" && ++imports === 2) {
                destroyUnlockedKeys(MAILBOX_UID);
            }
            return original(...args);
        }) as typeof crypto.subtle.importKey);

        await expect(unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD)).rejects.toBeInstanceOf(KeysLockedError);
        expect(getUnlockedKeys(MAILBOX_UID)).toBeUndefined();
    });
});

describe("destroy clears retained keys", () => {
    it("drops the retained handles, including from an array a consumer captured", async () => {
        const { mailboxKeys, superseded } = await rotatedMailbox();
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        const unlocked = getUnlockedKeys(MAILBOX_UID)!;
        const captured = unlocked.retainedEncryptionKeys!;
        expect(captured).toHaveLength(2);

        destroyUnlockedKeys(MAILBOX_UID);

        expect(unlocked.destroyed).toBe(true);
        expect(unlocked.retainedEncryptionKeys).toBeUndefined();
        expect(captured).toHaveLength(0);
        expect(unlocked.masterKey.every((byte) => byte === 0)).toBe(true);
        const rawMime = await encryptedMimeTo(superseded.certDer);
        expect((await evaluateMessageSecurity(rawMime, unlocked)).decryptError).toBeDefined();
    });
});

describe("decrypting mail encrypted to older keys", () => {
    it("decrypts a message encrypted to a superseded key", async () => {
        const { mailboxKeys, superseded } = await rotatedMailbox();
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);

        const result = await evaluateMessageSecurity(await encryptedMimeTo(superseded.certDer, "Before rotation."), getUnlockedKeys(MAILBOX_UID));

        expect(result.state).toBe("encrypted");
        expect(result.text).toBe("Before rotation.");
        expect(result.decryptError).toBeUndefined();
    });

    it("decrypts a message encrypted to a compromised older key", async () => {
        const { mailboxKeys, compromised } = await rotatedMailbox();
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);

        const result = await evaluateMessageSecurity(await encryptedMimeTo(compromised.certDer, "Before the compromise."), getUnlockedKeys(MAILBOX_UID));

        expect(result.state).toBe("encrypted");
        expect(result.text).toBe("Before the compromise.");
    });

    it("still decrypts a message encrypted to the active key, and fails for a key the mailbox never had", async () => {
        const { mailboxKeys, active } = await rotatedMailbox();
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        const unlocked = getUnlockedKeys(MAILBOX_UID);

        expect((await evaluateMessageSecurity(await encryptedMimeTo(active.certDer, "Now."), unlocked)).text).toBe("Now.");
        const stranger = await makeIdentity();
        const failed = await evaluateMessageSecurity(await encryptedMimeTo(stranger.certDer), unlocked);
        expect(failed.state).toBe("encrypted");
        expect(failed.decryptError).toMatch(/doesn't have the key/);
    });

    it("decrypts with only retained keys (no active encryption key)", async () => {
        const old = await makeIdentity();
        const rawMime = await encryptedMimeTo(old.certDer, "Only retained.");
        const result = await evaluateMessageSecurity(rawMime, { retainedEncryptionKeys: [{ certDer: old.certDer, privateKey: old.privateKey }] });
        expect(result.text).toBe("Only retained.");
    });

    it("parseEncryptedMessageWithKeys decrypts with the retained key", async () => {
        const [active, old] = await Promise.all([makeIdentity(), makeIdentity()]);
        const part = await buildEncryptedMessage("text/plain", "via keys", HEADERS, HEADERS, [old.certDer]);
        const parsed = await parseEncryptedMessageWithKeys(part.body, [
            { certDer: active.certDer, privateKey: active.privateKey },
            { certDer: old.certDer, privateKey: old.privateKey },
        ]);
        expect(parsed.decrypted).toBe(true);
        expect(parsed.bodyText).toBe("via keys");
    });
});

function decryptSpy() {
    return vi.spyOn(pkijs.EnvelopedData.prototype, "decrypt");
}

/** Builds EnvelopedData DER with custom recipients. */
async function envelope(build: (enveloped: pkijs.EnvelopedData) => void | Promise<void>): Promise<Uint8Array> {
    const enveloped = new pkijs.EnvelopedData();
    await build(enveloped);
    await enveloped.encrypt({ name: "AES-GCM", length: 256 }, PLAINTEXT.buffer.slice(0));
    const contentInfo = new pkijs.ContentInfo({ contentType: pkijs.ContentInfo.ENVELOPED_DATA, content: enveloped.toSchema() });
    return new Uint8Array(contentInfo.toSchema().toBER());
}

function parseCert(der: Uint8Array): pkijs.Certificate {
    return pkijs.Certificate.fromBER(der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer);
}

describe("decryptEnvelopedDataWithKeys recipient matching", () => {
    it("picks the key named by issuer and serial number without trial and error", async () => {
        const [active, other, older, target] = await Promise.all([makeIdentity(), makeIdentity(), makeIdentity(), makeIdentity()]);
        const der = await encryptForRecipients(PLAINTEXT, [other.certDer, target.certDer]);
        const spy = decryptSpy();

        const decrypted = await decryptEnvelopedDataWithKeys(der, [
            { certDer: active.certDer, privateKey: active.privateKey },
            { certDer: older.certDer, privateKey: older.privateKey },
            { certDer: target.certDer, privateKey: target.privateKey },
        ]);

        expect(new TextDecoder().decode(decrypted)).toBe("old secret");
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toBe(1);
        expect(spy.mock.calls[0][1].recipientPrivateKey).toBe(target.privateKey);
    });

    it("picks the key named by subject key identifier without trial and error", async () => {
        const [active, target] = await Promise.all([makeIdentity(), makeIdentity({ withSki: true })]);
        const ski = (parseCert(target.certDer).extensions!.find((e) => e.extnID === "2.5.29.14")!.parsedValue as asn1js.OctetString).valueBlock.valueHexView;
        const recipientPublicKey = await crypto.subtle.importKey(
            "spki",
            await crypto.subtle.exportKey("spki", target.keys.publicKey),
            { name: "ECDH", namedCurve: "P-256" },
            true,
            [],
        );
        const der = await envelope(async (enveloped) => {
            enveloped.addRecipientByCertificate(parseCert(active.certDer));
            enveloped.addRecipientByKeyIdentifier(recipientPublicKey, ski.slice().buffer);
        });
        const spy = decryptSpy();

        const decrypted = await decryptEnvelopedDataWithKeys(der, [
            { certDer: (await makeIdentity()).certDer, privateKey: active.privateKey }, // no SKI extension at all
            { certDer: target.certDer, privateKey: target.privateKey },
        ]);

        expect(new TextDecoder().decode(decrypted)).toBe("old secret");
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toBe(1);
    });

    it("matches RSA key transport recipients by issuer and serial number", async () => {
        const rsaKeys = await crypto.subtle.generateKey(
            { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
            true,
            ["sign", "verify"],
        );
        const rsaCert = await x509.X509CertificateGenerator.createSelfSigned({
            serialNumber: "7f",
            name: "CN=rsa@example.com",
            notBefore: new Date(Date.now() - DAY),
            notAfter: new Date(Date.now() + DAY),
            signingAlgorithm: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            keys: rsaKeys,
        });
        const rsaPrivate = await crypto.subtle.importKey(
            "pkcs8",
            await crypto.subtle.exportKey("pkcs8", rsaKeys.privateKey),
            { name: "RSA-OAEP", hash: "SHA-512" },
            false,
            ["decrypt"],
        );
        const ec = await makeIdentity();
        const certDer = new Uint8Array(rsaCert.rawData);
        const der = await encryptForRecipients(PLAINTEXT, [ec.certDer, certDer]);
        const spy = decryptSpy();

        const decrypted = await decryptEnvelopedDataWithKeys(der, [
            { certDer: (await makeIdentity()).certDer, privateKey: ec.privateKey },
            { certDer, privateKey: rsaPrivate },
        ]);

        expect(new TextDecoder().decode(decrypted)).toBe("old secret");
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("falls back to trial decryption for a reissued certificate of the same key (active key first)", async () => {
        const original = await makeIdentity();
        const reissued = await makeIdentity({ keys: original.keys });
        const der = await encryptForRecipients(PLAINTEXT, [original.certDer]);
        const decoy = await makeIdentity();
        const spy = decryptSpy();

        const decrypted = await decryptEnvelopedDataWithKeys(der, [
            { certDer: decoy.certDer, privateKey: decoy.privateKey },
            { certDer: reissued.certDer, privateKey: reissued.privateKey },
        ]);

        expect(new TextDecoder().decode(decrypted)).toBe("old secret");
        expect(spy.mock.calls.map((call) => call[1].recipientPrivateKey)).toEqual([decoy.privateKey, reissued.privateKey]);
    });

    it("does not retry a matched slot that failed, and throws the last error when nothing opens", async () => {
        const [target, wrong] = await Promise.all([makeIdentity(), makeIdentity()]);
        const der = await encryptForRecipients(PLAINTEXT, [target.certDer]);
        const spy = decryptSpy();

        await expect(decryptEnvelopedDataWithKeys(der, [{ certDer: target.certDer, privateKey: wrong.privateKey }])).rejects.toBeInstanceOf(Error);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("skips non-certificate recipients (KEK) when matching", async () => {
        const target = await makeIdentity();
        const der = await envelope((enveloped) => {
            enveloped.addRecipientByPreDefinedData(new Uint8Array(32).fill(7).buffer, {}, 1);
            enveloped.addRecipientByCertificate(parseCert(target.certDer));
        });
        const spy = decryptSpy();

        const decrypted = await decryptEnvelopedDataWithKeys(der, [{ certDer: target.certDer, privateKey: target.privateKey }]);

        expect(new TextDecoder().decode(decrypted)).toBe("old secret");
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toBe(1);
    });

    it(`considers at most ${MAX_DECRYPTION_KEYS} keys`, async () => {
        const target = await makeIdentity();
        const der = await encryptForRecipients(PLAINTEXT, [target.certDer]);
        const decoy = await makeIdentity();
        const decoys = Array.from({ length: MAX_DECRYPTION_KEYS }, () => ({ certDer: decoy.certDer, privateKey: decoy.privateKey }));

        await expect(decryptEnvelopedDataWithKeys(der, [...decoys, { certDer: target.certDer, privateKey: target.privateKey }])).rejects.toBeInstanceOf(Error);
        await expect(decryptEnvelopedDataWithKeys(der, [...decoys.slice(1), { certDer: target.certDer, privateKey: target.privateKey }])).resolves.toEqual(
            PLAINTEXT,
        );
    });

    it(`bounds trial decryptions after the first key to ${MAX_TRIAL_DECRYPTIONS}`, async () => {
        const slots = 5;
        const der = await envelope((enveloped) => {
            for (let i = 0; i < slots; i++) {
                enveloped.addRecipientByPreDefinedData(new Uint8Array(32).fill(i + 1).buffer, {}, 1);
            }
        });
        const decoy = await makeIdentity();
        const keys = Array.from({ length: MAX_DECRYPTION_KEYS }, () => ({ certDer: decoy.certDer, privateKey: decoy.privateKey }));
        const spy = decryptSpy();

        await expect(decryptEnvelopedDataWithKeys(der, keys)).rejects.toBeInstanceOf(Error);

        expect(spy).toHaveBeenCalledTimes(slots + MAX_TRIAL_DECRYPTIONS);
    });

    it("skips an unparseable candidate certificate, and throws when no candidate is usable", async () => {
        const target = await makeIdentity();
        const der = await encryptForRecipients(PLAINTEXT, [target.certDer]);
        const garbage = new Uint8Array([0xff, 0x00, 0x01]);

        await expect(
            decryptEnvelopedDataWithKeys(der, [
                { certDer: garbage, privateKey: target.privateKey },
                { certDer: target.certDer, privateKey: target.privateKey },
            ]),
        ).resolves.toEqual(PLAINTEXT);
        await expect(decryptEnvelopedDataWithKeys(der, [{ certDer: garbage, privateKey: target.privateKey }])).rejects.toThrow(/certificate/i);
        await expect(decryptEnvelopedDataWithKeys(der, [])).rejects.toThrow(/no decryption key/i);
    });

    it("keeps decryptEnvelopedData's single-key behaviour", async () => {
        const [other, target] = await Promise.all([makeIdentity(), makeIdentity()]);
        const der = await encryptForRecipients(PLAINTEXT, [other.certDer, target.certDer]);
        await expect(decryptEnvelopedData(der, target.certDer, target.privateKey)).resolves.toEqual(PLAINTEXT);
        await expect(decryptEnvelopedData(der, (await makeIdentity()).certDer, (await makeIdentity()).privateKey)).rejects.toBeInstanceOf(Error);
    });
});

describe("retained keys are never used to encrypt or sign", () => {
    it("findActivePublicKey skips superseded and compromised keys", async () => {
        const { mailboxKeys } = await rotatedMailbox();
        await unlockWithPassword(MAILBOX_UID, mailboxKeys, PASSWORD);
        const unlocked: UnlockedKeys | undefined = getUnlockedKeys(MAILBOX_UID);
        expect(findActivePublicKey(mailboxKeys, "encrypt")!.fingerprint).toBe(unlocked!.encryptionFingerprint);
        expect(unlocked!.signingPrivateKey).toBeUndefined();
    });
});
