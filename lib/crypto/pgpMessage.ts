///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * OpenPGP messages (RFC 3156 PGP/MIME, and the inline forms some clients still send) - the OpenPGP counterpart of
 * `smimeMessage.ts`, for mail with OpenPGP users (restapi `specs/end-to-end_encryption.md` *OpenPGP Interoperability*). Only ever
 * imported dynamically: OpenPGP.js is loaded when an OpenPGP message is read or sent.
 *
 * Sending writes PGP/MIME only: `multipart/encrypted` (signed and encrypted in one OpenPGP message, RFC 3156 §6.2) and
 * detached `multipart/signed`. The inner entity carries the protected headers exactly as an S/MIME message does
 * (`smimeMessage.ts`'s `protectedHeaderLines()`, RFC 9788), marked both `hp=` and `protected-headers="v1"` (the form OpenPGP
 * mail clients recognise), and its body is base64 so the signed bytes survive transport.
 *
 * Reading recovers the inner entity and reports what the signature proved; the trust decision (pins, identity binding,
 * header checks) is `messageSecurity.ts`'s, the same as for S/MIME.
 */
import * as openpgp from "openpgp";
import { fromBase64 } from "./encoding.js";
import { bytesToBinaryString, binaryStringToBytes, decodeBodyText, parseMimeEntity, parseParameterizedHeader, splitMultipart } from "./mime.js";
import { type OpenPgpPrivateKey, type OpenPgpPublicKey, keyEmails, readPublicKeys } from "./openpgp.js";
import {
    base64Wrapped,
    flattenHeaderValue,
    generateBoundary,
    type MimePart,
    type ProtectedHeaders,
    protectedHeaderLines,
} from "./smimeMessage.js";

const CRLF = "\r\n";

/** Builds the inner entity: protected headers, then the body (base64) - wrapped with `attachKey` (an armored public key) in a
 * `multipart/mixed` when one is given, so a correspondent without our key can import it. */
function innerEntity(bodyContentType: string, bodyText: string, headerBlock: string, hp: "cipher" | "clear", attachKey?: string): string {
    const marks = `hp="${hp}"; protected-headers="v1"`;
    const bodyPart = [
        `Content-Type: ${flattenHeaderValue(bodyContentType)}`,
        `Content-Transfer-Encoding: base64`,
        "",
        base64Wrapped(new TextEncoder().encode(bodyText)),
    ].join(CRLF);
    if (!attachKey) {
        return [headerBlock, bodyPart.replace(/^Content-Type: ([^\r\n]*)/, `Content-Type: $1; ${marks}`)].join(CRLF);
    }
    const boundary = generateBoundary();
    return [
        headerBlock,
        `Content-Type: multipart/mixed; boundary="${boundary}"; ${marks}`,
        "",
        `--${boundary}`,
        bodyPart,
        `--${boundary}`,
        `Content-Type: application/pgp-keys; name="OpenPGP_public_key.asc"`,
        `Content-Disposition: attachment; filename="OpenPGP_public_key.asc"`,
        "",
        attachKey.replace(/\r?\n/g, CRLF).trim(),
        `--${boundary}--`,
    ].join(CRLF);
}

/**
 * An RFC 3156 `multipart/encrypted` message: the inner entity (protected headers, the body and - with `attachKey` - our public
 * key) signed with `signingKey` when given and encrypted to every key in `recipientKeys` in one OpenPGP message. Per the spec's
 * "Encrypt to Self", `recipientKeys` MUST include the sender's own key.
 */
export async function buildPgpEncryptedMessage(
    bodyContentType: string,
    bodyText: string,
    protectedHeaders: ProtectedHeaders,
    outerHeaders: ProtectedHeaders,
    recipientKeys: OpenPgpPublicKey[],
    signingKey?: OpenPgpPrivateKey,
    attachKey?: string,
): Promise<MimePart> {
    const entity = innerEntity(bodyContentType, bodyText, protectedHeaderLines(protectedHeaders, outerHeaders), "cipher", attachKey);
    const armored = await openpgp.encrypt({
        message: await openpgp.createMessage({ binary: new TextEncoder().encode(entity) }),
        encryptionKeys: recipientKeys,
        ...(signingKey ? { signingKeys: signingKey } : {}),
        format: "armored",
    });
    const boundary = generateBoundary();
    const body = [
        `--${boundary}`,
        `Content-Type: application/pgp-encrypted`,
        `Content-Description: PGP/MIME version identification`,
        "",
        "Version: 1",
        "",
        `--${boundary}`,
        `Content-Type: application/octet-stream; name="encrypted.asc"`,
        `Content-Description: OpenPGP encrypted message`,
        `Content-Disposition: inline; filename="encrypted.asc"`,
        "",
        armored.replace(/\r?\n/g, CRLF).trim(),
        `--${boundary}--`,
    ].join(CRLF);
    return { contentType: `multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${boundary}"`, body };
}

/** The `micalg` of a detached signature: `pgp-` and its hash algorithm's name (RFC 3156 §5). */
async function micalg(armoredSignature: string): Promise<string> {
    const signature = await openpgp.readSignature({ armoredSignature });
    const id = signature.packets[0]?.hashAlgorithm;
    const name = id !== undefined && id !== null ? openpgp.enums.read(openpgp.enums.hash, id) : "sha512";
    return `pgp-${String(name).toLowerCase()}`;
}

/** An RFC 3156 detached `multipart/signed` message: the inner entity (protected headers, the body and - with `attachKey` - our
 * public key), signed with `signingKey`. */
export async function buildPgpSignedOnlyMessage(
    bodyContentType: string,
    bodyText: string,
    protectedHeaders: ProtectedHeaders,
    signingKey: OpenPgpPrivateKey,
    attachKey?: string,
): Promise<MimePart> {
    const entity = innerEntity(bodyContentType, bodyText, protectedHeaderLines(protectedHeaders), "clear", attachKey);
    const signature = await openpgp.sign({
        message: await openpgp.createMessage({ binary: new TextEncoder().encode(entity) }),
        signingKeys: signingKey,
        detached: true,
        format: "armored",
    });
    const boundary = generateBoundary();
    const body = [
        `--${boundary}`,
        entity,
        `--${boundary}`,
        `Content-Type: application/pgp-signature; name="OpenPGP_signature.asc"`,
        `Content-Description: OpenPGP digital signature`,
        `Content-Disposition: attachment; filename="OpenPGP_signature.asc"`,
        "",
        signature.replace(/\r?\n/g, CRLF).trim(),
        `--${boundary}--`,
    ].join(CRLF);
    return {
        contentType: `multipart/signed; protocol="application/pgp-signature"; micalg=${await micalg(signature)}; boundary="${boundary}"`,
        body,
    };
}

/** A key that may have made a signature: a pinned one is trusted, one only attached to the message is not. */
export interface PgpSignerCandidate {
    key: OpenPgpPublicKey;
    trusted: boolean;
}

/** What a signature proved. `"unknown_key"`: no candidate key has the signing key's ID, so it can't be checked at all. */
export type PgpSignatureOutcome =
    | { status: "verified"; candidate: PgpSignerCandidate; fingerprint: string; emails: string[] }
    | { status: "invalid" }
    | { status: "unknown_key" };

/** The outcome over OpenPGP.js's `signatures`: verified by the first candidate whose key ID matches and whose check passes. */
/** OpenPGP.js's per-signature verification results. */
type Signatures = Awaited<ReturnType<typeof openpgp.verify>>["signatures"];

async function signatureOutcome(signatures: Signatures, candidates: PgpSignerCandidate[]): Promise<PgpSignatureOutcome> {
    let known = false;
    for (const signature of signatures) {
        const candidate = candidates.find((c) => c.key.getKeyIDs().some((id) => id.equals(signature.keyID)));
        if (!candidate) {
            continue;
        }
        known = true;
        const valid = await signature.verified.then(
            () => true,
            () => false,
        );
        if (valid) {
            return { status: "verified", candidate, fingerprint: candidate.key.getFingerprint().toLowerCase(), emails: await keyEmails(candidate.key) };
        }
    }
    return known ? { status: "invalid" } : { status: "unknown_key" };
}

/** The certificates attached to `entityText` (`application/pgp-keys` parts) - untrusted signer candidates. */
async function attachedKeys(entityText: string): Promise<OpenPgpPublicKey[]> {
    const keys: OpenPgpPublicKey[] = [];
    const visit = async (text: string, depth: number): Promise<void> => {
        if (depth > 4) {
            return;
        }
        const entity = parseMimeEntity(text);
        const type = parseParameterizedHeader(entity.headers["content-type"]);
        if (type.value === "application/pgp-keys") {
            keys.push(...(await readPublicKeys(decodeBodyText(entity))));
        } else if (type.value.startsWith("multipart/") && type.params["boundary"]) {
            for (const part of splitMultipart(entity.body, type.params["boundary"]).slice(0, 16)) {
                await visit(part, depth + 1);
            }
        }
    };
    await visit(entityText, 0);
    return keys;
}

/** A recovered OpenPGP message: the inner entity (a binary string, as `mime.ts` parses it) and what its signature proved. */
export interface ParsedPgpMessage {
    /** For an encrypted message: whether one of the keys opened it. Always `true` for a signed-only one. */
    decrypted: boolean;
    /** The recovered MIME entity (PGP/MIME), or for an inline message a `text/plain` entity built around its text. */
    entityText?: string;
    /** `undefined` when the message carried no signature. */
    signature?: PgpSignatureOutcome;
}

/** Candidates for `entityText`: the given ones, then any key attached to the message (untrusted). */
async function withAttached(candidates: PgpSignerCandidate[], entityText: string): Promise<PgpSignerCandidate[]> {
    return [...candidates, ...(await attachedKeys(entityText)).map((key) => ({ key, trusted: false }))];
}

/** Verifies an RFC 3156 `multipart/signed` message (`protocol="application/pgp-signature"`). Never throws. */
export async function parsePgpSignedMessage(contentType: string, body: string, candidates: PgpSignerCandidate[]): Promise<ParsedPgpMessage> {
    const boundary = parseParameterizedHeader(contentType).params["boundary"];
    const parts = boundary ? splitMultipart(body, boundary) : [];
    if (parts.length !== 2) {
        return { decrypted: true, signature: { status: "invalid" } };
    }
    const [signed, signaturePart] = parts;
    try {
        const signature = await openpgp.readSignature({ armoredSignature: decodeBodyText(parseMimeEntity(signaturePart)) });
        const all = await withAttached(candidates, signed);
        // What was signed is the part in canonical CRLF form (RFC 3156 §5).
        const canonical = signed.replace(/\r?\n/g, CRLF);
        const verification = await openpgp.verify({
            message: await openpgp.createMessage({ binary: binaryStringToBytes(canonical) }),
            signature,
            verificationKeys: all.map((c) => c.key),
            expectSigned: false,
        });
        return { decrypted: true, entityText: signed, signature: await signatureOutcome(verification.signatures, all) };
    } catch {
        return { decrypted: true, signature: { status: "invalid" } };
    }
}

/** The armored OpenPGP message in an RFC 3156 `multipart/encrypted` body (its second part), or `undefined`. */
function encryptedPayload(contentType: string, body: string): string | undefined {
    const boundary = parseParameterizedHeader(contentType).params["boundary"];
    const parts = boundary ? splitMultipart(body, boundary) : [];
    return parts.length === 2 ? decodeBodyText(parseMimeEntity(parts[1])) : undefined;
}

/**
 * Decrypts an RFC 3156 `multipart/encrypted` message with `decryptionKeys`, verifying the signature it carries (a combined signed
 * and encrypted message, RFC 3156 §6.2, or an inner `multipart/signed`, §6.1) against `candidates` and the keys attached inside.
 * Never throws.
 */
export async function parsePgpEncryptedMessage(
    contentType: string,
    body: string,
    decryptionKeys: OpenPgpPrivateKey[],
    candidates: PgpSignerCandidate[],
): Promise<ParsedPgpMessage> {
    const payload = encryptedPayload(contentType, body);
    if (!payload || decryptionKeys.length === 0) {
        return { decrypted: false };
    }
    let data: Uint8Array;
    let signed: boolean;
    try {
        const result = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: payload }), decryptionKeys, format: "binary", expectSigned: false });
        data = result.data;
        signed = result.signatures.length > 0;
    } catch {
        return { decrypted: false };
    }
    const entityText = bytesToBinaryString(data);
    const inner = parseMimeEntity(entityText);
    const innerType = parseParameterizedHeader(inner.headers["content-type"]);
    if (!signed && innerType.value === "multipart/signed" && innerType.params["protocol"]?.toLowerCase() === "application/pgp-signature") {
        const innerSigned = await parsePgpSignedMessage(inner.headers["content-type"], inner.body, candidates);
        return { decrypted: true, entityText: innerSigned.entityText ?? entityText, signature: innerSigned.signature };
    }
    if (!signed) {
        return { decrypted: true, entityText };
    }
    // The keys attached inside are only known now: verify the signature against them and the given ones together.
    const all = await withAttached(candidates, entityText);
    if (all.length === 0) {
        return { decrypted: true, entityText, signature: { status: "unknown_key" } };
    }
    const verified = await openpgp.decrypt({
        message: await openpgp.readMessage({ armoredMessage: payload }),
        decryptionKeys,
        verificationKeys: all.map((c) => c.key),
        format: "binary",
        expectSigned: false,
    });
    return { decrypted: true, entityText, signature: await signatureOutcome(verified.signatures, all) };
}

/** A `text/plain` entity for an inline message's recovered text. */
function plainEntity(text: string): string {
    return bytesToBinaryString(new TextEncoder().encode(`Content-Type: text/plain; charset=utf-8${CRLF}${CRLF}${text}`));
}

/** Decrypts an inline OpenPGP message (an armored `PGP MESSAGE` as the whole text body), verifying a signature it carries. Never
 * throws. */
export async function parsePgpInlineEncrypted(armored: string, decryptionKeys: OpenPgpPrivateKey[], candidates: PgpSignerCandidate[]): Promise<ParsedPgpMessage> {
    if (decryptionKeys.length === 0) {
        return { decrypted: false };
    }
    try {
        const result = await openpgp.decrypt({
            message: await openpgp.readMessage({ armoredMessage: armored }),
            decryptionKeys,
            verificationKeys: candidates.map((c) => c.key),
            expectSigned: false,
        });
        const signature = result.signatures.length > 0 ? await signatureOutcome(result.signatures, candidates) : undefined;
        return { decrypted: true, entityText: plainEntity(String(result.data)), ...(signature ? { signature } : {}) };
    } catch {
        return { decrypted: false };
    }
}

/** Verifies an inline cleartext-signed message (`BEGIN PGP SIGNED MESSAGE`). Never throws. */
export async function parsePgpCleartextSigned(text: string, candidates: PgpSignerCandidate[]): Promise<ParsedPgpMessage> {
    try {
        const message = await openpgp.readCleartextMessage({ cleartextMessage: text });
        const verification = await openpgp.verify({ message, verificationKeys: candidates.map((c) => c.key), expectSigned: false });
        return { decrypted: true, entityText: plainEntity(message.getText()), signature: await signatureOutcome(verification.signatures, candidates) };
    } catch {
        return { decrypted: true, signature: { status: "invalid" } };
    }
}

/** The certificates in a list of base64 keys (`PublicKey.publicKey` of OpenPGP entries) - unreadable ones dropped. */
export async function readKeysBase64(keys: string[]): Promise<OpenPgpPublicKey[]> {
    const read = await Promise.all(keys.map((key) => readPublicKeys(fromBase64(key))));
    return read.flat();
}
