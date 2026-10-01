///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { apiUrl } from "../../../../../lib/util/api.js";
import { Message, Recipient, attachmentContentUrl, getMessageRawContent, listAttachments } from "../../../../../lib/mail/mailApi.js";
import type { QuotedBody } from "../../../../../lib/mail/compose/composeQuoting.js";
import { MAX_QUOTED_IMAGE_BYTES, QuotedImageReference, embedQuotedImages } from "../../../../../lib/mail/compose/quotedImages.js";
import { EMBEDDED_IMAGE_TYPES, findInlineAttachment, toDataUri } from "../../../../../lib/mail/inlineImages.js";
import type { MessageSecurityResult } from "../../../../../lib/crypto/messageSecurity.js";
import { MimeAttachment, decodeHeaderText, extractDisplayBody, parseMimeEntity } from "../../../../../lib/crypto/mime.js";
import { parseRecipientList } from "./recipients.js";

/** What a Reply/Reply All/Forward needs from the message being answered, beyond what its `Message` record holds. */
export interface OriginalMessage {
    /** The body to quote. Empty when none could be loaded - the quote builders then fall back to `bodyPreview`. */
    body: QuotedBody;
    /** The original To and Cc recipients, recovered from the message's own headers - `undefined` when they couldn't
     * be. Only asked for by Reply All (see `loadOriginalMessage()`). */
    recipients?: Recipient[];
}

/** How long a reply waits for the original's body before it goes ahead with the preview - a slow or hung request must not
 * leave the window waiting on it (or, before it opened at once, keep it from opening) indefinitely. */
export const QUOTE_FETCH_TIMEOUT_MS = 10_000;
/** How long a fetched (or prefetched) body is remembered, so hovering Reply and then clicking it costs one request. */
export const QUOTE_CACHE_MS = 30_000;

const contentCache = new Map<string, { at: number; promise: Promise<string | undefined> }>();

/**
 * The server's sanitized HTML body of a message (`GET /mail/messages/:id/content`), or `undefined` when it has none (a
 * `text/plain` message is answered with its preview instead) or the request failed or timed out. Never rejects. Remembered
 * for `QUOTE_CACHE_MS` - except a failure, which is asked again the next time.
 */
function fetchContentHtml(uid: string): Promise<string | undefined> {
    const cached = contentCache.get(uid);
    if (cached && Date.now() - cached.at < QUOTE_CACHE_MS) {
        return cached.promise;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUOTE_FETCH_TIMEOUT_MS);
    const promise = (async (): Promise<string | undefined> => {
        try {
            const res = await fetch(apiUrl(`/mail/messages/${encodeURIComponent(uid)}/content`), { credentials: "include", signal: controller.signal });
            return res.ok && (res.headers.get("content-type") ?? "").includes("text/html") ? await res.text() : undefined;
        } catch {
            return undefined;
        } finally {
            clearTimeout(timer);
        }
    })();
    contentCache.set(uid, { at: Date.now(), promise });
    void promise.then((html) => {
        if (html === undefined && contentCache.get(uid)?.promise === promise) {
            contentCache.delete(uid);
        }
    });
    return promise;
}

/** Rejects when `promise` hasn't settled within `ms` (`getMessageRawContent()` takes no `AbortSignal`, so it is raced rather than aborted). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out.")), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Starts fetching what a Reply/Forward of `message` will quote, without waiting for the click - called when the pointer or
 * keyboard reaches a Reply/Reply All/Forward button - so the request is usually already answered when it is clicked.
 * Nothing to fetch for an encrypted message (`loadOriginalMessage()` never asks the server for one's body).
 */
export function prefetchOriginalMessage(message: Message): void {
    if (!message.encrypted) {
        void fetchContentHtml(message.uid);
    }
}

/** Forgets every remembered body (the sign-out and test seam). */
export function clearOriginalMessageCache(): void {
    contentCache.clear();
}

/** The recipients one address-list header names, RFC 2047-decoded, with their display names. */
function headerRecipients(value: string | undefined, type: "to" | "cc"): Recipient[] {
    if (!value) {
        return [];
    }
    return parseRecipientList(decodeHeaderText(value))
        .filter((recipient) => recipient.address.includes("@"))
        .map((recipient) => ({ address: recipient.address, ...(recipient.displayName ? { displayName: recipient.displayName } : {}), type }));
}

/** The `data:` URI of the picture a quoted image of `message` stands for - one of the message's own attachments, fetched with the session -
 * or `undefined` when there is none, it is not a raster image, it is too large or it could not be had. Never rejects. */
function serverImageResolver(message: Message): (reference: QuotedImageReference) => Promise<string | undefined> {
    let attachments: Promise<Awaited<ReturnType<typeof listAttachments>>> | undefined;
    return async (reference) => {
        try {
            attachments ??= listAttachments(message.folderUid, message.uid);
            const attachment = findInlineAttachment(await attachments, reference);
            const type = attachment?.mimeType.split(";")[0].trim().toLowerCase();
            if (!attachment || !type || !EMBEDDED_IMAGE_TYPES.test(type) || attachment.sizeBytes > MAX_QUOTED_IMAGE_BYTES) {
                return undefined;
            }
            const res = await fetch(attachmentContentUrl(attachment.uid), { credentials: "include" });
            const bytes = res.ok ? new Uint8Array(await res.arrayBuffer()) : undefined;
            return bytes && bytes.length <= MAX_QUOTED_IMAGE_BYTES ? toDataUri(type, bytes) : undefined;
        } catch {
            return undefined;
        }
    };
}

/** As `serverImageResolver()`, for the parts of a message this browser decrypted or verified (`MessageSecurityResult.attachments`). */
function partImageResolver(parts: MimeAttachment[]): (reference: QuotedImageReference) => Promise<string | undefined> {
    const candidates = parts.map((part, index) => ({ uid: String(index), filename: part.filename ?? "", mimeType: part.contentType, contentId: part.contentId }));
    return async (reference) => {
        const found = findInlineAttachment(candidates, reference);
        const part = found ? parts[Number(found.uid)] : undefined;
        const bytes = part && EMBEDDED_IMAGE_TYPES.test(part.contentType) ? part.decode() : undefined;
        return part && bytes && bytes.length <= MAX_QUOTED_IMAGE_BYTES ? toDataUri(part.contentType, bytes) : undefined;
    };
}

/**
 * Loads what a Reply/Reply All/Forward needs from `message`: the full body to quote - the same content
 * `MessageDetailPane` shows, never the truncated `bodyPreview` unless nothing else can be had - and, with
 * `options.recipients`, who the message was originally addressed to. Never rejects.
 *
 * Content the pane recovered client-side (`security.text`/`security.html`: a decrypted or verified body) is used as
 * is. For an encrypted message that's the plaintext, so the caller must keep the reply encrypted (see
 * `MessageDetailPane`'s reply handlers).
 *
 * An encrypted message without recovered content (locked keys, a failed decrypt, evaluation still running) quotes
 * nothing: the server only holds ciphertext, which is never fetched or quoted.
 *
 * Otherwise the server's sanitized HTML body (`GET /mail/messages/:id/content`) is used. That route falls back to the
 * preview for a message without an HTML part, so a `text/plain` answer is replaced by the text part of the message's
 * raw MIME.
 *
 * The recipients come from the verified message's protected headers when it has them, else from the raw message's own
 * `To`/`Cc` headers - restapi records only the envelope recipient of a delivered message (`ScanQueueJob`), so
 * `message.recipients` alone would reduce every Reply All to a plain reply. Unprotected headers are the sender's own
 * claim, exactly as in every other mail client's Reply All.
 *
 * The original's embedded images (`cid:`) are replaced by `data:` URIs of the pictures themselves - fetched from the message's
 * attachments, or taken from the decrypted entity - so the quote shows them and the new message can carry them (see `quotedImages.ts`).
 *
 * The quote builders sanitize whatever HTML this returns (`sanitizeQuotedHtml()`), whichever source it came from.
 */
export async function loadOriginalMessage(
    message: Message,
    security: MessageSecurityResult | null,
    options: { recipients?: boolean } = {},
): Promise<OriginalMessage> {
    const recovered: QuotedBody | undefined =
        security?.text !== undefined ? { text: security.text } : security?.html !== undefined ? { html: security.html } : undefined;
    const protectedHeaders = security?.protectedHeaders;
    const protectedRecipients = protectedHeaders
        ? [...headerRecipients(protectedHeaders.to, "to"), ...headerRecipients(protectedHeaders.cc, "cc")]
        : [];
    const result: OriginalMessage = { body: recovered ?? {}, ...(protectedRecipients.length > 0 ? { recipients: protectedRecipients } : {}) };
    if (message.encrypted) {
        return result;
    }
    let needsRaw = !!options.recipients && result.recipients === undefined;
    if (!recovered) {
        // Never rejects; nothing (a plain-text message, a failure, a timeout) leaves the raw message below as the other way
        // to the body.
        const html = await fetchContentHtml(message.uid);
        if (html !== undefined) {
            result.body = { html };
        } else {
            needsRaw = true;
        }
    }
    try {
        if (needsRaw) {
            const entity = parseMimeEntity(await withTimeout(getMessageRawContent(message.uid), QUOTE_FETCH_TIMEOUT_MS));
            if (!recovered && result.body.html === undefined) {
                const body = extractDisplayBody(entity);
                result.body = body.html !== undefined ? { html: body.html } : body.text !== undefined ? { text: body.text } : {};
            }
            const headers = [...headerRecipients(entity.headers["to"], "to"), ...headerRecipients(entity.headers["cc"], "cc")];
            if (options.recipients && result.recipients === undefined && headers.length > 0) {
                result.recipients = headers;
            }
        }
    } catch {
        // Whatever was loaded before the failure stands: the quote falls back to the preview, Reply All to the
        // message's own recipients.
    }
    if (result.body.html !== undefined) {
        const resolver = recovered ? partImageResolver(security?.attachments ?? []) : serverImageResolver(message);
        const html = result.body.html;
        // Bounded like the body's own request: a picture that will not arrive is left out of the quote, not waited for.
        result.body = { html: await withTimeout(embedQuotedImages(html, resolver), QUOTE_FETCH_TIMEOUT_MS).catch(() => html) };
    }
    return result;
}
