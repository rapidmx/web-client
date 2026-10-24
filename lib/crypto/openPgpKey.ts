///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The mailbox's own OpenPGP key (restapi `specs/end-to-end_encryption.md` *OpenPGP Interoperability*): generated here, its secret
 * key sealed under the master key like every other private key, its certificate enrolled with restapi - which publishes it on the
 * RapidMX discovery endpoint, the Web Key Directory and in an `Autocrypt` header, so OpenPGP users (Proton Mail and others) can
 * encrypt to the mailbox. S/MIME stays the mailbox's own format; this key is for correspondents who can't receive S/MIME.
 */
import type { ApiClient } from "../util/api.js";
import { type KeyVault, OPENPGP_KEY_TYPE, enrollKey, getEncryptionPolicy, getKeyVault, isOpenPgpKey, recordKeyExport } from "./keyvaultApi.js";
import { addOpenPgpKey, getUnlockedKeys, OPENPGP_PRIVATE_KEY_AAD_PURPOSE, openMasterKeyWithPassword } from "./keySession.js";
import type { OpenPgpPrivateKey } from "./openpgp.js";
import { buildAad, openWithKey, sealWithKey } from "./masterKey.js";

/**
 * Generates an OpenPGP key for `mailboxAddress` (`openpgp.ts`'s `generateOpenPgpKey()`), seals its secret key under `masterKey`
 * and enrolls it; restapi makes it the mailbox's active OpenPGP key, superseding any earlier one. Pass the vault's
 * `masterKeyGeneration` read with `masterKey` as `expectedMasterKeyGeneration` (`409` when another device rotated it meanwhile).
 * Resolves with the vault and the new key, ready to decrypt and sign with.
 */
export async function provisionOpenPgpKey(
    mailboxUid: string,
    mailboxAddress: string,
    masterKey: Uint8Array,
    expectedMasterKeyGeneration?: number,
    displayName?: string,
    client?: ApiClient,
): Promise<{ vault: KeyVault; key: { fingerprint: string; privateKey: OpenPgpPrivateKey } }> {
    const { generateOpenPgpKey, readSecretKey } = await import("./openpgp.js");
    const generated = await generateOpenPgpKey(mailboxAddress, displayName);
    try {
        const sealed = await sealWithKey(masterKey, generated.secretKey, buildAad(mailboxUid, OPENPGP_PRIVATE_KEY_AAD_PURPOSE));
        const vault = await enrollKey(
            mailboxUid,
            {
                useType: "encrypt",
                type: OPENPGP_KEY_TYPE,
                publicKey: generated.armoredPublicKey,
                wrappedKey: { ciphertext: sealed.ciphertext, nonce: sealed.nonce, algorithm: "AES-256-GCM" },
                ...(expectedMasterKeyGeneration !== undefined ? { expectedMasterKeyGeneration } : {}),
            },
            client,
        );
        return { vault, key: { fingerprint: generated.fingerprint, privateKey: await readSecretKey(generated.secretKey) } };
    } finally {
        generated.secretKey.fill(0);
    }
}

/** Provisions already in flight, per mailbox - a second caller joins the first. */
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Gives an unlocked mailbox an OpenPGP key when it has none - how every mailbox, including one set up before OpenPGP was
 * supported, gets one on its owner's next unlock. Resolves `true` when it enrolled one, `false` when there was nothing to do:
 * the mailbox isn't unlocked, the server doesn't allow OpenPGP (`EncryptionPolicy.allowOpenPgp`), the vault isn't set up yet, or it
 * already holds an OpenPGP key. Only the mailbox's owner may call this (restapi refuses anybody else's enrollment).
 */
export function ensureOpenPgpKey(mailboxUid: string, mailboxAddress: string, displayName?: string, client?: ApiClient): Promise<boolean> {
    const pending = inFlight.get(mailboxUid);
    if (pending) {
        return pending;
    }
    const run = (async (): Promise<boolean> => {
        const unlocked = getUnlockedKeys(mailboxUid);
        if (!unlocked || unlocked.shared || unlocked.openPgpKeys?.length) {
            return false;
        }
        const policy = await getEncryptionPolicy(client);
        if (policy.allowOpenPgp !== true) {
            return false;
        }
        const vault = await getKeyVault(mailboxUid, client);
        if (vault.wrappedKeys.length === 0 || vault.wrappedKeys.some((k) => isOpenPgpKey(k))) {
            return false;
        }
        const { key } = await provisionOpenPgpKey(mailboxUid, mailboxAddress, unlocked.masterKey, vault.masterKeyGeneration, displayName, client);
        addOpenPgpKey(mailboxUid, unlocked, key);
        return true;
    })().finally(() => inFlight.delete(mailboxUid));
    inFlight.set(mailboxUid, run);
    return run;
}

/**
 * The mailbox's active OpenPGP secret key, armored and protected with `passphrase` - for a user who reads this mailbox's OpenPGP
 * mail in another OpenPGP app too (Thunderbird, GnuPG...). Like the PKCS#12 export (`keyExport.ts`) it re-opens the vault with
 * the master password, whatever the session, never touches the session's keys, and is recorded with restapi (kind `encrypt`).
 * Throws when the mailbox has no OpenPGP key.
 */
export async function exportOpenPgpSecretKey(
    mailboxUid: string,
    masterPassword: string,
    passphrase: string,
    client?: ApiClient,
): Promise<{ armored: string; fingerprint: string }> {
    const { readSecretKey, exportProtectedSecretKey } = await import("./openpgp.js");
    const { vault, masterKey } = await openMasterKeyWithPassword(mailboxUid, masterPassword, client);
    try {
        // The newest OpenPGP key enrolled is the active one (restapi appends, and supersedes the earlier ones).
        const wrapped = [...vault.wrappedKeys].reverse().find((k) => isOpenPgpKey(k));
        if (!wrapped) {
            throw new Error("This mailbox has no OpenPGP key to export.");
        }
        const raw = await openWithKey(masterKey, wrapped, buildAad(mailboxUid, OPENPGP_PRIVATE_KEY_AAD_PURPOSE));
        try {
            const armored = await exportProtectedSecretKey(await readSecretKey(raw), passphrase);
            await recordKeyExport(mailboxUid, [{ kind: "encrypt", fingerprint: wrapped.fingerprint }], client);
            return { armored, fingerprint: wrapped.fingerprint };
        } finally {
            raw.fill(0);
        }
    } finally {
        masterKey.fill(0);
    }
}
