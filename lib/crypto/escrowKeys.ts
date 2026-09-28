///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Generates an escrow scope's key pair in the browser, for an administrator setting up escrow without an existing
 * PKI. The certificate goes to the server (as the scope's public key, which mailbox master keys are wrapped to);
 * the private key never does - the administrator must download it and hand it to the scope's holders, whose
 * offline tooling is the only thing that can ever unwrap an escrowed master key. Losing it makes every escrow
 * wrap made to this scope permanently unusable.
 *
 * The key is P-256, like every other key in this app: the certificate is signed with it as ECDSA, and holders
 * re-import the same key material as ECDH to decrypt (see `keys.ts`'s `importPrivateKeyPkcs8()`).
 */
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import type { EscrowScopePublicKey } from "../admin/escrowScopesApi.js";
import { toBase64 } from "./encoding.js";
import { computeCertFingerprint } from "./smime.js";

x509.cryptoProvider.set(crypto);

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GeneratedEscrowKeys {
    certificateDer: Uint8Array;
    certificatePem: string;
    /** PKCS#8, PEM encoded. */
    privateKeyPem: string;
    /** Ready to pass as `createEscrowScope()`'s `publicKey`. */
    publicKey: EscrowScopePublicKey;
}

function toPem(label: string, der: Uint8Array): string {
    const lines = toBase64(der).match(/.{1,64}/g) ?? [];
    return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** A random, positive certificate serial number, hex encoded. */
function randomSerial(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[0] &= 0x7f;
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function generateEscrowKeyPair(options: { name: string; validDays: number; now?: Date }): Promise<GeneratedEscrowKeys> {
    const notBefore = options.now ?? new Date();
    const notAfter = new Date(notBefore.getTime() + options.validDays * DAY_MS);
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]));
    const certificate = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: randomSerial(),
        // Structural name, never string-interpolated - see keys.ts's identical note on RDN injection.
        name: [{ CN: [options.name] }],
        notBefore,
        notAfter,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys,
        extensions: [new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyAgreement | x509.KeyUsageFlags.digitalSignature, true)],
    });
    const certificateDer = new Uint8Array(certificate.rawData);
    const privateKeyDer = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
    return {
        certificateDer,
        certificatePem: toPem("CERTIFICATE", certificateDer),
        privateKeyPem: toPem("PRIVATE KEY", privateKeyDer),
        publicKey: {
            publicKey: toBase64(certificateDer),
            type: "x509",
            fingerprint: await computeCertFingerprint(certificateDer),
            notBefore: notBefore.getTime(),
            notAfter: notAfter.getTime(),
        },
    };
}
