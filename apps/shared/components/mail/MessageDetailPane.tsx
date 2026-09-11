///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import {
    Attachment,
    Message,
    MessageClassification,
    ReceiptType,
    approveReceipt,
    attachmentContentUrl,
    cancelScheduledSend,
    classifyMessage,
    declineReceipt,
    recallMessage,
} from "@rapidmx/react-shared/mailApi.js";
import { buildForwardQuote, buildReplyQuote, forwardSubject, replySubject } from "@rapidmx/react-shared/composeQuoting.js";
import { useCompose } from "./compose/ComposeContext.js";
import Modal from "@rapidmx/react-shared/Modal.js";
import Alert from "../feedback/Alert.js";
import Button from "../buttons/Button.js";

export interface MessageDetailPaneProps {
    message: Message | null;
    attachments: Attachment[];
    /** Present only on the mobile detail route — renders a "back to messages" link above the header. Absent
     * on the desktop reading pane, which never navigates away (selecting a different message just swaps
     * `message` in place). */
    backHref?: string;
    /** Whether `message` currently lives in Sent Items — the only folder recall is offered from, matching
     * Outlook's own restriction (and `BaseMessageRoute.recall()`'s own server-side check). Each caller
     * computes this from its own already-loaded folder list rather than this component fetching folders
     * itself. */
    isSentItems?: boolean;
    /** Called with the server's updated copy (carrying `recallRequestedAt`) after a successful recall, so
     * the caller can patch its own in-memory message/list state — mirrors `mailDetailHooks.ts`'s
     * `useMarkMessageRead`'s identical `onUpdated` callback. */
    onRecalled?: (updated: Message) => void;
    /** Whether `message` currently lives in Outbox — the only folder a scheduled send can be canceled
     * from. Each caller computes this the same way it computes `isSentItems`. */
    isOutbox?: boolean;
    /** The mailbox's Drafts folder uid — required when `isOutbox` is `true`, since canceling a
     * scheduled send moves the message back into Drafts (see `cancelScheduledSend()`'s own doc comment
     * on why clearing `scheduledSendTime` alone doesn't do that). */
    draftsFolderUid?: string;
    /** Called with the server's updated copy (now back in Drafts, `scheduledSendTime` cleared) after
     * successfully canceling a scheduled send. */
    onScheduledSendCanceled?: (updated: Message) => void;
    /** Whether `message` currently lives in the Inbox — Focused/Other classification is an Inbox-only
     * concept (`FocusedInboxUtils.classifyMessage()` short-circuits to Focused for every other folder), so
     * the "Move to Other"/"Move to Focused" control below only renders here, the same
     * each-caller-computes-its-own-folder-type pattern `isSentItems`/`isOutbox` already use. */
    isInbox?: boolean;
    /** Called with the server's updated copy (carrying the new `inferenceClassification`) after a
     * successful classify — mirrors `onRecalled`'s identical shape. */
    onClassified?: (updated: Message) => void;
    /** Called with the server's updated copy after approving/declining a pending delivery/read receipt —
     * mirrors `onRecalled`'s identical shape. No gating prop needed (unlike `isSentItems`/`isOutbox`/
     * `isInbox`): `deliveryReceiptPending`/`readReceiptPending` already live directly on `message` and are
     * only ever `true` on a real delivered copy, so the banner below is self-gating. */
    onReceiptHandled?: (updated: Message) => void;
}

function formatBytes(bytes: number): string {
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
    return `${bytes} B`;
}

/**
 * A message's reading pane — header (subject/from/to/attachments) plus a sandboxed iframe for the body.
 * Shared by the desktop inline pane (`apps/www/index.tsx`, always visible alongside the message list),
 * the mobile detail route (`apps/www/messages/[uid].tsx`, a full page on its own reached by tapping
 * a message row), and `ConversationThreadPane` (one per expanded message in a thread) — see each call
 * site for how `message`/`attachments`/`isSentItems` are sourced.
 */
export default function MessageDetailPane({
    message,
    attachments,
    backHref,
    isSentItems,
    onRecalled,
    isOutbox,
    draftsFolderUid,
    onScheduledSendCanceled,
    isInbox,
    onClassified,
    onReceiptHandled,
}: MessageDetailPaneProps) {
    const { openCompose } = useCompose();
    const [confirming, setConfirming] = useState(false);
    const [recalling, setRecalling] = useState(false);
    const [canceling, setCanceling] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Kept separate from `error` (the Recall flow's own state) since this renders inline in the main
    // pane rather than inside a confirmation modal — the two flows never need to share one message.
    const [cancelError, setCancelError] = useState<string | null>(null);
    const [classifying, setClassifying] = useState(false);
    const [classifyError, setClassifyError] = useState<string | null>(null);
    const [alwaysForSender, setAlwaysForSender] = useState(false);
    // Names which pending receipt (`"delivery"`/`"read"`) is currently being approved/declined, if any —
    // `deliveryReceiptPending`/`readReceiptPending` can both be true independently, so a single boolean
    // wouldn't distinguish which row's buttons should show a loading state.
    const [receiptBusy, setReceiptBusy] = useState<ReceiptType | null>(null);
    const [receiptError, setReceiptError] = useState<string | null>(null);

    if (!message) {
        return <p className="p-8 text-sm text-text-muted">Select a message to read it.</p>;
    }

    // Only ever invoked from the Reply/Reply All/Forward buttons below, which themselves only render
    // once `message` is loaded (the early return above covers the only other state) — the non-null
    // assertions reflect that real invariant, matching `handleRecall`'s identical pattern just below.
    function handleReply() {
        openCompose({
            mailboxUid: message!.mailboxUid,
            to: message!.from.address,
            subject: replySubject(message!.subject),
            quotedHtml: buildReplyQuote(message!),
            signatureContext: "reply_forward",
        });
    }

    function handleReplyAll() {
        const cc = message!.recipients.filter((r) => r.type !== "bcc").map((r) => r.address);
        openCompose({
            mailboxUid: message!.mailboxUid,
            to: message!.from.address,
            cc: cc.join(", "),
            subject: replySubject(message!.subject),
            quotedHtml: buildReplyQuote(message!),
            signatureContext: "reply_forward",
        });
    }

    function handleForward() {
        openCompose({
            mailboxUid: message!.mailboxUid,
            subject: forwardSubject(message!.subject),
            quotedHtml: buildForwardQuote(message!),
            signatureContext: "reply_forward",
        });
    }

    async function handleRecall() {
        // Only ever invoked from the confirmation modal below, which itself only renders once `message`
        // is loaded (the early return above covers the only other state) — the non-null assertion
        // reflects that real invariant, matching this codebase's established pattern for the same class
        // of always-true-in-practice guard.
        setRecalling(true);
        setError(null);
        try {
            const updated = await recallMessage(message!.uid);
            setConfirming(false);
            onRecalled?.(updated);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not recall this message.");
        } finally {
            setRecalling(false);
        }
    }

    // Only ever invoked from the "Cancel" button below, which itself only renders once `message` is
    // loaded and `isOutbox`/`message.scheduledSendTime` are both truthy — `draftsFolderUid` is required
    // by that same rendering guard (see the prop's own doc comment), so the non-null assertion reflects
    // a real invariant, matching `handleRecall`'s identical pattern just above.
    async function handleCancelScheduledSend() {
        setCanceling(true);
        setCancelError(null);
        try {
            const updated = await cancelScheduledSend(message!, draftsFolderUid!);
            onScheduledSendCanceled?.(updated);
        } catch (err) {
            setCancelError(err instanceof ApiRequestError ? err.message : "Could not cancel this scheduled send.");
        } finally {
            setCanceling(false);
        }
    }

    // Only ever invoked from the classification button below, which itself only renders once `message`
    // is loaded and `isInbox` is true — the non-null assertion reflects the same real invariant as
    // `handleRecall`/`handleCancelScheduledSend` above.
    async function handleClassify(classifyAs: MessageClassification) {
        setClassifying(true);
        setClassifyError(null);
        try {
            const updated = await classifyMessage(message!.uid, classifyAs, alwaysForSender);
            onClassified?.(updated);
        } catch (err) {
            setClassifyError(err instanceof ApiRequestError ? err.message : "Could not reclassify this message.");
        } finally {
            setClassifying(false);
        }
    }

    // Only ever invoked from the pending-receipt banner below, which itself only renders once `message`
    // is loaded — same real invariant as every other handler above.
    async function handleReceipt(type: ReceiptType, action: "approve" | "decline") {
        setReceiptBusy(type);
        setReceiptError(null);
        try {
            const updated = await (action === "approve" ? approveReceipt : declineReceipt)(message!.uid, type);
            onReceiptHandled?.(updated);
        } catch (err) {
            setReceiptError(err instanceof ApiRequestError ? err.message : "Could not handle this receipt request.");
        } finally {
            setReceiptBusy(null);
        }
    }

    return (
        <div className="flex-1 min-w-0 flex flex-col">
            <div className="border-b border-border p-4">
                {backHref && (
                    <a href={backHref} className="text-sm text-primary-dark hover:underline block mb-2">
                        &larr; Back to messages
                    </a>
                )}
                <div className="flex items-start justify-between gap-3">
                    <h1 className="text-lg font-bold tracking-tight">{message.subject || "(no subject)"}</h1>
                    {isSentItems &&
                        (message.recallRequestedAt ? (
                            <span className="text-xs font-medium text-text-muted shrink-0 py-1 px-2.5 rounded-pill bg-surface-alt">
                                Recall requested
                            </span>
                        ) : (
                            <Button
                                type="button"
                                variant="secondary"
                                className="!w-auto shrink-0"
                                onClick={() => setConfirming(true)}
                            >
                                Recall this message
                            </Button>
                        ))}
                    {isOutbox && message.scheduledSendTime && (
                        <div className="flex items-center gap-2 shrink-0">
                            <span className="text-xs font-medium text-text-muted py-1 px-2.5 rounded-pill bg-surface-alt">
                                Scheduled for {new Date(message.scheduledSendTime).toLocaleString()}
                            </span>
                            <Button
                                type="button"
                                variant="secondary"
                                className="!w-auto"
                                loading={canceling}
                                disabled={canceling}
                                onClick={handleCancelScheduledSend}
                            >
                                Cancel
                            </Button>
                        </div>
                    )}
                </div>
                {cancelError && (
                    <div className="mt-2">
                        <Alert>{cancelError}</Alert>
                    </div>
                )}
                <p className="text-sm text-text-muted mt-1">
                    From {message.from.displayName || message.from.address} &middot;{" "}
                    {new Date(message.receivedDate).toLocaleString()}
                </p>
                <p className="text-sm text-text-muted">
                    To {message.recipients.map((r) => r.displayName || r.address).join(", ")}
                </p>
                <div className="flex gap-2 mt-3">
                    <Button type="button" variant="secondary" className="!w-auto" onClick={handleReply}>
                        Reply
                    </Button>
                    <Button type="button" variant="secondary" className="!w-auto" onClick={handleReplyAll}>
                        Reply All
                    </Button>
                    <Button type="button" variant="secondary" className="!w-auto" onClick={handleForward}>
                        Forward
                    </Button>
                </div>
                {isInbox && (
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                        <Button
                            type="button"
                            variant="text"
                            loading={classifying}
                            disabled={classifying}
                            onClick={() =>
                                handleClassify(message.inferenceClassification === "other" ? "focused" : "other")
                            }
                        >
                            {message.inferenceClassification === "other" ? "Move to Focused" : "Move to Other"}
                        </Button>
                        <label className="flex items-center gap-1.5 text-xs text-text-muted">
                            <input
                                type="checkbox"
                                checked={alwaysForSender}
                                onChange={(e) => setAlwaysForSender(e.target.checked)}
                            />
                            Always for this sender
                        </label>
                    </div>
                )}
                {classifyError && (
                    <div className="mt-2">
                        <Alert>{classifyError}</Alert>
                    </div>
                )}
                {(["delivery", "read"] as const)
                    .filter((type) => (type === "delivery" ? message.deliveryReceiptPending : message.readReceiptPending))
                    .map((type) => (
                        <div
                            key={type}
                            className="flex flex-wrap items-center gap-2 mt-2 py-2 px-3 rounded-sm bg-surface-alt text-sm"
                        >
                            <span>
                                {message.from.displayName || message.from.address} requested a {type} receipt for this
                                message.
                            </span>
                            <Button
                                type="button"
                                variant="secondary"
                                className="!w-auto"
                                loading={receiptBusy === type}
                                disabled={receiptBusy !== null}
                                onClick={() => handleReceipt(type, "approve")}
                            >
                                Send receipt
                            </Button>
                            <Button
                                type="button"
                                variant="text"
                                disabled={receiptBusy !== null}
                                onClick={() => handleReceipt(type, "decline")}
                            >
                                Decline
                            </Button>
                        </div>
                    ))}
                {receiptError && (
                    <div className="mt-2">
                        <Alert>{receiptError}</Alert>
                    </div>
                )}
                {attachments.length > 0 && (
                    <ul className="flex flex-wrap gap-2 mt-3">
                        {attachments.map((attachment) => (
                            <li key={attachment.uid}>
                                <a
                                    href={attachmentContentUrl(attachment.uid)}
                                    className="text-xs font-medium py-1 px-2.5 rounded-pill bg-surface-alt text-text-muted hover:text-primary-dark"
                                >
                                    {attachment.filename} ({formatBytes(attachment.sizeBytes)})
                                </a>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <iframe
                key={message.uid}
                title={message.subject || "Message content"}
                src={`/api/mail/messages/${encodeURIComponent(message.uid)}/content`}
                sandbox=""
                className="flex-1 w-full border-0"
            />

            <Modal open={confirming} onClose={() => setConfirming(false)} title="Recall this message?">
                <p className="text-sm text-text-muted mb-4">
                    This asks every original recipient's mail system to delete their copy, but only if it's
                    still unread there — there's no way to guarantee it, and no confirmation once it either
                    succeeds or fails. Recipients who already read the message will keep it.
                </p>
                {error && <Alert>{error}</Alert>}
                <div className="flex gap-3">
                    <Button type="button" loading={recalling} disabled={recalling} onClick={handleRecall} className="!w-auto">
                        Recall message
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        disabled={recalling}
                        onClick={() => setConfirming(false)}
                        className="!w-auto"
                    >
                        Cancel
                    </Button>
                </div>
            </Modal>
        </div>
    );
}
