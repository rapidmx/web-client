///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Zero-access keys (restapi `specs/search.md` §3): the per-mailbox keypair the server encrypts mail at rest to on arrival.
 * Generated here like the encryption key - P-256, its certificate issued by restapi's internal CA from a CSR, its PKCS#8
 * private key sealed under the mailbox master key - but never published: restapi keeps the certificate on
 * `Mailbox.zeroAccessKeys` and returns it only with the vault.
 */
import type { ApiClient } from "../util/api.js";
import { fromBase64 } from "./encoding.js";
import { type KeyVault, enrollKey, getKeyVault } from "./keyvaultApi.js";
import { exportPrivateKeyPkcs8, generateKeyPairWithCsr, importPrivateKeyPkcs8 } from "./keys.js";
import { addZeroAccessKey, getUnlockedKeys, type RetainedEncryptionKey, ZERO_ACCESS_PRIVATE_KEY_AAD_PURPOSE } from "./keySession.js";
import { buildAad, sealWithKey } from "./masterKey.js";

/** What `provisionZeroAccessKey()` resolves with. */
export interface ProvisionedZeroAccessKey {
    /** The vault as restapi returned it after the enrollment. */
    vault: KeyVault;
    /** The new key, ready to decrypt with (its private key imported non-extractable for ECDH). */
    key: RetainedEncryptionKey;
}

/**
 * Generates a zero-access keypair for `mailboxUid`, seals its private key under `masterKey` and enrolls it. The key becomes
 * the mailbox's active zero-access key (restapi supersedes any earlier one, whose private key stays in the vault). Pass the
 * vault's `masterKeyGeneration` read alongside `masterKey` as `expectedMasterKeyGeneration`, so restapi refuses (`409`)
 * the key if another device rotated the master key meanwhile.
 */
export async function provisionZeroAccessKey(
    mailboxUid: string,
    mailboxAddress: string,
    masterKey: Uint8Array,
    expectedMasterKeyGeneration?: number,
    client?: ApiClient,
): Promise<ProvisionedZeroAccessKey> {
    const { keyPair, csrPem } = await generateKeyPairWithCsr(mailboxAddress, "encrypt");
    const raw = await exportPrivateKeyPkcs8(keyPair.privateKey);
    try {
        const sealed = await sealWithKey(masterKey, raw, buildAad(mailboxUid, ZERO_ACCESS_PRIVATE_KEY_AAD_PURPOSE));
        const vault = await enrollKey(
            mailboxUid,
            {
                useType: "zero-access",
                csr: csrPem,
                wrappedKey: { ciphertext: sealed.ciphertext, nonce: sealed.nonce, algorithm: "AES-256-GCM" },
                ...(expectedMasterKeyGeneration !== undefined ? { expectedMasterKeyGeneration } : {}),
            },
            client,
        );
        // restapi appends the new wrapped key last.
        const enrolled = [...vault.wrappedKeys].reverse().find((k) => k.useType === "zero-access");
        const certificate = enrolled && vault.zeroAccessKeys?.find((k) => k.fingerprint === enrolled.fingerprint);
        if (!enrolled || !certificate) {
            throw new Error("The server did not return the enrolled zero-access key.");
        }
        const privateKey = await importPrivateKeyPkcs8(raw, { name: "ECDH", namedCurve: "P-256" }, ["deriveBits"], false);
        return { vault, key: { fingerprint: enrolled.fingerprint, certDer: fromBase64(certificate.publicKey), privateKey } };
    } finally {
        raw.fill(0);
    }
}

/** Provisions already in flight, per mailbox - a second caller (another effect, a re-render) joins the first. */
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Gives an unlocked mailbox a zero-access key when it has none yet - how a mailbox set up before zero-access encryption
 * existed gets one, on its owner's next unlock. Resolves `true` when it enrolled a key (and added it to the session), `false`
 * when there was nothing to do: the mailbox isn't unlocked, or its vault already holds an unrevoked zero-access key.
 *
 * Only the mailbox's owner may call this (restapi refuses anybody else's enrollment); a caller decides that, e.g. from
 * `KeyEnrollmentGate`'s `canProvision`.
 */
export function ensureZeroAccessKey(mailboxUid: string, mailboxAddress: string, client?: ApiClient): Promise<boolean> {
    const pending = inFlight.get(mailboxUid);
    if (pending) {
        return pending;
    }
    const run = (async (): Promise<boolean> => {
        const unlocked = getUnlockedKeys(mailboxUid);
        if (!unlocked || unlocked.zeroAccessKeys?.length) {
            return false;
        }
        const vault = await getKeyVault(mailboxUid, client);
        if ((vault.zeroAccessKeys ?? []).some((k) => !k.revokedAt) || vault.wrappedKeys.length === 0) {
            return false;
        }
        const { key } = await provisionZeroAccessKey(mailboxUid, mailboxAddress, unlocked.masterKey, vault.masterKeyGeneration, client);
        addZeroAccessKey(mailboxUid, unlocked, key);
        return true;
    })().finally(() => inFlight.delete(mailboxUid));
    inFlight.set(mailboxUid, run);
    return run;
}
