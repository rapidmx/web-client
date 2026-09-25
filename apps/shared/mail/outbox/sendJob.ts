///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    Attachment,
    ComposeRecipientInput,
    DraftThreading,
    Mailbox,
    Message,
    assembleDraft,
    assembleDraftRaw,
    getMailbox,
    getMessage,
    queueMessageSend,
    sendMessage,
    setMessageRequestReceipt,
} from "@rapidmx/react-shared/mail/mailApi.js";
import { describeSendFailure } from "@rapidmx/react-shared/mail/sendFailure.js";
import { RecipientEncryptionStatus, resolveRecipientEncryption } from "@rapidmx/react-shared/crypto/composeSecurity.js";
import { getUnlockedKeys } from "@rapidmx/react-shared/crypto/keySession.js";
import { EncryptionPolicy, findActivePublicKey, getEncryptionPolicy, lookupKeys } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { fromBase64 } from "@rapidmx/react-shared/crypto/encoding.js";
import type { ProtectedHeaders } from "@rapidmx/react-shared/crypto/smimeMessage.js";
import { policyCanAutoEncrypt } from "../../components/mail/compose/encryptionRequirement.js";
import { NotificationAction, dismiss, notify } from "../../notifications/store.js";
import { INLINE_IMAGE_PATTERN, SendBlock, SendDecisionInput, decideSend } from "./sendDecision.js";
import { beginPendingSend, finishPendingSend, setPendingStage } from "./pendingSends.js";
import { failOutgoing, forgetOutgoing, markOutgoingSending, markOutgoingSent, trackOutgoing } from "./outgoingReplies.js";
import { openComposeFromOutside, requestUnlockFromOutside } from "./composeBridge.js";
import { OutboxCountTracker, sendState } from "./sendState.js";

/** Everything the background send needs, captured when Send is clicked: the window it came from is gone by the time it runs. */
export interface SendRequest {
    /** The window's server draft. */
    draft: Message;
    mailboxUid: string;
    /** The sender's mailbox as the window had loaded it - `undefined` when that load had not succeeded (the send then tries again itself). */
    mailbox: Mailbox | undefined;
    /** The encryption policy as the window had loaded it, `undefined` likewise. */
    policy: EncryptionPolicy | undefined;
    /** The window's To/Cc/Bcc field text, kept so "Open draft" restores them exactly. */
    toText: string;
    ccText: string;
    bccText: string;
    to: ComposeRecipientInput[];
    cc: ComposeRecipientInput[];
    bcc: ComposeRecipientInput[];
    subject: string;
    html: string;
    attachments: Attachment[];
    requestReceipt: boolean;
    /** Send later: an ISO time in the future. Absent for an immediate send. */
    scheduledSendTime?: string;
    signEnabled: boolean;
    /** The sign / encrypt options were shown to the sender at some point this compose session (their keys were unlocked). */
    offeredSign: boolean;
    offeredEncrypt: boolean;
    encryptRequested: boolean;
    /** The sender's explicit choice to send without encryption/signing checks (an override). */
    forcePlaintext: boolean;
    /** Settles when the window's own autosaves have landed, so none can overwrite the assembly below. */
    saved?: Promise<unknown>;
    /** The thread this message continues (a reply or forward), as the compose session was opened with it - what lets the conversation on screen
     * show the message as soon as it is sent (see `outgoingReplies.ts`). Absent for a new message, and for a draft opened again, which the draft's own
     * `inReplyTo`/`references` stand in for. */
    threading?: DraftThreading;
}

/** How long a background send waits for the mailbox / encryption policy it did not have, before it goes ahead treating them as unknown. Nobody waits for it. */
export const CONTEXT_GRACE_MS = 4_000;

export function registerOutboxCounter(tracker: (mailboxUid: string) => OutboxCountTracker, onQueued: (mailboxUid: string) => void): () => void {
    sendState.countTracker = tracker;
    sendState.queuedListener = onQueued;
    return () => {
        if (sendState.countTracker === tracker) {
            sendState.countTracker = undefined;
            sendState.queuedListener = undefined;
        }
    };
}

const RETAINED_LIMIT = 25;

/** The request a message was queued from, while this tab still holds it: what lets "Open draft" and "Retry" work on a failure the server reports later. */
export function retainedRequest(draftUid: string): SendRequest | undefined {
    return sendState.retained.get(draftUid);
}

export function forgetRetainedRequest(draftUid: string): void {
    sendState.retained.delete(draftUid);
}

function retain(request: SendRequest): void {
    sendState.retained.delete(request.draft.uid);
    sendState.retained.set(request.draft.uid, request);
    if (sendState.retained.size > RETAINED_LIMIT) {
        sendState.retained.delete(sendState.retained.keys().next().value!);
    }
}

const UNSAFE_DISPLAY_NAME_PATTERN = /[@＠﹫\r\n]/;

/** The sender's signing/encryption key state right now, read from the tab's key session (they can lock mid-send). */
export function readSendKeys(mailboxUid: string, signEnabled: boolean, mailbox: Mailbox | undefined) {
    const stored = getUnlockedKeys(mailboxUid);
    const unlocked = stored?.destroyed ? undefined : stored;
    return {
        unlocked,
        canSign: signEnabled && !!mailbox && !!unlocked?.signingPrivateKey && !!unlocked.signingCertDer,
        canEncryptSelf: !!unlocked?.encryptionPrivateKey && !!unlocked.encryptionCertDer,
    };
}

/** Whether this sender could encrypt at all: an encryption key unlocked here, enrolled on the mailbox, or offered earlier this session. */
export function senderHasEncryptionKey(request: Pick<SendRequest, "mailbox" | "offeredEncrypt">, canEncryptSelf: boolean): boolean {
    return canEncryptSelf || request.offeredEncrypt || !!findActivePublicKey(request.mailbox?.keys ?? [], "encrypt");
}

/** The input `decideSend()` reads, from a request and what has been looked up. */
export function sendDecisionInput(
    request: SendRequest,
    mailbox: Mailbox | undefined,
    policy: EncryptionPolicy | undefined,
    recipients: (RecipientEncryptionStatus | undefined)[],
    lookupsComplete: boolean,
): SendDecisionInput {
    const keys = readSendKeys(request.mailboxUid, request.signEnabled, mailbox);
    return {
        forcePlaintext: request.forcePlaintext,
        signEnabled: request.signEnabled,
        offeredSign: request.offeredSign,
        encryptRequested: request.encryptRequested,
        policy,
        mailboxLoaded: !!mailbox,
        hasEncryptionKey: senderHasEncryptionKey({ mailbox, offeredEncrypt: request.offeredEncrypt }, keys.canEncryptSelf),
        keys: { canSign: keys.canSign, canEncryptSelf: keys.canEncryptSelf, unlocked: !!keys.unlocked },
        recipients,
        lookupsComplete,
        hasBcc: request.bcc.length > 0,
        hasAttachments: request.attachments.length > 0,
        hasInlineImages: INLINE_IMAGE_PATTERN.test(request.html),
    };
}

/** A send that did not go: the plain reason, the technical lines, and - for a refusal the sender can override - which. */
interface Failure {
    message: string;
    details: string[];
    block?: SendBlock;
}

type Outcome = { kind: "queued" | "sent" | "scheduled" } | { kind: "failed"; failure: Failure };

const OPEN_POLICY: EncryptionPolicy = { encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional" };

/** The mailbox and policy this send is missing, loaded now: the sender is not waiting, so a slow answer costs nothing - but it is not waited on for ever. */
async function completeContext(request: SendRequest): Promise<{ mailbox: Mailbox | undefined; policy: EncryptionPolicy | undefined }> {
    let mailbox = request.mailbox;
    let policy = request.policy;
    const keysNow = readSendKeys(request.mailboxUid, request.signEnabled, mailbox);
    const loads: Promise<unknown>[] = [];
    if (!mailbox) {
        loads.push(getMailbox(request.mailboxUid).then((loaded) => void (mailbox = loaded)));
    }
    if (!policy && (!mailbox || senderHasEncryptionKey({ mailbox, offeredEncrypt: request.offeredEncrypt }, keysNow.canEncryptSelf))) {
        loads.push(getEncryptionPolicy().then((loaded) => void (policy = loaded)));
    }
    if (loads.length > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const grace = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, CONTEXT_GRACE_MS);
        });
        await Promise.race([Promise.allSettled(loads), grace]);
        clearTimeout(timer);
    }
    return { mailbox, policy };
}

/** Builds the message's final content into the draft (plain, signed, or signed and encrypted in this browser) and returns the stored message. */
async function assemble(
    request: SendRequest,
    mailbox: Mailbox | undefined,
    mode: "plain" | "sign" | "encrypt",
    statuses: (RecipientEncryptionStatus | undefined)[],
    withSignature: boolean,
): Promise<Message> {
    const { draft, to, cc, bcc, subject, html } = request;
    if (mode === "plain") {
        return assembleDraft(draft.uid, { to, cc, bcc, subject, html });
    }
    const keys = readSendKeys(request.mailboxUid, request.signEnabled, mailbox);
    const own = mailbox!;
    const domain = own.primarySmtpAddress.split("@")[1] ?? "localhost";
    const displayName = own.displayName && !UNSAFE_DISPLAY_NAME_PATTERN.test(own.displayName) ? own.displayName : "";
    const protectedHeaders: ProtectedHeaders = {
        from: displayName ? `"${displayName.replace(/"/g, '\\"')}" <${own.primarySmtpAddress}>` : own.primarySmtpAddress,
        to: to.map((r) => r.address).join(", "),
        cc: cc.length > 0 ? cc.map((r) => r.address).join(", ") : undefined,
        date: new Date().toUTCString(),
        subject,
        messageId: `<${crypto.randomUUID()}@${domain}>`,
    };
    const bodyContentType = 'text/html; charset="utf-8"';
    const signing = withSignature ? { certDer: keys.unlocked!.signingCertDer!, privateKey: keys.unlocked!.signingPrivateKey! } : undefined;
    // The S/MIME code (PKI.js and the ASN.1/X.509 libraries, over half a megabyte) is only needed here, to sign or encrypt - a plain message
    // never loads it, and it is kept out of the compose window's own chunk.
    const { applyBaselineOuterHeaders, assembleOutboundMime, buildEncryptedMessage, buildSignedOnlyMessage } = await import(
        "@rapidmx/react-shared/crypto/smimeMessage.js"
    );
    const encrypt = mode === "encrypt";
    const outerHeaders = encrypt ? applyBaselineOuterHeaders(protectedHeaders) : protectedHeaders;
    const mimePart = encrypt
        ? await buildEncryptedMessage(
              bodyContentType,
              html,
              protectedHeaders,
              outerHeaders,
              [keys.unlocked!.encryptionCertDer!, ...statuses.map((status) => fromBase64(status!.encryptCert!.publicKey))],
              signing,
          )
        : await buildSignedOnlyMessage(bodyContentType, html, protectedHeaders, signing!.certDer, signing!.privateKey);
    const rawMime = assembleOutboundMime(outerHeaders, mimePart);
    return assembleDraftRaw(draft.uid, { to, cc, bcc, subject: outerHeaders.subject, rawMime });
}

function failureOf(err: unknown, fallback: string): Failure {
    const failure = describeSendFailure(err, fallback);
    return { message: failure.message, details: failure.lines };
}

/** Whether the server already holds `request`'s message as accepted (out of Drafts, or leased) - the answer to "did that request that never returned actually land?". */
async function alreadyAccepted(request: SendRequest): Promise<boolean> {
    try {
        const fresh = await getMessage(request.draft.uid);
        return fresh.folderUid !== request.draft.folderUid || !!fresh.scheduledSendLeaseExpiresAt || !!fresh.scheduledSendRelayedAt;
    } catch {
        return false;
    }
}

/** The whole client-side path of one send: settle, decide, assemble, hand over. Never rejects. */
async function attempt(request: SendRequest): Promise<Outcome> {
    try {
        await request.saved?.catch(() => undefined);
        const all = [...request.to, ...request.cc, ...request.bcc];
        let mailbox = request.mailbox;
        let policy = request.policy;
        let statuses: (RecipientEncryptionStatus | undefined)[] = all.map(() => undefined);
        let lookupsComplete = false;

        if (!request.forcePlaintext) {
            ({ mailbox, policy } = await completeContext(request));
            const keys = readSendKeys(request.mailboxUid, request.signEnabled, mailbox);
            const hasKey = senderHasEncryptionKey({ mailbox, offeredEncrypt: request.offeredEncrypt }, keys.canEncryptSelf);
            // Recipients' keys are only looked up when the answer can matter: encryption was asked for, or the loaded policy auto-applies.
            if (mailbox && hasKey && (request.encryptRequested || (policy && policyCanAutoEncrypt(policy)))) {
                const own = mailbox;
                const ownPrefersMutual = own.encryptPreference?.preferEncrypt === "mutual";
                const lookups = await Promise.all(
                    all.map((recipient) =>
                        lookupKeys(request.mailboxUid, recipient.address).then(
                            (lookup) => ({ lookup }),
                            () => null,
                        ),
                    ),
                );
                statuses = all.map((recipient, index) => {
                    const found = lookups[index];
                    return found ? resolveRecipientEncryption(own.primarySmtpAddress, ownPrefersMutual, policy ?? OPEN_POLICY, recipient.address, found.lookup) : undefined;
                });
            }
            lookupsComplete = true;
        }

        const decision = decideSend(sendDecisionInput(request, mailbox, policy, statuses, lookupsComplete));
        if (decision.action === "blocked") {
            return { kind: "failed", failure: { message: decision.block.message, details: [], block: decision.block } };
        }
        if (decision.action === "rejected") {
            return { kind: "failed", failure: { message: decision.message, details: [] } };
        }

        const assembled = await assemble(request, mailbox, decision.action, statuses, decision.action === "sign" || (decision.action === "encrypt" && decision.sign));
        const withReceipt = request.requestReceipt ? await setMessageRequestReceipt(assembled, true) : assembled;
        setPendingStage(request.draft.uid, "queuing");
        try {
            if (request.scheduledSendTime) {
                await sendMessage(withReceipt.uid, { scheduledSendTime: request.scheduledSendTime });
                return { kind: "scheduled" };
            }
            const result = await queueMessageSend(withReceipt.uid);
            return { kind: result.queued ? "queued" : "sent" };
        } catch (err) {
            // A request that never came back may still have landed: never offer to send it twice if it did.
            if (!(err instanceof ApiRequestError) && (await alreadyAccepted(request))) {
                return { kind: request.scheduledSendTime ? "scheduled" : "queued" };
            }
            throw err;
        }
    } catch (err) {
        return { kind: "failed", failure: failureOf(err, request.scheduledSendTime ? "Could not schedule this message." : "Could not send this message.") };
    }
}

function recipientSummary(request: SendRequest): string {
    const all = [...request.to, ...request.cc, ...request.bcc].map((recipient) => recipient.address);
    return all.length <= 2 ? all.join(" and ") : `${all[0]} and ${all.length - 1} others`;
}

/** "Message to a@b.c and 2 others (\"Subject\")" - which message a pop-up is about. */
export function describeMessage(subject: string, recipients: string): string {
    return `${recipients ? `To ${recipients}` : "Message"}${subject ? ` - "${subject}"` : ""}`;
}

/** Re-opens the compose window around a request's message, with everything as it was typed. */
export function openDraftFromRequest(request: SendRequest): boolean {
    const opened = openComposeFromOutside({
        mailboxUid: request.mailboxUid,
        resume: {
            draft: request.draft,
            mailboxUid: request.mailboxUid,
            to: request.toText,
            cc: request.ccText,
            bcc: request.bccText,
            subject: request.subject,
            html: request.html,
            attachments: request.attachments,
            requestReceipt: request.requestReceipt,
            signEnabled: request.signEnabled,
            encryptRequested: request.encryptRequested,
        },
    });
    // Being edited again, it is no longer a message on its way in the conversation.
    if (opened) {
        forgetOutgoing(request.draft.uid);
    }
    return opened;
}

function failureNotificationId(draftUid: string): string {
    return `send-failed:${draftUid}`;
}

/** The sticky "This message wasn't sent" pop-up for a send that failed on this side, with what can be done about it. */
function notifyFailure(request: SendRequest, failure: Failure): void {
    const uid = request.draft.uid;
    const actions: NotificationAction[] = [];
    const { block } = failure;
    if (block?.keysLocked && request.mailbox?.keys?.length) {
        actions.push({
            label: "Unlock",
            onClick: () => {
                void requestUnlockFromOutside(request.mailboxUid, request.mailbox!.keys!).then(
                    () => void retrySend(request),
                    () => undefined,
                );
            },
        });
    }
    if (block) {
        actions.push({ label: block.overrideLabel, onClick: () => void retrySend({ ...request, forcePlaintext: true }) });
    } else {
        actions.push({ label: "Retry", onClick: () => void retrySend(request) });
    }
    actions.push({ label: "Open draft", onClick: () => void openDraftFromRequest(request) });
    notify({
        id: failureNotificationId(uid),
        kind: "error",
        title: "This message wasn't sent",
        message: `${describeMessage(request.subject, recipientSummary(request))}: ${failure.message}`,
        details: failure.details,
        actions,
    });
    // The conversation on screen shows the same failure under the message, with the same ways out.
    failOutgoing(uid, failure.message, actions);
}

const SENT_BURST_MS = 6_000;

/** The short "Message sent" confirmation - several sent close together are one pop-up counting up, never a stack of them. */
export function notifySent(message = "Message sent"): void {
    const now = Date.now();
    const { sentBurst } = sendState;
    sendState.sentBurst = { count: now - sentBurst.at > SENT_BURST_MS ? 1 : sentBurst.count + 1, at: now };
    notify({ id: "message-sent", kind: "success", title: sendState.sentBurst.count > 1 ? `${sendState.sentBurst.count} messages sent` : message, timeoutMs: 4_000 });
}

/**
 * Sends `request`'s draft in the background and returns at once, `true` - or `false` (doing nothing) when a send of this draft is already
 * under way here. The outcome is shown as pop-ups and the Outbox indicator, never as a window that waits: a failure at any stage (assembling,
 * encrypting, the request) is a sticky "This message wasn't sent" with the reason, and Retry / Open draft; the server's own later outcome
 * (`send-succeeded`, `send-failed`, `send-retrying`) is `handleSendEvent()`'s.
 */
export function startSend(request: SendRequest): boolean {
    const uid = request.draft.uid;
    const recipients = [...request.to, ...request.cc, ...request.bcc].map((recipient) => recipient.address);
    if (!beginPendingSend({ draftUid: uid, mailboxUid: request.mailboxUid, subject: request.subject, recipients, scheduled: !!request.scheduledSendTime })) {
        return false;
    }
    // The failure of an earlier attempt is resolved by trying again.
    dismiss(failureNotificationId(uid));
    // A reply or forward is on screen in its conversation from this moment, before any of the work below.
    trackOutgoing(request);
    const tracker = sendState.countTracker?.(request.mailboxUid);
    void attempt(request).then((outcome) => {
        finishPendingSend(uid);
        if (outcome.kind === "failed") {
            tracker?.revert();
            notifyFailure(request, outcome.failure);
            return;
        }
        tracker?.settle();
        if (outcome.kind === "queued") {
            retain(request);
            sendState.queuedListener?.(request.mailboxUid);
        } else if (outcome.kind === "sent") {
            // A server with no queue relayed it before answering: the Sent Items copy exists already.
            markOutgoingSent(uid);
            notifySent();
        } else {
            notify({
                id: `scheduled:${uid}`,
                kind: "success",
                title: "Message scheduled",
                message: `It will be sent ${new Date(request.scheduledSendTime!).toLocaleString()}.`,
                timeoutMs: 5_000,
            });
        }
    });
    return true;
}

/** Tries a failed send again - unless the server already has the message (an earlier request that seemed to fail did land), which it must not send twice. */
export async function retrySend(request: SendRequest): Promise<void> {
    if (await alreadyAccepted(request)) {
        dismiss(failureNotificationId(request.draft.uid));
        markOutgoingSending(request.draft.uid);
        notify({ id: `already-sent:${request.draft.uid}`, kind: "info", title: "This message is already on its way", timeoutMs: 5_000 });
        return;
    }
    startSend({ ...request, saved: undefined });
}
