///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { apiUrl } from "@rapidmx/react-shared/util/api.js";
import { Message, Recipient, getMessageRawContent } from "@rapidmx/react-shared/mail/mailApi.js";
import type { QuotedBody } from "@rapidmx/react-shared/mail/compose/composeQuoting.js";
import type { MessageSecurityResult } from "@rapidmx/react-shared/crypto/messageSecurity.js";
import { decodeHeaderText, extractDisplayBody, parseMimeEntity } from "@rapidmx/react-shared/crypto/mime.js";
import { parseRecipientList } from "./recipients.js";

/** What a Reply/Reply All/Forward needs from the message being answered, beyond what its `Message` record holds. */
export interface OriginalMessage {
    /** The body to quote. Empty when none could be loaded - the quote builders then fall back to `bodyPreview`. */
    body: QuotedBody;
    /** The original To and Cc recipients, recovered from the message's own headers - `undefined` when they couldn't
     * be. Only asked for by Reply All (see `loadOriginalMessage()`). */
    recipients?: Recipient[];
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
        try {
            const res = await fetch(apiUrl(`/mail/messages/${encodeURIComponent(message.uid)}/content`), { credentials: "include" });
            if (res.ok && (res.headers.get("content-type") ?? "").includes("text/html")) {
                result.body = { html: await res.text() };
            } else {
                needsRaw = true;
            }
        } catch {
            // The raw message below is the other way to the body.
            needsRaw = true;
        }
    }
    try {
        if (needsRaw) {
            const entity = parseMimeEntity(await getMessageRawContent(message.uid));
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
    return result;
}
