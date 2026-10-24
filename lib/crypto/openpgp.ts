///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * OpenPGP keys (restapi `specs/end-to-end_encryption.md` *OpenPGP Interoperability*): the mailbox's own key, generated here, and the
 * keys of correspondents who use OpenPGP (Proton Mail, Thunderbird, GnuPG). Built on OpenPGP.js - which runs on WebCrypto and audited
 * curve code, never OpenSSL - and loaded only when OpenPGP is used: this module is only ever imported dynamically.
 *
 * S/MIME stays RapidMX's own format; an OpenPGP key exists so OpenPGP users can reach RapidMX users, and RapidMX users them.
 */
import * as openpgp from "openpgp";
import { fromBase64, toBase64 } from "./encoding.js";

export type OpenPgpPrivateKey = openpgp.PrivateKey;
export type OpenPgpPublicKey = openpgp.PublicKey;

/** A freshly generated key: the public certificate to publish and the secret key to seal under the master key. */
export interface GeneratedOpenPgpKey {
    /** Base64 of the binary transferable public key (`PublicKey.publicKey`). */
    publicKey: string;
    /** The same certificate, ASCII armored (what enrollment sends and the user can export). */
    armoredPublicKey: string;
    /** The binary transferable secret key, unencrypted - the caller seals it under the master key and zeroes this copy. */
    secretKey: Uint8Array;
    /** The primary key's fingerprint (40 hex characters for a v4 key, 64 for v6). */
    fingerprint: string;
}

/** Which OpenPGP key version to generate: 4 (RFC 4880, the default - what every OpenPGP app reads, GnuPG included) or 6 (RFC 9580). */
export type OpenPgpKeyVersion = 4 | 6;

/**
 * Generates the mailbox's OpenPGP key: an Ed25519 primary key with a Curve25519 encryption subkey and one user ID,
 * `displayName <address>`, never expiring (rotation replaces it). A v4 key uses the long-established EdDSA/ECDH Curve25519
 * algorithms; a v6 key RFC 9580's Ed25519/X25519. It carries no passphrase: like every other private key, its secret half is
 * sealed under the master key before it leaves this device.
 */
export async function generateOpenPgpKey(address: string, displayName?: string, version: OpenPgpKeyVersion = 4): Promise<GeneratedOpenPgpKey> {
    const userIDs = [{ ...(displayName ? { name: displayName } : {}), email: address }];
    const { privateKey, publicKey } =
        version === 6
            ? await openpgp.generateKey({ type: "curve25519", userIDs, format: "object", config: { v6Keys: true } })
            : await openpgp.generateKey({ type: "ecc", curve: "curve25519Legacy", userIDs, format: "object" });
    return {
        publicKey: toBase64(publicKey.write()),
        armoredPublicKey: publicKey.armor(),
        secretKey: privateKey.write(),
        fingerprint: publicKey.getFingerprint(),
    };
}

/** A rotation's new key with its user ID certified by the key it replaces, so correspondents who pinned the old one accept the
 * new one without asking (restapi `OpenPgpKeyUtils.canReplaceOpenPgpKeyAutomatically()`). */
export async function certifyWithPredecessor(successor: GeneratedOpenPgpKey, predecessor: OpenPgpPrivateKey): Promise<GeneratedOpenPgpKey> {
    const secret = await openpgp.readPrivateKey({ binaryKey: successor.secretKey });
    const certified = await secret.signPrimaryUser([predecessor]);
    const publicKey = certified.toPublic();
    return { ...successor, publicKey: toBase64(publicKey.write()), armoredPublicKey: publicKey.armor(), secretKey: certified.write() };
}

/** The secret key in `bytes` (a sealed `WrappedPrivateKey`'s plaintext), ready to decrypt and sign with. */
export async function readSecretKey(bytes: Uint8Array): Promise<OpenPgpPrivateKey> {
    return await openpgp.readPrivateKey({ binaryKey: bytes });
}

/** The certificate in `base64` (`PublicKey.publicKey`), or `undefined` when it isn't one. */
export async function readPublicKey(base64: string): Promise<OpenPgpPublicKey | undefined> {
    try {
        return await openpgp.readKey({ binaryKey: fromBase64(base64) });
    } catch {
        return undefined;
    }
}

/** Every certificate in an armored or binary key block (e.g. an attached `application/pgp-keys` part, or a pasted one). */
export async function readPublicKeys(block: string | Uint8Array): Promise<OpenPgpPublicKey[]> {
    try {
        const keys =
            typeof block === "string" && block.includes("-----BEGIN PGP PUBLIC KEY BLOCK-----")
                ? await openpgp.readKeys({ armoredKeys: block })
                : await openpgp.readKeys({ binaryKeys: typeof block === "string" ? fromBase64(block.replace(/\s+/g, "")) : block });
        return keys.filter((key) => !key.isPrivate());
    } catch {
        return [];
    }
}

/** The email addresses a certificate's user IDs name with a verifying self-signature, lowercased. */
export async function keyEmails(key: OpenPgpPublicKey): Promise<string[]> {
    const emails: string[] = [];
    for (const user of key.users) {
        const email = user.userID?.email;
        if (email && (await user.verify().then(() => true, () => false))) {
            emails.push(email.toLowerCase());
        }
    }
    return emails;
}

/** A certificate's armored form, for export or for attaching to a message. */
export function armorPublicKey(key: OpenPgpPublicKey): string {
    return key.armor();
}

/** A secret key armored and protected with `passphrase` - the export a user imports into another OpenPGP app. */
export async function exportProtectedSecretKey(key: OpenPgpPrivateKey, passphrase: string): Promise<string> {
    const copy = await openpgp.readPrivateKey({ binaryKey: key.write() });
    return (await openpgp.encryptKey({ privateKey: copy, passphrase })).armor();
}

/** `key`'s public certificate as base64 (`PublicKey.publicKey`). */
export function publicKeyBase64(key: OpenPgpPrivateKey | OpenPgpPublicKey): string {
    return toBase64(key.toPublic().write());
}
