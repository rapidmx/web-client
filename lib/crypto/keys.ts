///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Client-side keypair generation for `specs/end-to-end_encryption.md`'s "Keypair Generation & Storage":
 * on first sign-in, the client generates two ECC P-256 keypairs (signing, encryption) and builds a
 * PKCS#10 CSR for each — `keyvaultApi.ts`'s `enrollKey()` then either submits the encryption CSR to the
 * server's internal CA (`useType: "encrypt"`), or, for signing, the CSR is sent through the separate,
 * asynchronous public-CA enrollment flow this repo doesn't drive directly (`useType: "sign"` expects an
 * already-issued certificate — see `keyvaultApi.ts`'s `EnrollKeyInput` doc comment).
 *
 * Both keys are generated as WebCrypto `ECDSA` keypairs (`sign`/`verify` usages) even though the
 * encryption key is only ever used, once issued, for key-agreement operations, never for signing a
 * message — a PKCS#10 CSR must itself be signed by the key it certifies (proof of possession), which
 * requires a signing-capable `CryptoKey`. The issued certificate's own `keyUsage` extension (set
 * server-side — see `@rapidmx/restapi`'s `LocalX509CertificateAuthority`) is what actually restricts the
 * encryption key to key-agreement use; nothing in this module relies on that restriction, it only
 * generates the keypair and proves possession of it. The same underlying P-256 key material is
 * re-imported under the `ECDH` algorithm tag by `crypto/smime.ts` when it's actually used to encrypt/
 * decrypt (see `exportPrivateKeyPkcs8()`'s own doc comment) — WebCrypto ties an algorithm to a
 * `CryptoKey` object, not to the underlying key material itself, so this is the same key, re-imported.
 *
 * ECC P-256, not RSA, per the spec: "roughly halves the size of the Autocrypt-style header carried on
 * every outgoing message" versus RSA-2048.
 */

/**
 * `@peculiar/x509` (with its `tsyringe`/`reflect-metadata` and ASN.1 dependencies) is only needed to build a CSR - once per
 * mailbox, at first-time key setup or a rotation - but this module is imported by `keySession.ts`, which every page's shell
 * reaches. It is therefore loaded on first use, so it stays out of every page's initial JavaScript.
 *
 * `reflect-metadata` is awaited first on its own: `tsyringe` (a dependency of `@peculiar/x509`) throws "tsyringe requires a
 * reflect polyfill" when it evaluates before the polyfill has.
 *
 * The global `crypto` (WebCrypto) is what a browser tab or Electron renderer already provides natively - no polyfill needed,
 * unlike Node's own global `crypto`, which @peculiar/x509's server-side usage in @rapidmx/restapi has to opt into explicitly
 * (see that repo's `LocalX509CertificateAuthority.ts`).
 */
async function loadX509(): Promise<typeof import("@peculiar/x509")> {
    await import("reflect-metadata");
    const x509 = await import("@peculiar/x509");
    x509.cryptoProvider.set(crypto);
    return x509;
}

const KEY_ALGORITHM: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
const CSR_SIGNING_ALGORITHM: EcdsaParams & Algorithm = { name: "ECDSA", hash: "SHA-256" };

export interface GeneratedKeyPair {
    keyPair: CryptoKeyPair;
    /** PEM-encoded PKCS#10 CSR, ready to pass as `keyvaultApi.ts`'s `EnrollKeyInput.csr`. */
    csrPem: string;
}

/**
 * Generates a fresh P-256 keypair and a self-signed PKCS#10 CSR naming `mailboxAddress` as the subject
 * common name. `useType` only affects the CSR's own extensions (`emailProtection` EKU either way, since
 * both signing and encryption certs are used for S/MIME) — actual key-usage restriction happens
 * server-side at issuance, not here; this function only proves possession of the generated key.
 */
export async function generateKeyPairWithCsr(mailboxAddress: string, useType: "sign" | "encrypt"): Promise<GeneratedKeyPair> {
    const x509 = await loadX509();
    const keyPair = await crypto.subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"]);
    const csr = await x509.Pkcs10CertificateRequestGenerator.create({
        // Structural (array-of-object) subject name, matching @rapidmx/restapi's own CA-side convention -
        // never string-interpolated, so a mailbox address containing RDN-special characters (`,`, `+`,
        // `=`) can't inject an extra attribute into the subject DN.
        name: [{ CN: [mailboxAddress] }],
        keys: keyPair,
        signingAlgorithm: CSR_SIGNING_ALGORITHM,
        extensions: [
            new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.4"] /* emailProtection */, false),
        ],
    });
    return { keyPair, csrPem: csr.toString("pem") };
}

/** Exports a private key as raw PKCS#8 bytes — the form AEAD-sealed under MK (see `masterKey.ts`) before
 * being uploaded via `keyvaultApi.ts`'s `enrollKey()`. */
export async function exportPrivateKeyPkcs8(privateKey: CryptoKey): Promise<Uint8Array> {
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
    return new Uint8Array(pkcs8);
}

/**
 * Re-imports a PKCS#8 private key for a specific algorithm/usage — used both to restore a signing key
 * after unwrapping it (`algorithm: "ECDSA"`, `usages: ["sign"]`) and, by `crypto/smime.ts`, to reinterpret
 * the same P-256 encryption key material for actual key-agreement operations (`algorithm: "ECDH"`,
 * `usages: ["deriveBits"]`) — see this module's own doc comment for why one physical key supports both.
 *
 * Imported **non-extractable by default**: signing/ECDH (including pkijs's own `SignedData.sign()`/
 * `EnvelopedData.decrypt()`, which use a `CryptoKey` recipient key directly) never need to read the key
 * material back out, so a script that obtains the `CryptoKey` object can use it but not exfiltrate it.
 * Pass `extractable: true` only for a path that genuinely has to re-export the PKCS#8 bytes (see
 * `keySession.ts`'s `unlockWithPassword()` for the one current case, and why).
 */
export async function importPrivateKeyPkcs8(
    raw: Uint8Array,
    algorithm: EcKeyImportParams,
    usages: KeyUsage[],
    extractable: boolean = false,
): Promise<CryptoKey> {
    return crypto.subtle.importKey("pkcs8", raw as BufferSource, algorithm, extractable, usages);
}
