///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { getUnlockedKeys } from "../../../../../lib/crypto/keySession.js";
import { listConversationMessages } from "../../../../../lib/mail/conversationsApi.js";
import { formatMailAddress } from "../../../../../lib/mail/mailAddress.js";
import { getMessageRawContent, listAttachments, type Message, type Recipient } from "../../../../../lib/mail/mailApi.js";
import type { ApiClient } from "../../../../../lib/util/api.js";
import { fetchBodyContent } from "./bodyContent.js";
import { ENCRYPTED_SUBJECT_PLACEHOLDER, displaySubject } from "./EncryptedPreview.js";
import type { PrintableMessage } from "./printMessage.js";

const format = (list: Recipient[]) => list.map((r) => formatMailAddress(r)).join(", ");

/** The header lines printed above a message's body. */
export function printHeaders(message: Message, from: string): PrintableMessage["headers"] {
    return [
        { name: "From", value: from },
        { name: "To", value: format(message.recipients.filter((r) => r.type !== "cc" && r.type !== "bcc")) },
        { name: "Cc", value: format(message.recipients.filter((r) => r.type === "cc")) },
        { name: "Date", value: new Date(message.receivedDate).toLocaleString() },
    ];
}

/**
 * The messages of `message`'s conversation that came before it, newest first - the order they follow it in a printed conversation. A conversation
 * the server has no id for (or one that can't be read) has none: the message prints alone.
 */
export async function olderConversationMessages(message: Message, client?: ApiClient): Promise<Message[]> {
    if (!message.conversationId) {
        return [];
    }
    const thread = await listConversationMessages(message.mailboxUid, message.conversationId, { limit: 500 }, client);
    const sent = new Date(message.receivedDate).getTime();
    return thread
        .filter((other) => other.uid !== message.uid && new Date(other.receivedDate).getTime() <= sent)
        .sort((a, b) => new Date(b.receivedDate).getTime() - new Date(a.receivedDate).getTime());
}

/**
 * One earlier message of a conversation as it prints: the body the reading pane would show. An encrypted one is decrypted here when this device has
 * its mailbox's keys unlocked; when it can't be, it prints a line saying so rather than the ciphertext. `client` is the explicit `ApiClient` every
 * request goes through when given (see `useApiClient()`); without one they are the cookie requests they always were.
 */
export async function printableOlderMessage(message: Message, client?: ApiClient): Promise<PrintableMessage> {
    const attachments = await listAttachments(message.folderUid, message.uid, client).catch(() => []);
    if (message.encrypted) {
        const unlocked = getUnlockedKeys(message.mailboxUid);
        if (unlocked) {
            const { evaluateMessageSecurity } = await import("../../../../../lib/crypto/messageSecurity.js");
            const security = await evaluateMessageSecurity(await getMessageRawContent(message.uid, client), unlocked);
            const content =
                security.text !== undefined ? ({ kind: "text", text: security.text } as const) : security.html !== undefined ? ({ kind: "html", html: security.html } as const) : undefined;
            if (content) {
                return {
                    subject: (message.subject === ENCRYPTED_SUBJECT_PLACEHOLDER ? security.subject : undefined) || displaySubject(message.subject) || "(no subject)",
                    headers: printHeaders(message, formatMailAddress(message.from)),
                    content,
                    attachments,
                    inlineParts: security.attachments,
                };
            }
        }
        return {
            subject: displaySubject(message.subject) || "(no subject)",
            headers: printHeaders(message, formatMailAddress(message.from)),
            content: { kind: "text", text: "This message is encrypted and could not be decrypted, so it is not printed." },
        };
    }
    return {
        subject: message.subject || "(no subject)",
        headers: printHeaders(message, formatMailAddress(message.from)),
        // Without a client this is exactly the cookie request it always was.
        content: await (client ? fetchBodyContent(message.uid, message.version, undefined, client) : fetchBodyContent(message.uid, message.version)),
        attachments,
    };
}
