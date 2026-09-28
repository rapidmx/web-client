///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The CMS (S/MIME) engine behind `specs/end-to-end_encryption.md`'s "Message Format" requirement
 * ("RapidMX MUST use S/MIME (CMS) as the on-the-wire message format for both signatures and
 * encryption"). This module operates on raw CMS structures (`SignedData`/`EnvelopedData`) via
 * `pkijs` — the actual MIME assembly (`multipart/signed`, RFC 9788 header protection, the
 * `application/pkcs7-mime` wrapping) is a distinct, mechanical layer built on top of these
 * primitives, not implemented here.
 *
 * Certificates are always the base64-decoded DER bytes — the same wire format
 * `keyvaultApi.ts`'s `PublicKey.publicKey` already uses — never PEM, so this module composes
 * directly with values read from a `Mailbox`/`Contact`'s `keys` array with no reformatting.
 */
import "reflect-metadata";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

// Mirrors keys.ts's own WebCrypto engine setup - both @peculiar/x509 and pkijs need to be told which
// Crypto implementation to use; the browser/Electron renderer's own global `crypto` is exactly what
// both expect (unlike Node's global `crypto`, which @rapidmx/restapi's server-side code has to set up
// differently - see that repo's LocalX509CertificateAuthority.ts). The raw (`crypto`, `crypto.subtle`)
// three-argument form, not `new pkijs.CryptoEngine({...})` - pkijs's own `CryptoEngine` class doesn't
// actually satisfy its own `ICryptoEngine` interface (a real type-definition inconsistency in pkijs
// itself, confirmed via `tsc --noEmit`: `generateKey`'s Ed25519/X25519 overloads don't line up between
// the two), so passing an instance of it here fails to compile even though it works at runtime.
pkijs.setEngine("rapidmx", crypto, crypto.subtle);

/** SHA-256 detached signatures throughout, matching this system's hash-algorithm default everywhere
 * else (fingerprints, HKDF). */
const DIGEST_ALGORITHM = "SHA-256";

/** AES-256-GCM for CMS content encryption, matching `masterKey.ts`'s own AEAD choice - one AEAD
 * construction used consistently across this entire E2E scheme. */
const CONTENT_ENCRYPTION_ALGORITHM: AesKeyGenParams = { name: "AES-GCM", length: 256 };

/** `id-data` (RFC 5652 §4) - the only encapsulated content type S/MIME message signatures use. */
const ID_DATA = pkijs.ContentInfo.DATA;

/** AES-GCM content-encryption OIDs (id-aes128-GCM, id-aes192-GCM, id-aes256-GCM - RFC 5084). The only
 * content encryption `decryptEnvelopedData()` accepts: see `UnsupportedContentEncryptionError`. */
const AEAD_CONTENT_ENCRYPTION_OIDS = new Set(["2.16.840.1.101.3.4.1.6", "2.16.840.1.101.3.4.1.26", "2.16.840.1.101.3.4.1.46"]);

/**
 * Thrown by `decryptEnvelopedData()` for content encrypted with a non-AEAD algorithm (e.g. AES-CBC, 3DES).
 * Unauthenticated CBC content is malleable - an attacker who can't read the message can still flip
 * plaintext bits or mount EFAIL-style exfiltration gadgets against the decrypted HTML - so it is rejected
 * outright rather than rendered with a weaker indicator.
 *
 * Interop note: many legacy S/MIME clients still send AES-CBC `EnvelopedData`; those messages are
 * undecryptable in RapidMX clients by design. Everything RapidMX itself sends uses AES-256-GCM.
 */
export class UnsupportedContentEncryptionError extends Error {
    public readonly algorithmOid: string;

    constructor(algorithmOid: string) {
        super(`This message uses unauthenticated content encryption (${algorithmOid}), which is not accepted.`);
        this.name = "UnsupportedContentEncryptionError";
        this.algorithmOid = algorithmOid;
    }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function parseCertificate(certDer: Uint8Array): pkijs.Certificate {
    const asn1 = asn1js.fromBER(toArrayBuffer(certDer));
    if (asn1.offset === -1) {
        throw new Error("Could not parse the certificate as valid DER/BER.");
    }
    return new pkijs.Certificate({ schema: asn1.result });
}

/**
 * Builds a detached CMS `SignedData` structure over `content`, per the spec's "Digital Signatures"
 * section — detached, never opaque, so clients that don't understand S/MIME still render the
 * message body. The signer's own certificate is embedded in the `certificates` field (never sent
 * separately — unlike the encryption key, which travels in the `RapidMX-Key` header).
 */
export async function signDetached(content: Uint8Array, signingCertDer: Uint8Array, signingPrivateKey: CryptoKey): Promise<Uint8Array> {
    const cert = parseCertificate(signingCertDer);
    const signedData = new pkijs.SignedData({
        // No `eContent` - an omitted eContent is exactly what makes this a *detached* signature per
        // RFC 5652; the actual content is passed to sign()/verify() separately, never embedded here.
        encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: pkijs.ContentInfo.DATA }),
        signerInfos: [
            new pkijs.SignerInfo({
                sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
            }),
        ],
        certificates: [cert],
    });
    await signedData.sign(signingPrivateKey, 0, DIGEST_ALGORITHM, toArrayBuffer(content));

    const contentInfo = new pkijs.ContentInfo({ contentType: pkijs.ContentInfo.SIGNED_DATA, content: signedData.toSchema(true) });
    return new Uint8Array(contentInfo.toSchema().toBER());
}

export interface VerifyResult {
    valid: boolean;
    /** The certificate pkijs matched to the verified SignerInfo's `sid` (never merely the first embedded
     * certificate) - present whenever `valid` is true. Callers
     * compare its fingerprint against the pinned `Contact` key per the spec's Trust Model (TOFU);
     * this function only proves the signature is mathematically valid over `content`, not that the
     * certificate belongs to who the message claims. */
    signerCertificateDer?: Uint8Array;
}

/** Verifies a detached CMS signature (as produced by `signDetached()`) against `content`. A parse
 * failure or content-type mismatch is treated as an invalid signature (`valid: false`), not a thrown
 * error - a malformed/foreign CMS blob is exactly the "signature failed" case the spec's Message
 * Security Indicators table requires being able to render. */
export async function verifyDetached(content: Uint8Array, signatureDer: Uint8Array): Promise<VerifyResult> {
    const signedData = parseSignedData(signatureDer);
    // A detached signature MUST NOT carry encapsulated content: pkijs's verify() silently prefers an
    // embedded eContent over the caller-supplied `data`, so accepting one here would let an attacker take
    // ANY opaque signature the victim ever produced and staple it onto arbitrary content, which would
    // then verify as "signed" (the round-3 review's PoC 1 - see smimeRegressions.test.ts).
    if (!signedData || signedData.encapContentInfo.eContent) {
        return { valid: false };
    }
    return verifySignerZero(signedData, toArrayBuffer(content));
}

/** Parses untrusted DER as a `ContentInfo` wrapping `SignedData` whose `eContentType` is `id-data`.
 * Constructing SignedData from an untrusted schema can throw on a structurally-valid-BER-but-not-
 * actually-SignedData blob - that degrades to `undefined` ("signature failed"), never a thrown error, per
 * the spec's Message Security Indicators (a malformed CMS blob is exactly that state, not a crash). */
function parseSignedData(der: Uint8Array): pkijs.SignedData | undefined {
    try {
        const contentInfo = pkijs.ContentInfo.fromBER(toArrayBuffer(der));
        if (contentInfo.contentType !== pkijs.ContentInfo.SIGNED_DATA) {
            return undefined;
        }
        const signedData = new pkijs.SignedData({ schema: contentInfo.content });
        return signedData.encapContentInfo.eContentType === ID_DATA ? signedData : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Verifies `signerInfos[0]` and returns the certificate pkijs actually matched to that SignerInfo's `sid`
 * (`extendedMode`) - never simply `certificates[0]`, which an attacker controls independently of who
 * signed: embedding the victim's certificate first and signing with their own key (whose certificate is
 * second) previously reported the victim's certificate as the signer (the round-3 review's PoC 2).
 * pkijs throws a `SignedDataVerifyError` for most failures in extended mode; all degrade to invalid.
 */
async function verifySignerZero(signedData: pkijs.SignedData, data?: ArrayBuffer): Promise<VerifyResult> {
    try {
        const result = await signedData.verify({ signer: 0, data, extendedMode: true });
        if (result.signatureVerified !== true || !result.signerCertificate) {
            return { valid: false };
        }
        return { valid: true, signerCertificateDer: new Uint8Array(result.signerCertificate.toSchema().toBER()) };
    } catch {
        return { valid: false };
    }
}

/**
 * Extracts every email address a certificate asserts, lowercased: SAN `rfc822Name` entries when the
 * certificate has any (RFC 5280 §4.2.1.6 - SAN is authoritative when present), otherwise the subject's
 * legacy `emailAddress` attributes plus a `CN` that is itself an email address (how this deployment's
 * own self-signed/test certificates and many older CAs name a mailbox). Used by `messageSecurity.ts` to
 * bind a signer certificate to the message's claimed sender. Returns `[]` for unparseable input -
 * including a certificate whose SubjectAlternativeName extension pkijs couldn't parse (no `parsedValue`),
 * which then fails the identity check (`signature_failed`) rather than throwing out of message evaluation.
 */
export function extractCertificateEmails(certDer: Uint8Array): string[] {
    let cert: pkijs.Certificate;
    try {
        cert = parseCertificate(certDer);
    } catch {
        return [];
    }
    const sanEmails: string[] = [];
    for (const extension of cert.extensions ?? []) {
        if (extension.extnID !== "2.5.29.17") {
            continue;
        }
        // pkijs parses a well-formed SubjectAlternativeName into an AltName automatically, and leaves
        // `parsedValue` unset for a malformed one - a certificate asserting an unreadable SAN names nobody.
        const altNames = (extension.parsedValue as pkijs.AltName | undefined)?.altNames;
        if (!Array.isArray(altNames)) {
            return [];
        }
        for (const name of altNames) {
            // GeneralName type 1 = rfc822Name (an IA5String value).
            if (name.type === 1) {
                sanEmails.push(String(name.value).toLowerCase());
            }
        }
    }
    if (sanEmails.length > 0) {
        return sanEmails;
    }
    const subjectEmails: string[] = [];
    for (const attribute of cert.subject.typesAndValues) {
        const isEmailAttribute = attribute.type === "1.2.840.113549.1.9.1";
        const isCommonName = attribute.type === "2.5.4.3";
        const value = String(attribute.value.valueBlock.value).trim().toLowerCase();
        if (isEmailAttribute || (isCommonName && /^[^\s@]+@[^\s@]+$/.test(value))) {
            subjectEmails.push(value);
        }
    }
    return subjectEmails;
}

/**
 * Builds an *opaque* (content embedded, not detached) CMS `SignedData` structure over `content`.
 * Used only when the signed message is going to be encrypted immediately afterward (`buildMessage()`
 * in `smimeMessage.ts` composes this with `encryptForRecipients()` for the combined sign-then-encrypt
 * case) — the spec's "Digital Signatures" section requires *detached* signing only "for
 * signature-only messages"; once the whole thing is being encrypted regardless, there is no legacy
 * client ever exposed to this intermediate opaque layer, so embedding the content here (simpler than
 * building a second detached `multipart/signed` entity solely to immediately encrypt it) is
 * conformant, not a shortcut around that requirement.
 */
export async function signOpaque(content: Uint8Array, signingCertDer: Uint8Array, signingPrivateKey: CryptoKey): Promise<Uint8Array> {
    const cert = parseCertificate(signingCertDer);
    const signedData = new pkijs.SignedData({
        encapContentInfo: new pkijs.EncapsulatedContentInfo({
            eContentType: pkijs.ContentInfo.DATA,
            eContent: new asn1js.OctetString({ valueHex: toArrayBuffer(content) }),
        }),
        signerInfos: [
            new pkijs.SignerInfo({
                sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
            }),
        ],
        certificates: [cert],
    });
    await signedData.sign(signingPrivateKey, 0, DIGEST_ALGORITHM);

    const contentInfo = new pkijs.ContentInfo({ contentType: pkijs.ContentInfo.SIGNED_DATA, content: signedData.toSchema(true) });
    return new Uint8Array(contentInfo.toSchema().toBER());
}

export interface VerifyOpaqueResult extends VerifyResult {
    /** The embedded content, recovered from the SignedData structure - only present when `valid`. */
    content?: Uint8Array;
}

/** Verifies an opaque CMS signature (as produced by `signOpaque()`) and recovers its embedded
 * content — unlike `verifyDetached()`, the content isn't supplied separately by the caller, since the
 * whole point of an opaque signature is that it carries its own content. */
export async function verifyOpaque(signedDer: Uint8Array): Promise<VerifyOpaqueResult> {
    const signedData = parseSignedData(signedDer);
    const eContent = signedData?.encapContentInfo.eContent;
    if (!signedData || !eContent) {
        return { valid: false };
    }
    const result = await verifySignerZero(signedData);
    if (!result.valid) {
        return { valid: false };
    }
    // `.getValue()`, not `.valueBlock.valueHexView` directly - eContent commonly round-trips as a
    // *constructed* OctetString (an outer OctetString wrapping one or more inner primitive OctetString
    // chunks, standard per RFC 5652), and only `.getValue()` transparently concatenates those chunks;
    // reading `.valueBlock.valueHexView` directly is only correct for a primitive OctetString and
    // silently returns empty bytes otherwise (confirmed by direct reproduction).
    return { ...result, content: new Uint8Array(eContent.getValue()) };
}

/**
 * Builds a CMS `EnvelopedData` structure encrypting `content` to every certificate in
 * `recipientCertDers` — per the spec's "Encrypt to Self" requirement, callers MUST include the
 * sender's own encryption certificate in this list alongside the actual recipients' certificates, or
 * the sender's own Sent-folder copy becomes unreadable to them.
 */
export async function encryptForRecipients(content: Uint8Array, recipientCertDers: Uint8Array[]): Promise<Uint8Array> {
    const envelopedData = new pkijs.EnvelopedData();
    for (const certDer of recipientCertDers) {
        envelopedData.addRecipientByCertificate(parseCertificate(certDer));
    }
    await envelopedData.encrypt(CONTENT_ENCRYPTION_ALGORITHM, toArrayBuffer(content));

    const contentInfo = new pkijs.ContentInfo({ contentType: pkijs.ContentInfo.ENVELOPED_DATA, content: envelopedData.toSchema() });
    return new Uint8Array(contentInfo.toSchema().toBER());
}

/**
 * Decrypts a CMS `EnvelopedData` structure using one recipient's own certificate/private key.
 * `EnvelopedData` doesn't label which `RecipientInfo` belongs to which recipient in a way this
 * function's own caller already knows in advance, so it tries every recipient slot in turn with the
 * one keypair it has, succeeding on whichever slot was actually built for it and discarding the rest
 * — the same shape as trying every wrapped-key entry in `KeyVault.masterKeyWraps` until one unwraps.
 * A slot whose recipient identifier names this certificate is tried first. See
 * `decryptEnvelopedDataWithKeys()` for several candidate keys.
 */
export async function decryptEnvelopedData(
    envelopedDer: Uint8Array,
    recipientCertDer: Uint8Array,
    recipientPrivateKey: CryptoKey,
): Promise<Uint8Array> {
    return decryptEnvelopedDataWithKeys(envelopedDer, [{ certDer: recipientCertDer, privateKey: recipientPrivateKey }]);
}

/** One candidate decryption keypair for `decryptEnvelopedDataWithKeys()`. */
export interface DecryptionKey {
    /** Base64-decoded DER certificate of the key. */
    certDer: Uint8Array;
    privateKey: CryptoKey;
}

/** At most this many candidate keys are considered by `decryptEnvelopedDataWithKeys()` (further ones are ignored) - the
 * active encryption key plus `keySession.ts`'s `MAX_RETAINED_ENCRYPTION_KEYS` retained ones. */
export const MAX_DECRYPTION_KEYS = 21;

/** Trial decryptions (a key tried against a slot whose recipient identifier doesn't name it) allowed for every key
 * after the first, together. The first key keeps the unbounded every-slot trial `decryptEnvelopedData()` always did;
 * this budget stops a message with many recipient slots from costing `slots x keys` ECDH operations. */
export const MAX_TRIAL_DECRYPTIONS = 64;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** The recipient identifier of one `RecipientInfo`: an issuer and serial number, or a subject key identifier. Only
 * key transport (`variant` 1) and key agreement (`variant` 2) recipients carry one naming a certificate; key agreement
 * uses the first encrypted key's identifier, which is the only one pkijs's `decrypt()` reads. */
function recipientIdentifier(recipientInfo: pkijs.RecipientInfo): pkijs.IssuerAndSerialNumber | asn1js.OctetString | undefined {
    if (recipientInfo.variant === 1) {
        return (recipientInfo.value as pkijs.KeyTransRecipientInfo).rid;
    }
    if (recipientInfo.variant === 2) {
        // pkijs refuses to parse a key agreement recipient without an encrypted key, so `[0]` always exists; a parsed
        // identifier is variant 1 (issuer and serial number) or 2 (a `RecipientKeyIdentifier`).
        const rid = (recipientInfo.value as pkijs.KeyAgreeRecipientInfo).recipientEncryptedKeys.encryptedKeys[0].rid;
        return rid.variant === 1 ? (rid.value as pkijs.IssuerAndSerialNumber) : (rid.value as pkijs.RecipientKeyIdentifier).subjectKeyIdentifier;
    }
    return undefined;
}

/** The subject key identifier extension's value, when the certificate has a readable one. */
function subjectKeyIdentifier(certificate: pkijs.Certificate): Uint8Array | undefined {
    const extension = certificate.extensions?.find((candidate) => candidate.extnID === "2.5.29.14");
    const parsed = extension?.parsedValue as asn1js.OctetString | undefined;
    return parsed instanceof asn1js.OctetString ? new Uint8Array(parsed.valueBlock.valueHexView) : undefined;
}

/** Whether a recipient slot's identifier names `certificate` (same serial number and issuer DER, or same subject key
 * identifier). A slot with no certificate identifier (KEK, password) names nobody. */
function recipientMatchesCertificate(recipientInfo: pkijs.RecipientInfo, certificate: pkijs.Certificate): boolean {
    const identifier = recipientIdentifier(recipientInfo);
    if (identifier instanceof pkijs.IssuerAndSerialNumber) {
        return (
            bytesEqual(new Uint8Array(identifier.serialNumber.valueBlock.valueHexView), new Uint8Array(certificate.serialNumber.valueBlock.valueHexView)) &&
            bytesEqual(new Uint8Array(identifier.issuer.toSchema().toBER()), new Uint8Array(certificate.issuer.toSchema().toBER()))
        );
    }
    if (identifier instanceof asn1js.OctetString) {
        const ski = subjectKeyIdentifier(certificate);
        return ski !== undefined && bytesEqual(new Uint8Array(identifier.valueBlock.valueHexView), ski);
    }
    return false;
}

/**
 * Decrypts a CMS `EnvelopedData` structure with whichever of several candidate keys it was encrypted to - the mailbox's
 * active encryption key followed by the retained older ones (`keySession.ts`'s `retainedEncryptionKeys`), so mail
 * encrypted to a key since replaced stays readable.
 *
 * **Matching first:** every recipient slot whose identifier (issuer and serial number, or subject key identifier) names
 * a candidate's certificate is tried with that key, in candidate order - normally one decryption, no guessing.
 * **Trial otherwise** (e.g. the sender encrypted to a reissued certificate for the same key): the first candidate is
 * tried against every remaining slot, then the others in order, sharing `MAX_TRIAL_DECRYPTIONS`.
 *
 * Only the first `MAX_DECRYPTION_KEYS` candidates are considered. A candidate whose certificate can't be parsed is
 * skipped (the parse error is thrown only when no candidate is usable). Throws `UnsupportedContentEncryptionError` for
 * non-AEAD content, and the last decryption error when no key opens any slot.
 */
export async function decryptEnvelopedDataWithKeys(envelopedDer: Uint8Array, keys: DecryptionKey[]): Promise<Uint8Array> {
    const contentInfo = pkijs.ContentInfo.fromBER(toArrayBuffer(envelopedDer));
    if (contentInfo.contentType !== pkijs.ContentInfo.ENVELOPED_DATA) {
        throw new Error("This CMS content is not EnvelopedData.");
    }
    const envelopedData = new pkijs.EnvelopedData({ schema: contentInfo.content });
    const contentEncryptionOid = envelopedData.encryptedContentInfo.contentEncryptionAlgorithm.algorithmId;
    if (!AEAD_CONTENT_ENCRYPTION_OIDS.has(contentEncryptionOid)) {
        throw new UnsupportedContentEncryptionError(contentEncryptionOid);
    }

    const candidates: { certificate: pkijs.Certificate; privateKey: CryptoKey }[] = [];
    let parseError: unknown;
    for (const key of keys.slice(0, MAX_DECRYPTION_KEYS)) {
        try {
            candidates.push({ certificate: parseCertificate(key.certDer), privateKey: key.privateKey });
        } catch (err) {
            parseError = err;
        }
    }
    if (candidates.length === 0) {
        throw parseError instanceof Error ? parseError : new Error("No decryption key was supplied.");
    }

    const slotCount = envelopedData.recipientInfos.length;
    const tried = new Set<string>();
    let lastError: unknown;
    const attempt = async (index: number, candidate: number): Promise<Uint8Array | undefined> => {
        tried.add(`${index}:${candidate}`);
        const { certificate, privateKey } = candidates[candidate];
        try {
            return new Uint8Array(await envelopedData.decrypt(index, { recipientCertificate: certificate, recipientPrivateKey: privateKey }));
        } catch (err) {
            lastError = err;
            return undefined;
        }
    };

    for (let candidate = 0; candidate < candidates.length; candidate++) {
        for (let index = 0; index < slotCount; index++) {
            if (recipientMatchesCertificate(envelopedData.recipientInfos[index], candidates[candidate].certificate)) {
                const decrypted = await attempt(index, candidate);
                if (decrypted) {
                    return decrypted;
                }
            }
        }
    }

    let trialBudget = MAX_TRIAL_DECRYPTIONS;
    for (let candidate = 0; candidate < candidates.length; candidate++) {
        for (let index = 0; index < slotCount; index++) {
            if (tried.has(`${index}:${candidate}`)) {
                continue;
            }
            if (candidate > 0 && trialBudget-- <= 0) {
                break;
            }
            const decrypted = await attempt(index, candidate);
            if (decrypted) {
                return decrypted;
            }
        }
    }
    // The `new Error(...)` fallback covers an EnvelopedData with zero recipientInfos (no attempt ever runs, so
    // `lastError` stays its initial `undefined`) - not reachable through this module's own encryptForRecipients(),
    // which always adds at least one recipient in practice, but kept as a defensive fallback since `lastError` could
    // otherwise surface as a non-Error thrown value.
    throw lastError instanceof Error ? lastError : new Error("No recipient slot in this EnvelopedData could be decrypted with these keys.");
}

/** SHA-256 fingerprint of a DER certificate, hex encoded — matches `keyvaultApi.ts`'s own `PublicKey.
 * fingerprint` format exactly, so a value computed here is directly comparable against one already on
 * a `Mailbox`/`Contact` record. Used by `messageSecurity.ts` to compare a received message's embedded
 * signer certificate against a pinned `Contact` key per the spec's Trust Model (TOFU) — `verifyDetached()`/
 * `verifyOpaque()` only prove a signature is mathematically valid, never that the certificate belongs to
 * who the message claims (see `VerifyResult`'s own doc comment). */
export async function computeCertFingerprint(certDer: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest(DIGEST_ALGORITHM, toArrayBuffer(certDer));
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
