///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * MIME assembly around `smime.ts`'s CMS primitives, implementing `specs/end-to-end_encryption.md`'s
 * "Header Protection" requirement — RFC 9788, not the older, spec-forbidden RFC 8551 §3.1
 * `message/rfc822`-wrapping approach.
 *
 * RFC 9788's actual mechanism (verified against the RFC text directly, not assumed from memory,
 * given how easy it is to get a narrow/recent spec wrong from recollection alone): protected header
 * fields are **not** wrapped in a `multipart/mixed` gutter part. They become literal header lines
 * prepended directly to the MIME entity that is signed/encrypted (the "Cryptographic Payload"),
 * whose own `Content-Type` gains an `hp="clear"` (signed-only) or `hp="cipher"` (encrypted) parameter.
 * For encrypted messages, `HP-Outer: <Field>: <value>` lines carry a copy of the outer envelope's
 * headers inside the protected payload, so a recipient can detect outer-header tampering. The outer,
 * unprotected envelope keeps real `From`/`To`/`Cc`/`Date` values but MUST obscure `Subject` to the
 * literal `"[...]"` under `hcp_baseline` — RFC 9788's own required minimum default policy (a
 * conformant MUA "MUST have a default HCP that offers confidentiality for the Subject Header Field at
 * least" — Section 3.3); this module implements exactly that baseline, not the more ambitious
 * `hcp_shy` policy (which also strips display names and normalizes Date to UTC).
 *
 * Combined sign-then-encrypt uses **opaque** signing (`smime.ts`'s `signOpaque()`), embedding the
 * `hp="cipher"`-tagged content inside an `application/pkcs7-mime; smime-type="signed-data"` entity,
 * which is then itself the plaintext encrypted into the final `enveloped-data` — matching the nesting
 * RFC 9788's own worked example uses (outer enveloped-data → decrypts to signed-data → unwraps to the
 * real `hp="cipher"` content), not a `multipart/signed` structure encrypted as a whole.
 */
import { toBase64 } from "./encoding.js";
import {
    DisplayBody,
    binaryStringToBytes,
    bytesToBinaryString,
    decodeBase64Text,
    decodeBodyText,
    decodeHeaderText,
    encodeAddressListHeaderValue,
    encodeUnstructuredHeaderValue,
    isBinaryString,
    extractAttachments,
    extractDisplayBody,
    MimeAttachment,
    MimeHeaderField,
    parseMimeEntity,
    parseParameterizedHeader,
    splitMultipart,
} from "./mime.js";
import {
    type DecryptionKey,
    decryptEnvelopedDataWithKeys,
    encryptForRecipients,
    signDetached,
    signOpaque,
    UnsupportedContentEncryptionError,
    verifyDetached,
    verifyOpaque,
} from "./smime.js";

const CRLF = "\r\n";
/** RFC 2045's own line-length limit for base64-encoded body content. */
const BASE64_LINE_WIDTH = 76;

export interface ProtectedHeaders {
    from: string;
    to: string;
    cc?: string;
    /** An RFC 5322 date string (e.g. `new Date().toUTCString()`-shaped, `Date:`-header ready). */
    date: string;
    subject: string;
    messageId: string;
}

/** RFC 9788's `hcp_baseline` Header Confidentiality Policy — the RFC's own required minimum default
 * (Section 3.3). Applied to produce the OUTER, unprotected envelope's headers from the real
 * (protected) ones; `From`/`To`/`Cc`/`Date` pass through unchanged, `Subject` is obscured. */
export function applyBaselineOuterHeaders(headers: ProtectedHeaders): ProtectedHeaders {
    return { ...headers, subject: "[...]" };
}

function base64Wrapped(bytes: Uint8Array): string {
    const encoded = toBase64(bytes);
    const lines: string[] = [];
    for (let i = 0; i < encoded.length; i += BASE64_LINE_WIDTH) {
        lines.push(encoded.slice(i, i + BASE64_LINE_WIDTH));
    }
    return lines.join(CRLF);
}

function generateBoundary(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `----=_RapidMX_${Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`;
}

/** Strips CR/LF/NUL from a header value that has no further encoding (Date, Message-ID, Content-Type). */
function flattenHeaderValue(value: string): string {
    return value.replace(/[\r\n\0]+/g, " ");
}

/**
 * Serializes `headers` as RFC 5322 header lines, safely: CR/LF/NUL in any value become a space (so a
 * caller-supplied Subject or display name can never inject an extra header or end the header block), and
 * non-ASCII Subject text / display names are RFC 2047-encoded (`mime.ts`'s `encode*HeaderValue()`). The
 * protected copy, the `HP-Outer` copy and the outer envelope all go through this same deterministic
 * encoding, so the receive-side comparisons between them still compare like with like.
 */
function headerLines(headers: ProtectedHeaders, prefix = ""): string[] {
    return [
        `${prefix}From: ${encodeAddressListHeaderValue(headers.from)}`,
        `${prefix}To: ${encodeAddressListHeaderValue(headers.to)}`,
        ...(headers.cc ? [`${prefix}Cc: ${encodeAddressListHeaderValue(headers.cc)}`] : []),
        `${prefix}Date: ${flattenHeaderValue(headers.date)}`,
        `${prefix}Subject: ${encodeUnstructuredHeaderValue(headers.subject)}`,
        ...(prefix ? [] : [`Message-ID: ${flattenHeaderValue(headers.messageId)}`]),
    ];
}

function protectedHeaderLines(headers: ProtectedHeaders, hpOuter?: ProtectedHeaders): string {
    const lines = headerLines(headers);
    if (hpOuter) {
        // RFC 9788 Section 2.2.1's `hp-outer` field: the literal string "HP-Outer:" followed by the
        // original field name and its (outer, possibly-obscured) value. Written on every encrypted
        // message per the spec, and compared against the actual outer envelope on receipt by
        // parseEncryptedMessage() (see ParsedEncryptedMessage.headerTamperDetected).
        lines.push(...headerLines(hpOuter, "HP-Outer: "));
    }
    return lines.join(CRLF);
}

/** One MIME entity's worth of headers-beyond-Content-Type plus body, ready for a caller (the actual
 * outbound-message compose step, built on top of this module) to combine with the outer envelope's
 * own `From`/`To`/`Subject`/`Date`/`Message-ID`. */
export interface MimePart {
    /** The full `Content-Type` header value, including any parameters. */
    contentType: string;
    /** Any other headers this entity needs (`Content-Transfer-Encoding`, `Content-Disposition`, ...). */
    additionalHeaders?: Record<string, string>;
    body: string;
}

/**
 * Builds a detached `multipart/signed` message with RFC 9788 header protection (`hp="clear"`) — per
 * the spec, the only form signature-only messages may use (opaque signing is reserved for the
 * sign-then-encrypt case in `buildEncryptedMessage()`, where no legacy client is ever exposed to it).
 */
export async function buildSignedOnlyMessage(
    bodyContentType: string,
    bodyText: string,
    protectedHeaders: ProtectedHeaders,
    signingCertDer: Uint8Array,
    signingPrivateKey: CryptoKey,
): Promise<MimePart> {
    const boundary = generateBoundary();
    // Base64 so the signed bytes survive transport unchanged: a raw UTF-8 body is usually one long line, which
    // MTAs rewrap past 998 characters and so break the detached signature.
    const innerEntity = [
        protectedHeaderLines(protectedHeaders),
        `Content-Type: ${flattenHeaderValue(bodyContentType)}; hp="clear"`,
        `Content-Transfer-Encoding: base64`,
        "",
        base64Wrapped(new TextEncoder().encode(bodyText)),
    ].join(CRLF);

    const signature = await signDetached(new TextEncoder().encode(innerEntity), signingCertDer, signingPrivateKey);

    const body = [
        `--${boundary}`,
        innerEntity,
        `--${boundary}`,
        `Content-Type: application/pkcs7-signature; name="smime.p7s"`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="smime.p7s"`,
        "",
        base64Wrapped(signature),
        `--${boundary}--`,
    ].join(CRLF);

    return { contentType: `multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="${boundary}"`, body };
}

export interface ParsedSignedOnlyMessage {
    verified: boolean;
    /** The certificate pkijs matched to the verified SignerInfo (not merely the first embedded one). */
    signerCertificateDer?: Uint8Array;
    protectedHeaders?: ProtectedHeaders;
    /** Every header field of the signed entity, in order, repeats included - lets a caller reject a
     * message carrying more than one protected `From`/`To`/`Cc`/`Sender` (see `messageSecurity.ts`). */
    protectedHeaderFields?: MimeHeaderField[];
    bodyContentType?: string;
    /** The inner entity's body with its Content-Transfer-Encoding/charset decoded (for a multipart inner
     * entity this is the raw multipart text - use `displayBody` for what to render). */
    bodyText?: string;
    /** The displayable body: `html` only for a real text/html part, `text` for text/plain. */
    displayBody?: DisplayBody;
    /** The attachments inside the *signed* entity - the only ones the signature covers. */
    attachments?: MimeAttachment[];
}

const SIGNATURE_CONTENT_TYPES = new Set(["application/pkcs7-signature", "application/x-pkcs7-signature"]);
const PKCS7_MIME_CONTENT_TYPES = new Set(["application/pkcs7-mime", "application/x-pkcs7-mime"]);

/** Parses and verifies a `multipart/signed` message (RFC 1847/8551). Returns `{ verified: false }` (never
 * throws) for anything malformed — same "degrade to a failed-signature state, don't crash" contract as
 * `smime.ts`'s own verify functions. Accepts foreign-MUA framing: unquoted/case-varied parameters,
 * preamble/epilogue, transport padding, and a signed part stored with bare-LF line endings (retried in
 * canonical CRLF form, which is what RFC 8551 §3.1.1 says was actually signed). The body must hold exactly two
 * parts (RFC 1847 §2.1): a third part isn't covered by the signature, so a message carrying one is rejected
 * rather than shown - partly unsigned - under a verified badge. */
export async function parseSignedOnlyMessage(contentType: string, body: string): Promise<ParsedSignedOnlyMessage> {
    const boundary = parseParameterizedHeader(contentType).params["boundary"];
    if (!boundary) {
        return { verified: false };
    }
    const parts = splitMultipart(body, boundary);
    if (parts.length !== 2) {
        return { verified: false };
    }
    const [innerText, signaturePartText] = parts;
    const signaturePart = parseMimeEntity(signaturePartText);
    if (!SIGNATURE_CONTENT_TYPES.has(parseParameterizedHeader(signaturePart.headers["content-type"]).value)) {
        return { verified: false };
    }
    // The signature part is always base64 in practice (binary DER can't survive a text transport); a
    // missing Content-Transfer-Encoding header is treated as base64 too, matching common senders.
    const signatureDer = decodeBase64Text(signaturePart.body);
    if (!signatureDer || signatureDer.length === 0) {
        return { verified: false };
    }

    // The signed part's exact bytes: a binary string (see `mime.ts`) maps back to them one code unit per
    // byte; a string that was already decoded as text is UTF-8 encoded instead. A binary string holding
    // non-ASCII is also tried as UTF-8 text, for a caller that decoded an all-Latin-1 message itself. Each
    // form is retried in canonical CRLF form. Trying several byte forms is safe: each must still verify.
    const canonical = innerText.replace(/\r?\n/g, CRLF);
    const candidates: Uint8Array[] = [];
    for (const text of canonical === innerText ? [innerText] : [innerText, canonical]) {
        candidates.push(binaryStringToBytes(text));
        if (isBinaryString(text) && /[\x80-\xff]/.test(text)) {
            candidates.push(new TextEncoder().encode(text));
        }
    }
    let result: Awaited<ReturnType<typeof verifyDetached>> = { valid: false };
    for (const candidate of candidates) {
        result = await verifyDetached(candidate, signatureDer);
        if (result.valid) {
            break;
        }
    }
    if (!result.valid) {
        return { verified: false };
    }

    const inner = parseMimeEntity(innerText);
    return {
        verified: true,
        signerCertificateDer: result.signerCertificateDer,
        protectedHeaders: headersToProtectedHeaders(inner.headers),
        protectedHeaderFields: inner.fields,
        bodyContentType: inner.headers["content-type"],
        bodyText: decodeBodyText(inner),
        displayBody: extractDisplayBody(inner),
        attachments: extractAttachments(inner),
    };
}

/**
 * Builds an `application/pkcs7-mime; smime-type="enveloped-data"` message with RFC 9788 header
 * protection (`hp="cipher"`), optionally sign-then-encrypt when `signing` is supplied (opaque
 * signing — see this module's own doc comment for why). Per the spec's "Encrypt to Self"
 * requirement, `recipientCertDers` MUST include the sender's own encryption certificate.
 */
export async function buildEncryptedMessage(
    bodyContentType: string,
    bodyText: string,
    protectedHeaders: ProtectedHeaders,
    outerHeaders: ProtectedHeaders,
    recipientCertDers: Uint8Array[],
    signing?: { certDer: Uint8Array; privateKey: CryptoKey },
): Promise<MimePart> {
    const plaintextEntity = [
        protectedHeaderLines(protectedHeaders, outerHeaders),
        `Content-Type: ${flattenHeaderValue(bodyContentType)}; hp="cipher"`,
        "",
        bodyText,
    ].join(CRLF);

    let contentToEncrypt: Uint8Array;
    if (signing) {
        const signedDer = await signOpaque(new TextEncoder().encode(plaintextEntity), signing.certDer, signing.privateKey);
        contentToEncrypt = new TextEncoder().encode(
            [
                `Content-Type: application/pkcs7-mime; smime-type="signed-data"; name="smime.p7m"`,
                `Content-Transfer-Encoding: base64`,
                "",
                base64Wrapped(signedDer),
            ].join(CRLF),
        );
    } else {
        contentToEncrypt = new TextEncoder().encode(plaintextEntity);
    }

    const envelopedDer = await encryptForRecipients(contentToEncrypt, recipientCertDers);
    return {
        contentType: `application/pkcs7-mime; smime-type="enveloped-data"; name="smime.p7m"`,
        additionalHeaders: { "Content-Transfer-Encoding": "base64", "Content-Disposition": 'attachment; filename="smime.p7m"' },
        body: base64Wrapped(envelopedDer),
    };
}

/**
 * Combines a `MimePart` (from `buildSignedOnlyMessage()`/`buildEncryptedMessage()`) with the outer
 * envelope's own headers into one complete RFC 5322 message source, ready for `mailApi.ts`'s
 * `assembleDraftRaw()`. `outerHeaders` MUST be the already-obscured headers for an encrypted message
 * (`applyBaselineOuterHeaders()`'s output) - this function does no obscuring itself, it only serializes
 * whatever headers it's given. Deliberately excludes `Bcc`: that recipient list is submission-only and
 * must never appear as a message header (see `AssembleDraftRawInput`'s own doc comment - `bcc` is passed
 * to that call separately, never baked into `rawMime`). Header values are sanitized and RFC 2047-encoded
 * the same way as the protected headers (see `headerLines()`).
 */
export function assembleOutboundMime(outerHeaders: ProtectedHeaders, part: MimePart): string {
    const lines = [
        ...headerLines(outerHeaders),
        `MIME-Version: 1.0`,
        `Content-Type: ${flattenHeaderValue(part.contentType)}`,
        ...Object.entries(part.additionalHeaders ?? {}).map(([key, value]) => `${flattenHeaderValue(key)}: ${flattenHeaderValue(value)}`),
        "",
        part.body,
    ];
    return lines.join(CRLF);
}

export interface ParsedEncryptedMessage {
    decrypted: boolean;
    /** Whether an inner (opaque) signature was present and verified - `undefined` when the message
     * was encrypted without also being signed. */
    signatureVerified?: boolean;
    signerCertificateDer?: Uint8Array;
    protectedHeaders?: ProtectedHeaders;
    /** Every header field of the decrypted (and unwrapped) protected entity, in order, repeats included. */
    protectedHeaderFields?: MimeHeaderField[];
    bodyContentType?: string;
    bodyText?: string;
    /** `true` when `actualOuterHeaders` was supplied and disagrees with the `HP-Outer:` field copies
     * found in the decrypted protected content - RFC 9788's own requirement to "visually distinguish a
     * message whose outer and protected headers disagree" (a MITM or malicious intermediary rewrote the
     * unprotected envelope after signing/encryption). `false` when both were supplied and agree.
     * `undefined` when there's nothing to compare - no `actualOuterHeaders` given, or the message
     * carries no `HP-Outer:` lines at all (a foreign sender's S/MIME implementation that doesn't write
     * them, or a message from before this field existed). */
    headerTamperDetected?: boolean;
    /** The displayable body: `html` only for a real text/html part, `text` for text/plain. */
    displayBody?: DisplayBody;
    /** `true` when decryption was refused because the content encryption isn't AEAD (see `smime.ts`'s
     * `UnsupportedContentEncryptionError`) - lets the caller explain that instead of "wrong key". */
    unsupportedContentEncryption?: boolean;
    /** The attachments inside the decrypted (and, when signed, verified) entity. */
    attachments?: MimeAttachment[];
}

/** RFC 9788's `HP-Outer:` field-copy fields to actually compare - a subset of `ProtectedHeaders`
 * (`messageId` has no `HP-Outer` counterpart; only the fields the outer envelope itself carries do).
 * Exported so `messageSecurity.ts` can build one from a received message's real outer envelope. */
export type ComparableOuterHeaders = Partial<Pick<ProtectedHeaders, "from" | "to" | "cc" | "date" | "subject">>;

/** Extracts the outer-envelope header values RFC 9788's `HP-Outer: <Field>: <value>` mechanism embeds
 * inside an encrypted message's protected content - one line per outer header, all sharing the literal
 * field name `HP-Outer`, which `splitHeadersAndBody()`'s own flat header map can hold only the last of
 * (a real bug if reused for this - JSON/`Record` keys aren't multi-valued). Scans the raw header block
 * text directly instead. Returns `undefined` when no `HP-Outer:` lines are present at all, so a caller
 * can distinguish "nothing to compare" from "compared and everything matched". */
function extractHpOuterHeaders(fields: MimeHeaderField[]): ComparableOuterHeaders | undefined {
    const result: ComparableOuterHeaders = {};
    let found = false;
    for (const { name, value } of fields) {
        const match = name.toLowerCase() === "hp-outer" ? /^(From|To|Cc|Date|Subject):\s*(.*)$/i.exec(value) : null;
        if (!match) {
            continue;
        }
        found = true;
        result[match[1].toLowerCase() as keyof ComparableOuterHeaders] = match[2].trim();
    }
    return found ? result : undefined;
}

/** `true` when every field `hpOuter` actually carries matches `actualOuterHeaders`' value for that same
 * field - a field `hpOuter` doesn't carry (e.g. no `Cc` on this message) is not compared, since RFC
 * 9788 never claims coverage for it either way. */
function outerHeadersMatch(hpOuter: ComparableOuterHeaders, actualOuterHeaders: ComparableOuterHeaders): boolean {
    return (Object.keys(hpOuter) as (keyof ComparableOuterHeaders)[]).every((field) => hpOuter[field] === actualOuterHeaders[field]);
}

/** Decrypts (and, if present, verifies the inner signature of) a message built by
 * `buildEncryptedMessage()`. Returns `{ decrypted: false }` (never throws) for anything malformed or
 * undecryptable with the given key — the caller's own concern is distinguishing "wrong key" from
 * "corrupt message," neither of which this function treats as exceptional.
 *
 * `actualOuterHeaders` — the received message's real, unprotected outer envelope headers (as the
 * caller itself read them, before ever calling this function) — enables the RFC 9788 `HP-Outer`
 * comparison (see `ParsedEncryptedMessage.headerTamperDetected`); omit it to skip that check entirely.
 */
export async function parseEncryptedMessage(
    base64Body: string,
    recipientCertDer: Uint8Array,
    recipientPrivateKey: CryptoKey,
    actualOuterHeaders?: ComparableOuterHeaders,
): Promise<ParsedEncryptedMessage> {
    return parseEncryptedMessageWithKeys(base64Body, [{ certDer: recipientCertDer, privateKey: recipientPrivateKey }], actualOuterHeaders);
}

/** `parseEncryptedMessage()` with several candidate keys - the active encryption key first, then retained older ones -
 * decrypted by `smime.ts`'s `decryptEnvelopedDataWithKeys()` (recipient-identifier matching first, then a bounded
 * trial). Same never-throws contract. */
export async function parseEncryptedMessageWithKeys(
    base64Body: string,
    keys: DecryptionKey[],
    actualOuterHeaders?: ComparableOuterHeaders,
): Promise<ParsedEncryptedMessage> {
    const envelopedDer = decodeBase64Text(base64Body);
    if (!envelopedDer) {
        return { decrypted: false };
    }

    let decrypted: Uint8Array;
    try {
        decrypted = await decryptEnvelopedDataWithKeys(envelopedDer, keys);
    } catch (err) {
        return err instanceof UnsupportedContentEncryptionError ? { decrypted: false, unsupportedContentEncryption: true } : { decrypted: false };
    }

    function compareTamper(fields: MimeHeaderField[]): boolean | undefined {
        const hpOuter = extractHpOuterHeaders(fields);
        if (!hpOuter || !actualOuterHeaders) {
            return undefined;
        }
        return !outerHeadersMatch(hpOuter, actualOuterHeaders);
    }

    // Binary strings (see `mime.ts`), so an 8bit body's charset is applied to its real bytes.
    let entity = parseMimeEntity(bytesToBinaryString(decrypted));
    const wrapper = parseParameterizedHeader(entity.headers["content-type"]);
    let signature: Pick<ParsedEncryptedMessage, "signatureVerified" | "signerCertificateDer"> = {};

    if (PKCS7_MIME_CONTENT_TYPES.has(wrapper.value) && wrapper.params["smime-type"]?.toLowerCase() === "signed-data") {
        const signedDer = decodeBase64Text(entity.body);
        if (!signedDer) {
            return { decrypted: false };
        }
        const verifyResult = await verifyOpaque(signedDer);
        if (!verifyResult.valid) {
            return { decrypted: true, signatureVerified: false };
        }
        // verifyOpaque() always returns `content` alongside `valid: true`.
        entity = parseMimeEntity(bytesToBinaryString(verifyResult.content as Uint8Array));
        signature = { signatureVerified: true, signerCertificateDer: verifyResult.signerCertificateDer };
    }

    return {
        decrypted: true,
        ...signature,
        protectedHeaders: headersToProtectedHeaders(entity.headers),
        protectedHeaderFields: entity.fields,
        bodyContentType: entity.headers["content-type"],
        bodyText: decodeBodyText(entity),
        displayBody: extractDisplayBody(entity),
        attachments: extractAttachments(entity),
        headerTamperDetected: compareTamper(entity.fields),
    };
}

/** Splits a MIME entity's raw text into its header lines (lowercased-key map, first occurrence of each
 * name, unfolded) and raw body, plus the entity's own Content-Type value for convenience. Kept for
 * backward compatibility - new code should use `mime.ts`'s `parseMimeEntity()`, which also exposes every
 * repeated field in order. Tolerates bare-LF line endings. */
export function splitHeadersAndBody(entity: string): { headers: Record<string, string>; contentType?: string; body: string; rawHeaderBlock: string } {
    const { headers, body, rawHeaderBlock } = parseMimeEntity(entity);
    return { headers, contentType: headers["content-type"], body, rawHeaderBlock };
}

function headersToProtectedHeaders(headers: Record<string, string>): ProtectedHeaders {
    return {
        from: headers["from"] ?? "",
        to: headers["to"] ?? "",
        cc: headers["cc"],
        date: headers["date"] ?? "",
        // Display text: RFC 2047 encoded-words / raw UTF-8 decoded. The address fields stay raw - they are
        // only ever compared (via `extractAddresses()`), never shown.
        subject: decodeHeaderText(headers["subject"] ?? ""),
        messageId: headers["message-id"] ?? "",
    };
}
