///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * How a message's embedded images are found among its attachments, shared by the reading pane (which shows them) and the reply/forward
 * quote (which carries them into the new message). Pure: nothing here touches the network or the DOM.
 */

/** The image types an embedded image may have: raster only. SVG is left out - a quote becomes part of a message this server sends. */
export const EMBEDDED_IMAGE_TYPES = /^image\/(?:png|jpe?g|gif|webp|avif|bmp)$/i;

/** What identifies an attachment as far as embedded images are concerned. */
export interface InlineCandidate {
    uid: string;
    filename: string;
    mimeType: string;
    contentId?: string;
}

/**
 * A `Content-ID` (or the token of a `cid:` URL) in the one form two references to the same part have in common: without the angle brackets of
 * the header, percent-decoding undone (a `cid:` URL is a URL), and in lower case (mail clients disagree on the case they write it in).
 */
export function normalizeContentId(value: string): string {
    let text = value.trim();
    try {
        text = decodeURIComponent(text);
    } catch {
        // Not percent-encoded after all (a `%` of its own): taken as written.
    }
    return text.trim().replace(/^<|>$/g, "").toLowerCase();
}

/** A file name as a person would compare two of them: form-encoding (`+` for a space) and case undone. */
function normalizeFilename(value: string): string {
    let text = value.trim().replace(/\+/g, " ");
    try {
        text = decodeURIComponent(text);
    } catch {
        // Taken as written.
    }
    return text.toLowerCase();
}

/**
 * The attachment an embedded image stands for: the one whose `Content-ID` is `cid` (see `normalizeContentId()`) or, for an image that
 * names no part we can find - a message from an older version of this app attached the picture without a `Content-ID`, and the server
 * then leaves the `<img>` with its `alt` only - the one image attachment whose file name is `alt`, when there is exactly one.
 */
export function findInlineAttachment<T extends InlineCandidate>(attachments: T[] | undefined, reference: { cid?: string; alt?: string }): T | undefined {
    if (!attachments) {
        return undefined;
    }
    if (reference.cid !== undefined) {
        const wanted = normalizeContentId(reference.cid);
        const byId = attachments.find((attachment) => attachment.contentId && normalizeContentId(attachment.contentId) === wanted);
        if (byId) {
            return byId;
        }
    }
    const alt = reference.alt?.trim();
    if (!alt) {
        return undefined;
    }
    const wanted = normalizeFilename(alt);
    const named = attachments.filter((attachment) => EMBEDDED_IMAGE_TYPES.test(attachment.mimeType) && normalizeFilename(attachment.filename) === wanted);
    return named.length === 1 ? named[0] : undefined;
}

/** The base64 of `bytes`. */
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/** A `data:` URI of `bytes` as `contentType`. */
export function toDataUri(contentType: string, bytes: Uint8Array): string {
    return `data:${contentType};base64,${bytesToBase64(bytes)}`;
}

const DATA_IMAGE = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]*)$/i;

/** The type and bytes of a base64 `data:image/...` URI, or `undefined` for anything else. */
export function parseDataImage(uri: string): { contentType: string; bytes: Uint8Array } | undefined {
    const match = DATA_IMAGE.exec(uri.trim());
    if (!match) {
        return undefined;
    }
    try {
        const binary = atob(match[2].replace(/\s/g, ""));
        return { contentType: match[1].toLowerCase(), bytes: Uint8Array.from(binary, (char) => char.charCodeAt(0)) };
    } catch {
        return undefined;
    }
}

/** A new `Content-ID` for an image about to be attached to a draft. */
export function newContentId(): string {
    return `${crypto.randomUUID()}@inline.rapidmx`;
}
