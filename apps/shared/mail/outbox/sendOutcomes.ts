///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Message, cancelScheduledSend, deleteMessage, getMessage, listAttachments, listFolders, queueMessageSend } from "../../../../lib/mail/mailApi.js";
import { SendEvent, describeSendEventError } from "../../../../lib/mail/sendEvents.js";
import type { ApiClient } from "../../../../lib/util/api.js";
import { formatRecipient } from "../../components/mail/compose/recipients.js";
import { loadOriginalMessage } from "../../components/mail/compose/quotedBody.js";
import { notifyApiError } from "../../notifications/apiErrors.js";
import { dismiss, notify } from "../../notifications/store.js";
import { beginPendingSend, finishPendingSend, setPendingStage } from "./pendingSends.js";
import { failOutgoing, forgetOutgoing, markOutgoingSending, markOutgoingSent } from "./outgoingReplies.js";
import { openComposeFromOutside } from "./composeBridge.js";
import {
    SendRequest,
    copyFailed,
    copyRetried,
    describeMessage,
    forgetCopies,
    forgetRetainedRequest,
    notifySent,
    openDraftFromRequest,
    retainedRequest,
    unsentCopies,
} from "./sendJob.js";

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
async function moveBackToDrafts(uid: string, mailboxUid: string, client: ApiClient | undefined): Promise<Message> {
    const message = await getMessage(uid, client);
    const drafts = (await listFolders(mailboxUid, client)).find((folder) => folder.type === "drafts");
    if (!drafts || message.folderUid === drafts.uid) {
        return message;
    }
    return cancelScheduledSend(message, drafts.uid, client);
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "Open draft" for a message the server failed to relay: back into Drafts, and into a compose window with what was written. */
async function openFailedDraft(event: SendEvent, client: ApiClient | undefined): Promise<void> {
    const request = retainedRequest(event.uid);
    // A message sent as several copies (one per encryption format) is written again only when none of them went: while another copy has
    // gone or may still go, the whole message sent again would reach its recipients a second time - however the action came to be offered.
    const copies = unsentCopies(request);
    if (request?.copyFates && !copies) {
        notify({
            id: `open-draft:${event.uid}`,
            kind: "info",
            title: "Only this copy didn't go",
            message: "The copy for its other recipients is sent on its own. Use Retry to send this one to its own recipients.",
            timeoutMs: 8_000,
        });
        return;
    }
    try {
        // Of a message sent as several copies, its own draft is the one written again.
        const moved = await moveBackToDrafts(copies ? request!.draft.uid : event.uid, event.mailboxUid ?? "", client);
        // Back in Drafts it is no longer a message on its way in its conversation.
        forgetOutgoing(event.uid);
        if (request) {
            // The other copies (the OpenPGP one's own draft) go: the message is encrypted afresh when it is sent again, and none of them may
            // be retried meanwhile.
            for (const uid of copies?.filter((uid) => uid !== request.draft.uid) ?? []) {
                const extra = await moveBackToDrafts(uid, event.mailboxUid ?? "", client);
                await deleteMessage(extra.uid, extra.version, client);
                dismiss(failedId(uid));
                forgetOutgoing(uid);
            }
            if (request.copyFates) {
                forgetCopies(request.copyFates);
            }
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
        const original = await loadOriginalMessage(moved, null, {}, client);
        const attachments = await listAttachments(moved.folderUid, moved.uid, client).catch(() => []);
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

/** "Retry" for a message the server failed to relay: the same send call again - a failed message stays in Outbox and the server queues it afresh (with a new retry budget).
 * `request`: the one it was queued from, when this tab holds it - a copy of a message sent as several is then awaited again. */
async function retryFailed(event: SendEvent, client: ApiClient | undefined, request: SendRequest | undefined): Promise<void> {
    if (!beginPendingSend({ draftUid: event.uid, mailboxUid: event.mailboxUid ?? "", subject: event.subject, recipients: event.recipients, scheduled: false })) {
        return;
    }
    dismiss(failedId(event.uid));
    markOutgoingSending(event.uid);
    copyRetried(request, event.uid);
    try {
        setPendingStage(event.uid, "queuing");
        const result = await queueMessageSend(event.uid, client);
        // Relayed before the server answered - and so, when it is one copy of several, maybe the last of them.
        if (!result.queued && forgetRetainedRequest(event.uid)) {
            notifySent();
        }
    } catch (err) {
        copyFailed(request, event.uid);
        notifyApiError(err, "This message wasn't sent", { dedupeKey: failedId(event.uid) });
    } finally {
        finishPendingSend(event.uid);
    }
}

/** Shows what a send event means to the user. `client` is the explicit `ApiClient` (from `useApiClient()`) whichever code observed this push
 * event was rendered under - `undefined` (the default) for every existing caller, which keeps using the default global cookie-based session
 * exactly as before. */
export function handleSendEvent(event: SendEvent, client?: ApiClient): void {
    if (event.action === "send-succeeded") {
        dismiss(retryId(event.uid));
        // A partly-sent message's failure (`notifyFailure()`) is shown under its first copy's uid but is of a copy that was never handed over:
        // it stays, with the Retry that hands that copy over.
        if (![...(retainedRequest(event.uid)?.copyFates?.values() ?? [])].includes("unsent")) {
            dismiss(failedId(event.uid));
        }
        // The conversation on screen swaps the message it drew for the Sent Items copy (a message this tab did not send has nothing drawn).
        markOutgoingSent(event.uid);
        // The server reports every message it relays, scheduled ones from long ago included: only a message this tab queued in the background is
        // worth a confirmation (several are one pop-up counting up). Anything else - a send-later message going out, another tab's send - is quiet.
        // A message sent as several copies (one per encryption format) is confirmed once, when the last of them has gone.
        if (retainedRequest(event.uid) && forgetRetainedRequest(event.uid)) {
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
    const request = retainedRequest(event.uid);
    copyFailed(request, event.uid);
    // Every copy of a message sent as several (one per encryption format, `SendRequest.copyUids`) failed or never went: nobody has it, and it
    // is the whole message's failure - one pop-up, whose Retry hands each copy over again and whose "Open draft" writes the message again.
    const copies = unsentCopies(request);
    // One copy of several, while another has gone or may still go: the others' recipients have theirs or will, and "Open draft" would send
    // the whole message to them again - Retry sends just this copy, to just its own recipients.
    const oneCopy = !!request?.copyFates && !copies;
    const retry = () => {
        for (const uid of copies ?? [event.uid]) {
            void retryFailed({ ...event, uid }, client, request);
        }
    };
    const actions = [{ label: "Retry", onClick: retry }, ...(oneCopy ? [] : [{ label: "Open draft", onClick: () => void openFailedDraft(event, client) }])];
    const message: string = oneCopy ? `The copy for some of its recipients didn't go - the others' copy is sent on its own. ${failure.message}` : failure.message;
    // What an earlier copy's failure said of the others is no longer so: this pop-up stands for the whole message.
    for (const uid of copies?.filter((uid) => uid !== event.uid) ?? []) {
        dismiss(failedId(uid));
        failOutgoing(uid, message, actions);
    }
    notify({
        id: failedId(event.uid),
        kind: "error",
        title: "This message wasn't sent",
        message: `${what}: ${message}`,
        details: failure.lines,
        actions,
    });
    // The conversation on screen shows the same failure under the message, with the same ways out.
    failOutgoing(event.uid, message, actions);
}
