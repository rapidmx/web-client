///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * "Export keys for Outlook/phone" (restapi `specs/search.md` §3, *Clients that don't run RapidMX*): a passphrase-protected
 * PKCS#12 file holding the private keys a mail client needs to read this mailbox's mail on its own - every zero-access key
 * (mail at rest is S/MIME `enveloped-data` to these) and every end-to-end encryption key (current and retained), plus, only
 * when asked, the active signing key. Built entirely here from a fresh master-password unlock: the session's own private
 * keys are non-extractable, and the server never sees the file or the passphrase. restapi only records that an export
 * happened (`key_vault.export`), with the fingerprints exported and nothing else.
 */
import "reflect-metadata";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import type { ApiClient } from "../util/api.js";
import { fromBase64 } from "./encoding.js";
import { type KeyVault, type PublicKey, findActivePublicKey, recordKeyExport, type WrappedPrivateKey } from "./keyvaultApi.js";
import {
    ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE,
    MAX_RETAINED_ENCRYPTION_KEYS,
    openMasterKeyWithPassword,
    SIGNING_PRIVATE_KEY_AAD_PURPOSE,
    ZERO_ACCESS_PRIVATE_KEY_AAD_PURPOSE,
} from "./keySession.js";
import { buildAad, openWithKey } from "./masterKey.js";

/** PBKDF2 iterations for the shrouded key bags and the PKCS#12 MAC. Windows, macOS and iOS all accept this. */
export const KEY_EXPORT_ITERATIONS = 100_000;

/** The shortest export passphrase accepted. The file grants read access to all of this mailbox's mail. */
export const MIN_EXPORT_PASSPHRASE_LENGTH = 12;

const PKCS8_SHROUDED_KEY_BAG = "1.2.840.113549.1.12.10.1.2";
const CERT_BAG = "1.2.840.113549.1.12.10.1.3";
const X509_CERTIFICATE = "1.2.840.113549.1.9.22.1";
const FRIENDLY_NAME = "1.2.840.113549.1.9.20";
const LOCAL_KEY_ID = "1.2.840.113549.1.9.21";

/** The shrouded key bags' cipher. pkijs's type wants an `iv`, but it generates a fresh one for every bag and ignores this one. */
const AES_256_CBC = { name: "AES-CBC", length: 256, iv: new Uint8Array(16) } as pkijs.ContentEncryptionAlgorithm;

/** Which key a bag holds, for its friendly name and the export's audit record. */
export type ExportedKeyKind = "zero-access" | "encrypt" | "sign";

/** What `exportKeysAsPkcs12()` takes. */
export interface KeyExportInput {
    mailboxUid: string;
    /** The mailbox's address, used in each key's friendly name. */
    mailboxAddress: string;
    /** The mailbox's published keys (`Mailbox.keys`): the encryption and signing certificates. */
    mailboxKeys: PublicKey[];
    /** The master password, for the fresh unlock every export needs. */
    masterPassword: string;
    /** Protects the PKCS#12 file. At least `MIN_EXPORT_PASSPHRASE_LENGTH` characters. */
    exportPassphrase: string;
    /** Whether to include the active signing key, for clients that will sign. Off unless the user opts in. */
    includeSigningKey?: boolean;
}

/** One key in the export. */
export interface ExportedKey {
    kind: ExportedKeyKind;
    fingerprint: string;
}

/** What `exportKeysAsPkcs12()` resolves with. */
export interface KeyExport {
    /** The DER-encoded PKCS#12 (`.p12`) file. */
    pkcs12: Uint8Array;
    /** The keys it holds, zero-access keys first. */
    keys: ExportedKey[];
}

/** One private key opened from the vault, before it goes into a bag. Its `pkcs8` is zeroed once the file is built. */
interface OpenedKey extends ExportedKey {
    certDer: Uint8Array;
    pkcs8: Uint8Array;
}

/** The export has nothing to hold - the vault has no zero-access or encryption private key this password opens. */
export class NothingToExportError extends Error {
    constructor() {
        super("This mailbox has no keys to export yet.");
        this.name = "NothingToExportError";
    }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function hexBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

function bagAttributes(friendlyName: string, localKeyId: Uint8Array): pkijs.Attribute[] {
    return [
        new pkijs.Attribute({ type: FRIENDLY_NAME, values: [new asn1js.BmpString({ value: friendlyName })] }),
        new pkijs.Attribute({ type: LOCAL_KEY_ID, values: [new asn1js.OctetString({ valueHex: toArrayBuffer(localKeyId) })] }),
    ];
}

function friendlyName(kind: ExportedKeyKind, address: string, index: number): string {
    const label = kind === "zero-access" ? "zero-access key" : kind === "encrypt" ? "encryption key" : "signing key";
    return `RapidMX ${label} (${address})${index > 0 ? ` ${index + 1}` : ""}`;
}

/** Opens one wrapped private key to its raw PKCS#8, or `undefined` when it won't open under this master key - an export
 * carries what it can rather than failing on one stale wrap. */
async function openPkcs8(masterKey: Uint8Array, wrapped: WrappedPrivateKey, aad: Uint8Array): Promise<Uint8Array | undefined> {
    try {
        return await openWithKey(masterKey, wrapped, aad);
    } catch {
        return undefined;
    }
}

/** Opens every key the export holds, in order: zero-access keys (unrevoked newest first), the encryption keys (active
 * first, then retained newest first), then the active signing key if asked. Each list is capped like the session's. */
async function openExportedKeys(input: KeyExportInput, vault: KeyVault, masterKey: Uint8Array): Promise<OpenedKey[]> {
    const opened: OpenedKey[] = [];
    const wrappedFor = (fingerprint: string) => vault.wrappedKeys.find((k) => k.fingerprint === fingerprint);
    const take = async (kind: ExportedKeyKind, keys: { fingerprint: string; publicKey: string }[], purpose: string, max: number) => {
        const aad = buildAad(input.mailboxUid, purpose);
        const seen = new Set<string>();
        for (const key of keys) {
            const wrapped = wrappedFor(key.fingerprint);
            if (!wrapped || seen.has(key.fingerprint) || seen.size === max) {
                continue;
            }
            const pkcs8 = await openPkcs8(masterKey, wrapped, aad);
            if (pkcs8) {
                seen.add(key.fingerprint);
                opened.push({ kind, fingerprint: key.fingerprint, certDer: fromBase64(key.publicKey), pkcs8 });
            }
        }
    };

    const zeroAccess = [...(vault.zeroAccessKeys ?? [])].sort((a, b) => Number(!!a.revokedAt) - Number(!!b.revokedAt) || b.notBefore - a.notBefore);
    await take("zero-access", zeroAccess, ZERO_ACCESS_PRIVATE_KEY_AAD_PURPOSE, MAX_RETAINED_ENCRYPTION_KEYS + 1);

    const active = findActivePublicKey(input.mailboxKeys, "encrypt");
    const encryption = [
        ...(active ? [active] : []),
        ...input.mailboxKeys.filter((k) => k.useType === "encrypt" && k !== active).sort((a, b) => b.notBefore - a.notBefore),
    ];
    await take("encrypt", encryption, ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE, MAX_RETAINED_ENCRYPTION_KEYS + 1);

    if (input.includeSigningKey) {
        const signing = findActivePublicKey(input.mailboxKeys, "sign");
        await take("sign", signing ? [signing] : [], SIGNING_PRIVATE_KEY_AAD_PURPOSE, 1);
    }
    return opened;
}

/** Builds the PKCS#12 file: one PBES2 (PBKDF2-SHA256, AES-256-CBC) shrouded key bag and one certificate bag per key,
 * paired by `localKeyID`, in an unencrypted SafeContents, under a SHA-256 MAC. */
async function buildPkcs12(keys: OpenedKey[], address: string, passphrase: string): Promise<Uint8Array> {
    const crypto = pkijs.getCrypto(true);
    // UTF-8 for both: pkijs re-encodes it as the BMPString the PKCS#12 MAC derivation (RFC 7292 Appendix B) takes.
    const utf8 = toArrayBuffer(new TextEncoder().encode(passphrase));
    const bags: pkijs.SafeBag[] = [];
    const shrouded: pkijs.PKCS8ShroudedKeyBag[] = [];
    const counts: Record<ExportedKeyKind, number> = { "zero-access": 0, encrypt: 0, sign: 0 };

    for (const key of keys) {
        const name = friendlyName(key.kind, address, counts[key.kind]++);
        const localKeyId = hexBytes(key.fingerprint).slice(0, 20);
        const keyBag = new pkijs.PKCS8ShroudedKeyBag({ parsedValue: pkijs.PrivateKeyInfo.fromBER(toArrayBuffer(key.pkcs8)) });
        shrouded.push(keyBag);
        bags.push(new pkijs.SafeBag({ bagId: PKCS8_SHROUDED_KEY_BAG, bagValue: keyBag, bagAttributes: bagAttributes(name, localKeyId) }));
        const certBag = new pkijs.CertBag({ certId: X509_CERTIFICATE, parsedValue: pkijs.Certificate.fromBER(toArrayBuffer(key.certDer)) });
        bags.push(new pkijs.SafeBag({ bagId: CERT_BAG, bagValue: certBag, bagAttributes: bagAttributes(name, localKeyId) }));
    }

    for (const keyBag of shrouded) {
        await keyBag.makeInternalValues(
            { password: utf8, contentEncryptionAlgorithm: AES_256_CBC, hmacHashAlgorithm: "SHA-256", iterationCount: KEY_EXPORT_ITERATIONS },
            crypto,
        );
    }

    const pfx = new pkijs.PFX({
        parsedValue: {
            integrityMode: 0,
            authenticatedSafe: new pkijs.AuthenticatedSafe({ parsedValue: { safeContents: [{ privacyMode: 0, value: new pkijs.SafeContents({ safeBags: bags }) }] } }),
        },
    });
    await pfx.parsedValue!.authenticatedSafe!.makeInternalValues({ safeContents: [{}] }, crypto);
    await pfx.makeInternalValues(
        { password: utf8, iterations: KEY_EXPORT_ITERATIONS, pbkdf2HashAlgorithm: { name: "SHA-256" }, hmacHashAlgorithm: "SHA-256" },
        crypto,
    );
    return new Uint8Array(pfx.toSchema().toBER(false));
}

/**
 * Builds the "Export keys for Outlook/phone" PKCS#12 for `input.mailboxUid` (see this module's comment) and records the
 * export with restapi. Re-opens the vault with `masterPassword` - rejecting as `unlockWithPassword()` does on a wrong
 * one - and never touches the in-memory session. Every opened private key and the master key are zeroed before this
 * returns, whether or not it succeeds. Throws `NothingToExportError` when no key opens.
 */
export async function exportKeysAsPkcs12(input: KeyExportInput, client?: ApiClient): Promise<KeyExport> {
    if (input.exportPassphrase.length < MIN_EXPORT_PASSPHRASE_LENGTH) {
        throw new Error(`The export passphrase must be at least ${MIN_EXPORT_PASSPHRASE_LENGTH} characters.`);
    }
    const { vault, masterKey } = await openMasterKeyWithPassword(input.mailboxUid, input.masterPassword, client);
    let opened: OpenedKey[] = [];
    try {
        opened = await openExportedKeys(input, vault, masterKey);
        if (!opened.some((k) => k.kind !== "sign")) {
            throw new NothingToExportError();
        }
        const pkcs12 = await buildPkcs12(opened, input.mailboxAddress, input.exportPassphrase);
        const keys = opened.map(({ kind, fingerprint }) => ({ kind, fingerprint }));
        await recordKeyExport(input.mailboxUid, keys, client);
        return { pkcs12, keys };
    } finally {
        masterKey.fill(0);
        for (const key of opened) {
            key.pkcs8.fill(0);
        }
    }
}
