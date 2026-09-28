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
import { DisplayBody, MimeAttachment, MimeHeaderField, decodeHeaderText, extractAddresses, parseMimeEntity, parseParameterizedHeader, plainTextToHtml } from "./mime.js";
import { toBase64 } from "./encoding.js";
import { computeCertFingerprint, extractCertificateEmails } from "./smime.js";
import { ComparableOuterHeaders, ProtectedHeaders, parseEncryptedMessageWithKeys, parseSignedOnlyMessage } from "./smimeMessage.js";
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
     * carries RFC 9788 protected headers (a protected `From`). Absent for a legacy S/MIME sender's signed-only
     * message: its outer Subject/To/Cc were then never signed, and a UI should not present them as verified. */
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
    "This message uses an older, unauthenticated encryption algorithm that RapidMX doesn't accept, so it can't be opened safely.";

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
    protectedHeaders: (Pick<ProtectedHeaders, "from" | "to"> & Partial<Pick<ProtectedHeaders, "cc" | "subject">>) | undefined;
    /** The received message's outer header map (lowercased names), as `parseMimeEntity()` returns it. */
    outerHeaders: Record<string, string>;
    /** Every outer header field in order (`parseMimeEntity()`'s `fields`) - checked for repeated
     * `From`/`To`/`Cc`/`Sender`. Omitted, only the first-occurrence map above is available. */
    outerFields?: MimeHeaderField[];
    /** Every protected header field in order - checked for repeats the same way. */
    protectedFields?: MimeHeaderField[];
    /** One trusted fingerprint or several (any match is accepted). An empty array counts as none supplied. */
    pinnedSignerFingerprint?: string | string[];
    /** Also require the protected `Subject` (when protected headers are present) to equal the outer one - right for
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

function normalizePins(pins: string | string[] | undefined): string[] {
    return (Array.isArray(pins) ? pins : pins === undefined ? [] : [pins]).map((pin) => pin.toLowerCase());
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
        return input.signerCertificateDer && checkIdentityAndHeaders(input, certDer) === undefined ? "signer_key_changed" : "untrusted_signer";
    }
    return checkIdentityAndHeaders(input, certDer);
}

/** Checks 3-4 from this module's doc comment. */
function checkIdentityAndHeaders(input: SignerBindingInput, certDer: Uint8Array): SignatureFailureReason | undefined {
    const { protectedHeaders, outerHeaders } = input;
    if (hasRepeatedAddressField(input.outerFields) || hasRepeatedAddressField(input.protectedFields)) {
        return "header_mismatch";
    }
    const outerFrom = extractAddresses(outerHeaders["from"]);
    const protectedFrom = extractAddresses(protectedHeaders?.from);
    const senderAddresses = protectedFrom.length > 0 ? protectedFrom : outerFrom;
    if (senderAddresses.length !== 1 || !extractCertificateEmails(certDer).includes(senderAddresses[0])) {
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
        if (input.compareSubject && normalizeSubject(protectedHeaders?.subject) !== normalizeSubject(outerHeaders["subject"])) {
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
    pinnedSignerFingerprints?: string | string[],
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
    pinnedSignerFingerprints: string | string[] | undefined,
    readerAddress: string | undefined,
): Promise<LiveEvaluation> {
    const { headers, body, fields } = parseMimeEntity(rawMime);
    const rawContentType = headers["content-type"];
    if (!rawContentType) {
        return { result: { state: "unprotected" }, kind: "other" };
    }
    const contentType = parseParameterizedHeader(rawContentType);
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
        const content = {
            ...renderDisplayBody(parsed.displayBody),
            headerTamperDetected: parsed.headerTamperDetected,
            subject: parsed.protectedHeaders?.subject || undefined,
            ...exposedHeaders(parsed.protectedHeaders),
            attachments: parsed.attachments,
            ...addressing(parsed.protectedHeaders),
        };
        if (parsed.signatureVerified === undefined) {
            return { result: { state: "encrypted", ...content }, kind: "encrypted" };
        }
        if (!parsed.signatureVerified) {
            return { result: { state: "signature_failed", signatureFailureReason: "invalid_signature", ...content }, kind: "encrypted" };
        }
        const { failure, trusted, signer, acceptedSigner } = await checkSigner(parsed.signerCertificateDer, parsed.protectedHeaders, parsed.protectedHeaderFields, false);
        if (failure) {
            return { result: { state: "signature_failed", signatureFailureReason: failure, ...content, ...(failure === "signer_key_changed" ? acceptedSigner : signer) }, kind: "encrypted" };
        }
        return { result: { state: trusted ? "encrypted_verified" : "encrypted_unverified_signer", ...content, ...acceptedSigner }, kind: "encrypted" };
    }

    return { result: { state: "unprotected" }, kind: "other" };
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
    pinnedSignerFingerprints: string | string[] | undefined,
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
