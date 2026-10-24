///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Evaluates a *received* message's raw MIME source into one of `specs/end-to-end_encryption.md`'s
 * "Message Security Indicators" states, and recovers the plaintext body when applicable. Reads the
 * outer envelope's own `Content-Type` (via `mime.ts`'s `parseMimeEntity()`) to decide whether the message
 * is `multipart/signed`, `application/pkcs7-mime; smime-type="enveloped-data"`, or neither.
 *
 * **What a verified state means.** `"signed_verified"`/`"encrypted_verified"` require ALL of: (1) a
 * cryptographically valid CMS signature (`smime.ts` - detached signatures carrying their own eContent are
 * rejected, the signer certificate is the one matched to the SignerInfo, never simply the first embedded
 * certificate, and a `multipart/signed` body must hold exactly the signed part and the signature); (2) the
 * signer certificate's fingerprint is one the reader already trusts - a pinned `Contact` signing key passed
 * as `pinnedSignerFingerprints`, or the unlocked mailbox's own `signingFingerprint`; (3) the signer
 * certificate names the sender: one of its email addresses (SAN rfc822Name, else subject emailAddress /
 * email-shaped CN) equals the single address in the protected `From` (or the outer `From` when the signed
 * content carries no protected headers, as with non-RFC 9788 senders); (4) the protected `From`/`To`/`Cc`
 * address sets (when present) equal the outer envelope's, a signed-only message's protected `Subject` equals
 * its outer one (what the mail list shows), and neither header block carries more than one
 * `From`/`To`/`Cc`/`Sender` field.
 *
 * **No trust anchor, no verified badge.** Certificates aren't chain-validated (there is no trust store), so
 * checks 1, 3 and 4 alone prove only that *someone* holding a certificate naming the sender signed it - a
 * self-issued certificate with SAN `ceo@victim.com` passes them. Without a matching pin the result is
 * `"signed_unverified_signer"`/`"encrypted_unverified_signer"` instead, carrying `signerFingerprint` and
 * `signerEmails` so a UI can show "signed by an unverified certificate" and offer to trust it. A failure of checks 1, 3
 * or 4 is `"signature_failed"` with `signatureFailureReason` saying which check failed.
 *
 * **Pinned, but a different key.** When pins were supplied and checks 1, 3 and 4 pass but the signer matches no pin, the
 * result is `"signature_failed"` with `signatureFailureReason: "signer_key_changed"`: the sender's certificate names
 * them and the message is intact, but it isn't the key the reader pinned (a rotation the reader hasn't accepted, or an
 * impersonation). Only this failure also carries `signerCertificate`, so a UI can compare it with the pinned keys
 * (`contactsApi.ts`'s `fetchSignerKeyState()`) and let the user accept or reject it (`keyvaultApi.ts`'s
 * `resolveKeyConflict()`). A pin mismatch whose certificate also fails check 3 or 4 (or couldn't be resolved) stays
 * `untrusted_signer`. Previously pinned keys count as pins (see `signingKeyFingerprints()`), so mail signed before an
 * accepted or automatic rotation still verifies.
 */
import {
    DisplayBody,
    MimeAttachment,
    MimeHeaderField,
    bytesToBinaryString,
    decodeBodyText,
    type MimeEntity,
    decodeBase64Text,
    decodeHeaderText,
    extractAddresses,
    extractAttachments,
    extractCalendarText,
    extractDisplayBody,
    parseMimeEntity,
    parseParameterizedHeader,
    plainTextToHtml,
} from "./mime.js";
import { fromBase64, toBase64 } from "./encoding.js";
import { type DecryptionKey, computeCertFingerprint, decryptEnvelopedDataWithKeys, extractCertificateEmails } from "./smime.js";
import {
    ComparableOuterHeaders,
    ProtectedHeaders,
    extractHpOuterHeaders,
    headersToProtectedHeaders,
    outerHeadersMatch,
    parseEncryptedMessageWithKeys,
    parseSignedOnlyMessage,
} from "./smimeMessage.js";
import type { OpenPgpPrivateKey } from "./openpgp.js";
import type { ParsedPgpMessage, PgpSignerCandidate } from "./pgpMessage.js";
import { type PublicKey, isTrustedForVerification } from "./keyvaultApi.js";
import { KeysLockedError } from "./masterKey.js";
import { type SealKeyMaterial, type SealedVerificationState, buildVerificationSeal, openVerificationSeal, rawMimeSha256 } from "./verificationSeal.js";

export { signingKeyFingerprints } from "./keyvaultApi.js";


/** `"signed_unverified_signer"`/`"encrypted_unverified_signer"`: the signature is valid and its certificate
 * names the sender, but the certificate isn't one the reader trusts (no pinned key matched) - see this module's
 * doc comment. The encrypted variant's content was decrypted like `"encrypted_verified"`'s.
 *
 * `"verified_at_first_open"`: only ever returned by `evaluateMessageSecurityWithSeal()`. The live check now fails only
 * because of the signer key's status (`signer_key_changed`, or `*_unverified_signer` - the pins are gone or no longer
 * trust the key), but the message carries a valid verification seal (`verificationSeal.ts`) for this exact raw MIME and
 * this same signer certificate, recording that it verified when first opened. The result carries `verifiedAt`,
 * `sealedState`, `signerFingerprint`, the recovered content, `liveState`/`liveSignatureFailureReason`, and
 * `laterCompromised` when the signer key has since been revoked as compromised. A UI should show it as "verified when
 * first opened" - distinct from the live verified states, and with a warning when `laterCompromised` is set. */
export type MessageSecurityState =
    | "encrypted"
    | "signed_verified"
    | "encrypted_verified"
    | "signed_unverified_signer"
    | "encrypted_unverified_signer"
    | "signature_failed"
    | "verified_at_first_open"
    | "protected_at_rest"
    | "unprotected";

/** Why a message is `"signature_failed"`. `invalid_signature`: the CMS signature itself is malformed or
 * doesn't verify over the content (or a `multipart/signed` body doesn't hold exactly two parts).
 * `signer_key_changed`: pinned fingerprints were supplied and the signer certificate matches none of them, but it
 * names the sender and every header check passes - the sender appears to use a new key (see this module's doc
 * comment); the result carries `signerCertificate`. `untrusted_signer`: pinned fingerprints were supplied and the signer
 * certificate matches none of them and also fails the identity or header checks (or no signer certificate could be
 * resolved at all). `signer_identity_mismatch`: the signer certificate doesn't name the message's `From` address (or
 * `From` doesn't hold exactly one address). `header_mismatch`: the signed/protected `From`/`To`/`Cc` (or a signed-only
 * message's `Subject`) disagree with the outer envelope's, or either header block repeats a `From`/`To`/`Cc`/`Sender`
 * field. */
export type SignatureFailureReason = "invalid_signature" | "signer_key_changed" | "untrusted_signer" | "signer_identity_mismatch" | "header_mismatch";

/** The header fields recovered from inside the signed/encrypted entity (RFC 9788 header protection), decoded
 * for display where they are text. */
export interface MessageProtectedHeaders {
    from: string;
    to: string;
    cc?: string;
    subject: string;
}

export interface MessageSecurityResult {
    state: MessageSecurityState;
    /** The verified/decrypted content as HTML - still needs client-side sanitization before touching the
     * DOM (this module does none itself; see `MessageDetailPane.tsx`). For a `text/html` body this is that
     * HTML; for a `text/plain` body it is the text HTML-escaped inside a whitespace-preserving `<pre>`
     * (never plain text passed through as markup), with the raw text in `text`. Absent for
     * `"unprotected"` (the caller should keep using the server's own sanitized `/content` body) and for an
     * encrypted message this device couldn't open (see `decryptError`). */
    html?: string;
    /** The raw plain text, present only when the recovered body was `text/plain` (not `text/html`). */
    text?: string;
    /** `true` when `evaluateMessageSecurity()` was given a `readerAddress` and recovered protected `To`/`Cc`
     * headers that don't include it - e.g. a genuinely signed message re-sent verbatim to someone it was
     * never addressed to. Informational, orthogonal to `state` (a Bcc recipient legitimately sees this
     * too), so a UI can say "this message wasn't addressed to you" next to an otherwise valid signature.
     * `undefined` when no reader address was given or nothing protected was recovered. */
    notAddressedToReader?: boolean;
    /** Present only for `"signature_failed"`: which verification step failed. */
    signatureFailureReason?: SignatureFailureReason;
    /** Present only when the message was encrypted but this device couldn't decrypt it (a wrong or
     * since-rotated key, non-AEAD content encryption, or corrupt/foreign data) - the caller should keep
     * showing whatever `GET /:id/content` already produced alongside this explanation. */
    decryptError?: string;
    /** Set when the stored message was sealed at rest by the server (restapi `specs/search.md` §3) and opened here with the mailbox's
     * zero-access key. `state` then describes the original message inside: `protected_at_rest` when it arrived unprotected, or its own
     * signed/encrypted state otherwise. */
    zeroAccess?: boolean;
    /** With `zeroAccess`: the original's calendar file (`extractCalendarText()`), which the server can't read from the sealed copy - the
     * client sends it with the invitation endpoints. Absent when the message carries none. */
    calendar?: string;
    /** See `ParsedEncryptedMessage.headerTamperDetected`'s own doc comment - a deliberately separate,
     * orthogonal signal from `state`, since RFC 9788's `HP-Outer` is written on every encrypted message
     * regardless of whether it's also signed. `undefined` for anything that isn't an encrypted message
     * this device could decrypt. */
    headerTamperDetected?: boolean;
    /** The real subject recovered from the message's protected headers - RFC 9788 header protection
     * obscures the outer envelope's own `Subject` to `"[...]"`. Populated only when content was actually
     * recovered and it carried a protected Subject. */
    subject?: string;
    /** Every protected header recovered from inside the signed/decrypted entity - present only when that entity
     * carries RFC 9788 protected headers (a protected `From`) AND a signature over them verified (so also for a
     * `"verified_at_first_open"` result). Absent for a legacy S/MIME sender's signed-only message (its outer
     * Subject/To/Cc were then never signed, and a UI should not present them as verified), and for an encrypted
     * message without a verified signature: anyone holding the reader's public certificate can encrypt headers of their
     * own choosing, so they are never exposed. */
    protectedHeaders?: MessageProtectedHeaders;
    /** The attachments inside the verified/decrypted entity - for a signed-only message the only attachments the
     * signature covers, so a UI showing a verified badge should list these rather than the server's attachment
     * records (which include anything outside the signed part). Present whenever content was recovered. */
    attachments?: MimeAttachment[];
    /** SHA-256 fingerprint (hex) of the certificate that produced a cryptographically valid signature - present
     * for `"signed_verified"`, `"encrypted_verified"`, the `*_unverified_signer` states and a `"signature_failed"`
     * whose signature itself was valid. Compare against / pin as a `PublicKey.fingerprint`. */
    signerFingerprint?: string;
    /** The email addresses that signer certificate asserts (lowercased), alongside `signerFingerprint`. */
    signerEmails?: string[];
    /** `"openpgp"` when the signer is an OpenPGP key: `signerCertificate` is then its certificate (base64 binary) and
     * `signerFingerprint` its primary key's fingerprint - pin it with `trustSigner()`'s `type: "openpgp"`. */
    signerKeyType?: "openpgp";
    /** `true` for an OpenPGP message whose signature was made by a key this reader doesn't have (neither pinned for the sender,
     * nor the reader's own, nor attached to the message), so it couldn't be checked at all. A signed-only one is then reported
     * `"unprotected"` (its content is readable anyway), an encrypted one `"encrypted"`; a UI can say the sender's key isn't known
     * yet. */
    signerKeyUnknown?: boolean;
    /** Base64 DER of the certificate that verified the signature - what `keyvaultApi.ts`'s `trustSigner()` pins for
     * a "trust this signer" action. Present alongside `signerFingerprint` for `"signed_verified"`,
     * `"encrypted_verified"`, the `*_unverified_signer` states, and `"signature_failed"` with reason
     * `"signer_key_changed"` (for a key-changed comparison and `resolveKeyConflict()`'s `certificate`). Never for any
     * other `"signature_failed"`, even when its signature itself was valid (a failed binding is not something to offer
     * trusting). */
    signerCertificate?: string;
    /** Only from `evaluateMessageSecurityWithSeal()`: a seal for a live `"signed_verified"`/`"encrypted_verified"` result
     * when no stored seal opens under the current master key generation, or the stored seal is from an older generation.
     * Persist it best effort with `mailApi.ts`'s `setMessageVerificationSeal(messageUid, sealToWrite.seal,
     * sealToWrite.masterKeyGeneration)` (a `VerificationSealConflictError` means the server kept the stored seal - ignore
     * it). */
    sealToWrite?: SealToWrite;
    /** For `"verified_at_first_open"`: when the sealed verification happened (epoch ms). */
    verifiedAt?: number;
    /** For `"verified_at_first_open"`: the verified state the seal recorded. */
    sealedState?: SealedVerificationState;
    /** For `"verified_at_first_open"`: the live state the seal overrode (`"signature_failed"` or `*_unverified_signer`). */
    liveState?: MessageSecurityState;
    /** For `"verified_at_first_open"` over a live `"signature_failed"`: its reason (always `"signer_key_changed"`). */
    liveSignatureFailureReason?: SignatureFailureReason;
    /** For `"verified_at_first_open"`: `true` when the caller's `signerKeys` show the signer key is now revoked as
     * compromised (or revoked with no reason) - the seal proves it verified then, not that the key was safe then. */
    laterCompromised?: boolean;
}

/** A seal for the caller to store, with the master key generation it was written under. */
export interface SealToWrite {
    seal: string;
    masterKeyGeneration: number;
}

function isSignedOnlyContentType(contentTypeValue: string): boolean {
    return contentTypeValue === "multipart/signed";
}

/** Matches `buildEncryptedMessage()`'s own output shape, and leniently accepts the equivalent legacy/
 * AEAD `smime-type` values a foreign S/MIME sender could produce (mirrors `@rapidmx/restapi`'s own
 * server-side `SmimeUtils.isEncryptedBody()` classification, so the two systems agree on what counts as
 * encrypted). Parameters are matched case-insensitively, quoted or not. */
function isEncryptedContentType(contentType: { value: string; params: Record<string, string> }): boolean {
    if (contentType.value === "multipart/encrypted") {
        return true;
    }
    if (!contentType.value.endsWith("pkcs7-mime")) {
        return false;
    }
    const smimeType = contentType.params["smime-type"]?.toLowerCase();
    return smimeType === "enveloped-data" || smimeType === "authenveloped-data";
}

const NO_KEY_ERROR = "This device doesn't have the key needed to decrypt this message.";
const UNSUPPORTED_ENCRYPTION_ERROR =
    "This message uses an older, unauthenticated encryption algorithm, or an encryption format, that RapidMX doesn't accept, so it can't be opened safely.";

function renderDisplayBody(display: DisplayBody | undefined): Pick<MessageSecurityResult, "html" | "text"> {
    if (display?.html !== undefined) {
        return { html: display.html };
    }
    if (display?.text !== undefined) {
        return { html: plainTextToHtml(display.text), text: display.text };
    }
    return {};
}

function sameAddressSet(a: string[], b: string[]): boolean {
    const left = new Set(a);
    const right = new Set(b);
    return left.size === right.size && [...left].every((address) => right.has(address));
}

/** Normalizes whitespace runs, so a Subject refolded in transit still compares equal. */
function normalizeSubject(value: string | undefined): string {
    return decodeHeaderText(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
}


export interface SignerBindingInput {
    /** The certificate matched to the verified SignerInfo; `undefined` fails closed. */
    signerCertificateDer: Uint8Array | undefined;
    /** Headers recovered from inside the signed content (RFC 9788), if any. */
    protectedHeaders: (Pick<ProtectedHeaders, "from" | "to"> & Partial<Pick<ProtectedHeaders, "cc" | "subject" | "date">>) | undefined;
    /** The received message's outer header map (lowercased names), as `parseMimeEntity()` returns it. */
    outerHeaders: Record<string, string>;
    /** Every outer header field in order (`parseMimeEntity()`'s `fields`) - checked for repeated
     * `From`/`To`/`Cc`/`Sender`. Omitted, only the first-occurrence map above is available. */
    outerFields?: MimeHeaderField[];
    /** Every protected header field in order - checked for repeats the same way. */
    protectedFields?: MimeHeaderField[];
    /** One trusted fingerprint or several (any match is accepted). An empty array counts as none supplied. */
    pinnedSignerFingerprint?: string | string[];
    /** Also require the protected `Subject` and `Date` (when protected headers are present) to equal the outer ones - right for
     * a signed-only (`hp="clear"`) message, wrong for an encrypted one whose outer Subject is obscured. */
    compareSubject?: boolean;
}

/** Address header fields a message must carry at most once (RFC 5322 §3.6 allows exactly zero or one). */
const SINGLETON_ADDRESS_FIELDS = ["from", "to", "cc", "sender"];

function hasRepeatedAddressField(fields: MimeHeaderField[] | undefined): boolean {
    const counts = new Map<string, number>();
    for (const { name } of fields ?? []) {
        const key = name.toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return SINGLETON_ADDRESS_FIELDS.some((name) => (counts.get(name) ?? 0) > 1);
}

/** Whether the unsigned (outer) `Date:` header value `outer` names the same instant as the signed one, `signed`. A signed date
 * that is missing or unreadable leaves nothing to compare, but when there is one the outer must match it: a replayed message
 * that dropped or garbled its outer Date is as changed as one that carries a new one. */
function sameInstant(signed: string | undefined, outer: string | undefined): boolean {
    // `String(undefined)` is not a date either.
    const left = Date.parse(String(signed));
    return Number.isNaN(left) || left === Date.parse(String(outer));
}

function normalizePins(pins: SignerPinsInput): string[] {
    const list: string[] = Array.isArray(pins) ? pins : pins === undefined ? [] : typeof pins === "string" ? [pins] : pins.fingerprints;
    return list.map((pin) => pin.toLowerCase());
}

function pinnedOpenPgpKeys(pins: SignerPinsInput): string[] {
    return pins !== undefined && typeof pins === "object" && !Array.isArray(pins) ? pins.openPgpKeys : [];
}

/** Checks 2-4 from this module's doc comment for an already cryptographically verified signature.
 * Returns `undefined` when the signer is accepted, otherwise the failure reason. A pin mismatch is
 * `"signer_key_changed"` when checks 3 and 4 pass for the certificate, and `"untrusted_signer"` when they don't (or no
 * certificate was resolved).
 *
 * With no `pinnedSignerFingerprint` (or an empty array), check 2 is skipped and `undefined` means only that the
 * certificate names the sender consistently - NOT that the signer is trusted. Use `evaluateMessageSecurity()`
 * (which reports that case as `*_unverified_signer`) unless you enforce a pin yourself. */
export async function checkSignerBinding(input: SignerBindingInput): Promise<SignatureFailureReason | undefined> {
    const pins = normalizePins(input.pinnedSignerFingerprint);
    // Fail closed: an absent certificate hashes/extracts as empty, which can never match a pin or From.
    const certDer = input.signerCertificateDer ?? new Uint8Array();
    if (pins.length > 0 && !pins.includes(await computeCertFingerprint(certDer))) {
        // A certificate that otherwise binds cleanly to the sender is a key change for the user to judge; anything else
        // (no certificate, wrong identity, header tampering) stays a plain untrusted signer.
        return input.signerCertificateDer && checkIdentityAndHeaders(input, extractCertificateEmails(certDer)) === undefined ? "signer_key_changed" : "untrusted_signer";
    }
    return checkIdentityAndHeaders(input, extractCertificateEmails(certDer));
}

/** Checks 3-4 from this module's doc comment, for a signer whose key names `signerEmails` (an X.509 certificate's, or an
 * OpenPGP key's user IDs). */
function checkIdentityAndHeaders(input: Omit<SignerBindingInput, "signerCertificateDer">, signerEmails: string[]): SignatureFailureReason | undefined {
    const { protectedHeaders, outerHeaders } = input;
    if (hasRepeatedAddressField(input.outerFields) || hasRepeatedAddressField(input.protectedFields)) {
        return "header_mismatch";
    }
    const outerFrom = extractAddresses(outerHeaders["from"]);
    const protectedFrom = extractAddresses(protectedHeaders?.from);
    const senderAddresses = protectedFrom.length > 0 ? protectedFrom : outerFrom;
    if (senderAddresses.length !== 1 || !signerEmails.includes(senderAddresses[0])) {
        return "signer_identity_mismatch";
    }
    const protectedTo = extractAddresses(protectedHeaders?.to);
    if (!sameAddressSet(senderAddresses, outerFrom) || (protectedTo.length > 0 && !sameAddressSet(protectedTo, extractAddresses(outerHeaders["to"])))) {
        return "header_mismatch";
    }
    if (protectedFrom.length > 0) {
        // RFC 9788 protected headers are present, so Cc (possibly absent on both sides) and - for a signed-only
        // message - Subject were signed: an outer copy that differs was changed (or added) after signing.
        if (!sameAddressSet(extractAddresses(protectedHeaders?.cc), extractAddresses(outerHeaders["cc"]))) {
            return "header_mismatch";
        }
        // A signed-only message's outer Date is unsigned too: a signed message replayed later carries a new one. (An encrypted
        // message's outer Date is checked against its HP-Outer copy instead - see `headerTamperDetected`.)
        if (
            input.compareSubject &&
            (normalizeSubject(protectedHeaders?.subject) !== normalizeSubject(outerHeaders["subject"]) ||
                !sameInstant(protectedHeaders?.date, outerHeaders["date"]))
        ) {
            return "header_mismatch";
        }
    }
    return undefined;
}

/**
 * Evaluates one received message's raw MIME source (see `mailApi.ts`'s `getMessageRawContent()`) into
 * a security state + recovered plaintext. Never throws — a parse failure, wrong key, or unrecognized
 * content type all degrade to a result the caller can render directly.
 *
 * `pinnedSignerFingerprints` - the sender's trusted signing-key fingerprint(s): `signingKeyFingerprints()` of the
 * sender's `Contact.keys` and `Contact.previousKeys` (see `contactsApi.ts`'s `fetchPinnedSigningFingerprints()`). A
 * supplied pin that the signer doesn't match is `signer_key_changed` or `untrusted_signer`. The unlocked mailbox's own
 * `signingFingerprint` is always trusted too (mail this mailbox signed itself). Omitted or empty, a valid signature
 * from any other certificate is `*_unverified_signer`, never verified. `readerAddress` - the unlocked mailbox's own
 * address - enables `notAddressedToReader`.
 *
 * An encrypted message is decrypted with `unlocked`'s active encryption key or any of its `retainedEncryptionKeys` (the
 * older keys a rotation replaced - see `keySession.ts`), matched by recipient identifier first.
 */
export async function evaluateMessageSecurity(
    rawMime: string,
    unlocked: MessageSecurityKeys | undefined,
    pinnedSignerFingerprints?: SignerPinsInput,
    readerAddress?: string,
): Promise<MessageSecurityResult> {
    return (await evaluateLive(rawMime, unlocked, pinnedSignerFingerprints, readerAddress)).result;
}

/** The keys `evaluateMessageSecurity()` reads from an unlocked session (`keySession.ts`'s `UnlockedKeys`). */
export interface MessageSecurityKeys {
    encryptionPrivateKey?: CryptoKey;
    encryptionCertDer?: Uint8Array;
    retainedEncryptionKeys?: { certDer: Uint8Array; privateKey: CryptoKey }[];
    signingFingerprint?: string;
    /** The mailbox's zero-access keys (`keySession.ts`'s `UnlockedKeys.zeroAccessKeys`) - what opens a message the server sealed at
     * rest on arrival. */
    zeroAccessKeys?: { certDer: Uint8Array; privateKey: CryptoKey }[];
    /** The mailbox's OpenPGP secret keys (`keySession.ts`'s `UnlockedKeys.openPgpKeys`), the active one first - what opens mail an
     * OpenPGP user encrypted to the mailbox, and verifies mail it signed itself. */
    openPgpKeys?: { fingerprint: string; privateKey: OpenPgpPrivateKey }[];
}

/** The sender's trusted keys, when they include OpenPGP certificates: `fingerprints` as `pinnedSignerFingerprints`, and
 * `openPgpKeys` the pinned OpenPGP certificates themselves (base64, `PublicKey.publicKey`) - an OpenPGP signature carries only
 * a key ID, so its key has to be supplied to be checked at all (`pinnedSigners.ts`'s `getPinnedSigners()`). */
export interface SignerPins {
    fingerprints: string[];
    openPgpKeys: string[];
}

/** What `pinnedSignerFingerprints` accepts: one fingerprint, several, or `SignerPins`. */
export type SignerPinsInput = string | string[] | SignerPins | undefined;

/**
 * The subject and preview of a zero-access message (`Message.zeroAccess.sealedSummary`, base64 CMS of JSON `{ subject, preview }`),
 * decrypted with the mailbox's zero-access keys - a few hundred bytes, so a message list shows real subjects without downloading
 * each message. `undefined` when no key opens it or it isn't a summary.
 */
export async function openZeroAccessSummary(
    sealedSummary: string,
    keys: DecryptionKey[] | undefined,
): Promise<{ subject: string; preview: string } | undefined> {
    if (!keys?.length) {
        return undefined;
    }
    try {
        const json: unknown = JSON.parse(new TextDecoder().decode(await decryptEnvelopedDataWithKeys(fromBase64(sealedSummary), keys)));
        const { subject, preview } = (json ?? {}) as Record<string, unknown>;
        return typeof subject === "string" && typeof preview === "string" ? { subject, preview } : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The original MIME (as a binary string) of a stored message the server sealed at rest, opened with `unlocked.zeroAccessKeys` -
 * `undefined` when it isn't a sealed message or no key opens it. For what needs the original itself, e.g. reporting it to the spam
 * filter (`reportMessage()`'s `rawMessage`).
 */
export async function openZeroAccessMessage(rawMime: string, unlocked: MessageSecurityKeys | undefined): Promise<string | undefined> {
    const { headers, body } = parseMimeEntity(rawMime);
    const rawContentType = headers["content-type"];
    if (!unlocked?.zeroAccessKeys?.length || !rawContentType || !isEncryptedContentType(parseParameterizedHeader(rawContentType))) {
        return undefined;
    }
    return openZeroAccess(body, unlocked.zeroAccessKeys);
}

/**
 * The original MIME of a message the server sealed at rest (restapi `specs/search.md` §3) - the stored S/MIME `enveloped-data`
 * message's content, decrypted with one of `keys` - or `undefined` when none of them opens it. Only the server ever encrypts to a
 * zero-access key (it is never published), so a message that opens with one was sealed at rest, never sent end-to-end.
 */
async function openZeroAccess(body: string, keys: DecryptionKey[]): Promise<string | undefined> {
    const der = decodeBase64Text(body);
    if (!der) {
        return undefined;
    }
    try {
        return bytesToBinaryString(await decryptEnvelopedDataWithKeys(der, keys));
    } catch {
        return undefined;
    }
}

/** `evaluateMessageSecurity()`'s result plus what the seal-aware wrapper needs: which kind of protected message it was,
 * and a signed-only message's verified content, which a `signer_key_changed` result doesn't carry publicly. */
interface LiveEvaluation {
    result: MessageSecurityResult;
    kind: "signed" | "encrypted" | "other";
    signedContent?: Partial<MessageSecurityResult>;
}

async function evaluateLive(
    rawMime: string,
    unlocked: MessageSecurityKeys | undefined,
    pinnedSignerFingerprints: SignerPinsInput,
    readerAddress: string | undefined,
    sealedAtRest = false,
): Promise<LiveEvaluation> {
    const outerEntity = parseMimeEntity(rawMime);
    const { headers, body, fields } = outerEntity;
    const rawContentType = headers["content-type"];
    const contentType = parseParameterizedHeader(rawContentType ?? "text/plain");
    const pgp = pgpKind(contentType, outerEntity);
    if (pgp) {
        return await evaluatePgp(pgp, rawContentType ?? "text/plain", outerEntity, unlocked, pinnedSignerFingerprints, readerAddress);
    }
    if (!rawContentType) {
        return { result: { state: "unprotected" }, kind: "other" };
    }
    const callerPins = normalizePins(pinnedSignerFingerprints);

    // The received message's own *real* outer envelope - what `HP-Outer`'s field copies (written at
    // send time, inside the encrypted content) are compared against to detect post-send tampering.
    const actualOuterHeaders: ComparableOuterHeaders = {
        from: headers["from"],
        to: headers["to"],
        cc: headers["cc"],
        date: headers["date"],
        subject: headers["subject"],
    };

    /** Runs checks 2-4 and resolves the trust outcome: a failure reason, or whether a pin matched. */
    const checkSigner = async (
        signerCertificateDer: Uint8Array | undefined,
        protectedHeaders: ProtectedHeaders | undefined,
        protectedFields: MimeHeaderField[] | undefined,
        compareSubject: boolean,
    ): Promise<{
        failure?: SignatureFailureReason;
        trusted: boolean;
        signer: Pick<MessageSecurityResult, "signerFingerprint" | "signerEmails">;
        acceptedSigner: Pick<MessageSecurityResult, "signerFingerprint" | "signerEmails" | "signerCertificate">;
    }> => {
        const certDer = signerCertificateDer ?? new Uint8Array();
        const fingerprint = await computeCertFingerprint(certDer);
        const signer = signerCertificateDer ? { signerFingerprint: fingerprint, signerEmails: extractCertificateEmails(certDer) } : {};
        // The certificate itself (for "trust this signer" or a key-changed comparison) only accompanies a signature that
        // didn't fail or failed only as `signer_key_changed` - both always have a certificate (a missing one fails the
        // binding check closed as another reason), so `certDer` is the real one.
        const acceptedSigner = { ...signer, signerCertificate: toBase64(certDer) };
        const trustedPins = unlocked?.signingFingerprint ? [...callerPins, unlocked.signingFingerprint.toLowerCase()] : callerPins;
        const failure = await checkSignerBinding({
            signerCertificateDer,
            protectedHeaders,
            outerHeaders: headers,
            outerFields: fields,
            protectedFields,
            // Only pins the caller supplied make a mismatch a failure; the mailbox's own key alone never does.
            pinnedSignerFingerprint: callerPins.length > 0 ? trustedPins : undefined,
            compareSubject,
        });
        return { failure, trusted: trustedPins.includes(fingerprint), signer, acceptedSigner };
    };

    const addressing = (protectedHeaders: ProtectedHeaders | undefined): Pick<MessageSecurityResult, "notAddressedToReader"> => {
        const recipients = [...extractAddresses(protectedHeaders?.to), ...extractAddresses(protectedHeaders?.cc)];
        if (!readerAddress || recipients.length === 0) {
            return {};
        }
        return { notAddressedToReader: !recipients.includes(readerAddress.trim().toLowerCase()) };
    };

    const exposedHeaders = (protectedHeaders: ProtectedHeaders | undefined): Pick<MessageSecurityResult, "protectedHeaders"> => {
        if (!protectedHeaders || extractAddresses(protectedHeaders.from).length === 0) {
            return {};
        }
        const { from, to, cc, subject } = protectedHeaders;
        return { protectedHeaders: { from, to, ...(cc !== undefined ? { cc } : {}), subject } };
    };

    if (isSignedOnlyContentType(contentType.value)) {
        const parsed = await parseSignedOnlyMessage(rawContentType, body);
        if (!parsed.verified) {
            return { result: { state: "signature_failed", signatureFailureReason: "invalid_signature" }, kind: "signed" };
        }
        const { failure, trusted, signer, acceptedSigner } = await checkSigner(parsed.signerCertificateDer, parsed.protectedHeaders, parsed.protectedHeaderFields, true);
        const content = {
            ...renderDisplayBody(parsed.displayBody),
            subject: parsed.protectedHeaders?.subject || undefined,
            ...exposedHeaders(parsed.protectedHeaders),
            attachments: parsed.attachments,
        };
        if (failure) {
            const result: MessageSecurityResult = { state: "signature_failed", signatureFailureReason: failure, ...(failure === "signer_key_changed" ? acceptedSigner : signer) };
            return { result, kind: "signed", ...(failure === "signer_key_changed" ? { signedContent: { ...content, ...addressing(parsed.protectedHeaders) } } : {}) };
        }
        return {
            result: { state: trusted ? "signed_verified" : "signed_unverified_signer", ...content, ...acceptedSigner, ...addressing(parsed.protectedHeaders) },
            kind: "signed",
        };
    }

    // A message the server sealed at rest: evaluate the original it holds - which may itself be signed or end-to-end encrypted -
    // and report one that was unprotected when it arrived as `protected_at_rest`, with its content.
    if (isEncryptedContentType(contentType) && !sealedAtRest && unlocked?.zeroAccessKeys?.length) {
        const original = await openZeroAccess(body, unlocked.zeroAccessKeys);
        if (original !== undefined) {
            const inner = await evaluateLive(original, unlocked, pinnedSignerFingerprints, readerAddress, true);
            const entity = parseMimeEntity(original);
            const subject = entity.headers["subject"];
            const calendarText = extractCalendarText(entity);
            const calendar = calendarText !== undefined ? { calendar: calendarText } : {};
            if (inner.result.state !== "unprotected") {
                // The stored message's own Subject is the placeholder: the original's stands in when the inner result has none.
                const fallbackSubject = inner.result.subject === undefined && subject !== undefined ? { subject: decodeHeaderText(subject) } : {};
                return { ...inner, result: { ...inner.result, ...fallbackSubject, ...calendar, zeroAccess: true } };
            }
            return {
                result: {
                    state: "protected_at_rest",
                    zeroAccess: true,
                    ...calendar,
                    ...renderDisplayBody(extractDisplayBody(entity)),
                    ...(subject !== undefined ? { subject: decodeHeaderText(subject) } : {}),
                    attachments: extractAttachments(entity),
                },
                kind: "other",
            };
        }
    }

    if (isEncryptedContentType(contentType)) {
        // The active key first, then the retained older ones (see `keySession.ts`'s `retainedEncryptionKeys`), so mail
        // encrypted to a key since replaced still opens. Only ever used to decrypt here - never to encrypt or sign.
        const keys = [
            ...(unlocked?.encryptionPrivateKey && unlocked.encryptionCertDer ? [{ certDer: unlocked.encryptionCertDer, privateKey: unlocked.encryptionPrivateKey }] : []),
            ...(unlocked?.retainedEncryptionKeys ?? []).map(({ certDer, privateKey }) => ({ certDer, privateKey })),
        ];
        if (keys.length === 0) {
            return { result: { state: "encrypted", decryptError: NO_KEY_ERROR }, kind: "encrypted" };
        }
        const parsed = await parseEncryptedMessageWithKeys(body, keys, actualOuterHeaders);
        if (!parsed.decrypted) {
            return { result: { state: "encrypted", decryptError: parsed.unsupportedContentEncryption ? UNSUPPORTED_ENCRYPTION_ERROR : NO_KEY_ERROR }, kind: "encrypted" };
        }
        // Anyone holding the reader's public certificate can encrypt a message with any protected headers they like, so they
        // are only exposed once a signature over them verified - and a key-changed message keeps them aside for a seal.
        const content = {
            ...renderDisplayBody(parsed.displayBody),
            headerTamperDetected: parsed.headerTamperDetected,
            subject: parsed.protectedHeaders?.subject || undefined,
            attachments: parsed.attachments,
            ...addressing(parsed.protectedHeaders),
        };
        const signedHeaders = exposedHeaders(parsed.protectedHeaders);
        if (parsed.signatureVerified === undefined) {
            return { result: { state: "encrypted", ...content }, kind: "encrypted" };
        }
        if (!parsed.signatureVerified) {
            return { result: { state: "signature_failed", signatureFailureReason: "invalid_signature", ...content }, kind: "encrypted" };
        }
        const { failure, trusted, signer, acceptedSigner } = await checkSigner(parsed.signerCertificateDer, parsed.protectedHeaders, parsed.protectedHeaderFields, false);
        if (failure) {
            return {
                result: { state: "signature_failed", signatureFailureReason: failure, ...content, ...(failure === "signer_key_changed" ? acceptedSigner : signer) },
                kind: "encrypted",
                ...(failure === "signer_key_changed" ? { signedContent: signedHeaders } : {}),
            };
        }
        return { result: { state: trusted ? "encrypted_verified" : "encrypted_unverified_signer", ...content, ...signedHeaders, ...acceptedSigner }, kind: "encrypted" };
    }

    return { result: { state: "unprotected" }, kind: "other" };
}

/** Which OpenPGP form a received message is, if any: RFC 3156 PGP/MIME (`multipart/signed` or `multipart/encrypted` with an OpenPGP
 * `protocol`), or an inline message - a `text/plain` body that is one armored `PGP MESSAGE`, or a cleartext signature. */
type PgpKind = "signed" | "encrypted" | "inline-encrypted" | "inline-signed";

const INLINE_PGP_MESSAGE = /^-----BEGIN PGP MESSAGE-----\r?\n[\s\S]*-----END PGP MESSAGE-----$/;
const INLINE_PGP_SIGNED = /^-----BEGIN PGP SIGNED MESSAGE-----\r?\n[\s\S]*-----END PGP SIGNATURE-----$/;

function pgpKind(contentType: { value: string; params: Record<string, string> }, entity: MimeEntity): PgpKind | undefined {
    const protocol = contentType.params["protocol"]?.toLowerCase();
    if (contentType.value === "multipart/signed" && protocol === "application/pgp-signature") {
        return "signed";
    }
    if (contentType.value === "multipart/encrypted" && protocol === "application/pgp-encrypted") {
        return "encrypted";
    }
    if (contentType.value !== "text/plain") {
        return undefined;
    }
    const text = decodeBodyText(entity).trim();
    return INLINE_PGP_MESSAGE.test(text) ? "inline-encrypted" : INLINE_PGP_SIGNED.test(text) ? "inline-signed" : undefined;
}

/**
 * `evaluateLive()` for an OpenPGP message (restapi `specs/end-to-end_encryption.md` *OpenPGP Interoperability*), with the same
 * trust rules as S/MIME: a signature by a key pinned for the sender (`SignerPins.openPgpKeys`) or the reader's own is verified;
 * one by a key only attached to the message is `*_unverified_signer` - or `signer_key_changed` when the sender has a different key
 * pinned; and the key must name the sender, with the protected headers matching the outer ones (`checkIdentityAndHeaders()`).
 * A signature nobody's key can check is reported through `signerKeyUnknown`, never as failed. The crypto is `pgpMessage.ts`'s,
 * loaded only here.
 */
async function evaluatePgp(
    kind: PgpKind,
    rawContentType: string,
    outer: MimeEntity,
    unlocked: MessageSecurityKeys | undefined,
    pins: SignerPinsInput,
    readerAddress: string | undefined,
): Promise<LiveEvaluation> {
    const pgp = await import("./pgpMessage.js");
    const pinned = (await pgp.readKeysBase64(pinnedOpenPgpKeys(pins))).map((key) => ({ key, trusted: true }));
    const ownKeys = unlocked?.openPgpKeys ?? [];
    const candidates: PgpSignerCandidate[] = [...pinned, ...ownKeys.map(({ privateKey }) => ({ key: privateKey.toPublic(), trusted: true }))];
    const decryptionKeys = ownKeys.map(({ privateKey }) => privateKey);
    const encrypted = kind === "encrypted" || kind === "inline-encrypted";
    const text = decodeBodyText(outer).trim();
    let parsed: ParsedPgpMessage;
    if (kind === "signed") {
        parsed = await pgp.parsePgpSignedMessage(rawContentType, outer.body, candidates);
    } else if (kind === "encrypted") {
        parsed = await pgp.parsePgpEncryptedMessage(rawContentType, outer.body, decryptionKeys, candidates);
    } else if (kind === "inline-encrypted") {
        parsed = await pgp.parsePgpInlineEncrypted(text, decryptionKeys, candidates);
    } else {
        parsed = await pgp.parsePgpCleartextSigned(text, candidates);
    }
    const resultKind: LiveEvaluation["kind"] = encrypted ? "encrypted" : "signed";
    if (encrypted && !parsed.decrypted) {
        return { result: { state: "encrypted", decryptError: NO_KEY_ERROR }, kind: resultKind };
    }
    if (parsed.entityText === undefined) {
        return { result: { state: "signature_failed", signatureFailureReason: "invalid_signature" }, kind: resultKind };
    }
    const entity = parseMimeEntity(parsed.entityText);
    const inline = kind === "inline-encrypted" || kind === "inline-signed";
    const protectedHeaders: ProtectedHeaders | undefined = inline ? undefined : headersToProtectedHeaders(entity.headers);
    const hasProtected = !!protectedHeaders && extractAddresses(protectedHeaders.from).length > 0;
    const hpOuter = encrypted && !inline ? extractHpOuterHeaders(entity.fields) : undefined;
    const outerComparable: ComparableOuterHeaders = { from: outer.headers["from"], to: outer.headers["to"], cc: outer.headers["cc"], date: outer.headers["date"], subject: outer.headers["subject"] };
    const recipients = [...extractAddresses(protectedHeaders?.to), ...extractAddresses(protectedHeaders?.cc)];
    const content: Partial<MessageSecurityResult> = {
        ...renderDisplayBody(extractDisplayBody(entity)),
        subject: (hasProtected ? protectedHeaders?.subject : undefined) || undefined,
        attachments: extractAttachments(entity),
        ...(hpOuter ? { headerTamperDetected: !outerHeadersMatch(hpOuter, outerComparable) } : {}),
        ...(readerAddress && recipients.length > 0 ? { notAddressedToReader: !recipients.includes(readerAddress.trim().toLowerCase()) } : {}),
    };
    const signature = parsed.signature;
    if (!signature) {
        // Encrypted without a signature (an unsigned signed-only message can't happen: it is the signature).
        return { result: { state: "encrypted", ...content }, kind: resultKind };
    }
    if (signature.status === "unknown_key") {
        return { result: encrypted ? { state: "encrypted", ...content, signerKeyUnknown: true } : { state: "unprotected", signerKeyUnknown: true }, kind: resultKind };
    }
    if (signature.status === "invalid") {
        return { result: { state: "signature_failed", signatureFailureReason: "invalid_signature", ...(encrypted ? content : {}) }, kind: resultKind };
    }
    const signer = { signerFingerprint: signature.fingerprint, signerEmails: signature.emails, signerKeyType: "openpgp" as const };
    const acceptedSigner = { ...signer, signerCertificate: toBase64(signature.candidate.key.write()) };
    const signedHeaders: Partial<MessageSecurityResult> = hasProtected
        ? { protectedHeaders: { from: protectedHeaders.from, to: protectedHeaders.to, ...(protectedHeaders.cc !== undefined ? { cc: protectedHeaders.cc } : {}), subject: protectedHeaders.subject } }
        : {};
    const failure = checkIdentityAndHeaders(
        {
            protectedHeaders: hasProtected ? protectedHeaders : undefined,
            outerHeaders: outer.headers,
            outerFields: outer.fields,
            protectedFields: hasProtected ? entity.fields : undefined,
            compareSubject: !encrypted,
        },
        signature.emails,
    );
    // Signed by a key only attached to the message while the sender has OpenPGP keys pinned: they appear to use a new key.
    const keyChanged = !failure && !signature.candidate.trusted && pinned.length > 0;
    if (failure || keyChanged) {
        const reason: SignatureFailureReason = failure ?? "signer_key_changed";
        return {
            result: { state: "signature_failed", signatureFailureReason: reason, ...(encrypted ? content : {}), ...(reason === "signer_key_changed" ? acceptedSigner : signer) },
            kind: resultKind,
            ...(reason === "signer_key_changed" ? { signedContent: { ...content, ...signedHeaders } } : {}),
        };
    }
    const state: MessageSecurityState = signature.candidate.trusted ? (encrypted ? "encrypted_verified" : "signed_verified") : encrypted ? "encrypted_unverified_signer" : "signed_unverified_signer";
    return { result: { state, ...content, ...signedHeaders, ...acceptedSigner }, kind: resultKind };
}

/** Options for `evaluateMessageSecurityWithSeal()`. */
export interface VerificationSealOptions {
    mailboxUid: string;
    messageUid: string;
    /** The message's stored `Message.verificationSeal`, if any. */
    seal?: string;
    /** The vault's current `KeyVault.masterKeyGeneration` (`0` when it reports none): the generation a stored seal must
     * carry to be honoured, and the one a new `sealToWrite` is written under. */
    masterKeyGeneration: number;
    /** The message's stored `Message.verificationSealGeneration`, if any. When it is older than `masterKeyGeneration`, a
     * live verified message is re-sealed (after a `rekey()`). */
    sealGeneration?: number;
    /** The signer's key records the caller knows about, to tell whether the sealed signer key has since been revoked as
     * compromised: e.g. `[...state.pinned, ...state.previous]` from `contactsApi.ts`'s `fetchSignerKeyState()` for the
     * sender, plus the mailbox's own `keys` for mail from its own address. A record whose fingerprint equals the signer's
     * and fails `isTrustedForVerification()` sets `laterCompromised`. Omitted, `laterCompromised` is never set. */
    signerKeys?: readonly PublicKey[];
    /** The `verifiedAt` recorded in a new `sealToWrite`. Defaults to `Date.now()`. */
    now?: number;
}

const LIVE_VERIFIED_STATES: readonly MessageSecurityState[] = ["signed_verified", "encrypted_verified"];

/** Whether a live result failed only because of the signer key's status - the cases a seal may override. Every other
 * failure (an invalid signature, identity or header mismatch, `untrusted_signer`, HP-Outer tampering) never is. */
function failedOnlyOnKeyStatus(result: MessageSecurityResult): boolean {
    if (result.headerTamperDetected) {
        return false;
    }
    return (
        result.state === "signed_unverified_signer" ||
        result.state === "encrypted_unverified_signer" ||
        (result.state === "signature_failed" && result.signatureFailureReason === "signer_key_changed")
    );
}

/**
 * `evaluateMessageSecurity()` with verification seals (`verificationSeal.ts`). The live evaluation always runs first,
 * with the same arguments; then:
 *
 * **Live verified** (`"signed_verified"`/`"encrypted_verified"`, no HP-Outer tampering), and either no seal opens for this
 * mailbox, message, raw MIME and `options.masterKeyGeneration`, or `options.sealGeneration` is older than
 * `options.masterKeyGeneration`: the result gains `sealToWrite` (`{ seal, masterKeyGeneration }`), sealing the live
 * `signerFingerprint` and state at `options.now` under the current generation. The caller persists it best effort
 * (`setMessageVerificationSeal()`). This is how messages are re-sealed, lazily, after a `rekey()`: seals are never
 * carried across a master key rotation (see `verificationSeal.ts`).
 *
 * **Live failure caused only by key status** (`signer_key_changed`, `signed_unverified_signer`,
 * `encrypted_unverified_signer` - which also covers a signer key since revoked, since `signingKeyFingerprints()` drops
 * such pins): when the seal opens, its `signerFingerprint` equals the live one and its state matches the message kind
 * (signed-only vs. encrypted), the result is `"verified_at_first_open"` with `verifiedAt`, `sealedState`,
 * `signerFingerprint`, the recovered content (for a signed-only `signer_key_changed` message too), `liveState`,
 * `liveSignatureFailureReason` and `laterCompromised` (see `VerificationSealOptions.signerKeys`).
 * `signatureFailureReason` is dropped.
 *
 * **Everything else** returns the live result unchanged: an invalid signature, identity or header mismatch,
 * `untrusted_signer`, HP-Outer tampering, a seal whose MAC fails or whose hash, uids, generation or signer fingerprint differ, and
 * every unsigned state.
 *
 * With `unlocked` undefined (no master key) the seal is ignored and no seal is built. Throws `KeysLockedError` when
 * `unlocked` was destroyed (`keySession.ts`), before evaluating anything, or if it is destroyed while sealing; otherwise
 * never throws - a seal that can't be built (e.g. uids too long for the size limit) just leaves `sealToWrite` unset.
 */
export async function evaluateMessageSecurityWithSeal(
    rawMime: string,
    unlocked: (MessageSecurityKeys & SealKeyMaterial) | undefined,
    pinnedSignerFingerprints: SignerPinsInput,
    readerAddress: string | undefined,
    options: VerificationSealOptions,
): Promise<MessageSecurityResult> {
    if (unlocked?.destroyed) {
        throw new KeysLockedError();
    }
    const live = await evaluateLive(rawMime, unlocked, pinnedSignerFingerprints, readerAddress);
    const { result } = live;
    const isLiveVerified = LIVE_VERIFIED_STATES.includes(result.state) && !result.headerTamperDetected;
    // Every verified and key-status result carries the signer fingerprint (a certificate was always resolved).
    if (!unlocked || !result.signerFingerprint || (!isLiveVerified && !failedOnlyOnKeyStatus(result))) {
        return result;
    }

    const rawSha256 = await rawMimeSha256(rawMime);
    const generation = options.masterKeyGeneration;
    const opened = options.seal ? await openVerificationSeal(options.mailboxUid, unlocked, options.messageUid, options.seal, rawSha256, generation) : undefined;
    const signerFingerprint = result.signerFingerprint.toLowerCase();

    if (isLiveVerified) {
        const storedSealIsOlder = options.sealGeneration !== undefined && options.sealGeneration < generation;
        if (opened && !storedSealIsOlder) {
            return result;
        }
        try {
            const seal = await buildVerificationSeal(options.mailboxUid, unlocked, {
                messageUid: options.messageUid,
                rawSha256,
                signerFingerprint,
                state: result.state as SealedVerificationState,
                verifiedAt: options.now ?? Date.now(),
                masterKeyGeneration: generation,
            });
            return { ...result, sealToWrite: { seal, masterKeyGeneration: generation } };
        } catch (err) {
            if (err instanceof KeysLockedError) {
                throw err;
            }
            return result;
        }
    }

    const expectedSealedState: SealedVerificationState = live.kind === "signed" ? "signed_verified" : "encrypted_verified";
    if (!opened || opened.signerFingerprint !== signerFingerprint || opened.state !== expectedSealedState) {
        return result;
    }
    const laterCompromised = (options.signerKeys ?? []).some((key) => key.fingerprint.toLowerCase() === signerFingerprint && !isTrustedForVerification(key));
    const { signatureFailureReason, ...rest } = result;
    return {
        ...live.signedContent,
        ...rest,
        state: "verified_at_first_open",
        verifiedAt: opened.verifiedAt,
        sealedState: opened.state,
        liveState: result.state,
        ...(signatureFailureReason ? { liveSignatureFailureReason: signatureFailureReason } : {}),
        ...(laterCompromised ? { laterCompromised: true } : {}),
    };
}
