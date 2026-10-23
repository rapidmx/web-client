///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { getUnlockedKeys } from "../../../../../lib/crypto/keySession.js";
import { evaluateMessageSecurity, type MessageSecurityResult } from "../../../../../lib/crypto/messageSecurity.js";
import { getMessageRawContent, type Message, type Recipient, type RecipientType, listAttachments } from "../../../../../lib/mail/mailApi.js";
import { formatMailAddress } from "../../../../../lib/mail/mailAddress.js";
import type { ApiClient } from "../../../../../lib/util/api.js";
import type { ResumeCompose } from "../../../mail/outbox/composeBridge.js";
import { loadOriginalMessage } from "./quotedBody.js";

/** The comma-separated address text a recipient field holds, for the recipients of one type. */
function recipientText(recipients: Recipient[], type: RecipientType): string {
    return recipients
        .filter((recipient) => recipient.type === type)
        .map((recipient) => formatMailAddress(recipient))
        .join(", ");
}

/** Plain text as the HTML paragraphs the editor holds. */
function textToHtml(text: string): string {
    const escape = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return text
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, "<br>")}</p>`)
        .join("");
}

/**
 * What the compose window needs to continue `draft` - a message in the Drafts folder the reader opened rather than one a window of this tab
 * saved - read back from the server: its recipients and subject from the record, its body from the server's copy (with its embedded pictures)
 * and its attachments. `undefined` for a draft that cannot be edited here: an encrypted one holds only its ciphertext, which is never opened.
 * A draft saved in a zero-access mailbox is stored sealed to the mailbox's zero-access key: it is decrypted here with the unlocked keys (its
 * subject comes from the decrypted message too, the record holding only `[...]`), and is `undefined` - left to read - while they're locked.
 * Never rejects for a body that could not be loaded - the draft then opens with the preview, as a reply's quote does.
 */
export async function resumeFromDraft(draft: Message, client?: ApiClient): Promise<ResumeCompose | undefined> {
    if (draft.encrypted) {
        return undefined;
    }
    let security: MessageSecurityResult | null = null;
    if (draft.zeroAccess) {
        security = await openSealedDraft(draft, client);
        if (!security) {
            return undefined;
        }
    }
    const [original, attachments] = await Promise.all([loadOriginalMessage(draft, security), listAttachments(draft.folderUid, draft.uid, client)]);
    const html =
        original.body.html !== undefined ? original.body.html : original.body.text !== undefined ? textToHtml(original.body.text) : textToHtml(draft.bodyPreview ?? "");
    return {
        draft,
        mailboxUid: draft.mailboxUid,
        to: recipientText(draft.recipients, "to"),
        cc: recipientText(draft.recipients, "cc"),
        bcc: recipientText(draft.recipients, "bcc"),
        subject: security?.subject ?? draft.subject,
        html,
        attachments,
        requestReceipt: !!draft.requestReceipt,
        signEnabled: false,
        encryptRequested: false,
    };
}

/** `draft`'s sealed message decrypted with its mailbox's unlocked keys, or `null` when they're locked or it won't open with them. */
async function openSealedDraft(draft: Message, client?: ApiClient): Promise<MessageSecurityResult | null> {
    const unlocked = getUnlockedKeys(draft.mailboxUid);
    if (!unlocked) {
        return null;
    }
    try {
        const security = await evaluateMessageSecurity(await getMessageRawContent(draft.uid, client), unlocked);
        return security.zeroAccess ? security : null;
    } catch {
        return null;
    }
}
