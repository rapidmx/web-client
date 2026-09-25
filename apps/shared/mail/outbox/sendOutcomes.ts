///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Message, cancelScheduledSend, getMessage, listAttachments, listFolders, queueMessageSend } from "@rapidmx/react-shared/mail/mailApi.js";
import { SendEvent, describeSendEventError } from "@rapidmx/react-shared/mail/sendEvents.js";
import { formatRecipient } from "../../components/mail/compose/recipients.js";
import { loadOriginalMessage } from "../../components/mail/compose/quotedBody.js";
import { notifyApiError } from "../../notifications/apiErrors.js";
import { dismiss, notify } from "../../notifications/store.js";
import { beginPendingSend, finishPendingSend, setPendingStage } from "./pendingSends.js";
import { failOutgoing, forgetOutgoing, markOutgoingSending, markOutgoingSent } from "./outgoingReplies.js";
import { openComposeFromOutside } from "./composeBridge.js";
import { describeMessage, forgetRetainedRequest, notifySent, openDraftFromRequest, retainedRequest } from "./sendJob.js";

/**
 * What the user is told when the server reports how a queued message went (`send-succeeded`, `send-failed`, `send-retrying` push events,
 * see `@rapidmx/react-shared`'s `parseSendEvent()`): a quiet, single "Message sent" for a message this tab sent (several close together are
 * one pop-up counting up), an info pop-up when a delivery is retried, and - only when it finally failed - the sticky "This message wasn't sent" with the
 * server's reason, its technical details and what to do about it. The Outbox count, list and pill update themselves from the same events
 * (`useMailLiveUpdates()` refreshes on them).
 */

const retryId = (uid: string) => `send-retry:${uid}`;
const failedId = (uid: string) => `send-failed:${uid}`;

function summary(recipients: string[]): string {
    return recipients.length <= 2 ? recipients.join(" and ") : `${recipients[0]} and ${recipients.length - 1} others`;
}

/** Moves a message the server failed to relay back into Drafts (the only place it can be edited or sent again), and returns it as it is there. */
async function moveBackToDrafts(uid: string, mailboxUid: string): Promise<Message> {
    const message = await getMessage(uid);
    const drafts = (await listFolders(mailboxUid)).find((folder) => folder.type === "drafts");
    if (!drafts || message.folderUid === drafts.uid) {
        return message;
    }
    return cancelScheduledSend(message, drafts.uid);
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "Open draft" for a message the server failed to relay: back into Drafts, and into a compose window with what was written. */
async function openFailedDraft(event: SendEvent): Promise<void> {
    try {
        const moved = await moveBackToDrafts(event.uid, event.mailboxUid ?? "");
        // Back in Drafts it is no longer a message on its way in its conversation.
        forgetOutgoing(event.uid);
        const request = retainedRequest(event.uid);
        if (request) {
            openDraftFromRequest({ ...request, draft: moved });
            return;
        }
        if (moved.encrypted) {
            notify({
                id: `open-draft:${event.uid}`,
                kind: "info",
                title: "This message is encrypted",
                message: "It was moved back to Drafts, but it can only be edited in the tab that wrote it. Open it from Drafts to send it again.",
                timeoutMs: 8_000,
            });
            return;
        }
        const original = await loadOriginalMessage(moved, null);
        const attachments = await listAttachments(moved.folderUid, moved.uid).catch(() => []);
        const byType = (type: "to" | "cc" | "bcc") => moved.recipients.filter((recipient) => recipient.type === type).map(formatRecipient).join(", ");
        openComposeFromOutside({
            mailboxUid: moved.mailboxUid,
            resume: {
                draft: moved,
                mailboxUid: moved.mailboxUid,
                to: byType("to"),
                cc: byType("cc"),
                bcc: byType("bcc"),
                subject: moved.subject ?? event.subject,
                html: original.body.html ?? (original.body.text ? `<p>${escapeHtml(original.body.text).replace(/\r?\n/g, "<br>")}</p>` : ""),
                attachments,
                requestReceipt: !!moved.requestReceipt,
                signEnabled: true,
                encryptRequested: false,
            },
        });
    } catch (err) {
        notifyApiError(err, "Couldn't open this draft");
    }
}

/** "Retry" for a message the server failed to relay: the same send call again - a failed message stays in Outbox and the server queues it afresh (with a new retry budget). */
async function retryFailed(event: SendEvent): Promise<void> {
    if (!beginPendingSend({ draftUid: event.uid, mailboxUid: event.mailboxUid ?? "", subject: event.subject, recipients: event.recipients, scheduled: false })) {
        return;
    }
    dismiss(failedId(event.uid));
    markOutgoingSending(event.uid);
    try {
        setPendingStage(event.uid, "queuing");
        const result = await queueMessageSend(event.uid);
        if (!result.queued) {
            notifySent();
        }
    } catch (err) {
        notifyApiError(err, "This message wasn't sent", { dedupeKey: failedId(event.uid) });
    } finally {
        finishPendingSend(event.uid);
    }
}

/** Shows what a send event means to the user. */
export function handleSendEvent(event: SendEvent): void {
    if (event.action === "send-succeeded") {
        dismiss(retryId(event.uid));
        dismiss(failedId(event.uid));
        // The conversation on screen swaps the message it drew for the Sent Items copy (a message this tab did not send has nothing drawn).
        markOutgoingSent(event.uid);
        // The server reports every message it relays, scheduled ones from long ago included: only a message this tab queued in the background is
        // worth a confirmation (several are one pop-up counting up). Anything else - a send-later message going out, another tab's send - is quiet.
        if (retainedRequest(event.uid)) {
            forgetRetainedRequest(event.uid);
            notifySent();
        }
        return;
    }
    const failure = describeSendEventError(event.error, event.action === "send-failed" ? "The server couldn't send this message." : "The server couldn't send this message yet.");
    const what = describeMessage(event.subject, summary(event.recipients));
    if (event.action === "send-retrying") {
        const next = event.nextAttemptAt ? Date.parse(event.nextAttemptAt) : NaN;
        notify({
            id: retryId(event.uid),
            kind: "info",
            title: "Retrying to send",
            message: `${what} (attempt ${event.attempt + 1}${Number.isNaN(next) ? "" : `, at ${new Date(next).toLocaleTimeString()}`}). ${failure.message}`,
            details: failure.lines,
            sticky: false,
            timeoutMs: 8_000,
        });
        return;
    }
    dismiss(retryId(event.uid));
    const actions = [
        { label: "Retry", onClick: () => void retryFailed(event) },
        { label: "Open draft", onClick: () => void openFailedDraft(event) },
    ];
    notify({
        id: failedId(event.uid),
        kind: "error",
        title: "This message wasn't sent",
        message: `${what}: ${failure.message}`,
        details: failure.lines,
        actions,
    });
    // The conversation on screen shows the same failure under the message, with the same ways out.
    failOutgoing(event.uid, failure.message, actions);
}
