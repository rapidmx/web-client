///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiRequestError, apiUrl } from "@rapidmx/react-shared/util/api.js";
import { Attachment, attachmentContentUrl } from "@rapidmx/react-shared/mail/mailApi.js";
import type { MimeAttachment } from "@rapidmx/react-shared/crypto/mime.js";

/** What a message's body is: server-sanitized HTML, or plain text (a message with no HTML part, or the server's plain-text fallback). */
export type BodyContent = { kind: "html"; html: string } | { kind: "text"; text: string };

/** How many bodies are remembered for the session - a thread that is expanded, collapsed and expanded again does not ask the server twice. */
const CACHE_LIMIT = 40;
/** What the pane asks `/content` for. */
export const ACCEPT = "text/html, text/plain;q=0.8";
const cache = new Map<string, BodyContent>();

/** Forgets every remembered body (sign-out, and the tests). */
export function clearBodyContentCache(): void {
    cache.clear();
}

/** The remembered body for a message at a version, if any. */
export function cachedBodyContent(uid: string, version: number): BodyContent | undefined {
    return cache.get(`${uid}:${version}`);
}

/**
 * The message's body from the server's `GET /mail/messages/:id/content`: the HTML the server sanitized when it ingested the message
 * (`sanitizedHtmlBlobKey`), or - for a message with none - the plain-text preview. A request that fails throws an `ApiRequestError`.
 * Successful answers are remembered per uid and version.
 */
export async function fetchBodyContent(uid: string, version: number, signal?: AbortSignal): Promise<BodyContent> {
    const cached = cachedBodyContent(uid, version);
    if (cached) {
        return cached;
    }
    // Says what it can show, as a document request would: the server answers with the sanitized HTML, or its plain-text fallback.
    const res = await fetch(apiUrl(`/mail/messages/${encodeURIComponent(uid)}/content`), {
        credentials: "include",
        headers: { Accept: ACCEPT },
        signal,
    });
    if (!res.ok) {
        const contentType = res.headers.get("content-type") ?? "";
        const body = contentType.includes("application/json") ? await res.json().catch(() => undefined) : undefined;
        throw new ApiRequestError((body && (body.message || body.error)) || res.statusText || "Could not load this message.", res.status, body?.code, body);
    }
    const text = await res.text();
    const content: BodyContent = (res.headers.get("content-type") ?? "").toLowerCase().includes("text/html")
        ? { kind: "html", html: text }
        : { kind: "text", text };
    if (cache.size >= CACHE_LIMIT) {
        cache.delete(cache.keys().next().value as string);
    }
    cache.set(`${uid}:${version}`, content);
    return content;
}

/** The largest inline image embedded into a body from a signed or encrypted message. */
export const MAX_INLINE_IMAGE_BYTES = 5_000_000;
const INLINE_IMAGE_TYPES = /^image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/;

function base64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/** A server attachment record as it may really arrive: the model carries the part's `Content-ID`, though the client type doesn't list it. */
export type InlineCapable = Attachment & { contentId?: string };

/** The absolute URL of an attachment - the frame is a document of its own, where a relative URL would not mean what it does here. */
export function absoluteAttachmentUrl(uid: string): string {
    return new URL(attachmentContentUrl(uid), window.location.href).href;
}

/** The CSP source that allows exactly this server's attachment URLs and nothing else. */
export function attachmentSource(): string {
    return new URL(apiUrl("/mail/attachments/"), window.location.href).href;
}

/**
 * How an inline `cid:` image is resolved to something the frame may load: for a message shown from the server, the attachment whose
 * `Content-ID` matches (its URL on this server); for a decrypted or verified one, the part inside the signed/encrypted entity, embedded
 * as a `data:` URI (raster and SVG images up to `MAX_INLINE_IMAGE_BYTES`). Anything else has no source, so the image is not shown.
 */
export function makeCidResolver(attachments: InlineCapable[] | undefined, parts: MimeAttachment[] | undefined): (contentId: string) => string | undefined {
    return (contentId) => {
        if (parts) {
            const part = parts.find((candidate) => candidate.contentId === contentId);
            const bytes = part && INLINE_IMAGE_TYPES.test(part.contentType) ? part.decode() : undefined;
            return part && bytes && bytes.length <= MAX_INLINE_IMAGE_BYTES ? `data:${part.contentType};base64,${base64(bytes)}` : undefined;
        }
        const attachment = attachments?.find((candidate) => candidate.contentId === contentId);
        return attachment ? absoluteAttachmentUrl(attachment.uid) : undefined;
    };
}
