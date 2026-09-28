///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * A small, dependency-free MIME (RFC 5322 / RFC 2045-2047) parser used by `smimeMessage.ts` and
 * `messageSecurity.ts` to read *received* messages - which, unlike this package's own output, can come
 * from any foreign MUA/MTA. It deliberately covers exactly what S/MIME evaluation needs and nothing more:
 *
 * header unfolding (RFC 5322 §2.2.3) and CRLF-or-bare-LF line endings; case-insensitive RFC 2045
 * `type/subtype; name=value` parameters, quoted or unquoted; RFC 2046 multipart splitting with
 * preamble/epilogue, transport padding after the delimiter, and delimiters only recognized at the start
 * of a line; `Content-Transfer-Encoding` decoding (base64, quoted-printable; 7bit/8bit/binary pass
 * through) plus `charset` decoding via `TextDecoder`; and picking the displayable body (text/html
 * preferred, text/plain otherwise) out of a nested multipart.
 *
 * **Binary strings.** Received message source is handled as a "binary string": one UTF-16 code unit per
 * byte (0x00-0xFF), which is what `mailApi.ts`'s `getMessageRawContent()` returns (it reads the response
 * as bytes and decodes them as Latin-1) and what decrypted CMS content is converted to. That keeps an
 * 8bit body's bytes intact until its own `charset` is known, and keeps signed bytes verifiable exactly.
 * A string containing any code unit above 0xFF can't be a binary string, so it is treated as already
 * decoded text and UTF-8 encoded wherever bytes are needed (the pre-round-4 convention) - see
 * `binaryStringToBytes()`.
 *
 * Not supported (documented, not silently wrong): RFC 2231 parameter continuations/charset-encoded
 * parameters - not needed to classify, decrypt, or verify a message, and left verbatim. RFC 2047
 * encoded-words are decoded only where text is shown to a user (`decodeHeaderText()`); raw header values
 * (`MimeEntity.headers`) stay verbatim so header comparisons remain exact.
 */

/** One header field, unfolded, with its name exactly as written and its value trimmed. */
export interface MimeHeaderField {
    name: string;
    value: string;
}

export interface MimeEntity {
    /** Every header field in order - including repeated names (e.g. RFC 9788 `HP-Outer`). */
    fields: MimeHeaderField[];
    /** Lowercased name -> value of that name's FIRST occurrence. */
    headers: Record<string, string>;
    /** The raw, still-folded header block text (everything before the blank separator line). */
    rawHeaderBlock: string;
    /** The raw, undecoded body (everything after the blank separator line). */
    body: string;
}

export interface ParameterizedHeader {
    /** The lowercased main value (e.g. `multipart/signed`). */
    value: string;
    /** Lowercased parameter name -> unquoted value. */
    params: Record<string, string>;
}

/** Maximum multipart nesting `extractDisplayBody()` descends into - a hostile message can nest
 * arbitrarily deep, and nothing legitimate needs more than a handful of levels. */
const MAX_MULTIPART_DEPTH = 8;

/** Splits a MIME entity into its header fields and body. Never throws. */
export function parseMimeEntity(entity: string): MimeEntity {
    let rawHeaderBlock: string;
    let body: string;
    const leading = /^\r?\n/.exec(entity);
    if (leading) {
        // An entity whose very first line is blank has no headers at all (RFC 2046 §5.1.1 - a body part
        // with no header fields defaults to text/plain; charset=us-ascii).
        rawHeaderBlock = "";
        body = entity.slice(leading[0].length);
    } else {
        const separator = /\r?\n\r?\n/.exec(entity);
        rawHeaderBlock = separator ? entity.slice(0, separator.index) : entity;
        body = separator ? entity.slice(separator.index + separator[0].length) : "";
    }

    const fields: MimeHeaderField[] = [];
    const headers: Record<string, string> = {};
    const unfolded = rawHeaderBlock.replace(/\r?\n(?=[ \t])/g, "");
    for (const line of unfolded.split(/\r?\n/)) {
        const colonIndex = line.indexOf(":");
        if (colonIndex <= 0) {
            continue;
        }
        const name = line.slice(0, colonIndex).trim();
        const value = line.slice(colonIndex + 1).trim();
        fields.push({ name, value });
        const key = name.toLowerCase();
        if (!(key in headers)) {
            headers[key] = value;
        }
    }
    return { fields, headers, rawHeaderBlock, body };
}

/** Parses an RFC 2045 parameterized header value (`Content-Type`, `Content-Disposition`). */
export function parseParameterizedHeader(headerValue: string | undefined): ParameterizedHeader {
    const segments: string[] = [];
    let current = "";
    let inQuotes = false;
    const input = headerValue ?? "";
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (inQuotes && ch === "\\" && i + 1 < input.length) {
            current += input[++i];
        } else if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === ";" && !inQuotes) {
            segments.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    segments.push(current);

    const [main, ...rest] = segments;
    const params: Record<string, string> = {};
    for (const segment of rest) {
        const eq = segment.indexOf("=");
        const name = segment.slice(0, Math.max(eq, 0)).trim().toLowerCase();
        if (name && !(name in params)) {
            params[name] = segment.slice(eq + 1).trim();
        }
    }
    return { value: main.trim().toLowerCase(), params };
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Splits a multipart body on `boundary` per RFC 2046 §5.1.1: a delimiter is `--boundary` at the start of
 * a line (optionally followed by transport-padding whitespace), the CRLF preceding it belongs to the
 * delimiter (not the previous part), text before the first delimiter is preamble and text after the close
 * delimiter (`--boundary--`) is epilogue - both discarded. Each returned part is the exact text between
 * delimiter lines, which is what a `multipart/signed` signature covers.
 */
export function splitMultipart(body: string, boundary: string): string[] {
    const delimiter = new RegExp(`(?:^|\\r?\\n)--${escapeRegExp(boundary)}(--)?[ \\t]*(?=\\r?\\n|$)`, "g");
    const parts: string[] = [];
    let partStart = -1;
    let match: RegExpExecArray | null;
    while ((match = delimiter.exec(body)) !== null) {
        if (partStart !== -1) {
            parts.push(body.slice(partStart, Math.max(partStart, match.index)));
        }
        if (match[1]) {
            return parts;
        }
        const end = match.index + match[0].length;
        partStart = end + (body.startsWith("\r\n", end) ? 2 : body.startsWith("\n", end) ? 1 : 0);
    }
    // No close delimiter (a truncated message): whatever follows the last delimiter is still a part.
    if (partStart !== -1) {
        parts.push(body.slice(partStart));
    }
    return parts;
}

/** Returns the lowercased, trimmed `Content-Transfer-Encoding` mechanism, or `undefined`. */
function transferEncodingOf(entity: MimeEntity): string | undefined {
    return entity.headers["content-transfer-encoding"]?.trim().toLowerCase();
}

/** Decodes a base64 body into bytes, ignoring whitespace/line breaks. Returns `undefined` for invalid
 * base64 rather than throwing. */
export function decodeBase64Text(text: string): Uint8Array | undefined {
    try {
        const binary = atob(text.replace(/\s+/g, ""));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    } catch {
        return undefined;
    }
}

/** `true` when every code unit of `value` is at most 0xFF - i.e. it can be a binary string (see this
 * module's doc comment). */
export function isBinaryString(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) > 0xff) {
            return false;
        }
    }
    return true;
}

/** Converts a binary string to its bytes, or - for a string that can't be one (a code unit above 0xFF) -
 * to its UTF-8 encoding. */
export function binaryStringToBytes(value: string): Uint8Array {
    if (!isBinaryString(value)) {
        return new TextEncoder().encode(value);
    }
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
        bytes[i] = value.charCodeAt(i);
    }
    return bytes;
}

/** Converts bytes to a binary string (one code unit per byte), in chunks so a large message never exceeds
 * the engine's argument-count limit. */
export function bytesToBinaryString(bytes: Uint8Array): string {
    const CHUNK = 0x8000;
    const pieces: string[] = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
        pieces.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
    }
    return pieces.join("");
}

function hexValue(code: number): number {
    if (code >= 0x30 && code <= 0x39) return code - 0x30;
    if (code >= 0x41 && code <= 0x46) return code - 0x37;
    if (code >= 0x61 && code <= 0x66) return code - 0x57;
    return -1;
}

/** Decodes a quoted-printable body (RFC 2045 §6.7) into bytes, in one linear pass into a preallocated
 * buffer. Literal text between escapes (which can't legally be non-ASCII in QP, but is after an
 * 8-bit-unsafe gateway) is written run by run, decided once for the whole input: as the runs' own bytes
 * when the input is a binary string, else as their UTF-8 encoding (so an already-decoded `é` next to an
 * emoji isn't written as a lone 0xE9 byte). A run always ends at an ASCII `=`, so a surrogate pair is never
 * split. */
export function decodeQuotedPrintable(text: string): Uint8Array {
    const input = text.replace(/=[ \t]*\r?\n/g, "");
    const binary = isBinaryString(input);
    // At most 3 UTF-8 bytes per UTF-16 code unit, which only a non-binary string can need.
    const out = new Uint8Array(binary ? input.length : input.length * 3);
    const encoder = new TextEncoder();
    let length = 0;
    let runStart = 0;
    const flushRun = (end: number) => {
        if (binary) {
            for (let j = runStart; j < end; j++) {
                out[length++] = input.charCodeAt(j);
            }
        } else {
            length += encoder.encodeInto(input.slice(runStart, end), out.subarray(length)).written;
        }
    };
    for (let i = 0; i + 2 < input.length; i++) {
        if (input.charCodeAt(i) !== 0x3d) {
            continue;
        }
        const high = hexValue(input.charCodeAt(i + 1));
        const low = hexValue(input.charCodeAt(i + 2));
        if (high < 0 || low < 0) {
            continue;
        }
        flushRun(i);
        out[length++] = (high << 4) | low;
        i += 2;
        runStart = i + 1;
    }
    flushRun(input.length);
    return out.slice(0, length);
}

/** Decodes `bytes` in `charset` (UTF-8 when absent or unknown). With `fallbackText`, a decode that hits
 * invalid input returns `fallbackText` instead of replacement characters. */
function decodeCharset(bytes: Uint8Array, charset: string | undefined, fallbackText?: string): string {
    const options = { fatal: fallbackText !== undefined };
    let decoder: TextDecoder;
    try {
        decoder = new TextDecoder(charset || "utf-8", options);
    } catch {
        // An unknown/unsupported charset label - UTF-8 is the least-bad fallback (a superset of ASCII).
        decoder = new TextDecoder("utf-8", options);
    }
    try {
        return decoder.decode(bytes);
    } catch {
        return fallbackText as string;
    }
}

/** Decodes an entity's body into bytes per its `Content-Transfer-Encoding`. 7bit/8bit/binary (or no
 * header) return the body's own bytes (see `binaryStringToBytes()`). Returns `undefined` only for invalid
 * base64. */
export function decodeBodyBytes(entity: MimeEntity): Uint8Array | undefined {
    const cte = transferEncodingOf(entity);
    if (cte === "base64") {
        return decodeBase64Text(entity.body);
    }
    if (cte === "quoted-printable") {
        return decodeQuotedPrintable(entity.body);
    }
    return binaryStringToBytes(entity.body);
}

/** Decodes an entity's body to text: transfer encoding first, then its `charset` parameter (UTF-8 when
 * absent). A 7bit/8bit/binary body that isn't a binary string was already decoded by whoever produced the
 * string and passes through unchanged; so does a binary-string body whose bytes are invalid in its charset
 * (e.g. legacy already-decoded Latin-1 text under a UTF-8 charset). */
export function decodeBodyText(entity: MimeEntity): string {
    const cte = transferEncodingOf(entity);
    const charset = parseParameterizedHeader(entity.headers["content-type"]).params["charset"];
    if (cte !== "base64" && cte !== "quoted-printable") {
        return isBinaryString(entity.body) ? decodeCharset(binaryStringToBytes(entity.body), charset, entity.body) : entity.body;
    }
    return decodeCharset(decodeBodyBytes(entity) ?? new Uint8Array(), charset);
}

const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
const WHITESPACE_BETWEEN_ENCODED_WORDS = /(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)/g;

/**
 * Turns a raw header value into display text: a binary string holding valid UTF-8 (a raw 8-bit header,
 * RFC 6532) is decoded as UTF-8, then RFC 2047 encoded-words (`=?charset?B|Q?text?=`) are decoded, with
 * whitespace between adjacent encoded-words dropped (RFC 2047 §6.2). An encoded-word with an unknown
 * charset or undecodable content is left verbatim.
 */
export function decodeHeaderText(value: string): string {
    let text = value;
    if (isBinaryString(text) && /[\x80-\xff]/.test(text)) {
        text = decodeCharset(binaryStringToBytes(text), "utf-8", text);
    }
    return text.replace(WHITESPACE_BETWEEN_ENCODED_WORDS, "$1").replace(ENCODED_WORD, (word, charset: string, encoding: string, encoded: string) => {
        const bytes =
            encoding.toUpperCase() === "B"
                ? decodeBase64Text(encoded)
                : binaryStringToBytes(encoded.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16))));
        if (!bytes) {
            return word;
        }
        try {
            // RFC 2231 §5 allows a language suffix on the charset: `charset*lang`.
            return new TextDecoder(charset.split("*")[0], { fatal: true }).decode(bytes);
        } catch {
            return word;
        }
    });
}

/** Anything outside printable ASCII (space through `~`) and tab - such header text needs RFC 2047 encoding. */
const NEEDS_ENCODING = /[^\x20-\x7e\t]/;

/** Characters that must never reach a serialized header value: CR/LF (header injection) and NUL. */
const HEADER_BREAKING = /[\r\n\0]+/g;

/** Encodes `text` as RFC 2047 `B` encoded-words (UTF-8), each at most 75 characters, never splitting a
 * multi-byte character between words, joined by folding whitespace. */
function encodeWords(text: string): string {
    // "=?UTF-8?B?" + "?=" is 12 characters, leaving 63 for base64 - i.e. at most 45 source bytes.
    const MAX_BYTES_PER_WORD = 45;
    const encoder = new TextEncoder();
    const words: string[] = [];
    let current = "";
    let currentBytes = 0;
    for (const ch of text) {
        const size = encoder.encode(ch).length;
        if (currentBytes + size > MAX_BYTES_PER_WORD && current) {
            words.push(current);
            current = "";
            currentBytes = 0;
        }
        current += ch;
        currentBytes += size;
    }
    words.push(current);
    return words.map((word) => `=?UTF-8?B?${btoa(bytesToBinaryString(encoder.encode(word)))}?=`).join("\r\n ");
}

/** Makes an unstructured header value (e.g. `Subject`) safe to serialize: CR/LF/NUL become a space
 * (never a header break), and a value containing non-ASCII is RFC 2047-encoded. */
export function encodeUnstructuredHeaderValue(value: string): string {
    const flattened = value.replace(HEADER_BREAKING, " ");
    return NEEDS_ENCODING.test(flattened) ? encodeWords(flattened) : flattened;
}

/** Encodes one mailbox (`Name <addr>` or a bare addr-spec) - see `encodeAddressListHeaderValue()`. */
function encodeMailbox(mailbox: string): string {
    const angle = mailbox.lastIndexOf("<");
    if (angle === -1) {
        // A bare addr-spec (possibly internationalized) stays verbatim; stray non-ASCII text that
        // isn't an address at all is encoded rather than written raw.
        const bare = mailbox.trim();
        return bare.includes("@") || !NEEDS_ENCODING.test(bare) ? bare : encodeWords(bare);
    }
    const rawName = mailbox.slice(0, angle).trim();
    const address = mailbox.slice(angle).trim();
    const name = encodePhrase(rawName);
    return name ? `${name} ${address}` : address;
}

/** Encodes a display-name phrase (a mailbox's name or a group's label): unquoted and RFC 2047-encoded when
 * it holds non-ASCII, else kept exactly as written. */
function encodePhrase(rawPhrase: string): string {
    const phrase = rawPhrase.trim();
    const unquoted = /^".*"$/.test(phrase) ? phrase.slice(1, -1).replace(/\\(.)/g, "$1") : phrase;
    return NEEDS_ENCODING.test(unquoted) ? encodeWords(unquoted) : phrase;
}

/**
 * Makes an address-list header value (`From`/`To`/`Cc`) safe to serialize: CR/LF/NUL become a space, and
 * each mailbox's non-ASCII display name (`Zoë <z@example.com>`, quoted or not) is RFC 2047-encoded while
 * its addr-spec is kept verbatim (an internationalized address is left to SMTPUTF8, never encoded -
 * RFC 2047 §5 forbids encoded-words in an addr-spec). RFC 5322 group syntax (`Équipe: Zoë <z@x>, b@x;`)
 * keeps its `:` and `;`, with the group label encoded as a phrase of its own. A top-level `:` only opens
 * a group when a `;` follows it, so a stray colon in an unquoted display name isn't mistaken for one.
 */
export function encodeAddressListHeaderValue(value: string): string {
    const flattened = value.replace(HEADER_BREAKING, " ");
    if (!NEEDS_ENCODING.test(flattened)) {
        return flattened;
    }
    let out = "";
    let current = "";
    let inQuotes = false;
    let inAngle = false;
    let inGroup = false;
    const emit = (encoded: string, delimiter: string) => {
        out += (encoded && /[,:;]$/.test(out) ? " " : "") + encoded + delimiter;
        current = "";
    };
    for (let i = 0; i < flattened.length; i++) {
        const ch = flattened[i];
        if (inQuotes && ch === "\\" && i + 1 < flattened.length) {
            current += ch + flattened[++i];
            continue;
        }
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (!inQuotes && ch === "<") {
            inAngle = true;
        } else if (!inQuotes && ch === ">") {
            inAngle = false;
        } else if (!inQuotes && !inAngle) {
            if (ch === ",") {
                emit(encodeMailbox(current), ",");
                continue;
            }
            if (ch === ":" && !inGroup && flattened.includes(";", i)) {
                emit(encodePhrase(current), ":");
                inGroup = true;
                continue;
            }
            if (ch === ";" && inGroup) {
                emit(encodeMailbox(current), ";");
                inGroup = false;
                continue;
            }
        }
        current += ch;
    }
    emit(encodeMailbox(current), "");
    return out;
}

/** A message's displayable content: `html` only for a real `text/html` part, `text` only for a
 * `text/plain` part - never plain text mislabeled as HTML. */
export interface DisplayBody {
    html?: string;
    text?: string;
}

function isAttachment(entity: MimeEntity): boolean {
    return parseParameterizedHeader(entity.headers["content-disposition"]).value === "attachment";
}

/** Picks the displayable body out of an entity: a `text/html` part is preferred over `text/plain`, and a
 * multipart entity is searched (non-attachment children only, bounded depth). Entities with no
 * Content-Type default to text/plain per RFC 2045 §5.2. */
export function extractDisplayBody(entity: MimeEntity, depth = 0): DisplayBody {
    const contentType = parseParameterizedHeader(entity.headers["content-type"] ?? "text/plain");
    if (contentType.value === "text/html") {
        return { html: decodeBodyText(entity) };
    }
    if (contentType.value === "text/plain") {
        return { text: decodeBodyText(entity) };
    }
    const boundary = contentType.params["boundary"];
    if (!contentType.value.startsWith("multipart/") || !boundary || depth >= MAX_MULTIPART_DEPTH) {
        return {};
    }
    let text: string | undefined;
    for (const part of splitMultipart(entity.body, boundary)) {
        const child = parseMimeEntity(part);
        if (isAttachment(child)) {
            continue;
        }
        const found = extractDisplayBody(child, depth + 1);
        if (found.html !== undefined) {
            return { html: found.html };
        }
        text ??= found.text;
    }
    return text === undefined ? {} : { text };
}

/** One attachment found inside a MIME entity (see `extractAttachments()`). */
export interface MimeAttachment {
    /** The `Content-Disposition` `filename` (else the `Content-Type` `name`), RFC 2047-decoded; absent if neither. */
    filename?: string;
    /** The lowercased MIME type, e.g. `application/pdf`. */
    contentType: string;
    /** `"attachment"` for `Content-Disposition: attachment`, `"inline"` otherwise (an inline image, or a part with a
     * filename and no disposition). */
    disposition: "attachment" | "inline";
    /** The `Content-ID` without its angle brackets, if any - how an HTML body references an inline part. */
    contentId?: string;
    /** Decodes the part's content (transfer encoding undone) - lazily, so evaluating a message never pays for
     * attachments nobody opens. `undefined` for invalid base64. */
    decode(): Uint8Array | undefined;
}

/**
 * Lists the attachments inside `entity` (descending into multipart children, bounded depth): every leaf part
 * with `Content-Disposition: attachment`, a filename, or a non-text type. The `text/plain`/`text/html` parts a
 * reader would display (no disposition, no filename) are not attachments. Nested `message/rfc822` content is
 * reported as one attachment, never expanded.
 */
export function extractAttachments(entity: MimeEntity, depth = 0): MimeAttachment[] {
    const contentType = parseParameterizedHeader(entity.headers["content-type"] ?? "text/plain");
    const disposition = parseParameterizedHeader(entity.headers["content-disposition"]);
    const boundary = contentType.params["boundary"];
    if (contentType.value.startsWith("multipart/")) {
        if (!boundary || depth >= MAX_MULTIPART_DEPTH) {
            return [];
        }
        return splitMultipart(entity.body, boundary).flatMap((part) => extractAttachments(parseMimeEntity(part), depth + 1));
    }
    const rawFilename = disposition.params["filename"] ?? contentType.params["name"];
    const isAttachmentDisposition = disposition.value === "attachment";
    if (!isAttachmentDisposition && rawFilename === undefined && contentType.value.startsWith("text/")) {
        return [];
    }
    const contentId = entity.headers["content-id"]?.trim().replace(/^<(.*)>$/, "$1");
    return [
        {
            ...(rawFilename !== undefined ? { filename: decodeHeaderText(rawFilename) } : {}),
            contentType: contentType.value,
            disposition: isAttachmentDisposition ? "attachment" : "inline",
            ...(contentId ? { contentId } : {}),
            decode: () => decodeBodyBytes(entity),
        },
    ];
}

/** HTML-escapes plain text and wraps it in a whitespace-preserving `<pre>`, so a `text/plain` body can be
 * rendered through the same HTML path without ever being interpreted as markup. */
export function plainTextToHtml(text: string): string {
    const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    return `<pre style="white-space: pre-wrap; word-wrap: break-word; font-family: inherit">${escaped}</pre>`;
}

/** Extracts the bare, lowercased addr-specs from an address-list header value (`"Name" <a@b>, c@d`).
 * Handles quoted display names containing commas/angle brackets and RFC 5322 comments. */
export function extractAddresses(headerValue: string | undefined): string[] {
    if (!headerValue) {
        return [];
    }
    const withoutQuoted = headerValue.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\((?:[^()\\]|\\.)*\)/g, "");
    const addresses: string[] = [];
    for (const item of withoutQuoted.split(",")) {
        const angle = /<([^>]*)>/.exec(item);
        // A bare addr-spec may carry RFC 5322 group syntax around it (`Team: a@b, c@d;`).
        const address = (angle ? angle[1] : item.replace(/^[^:]*:/, "").replace(/;\s*$/, "")).trim().toLowerCase();
        if (address.includes("@")) {
            addresses.push(address);
        }
    }
    return addresses;
}
