///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiRequestError, type ApiClient } from "../../../../lib/util/api.js";
import {
    Attachment,
    ComposeRecipientInput,
    DraftThreading,
    Mailbox,
    Message,
    assembleDraft,
    assembleDraftRaw,
    createDraft,
    forgetDraftImages,
    getMailbox,
    getMessage,
    queueMessageSend,
    sendMessage,
    setMessageRequestReceipt,
} from "../../../../lib/mail/mailApi.js";
import { describeSendFailure } from "../../../../lib/mail/sendFailure.js";
import { RecipientEncryptionStatus, resolveRecipientEncryption } from "../../../../lib/crypto/composeSecurity.js";
import { getUnlockedKeys, type UnlockedKeys } from "../../../../lib/crypto/keySession.js";
import { EncryptionPolicy, findActivePublicKey, getEncryptionPolicy, lookupKeys } from "../../../../lib/crypto/keyvaultApi.js";
import { fromBase64 } from "../../../../lib/crypto/encoding.js";
import type { ProtectedHeaders } from "../../../../lib/crypto/smimeMessage.js";
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
    /** The copies of this message (`assemble()`: one per encryption format) already built but not handed over yet, after an attempt that
     * failed part-way: a retry hands over just these - never one that already went, and without building them again. */
    pendingCopies?: Message[];
    /** Some copies already went (`pendingCopies` holds only the rest): every later failure says so, and never offers "Open draft", which
     * would send those recipients a second copy - kept across any number of retries. */
    partial?: boolean;
    /** The uids of every copy of this message, when it is more than one (one per encryption format, each delivered only to its own
     * recipients): the request is retained under each, and a failure the server reports later for one of them offers no "Open draft",
     * which would send the other copy's recipients a second message. */
    copyUids?: string[];
    /** What has become of each of those copies, by uid: one map shared by every request made from this one (a retry's, the one retained), so
     * how any copy went is known to all of them. */
    copyFates?: Map<string, CopyFate>;
}

/** One copy of a message sent as several (`SendRequest.copyFates`): `unsent` - not handed over (or its hand-over failed), `pending` - handed
 * over, how it went still to be reported, `sent`, or `failed` - the server reported it couldn't relay it. */
export type CopyFate = "unsent" | "pending" | "sent" | "failed";

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

/** The request a message was queued from, while this tab still holds it: what lets "Open draft" and "Retry" work on a failure the server
 * reports later. A message sent as several copies (`SendRequest.copyUids`) is held under each copy still to go, from just before it is handed
 * over - how the first went can be reported while the next is still being handed over. */
export function retainedRequest(draftUid: string): SendRequest | undefined {
    return sendState.retained.get(draftUid);
}

/** Stops holding the request of a message sent as several copies under copy `uid` - never another message's request held there since. */
function release(fates: Map<string, CopyFate>, uid: string): void {
    if (sendState.retained.get(uid)?.copyFates === fates) {
        sendState.retained.delete(uid);
    }
}

/** Records that copy `uid` of a message sent as several (`fates`) has gone. Whether it was the last of them to go, each counted once, so the
 * message is confirmed now - always, for a message sent as one. */
function copyWent(fates: Map<string, CopyFate> | undefined, uid: string): boolean {
    if (!fates) {
        return true;
    }
    release(fates, uid);
    if (fates.get(uid) === "sent") {
        return false;
    }
    fates.set(uid, "sent");
    return [...fates.values()].every((fate) => fate === "sent");
}

/** Drops the request a message (or one of its copies) was queued from, and the pictures remembered as attached to its draft: it has gone, so
 * neither is wanted again. Whether the message has now gone in full - the last of its copies to go. */
export function forgetRetainedRequest(draftUid: string): boolean {
    const request = sendState.retained.get(draftUid);
    sendState.retained.delete(draftUid);
    forgetDraftImages(draftUid);
    return copyWent(request?.copyFates, draftUid);
}

/** Records that the server couldn't relay copy `uid` of the message `request` sent as several copies (nothing for a message sent as one). */
export function copyFailed(request: SendRequest | undefined, uid: string): void {
    request?.copyFates?.set(uid, "failed");
}

/** Copy `uid` of the message `request` sent as several copies is handed over again (a Retry): how it goes is to be reported once more, and
 * finds the request held under it. Nothing for a message sent as one. */
export function copyRetried(request: SendRequest | undefined, uid: string): void {
    if (request?.copyFates) {
        request.copyFates.set(uid, "pending");
        retain(request, [uid]);
    }
}

/** Every copy of the message `request` sent as several, when none of them has gone nor may still go - each failed, or was never handed over:
 * nobody has the message. `undefined` while one has gone or may, and for a message sent as one. */
export function unsentCopies(request: SendRequest | undefined): string[] | undefined {
    const fates = request?.copyFates;
    return fates && [...fates.values()].every((fate) => fate === "failed" || fate === "unsent") ? [...fates.keys()] : undefined;
}

/** Stops holding a message sent as several copies under any of them: it is being written again. */
export function forgetCopies(fates: Map<string, CopyFate>): void {
    for (const uid of fates.keys()) {
        release(fates, uid);
    }
}

function retain(request: SendRequest, uids: string[]): void {
    for (const uid of uids) {
        sendState.retained.delete(uid);
        sendState.retained.set(uid, request);
    }
    while (sendState.retained.size > RETAINED_LIMIT) {
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

/** Whether the sender can make an OpenPGP copy (it is encrypted to them too, with their own OpenPGP key) - or can't be told yet, the
 * mailbox being locked: `decideSend()` then asks for the unlock rather than settling for another format, or none. */
export function senderCanUseOpenPgp(unlocked: UnlockedKeys | undefined): boolean {
    return !unlocked || !!unlocked.openPgpKeys?.length;
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
    /** Some copies went (their recipients have it); the others are the attempt's `pendingCopies`. */
    partial?: boolean;
}

/** `copyUids`, `copyFates`: every copy of the message and what became of each, when there is more than one (`SendRequest.copyUids`). "sent"
 * for a message sent as several copies: the last of them went in this attempt, with nothing else to confirm it. */
type Copies = { copyUids?: string[]; copyFates?: Map<string, CopyFate> };
type Outcome = ({ kind: "queued" | "sent" | "scheduled" } & Copies) | ({ kind: "failed"; failure: Failure; pendingCopies?: Message[] } & Copies);

const OPEN_POLICY: EncryptionPolicy = { encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional" };

/** The mailbox and policy this send is missing, loaded now: the sender is not waiting, so a slow answer costs nothing - but it is not waited on for ever. */
async function completeContext(request: SendRequest, client: ApiClient | undefined): Promise<{ mailbox: Mailbox | undefined; policy: EncryptionPolicy | undefined }> {
    let mailbox = request.mailbox;
    let policy = request.policy;
    const keysNow = readSendKeys(request.mailboxUid, request.signEnabled, mailbox);
    const loads: Promise<unknown>[] = [];
    if (!mailbox) {
        loads.push(getMailbox(request.mailboxUid, undefined, client).then((loaded) => void (mailbox = loaded)));
    }
    if (!policy && (!mailbox || senderHasEncryptionKey({ mailbox, offeredEncrypt: request.offeredEncrypt }, keysNow.canEncryptSelf))) {
        loads.push(getEncryptionPolicy(client).then((loaded) => void (policy = loaded)));
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

/** Builds the message's final content into the draft (plain, signed, or signed and encrypted in this browser) and returns the stored
 * message(s) to send: one, or - for an encrypted message whose recipients need both formats (restapi `specs/end-to-end_encryption.md`
 * *OpenPGP Interoperability*) - an S/MIME copy (this draft) and an OpenPGP copy (a second draft), each listing every recipient but
 * delivered only to the recipients of its own format (`deliverTo`). Never a plaintext copy. */
async function assemble(
    request: SendRequest,
    mailbox: Mailbox | undefined,
    mode: "plain" | "sign" | "encrypt",
    statuses: (RecipientEncryptionStatus | undefined)[],
    withSignature: boolean,
    client: ApiClient | undefined,
): Promise<Message[]> {
    const { draft, to, cc, bcc, subject, html } = request;
    if (mode === "plain") {
        return [await assembleDraft(draft.uid, { to, cc, bcc, subject, html, intent: "send" }, client)];
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
        "../../../../lib/crypto/smimeMessage.js"
    );
    const encrypt = mode === "encrypt";
    const outerHeaders = encrypt ? applyBaselineOuterHeaders(protectedHeaders) : protectedHeaders;
    if (!encrypt) {
        const signedPart = await buildSignedOnlyMessage(bodyContentType, html, protectedHeaders, signing!.certDer, signing!.privateKey);
        return [await assembleDraftRaw(draft.uid, { to, cc, bcc, subject: outerHeaders.subject, rawMime: assembleOutboundMime(outerHeaders, signedPart), intent: "send" }, client)];
    }
    const smime = statuses.filter((status) => status!.format !== "openpgp");
    const pgp = statuses.filter((status) => status!.format === "openpgp");
    const deliverTo = (group: (RecipientEncryptionStatus | undefined)[]) => (smime.length > 0 && pgp.length > 0 ? { deliverTo: group.map((status) => status!.address) } : {});
    const sent: Message[] = [];
    if (smime.length > 0) {
        const part = await buildEncryptedMessage(
            bodyContentType,
            html,
            protectedHeaders,
            outerHeaders,
            [keys.unlocked!.encryptionCertDer!, ...smime.map((status) => fromBase64(status!.encryptCert!.publicKey))],
            signing,
        );
        const rawMime = assembleOutboundMime(outerHeaders, part);
        sent.push(await assembleDraftRaw(draft.uid, { to, cc, bcc, subject: outerHeaders.subject, rawMime, intent: "send", ...deliverTo(smime) }, client));
    }
    if (pgp.length > 0) {
        // OpenPGP.js and the PGP/MIME builder load only for a message that has OpenPGP recipients.
        const [{ buildPgpEncryptedMessage, readKeysBase64 }, { armorPublicKey }] = await Promise.all([
            import("../../../../lib/crypto/pgpMessage.js"),
            import("../../../../lib/crypto/openpgp.js"),
        ]);
        const ownKey = keys.unlocked!.openPgpKeys![0].privateKey;
        const recipientKeys = await readKeysBase64(pgp.map((status) => status!.openPgpKey!.publicKey));
        // Its own Message-ID: a second message, even though it is the same one for its readers.
        const pgpHeaders: ProtectedHeaders = { ...protectedHeaders, messageId: `<${crypto.randomUUID()}@${domain}>` };
        const pgpOuter = applyBaselineOuterHeaders(pgpHeaders);
        // Signed with the sender's OpenPGP key (what an OpenPGP reader can check) whenever the message is signed, and carrying the
        // sender's public key, so a correspondent without it can verify and reply encrypted.
        const part = await buildPgpEncryptedMessage(
            bodyContentType,
            html,
            pgpHeaders,
            pgpOuter,
            [ownKey.toPublic(), ...recipientKeys],
            withSignature ? ownKey : undefined,
            armorPublicKey(ownKey.toPublic()),
        );
        const rawMime = assembleOutboundMime(pgpOuter, part);
        const target = smime.length > 0 ? await createDraft(request.mailboxUid, draft.folderUid, undefined, client) : draft;
        sent.push(await assembleDraftRaw(target.uid, { to, cc, bcc, subject: pgpOuter.subject, rawMime, intent: "send", ...deliverTo(pgp) }, client));
    }
    return sent;
}

function failureOf(err: unknown, fallback: string): Failure {
    const failure = describeSendFailure(err, fallback);
    return { message: failure.message, details: failure.lines };
}

/** Whether the server already holds `copy` as accepted (out of Drafts, or leased) - the answer to "did that request that never returned actually land?". */
async function accepted(copy: Message, client: ApiClient | undefined): Promise<boolean> {
    try {
        const fresh = await getMessage(copy.uid, client);
        return fresh.folderUid !== copy.folderUid || !!fresh.scheduledSendLeaseExpiresAt || !!fresh.scheduledSendRelayedAt;
    } catch {
        return false;
    }
}

/** Whether the server already holds every copy of `request`'s message still to go (its draft, when none was built yet) as accepted. */
async function alreadyAccepted(request: SendRequest, client: ApiClient | undefined): Promise<boolean> {
    for (const copy of request.pendingCopies ?? [request.draft]) {
        if (!(await accepted(copy, client))) {
            return false;
        }
    }
    return true;
}

/** Hands `copies` over to the server - queued, or scheduled - one after the other. One that fails stops the rest: the failure carries the
 * copies still to go, so a retry never sends one twice (an encrypted message's other copy may already be on its way to its recipients). */
async function handOver(request: SendRequest, copies: Message[], client: ApiClient | undefined): Promise<Outcome> {
    // A retry hands over only what was left: the request already names every copy.
    const copyUids: string[] | undefined = request.copyUids ?? (copies.length > 1 ? copies.map((copy) => copy.uid) : undefined);
    const copyFates = request.copyFates ?? (copyUids && new Map(copyUids.map((uid): [string, CopyFate] => [uid, "unsent"])));
    // An immediate send of several copies is held under each before any is handed over: how the first went can be reported while the next
    // is still on its way to the server, and must find the others - a failure that offered "Open draft" would send their recipients the
    // message again, a success not counted would leave the message never confirmed.
    if (copyFates && !request.scheduledSendTime) {
        for (const copy of copies) {
            copyFates.set(copy.uid, "pending");
        }
        retain({ ...request, copyUids, copyFates }, copies.map((copy) => copy.uid));
    }
    let queued = false;
    let completed = false;
    for (let index = 0; index < copies.length; index++) {
        const copy = copies[index];
        try {
            if (request.scheduledSendTime) {
                await sendMessage(copy.uid, { scheduledSendTime: request.scheduledSendTime }, client);
            } else {
                const handed = await queueMessageSend(copy.uid, client);
                queued = handed.queued || queued;
                // A server with no queue relayed it before answering: one of several copies has gone already.
                if (!handed.queued && copyFates) {
                    completed = copyWent(copyFates, copy.uid) || completed;
                }
            }
        } catch (err) {
            // A request that never came back may still have landed: never offer to send it twice if it did.
            if (!(err instanceof ApiRequestError) && (await accepted(copy, client))) {
                queued = true;
                continue;
            }
            const failure = failureOf(err, request.scheduledSendTime ? "Could not schedule this message." : "Could not send this message.");
            // This copy and the ones after it weren't handed over: nothing of them is to be reported.
            if (copyFates) {
                for (const left of copies.slice(index)) {
                    copyFates.set(left.uid, "unsent");
                    release(copyFates, left.uid);
                }
            }
            // A copy that went in this attempt, or in an earlier one this retries.
            const partial = index > 0 || !!request.partial;
            return {
                kind: "failed",
                failure: partial
                    ? { ...failure, partial, message: `Only some of its recipients ${request.scheduledSendTime ? "will get it" : "were sent it"} - the copy for the others didn't go. ${failure.message}` }
                    : failure,
                // Nothing went of a single copy: a retry decides and assembles again from the request, like the first attempt (the stored
                // draft may have been opened and autosaved plain since). Several copies are kept even when none went, so a mixed-format
                // retry doesn't create another OpenPGP draft.
                pendingCopies: partial || copies.length > 1 ? copies.slice(index) : undefined,
                copyUids,
                copyFates,
            };
        }
    }
    if (request.scheduledSendTime) {
        return { kind: "scheduled", copyUids, copyFates };
    }
    // Several copies: the message has gone only when this hand-over saw the last of them go - otherwise the server's report for the last copy
    // to go confirms it.
    return { kind: (copyFates ? completed : !queued) ? "sent" : "queued", copyUids, copyFates };
}

/** The whole client-side path of one send: settle, decide, assemble, hand over. Never rejects. `client` is the explicit `ApiClient` (from
 * `useApiClient()`) the window that built `request` was rendered under, `undefined` for the default global cookie-based session. */
async function attempt(request: SendRequest, client: ApiClient | undefined): Promise<Outcome> {
    try {
        await request.saved?.catch(() => undefined);
        // Built already by the attempt that failed part-way: only what didn't go is handed over. A copy whose request seemed to fail but
        // landed (its answer was lost, and so was the check after it) has gone since: handed over again it is refused, and the copies after
        // it would never go - it is left out, and what fails now is a failure of only some of the recipients.
        if (request.pendingCopies?.length) {
            setPendingStage(request.draft.uid, "queuing");
            const remaining: Message[] = [];
            let completed = false;
            for (const copy of request.pendingCopies) {
                if (!(await accepted(copy, client))) {
                    remaining.push(copy);
                } else {
                    // How it went has most likely been reported already, to nothing waiting for it: it isn't waited for now.
                    completed = copyWent(request.copyFates, copy.uid) || completed;
                }
            }
            if (remaining.length === 0) {
                const { copyUids, copyFates } = request;
                return { kind: request.scheduledSendTime ? "scheduled" : completed ? "sent" : "queued", copyUids, copyFates };
            }
            return await handOver(remaining.length < request.pendingCopies.length ? { ...request, partial: true } : request, remaining, client);
        }
        const all = [...request.to, ...request.cc, ...request.bcc];
        let mailbox = request.mailbox;
        let policy = request.policy;
        let statuses: (RecipientEncryptionStatus | undefined)[] = all.map(() => undefined);
        let lookupsComplete = false;

        if (!request.forcePlaintext) {
            ({ mailbox, policy } = await completeContext(request, client));
            const keys = readSendKeys(request.mailboxUid, request.signEnabled, mailbox);
            const hasKey = senderHasEncryptionKey({ mailbox, offeredEncrypt: request.offeredEncrypt }, keys.canEncryptSelf);
            // Recipients' keys are only looked up when the answer can matter: encryption was asked for, or the loaded policy auto-applies.
            if (mailbox && hasKey && (request.encryptRequested || (policy && policyCanAutoEncrypt(policy)))) {
                const own = mailbox;
                const ownPrefersMutual = own.encryptPreference?.preferEncrypt === "mutual";
                const lookups = await Promise.all(
                    all.map((recipient) =>
                        lookupKeys(request.mailboxUid, recipient.address, client).then(
                            (lookup) => ({ lookup }),
                            () => null,
                        ),
                    ),
                );
                const ownOpenPgp = senderCanUseOpenPgp(keys.unlocked);
                statuses = all.map((recipient, index) => {
                    const found = lookups[index];
                    // Without an OpenPGP key of the sender's, a recipient with both formats gets S/MIME, whatever they prefer.
                    const status = found
                        ? resolveRecipientEncryption(own.primarySmtpAddress, ownPrefersMutual, policy ?? OPEN_POLICY, recipient.address, found.lookup, ownOpenPgp)
                        : undefined;
                    // An OpenPGP copy is encrypted to the sender too, with their own OpenPGP key: a recipient with only an OpenPGP key can't
                    // be encrypted to while the unlocked session has none.
                    return status?.format === "openpgp" && !ownOpenPgp ? { ...status, canEncrypt: false, autoEncrypt: false } : status;
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

        const assembled = await assemble(request, mailbox, decision.action, statuses, decision.action === "sign" || (decision.action === "encrypt" && decision.sign), client);
        const copies = request.requestReceipt ? await Promise.all(assembled.map((copy) => setMessageRequestReceipt(copy, true, client))) : assembled;
        setPendingStage(request.draft.uid, "queuing");
        return await handOver(request, copies, client);
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
    // Being edited again, it is no longer a message on its way in the conversation - and the failure's Retry, wherever it was clicked
    // from, must not hand over the draft the window is now editing (and autosaving).
    if (opened) {
        forgetOutgoing(request.draft.uid);
        dismiss(failureNotificationId(request.draft.uid));
    }
    return opened;
}

function failureNotificationId(draftUid: string): string {
    return `send-failed:${draftUid}`;
}

/** The sticky "This message wasn't sent" pop-up for a send that failed on this side, with what can be done about it. */
function notifyFailure(request: SendRequest, failure: Failure, client: ApiClient | undefined): void {
    const uid = request.draft.uid;
    const actions: NotificationAction[] = [];
    const { block } = failure;
    if (block?.keysLocked && request.mailbox?.keys?.length) {
        actions.push({
            label: "Unlock",
            onClick: () => {
                void requestUnlockFromOutside(request.mailboxUid, request.mailbox!.keys!).then(
                    () => void retrySend(request, client),
                    () => undefined,
                );
            },
        });
    }
    if (block) {
        actions.push({ label: block.overrideLabel, onClick: () => void retrySend({ ...request, forcePlaintext: true }, client) });
    } else {
        actions.push({ label: "Retry", onClick: () => void retrySend(request, client) });
    }
    // Part of it went: editing and sending the draft again would send those recipients a second copy.
    if (!failure.partial) {
        actions.push({ label: "Open draft", onClick: () => void openDraftFromRequest(request) });
    }
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
 *
 * `client` is the explicit `ApiClient` (from `useApiClient()`) the compose window that built `request` was rendered under - `undefined` (the
 * default) for every existing caller, which keeps using the default global cookie-based session exactly as before.
 */
export function startSend(request: SendRequest, client?: ApiClient): boolean {
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
    void attempt(request, client).then((outcome) => {
        finishPendingSend(uid);
        if (outcome.kind === "failed") {
            tracker?.revert();
            notifyFailure(
                outcome.pendingCopies
                    ? { ...request, pendingCopies: outcome.pendingCopies, partial: outcome.failure.partial, copyUids: outcome.copyUids, copyFates: outcome.copyFates }
                    : request,
                outcome.failure,
                client,
            );
            return;
        }
        tracker?.settle();
        if (outcome.kind === "queued") {
            // A message sent as several copies is held under each already, from before it was handed over.
            if (!outcome.copyFates) {
                retain(request, [uid]);
            }
            sendState.queuedListener?.(request.mailboxUid);
        } else if (outcome.kind === "sent") {
            // A server with no queue relayed it before answering (or, of several copies, the last of them went in this attempt): the Sent
            // Items copy exists already.
            markOutgoingSent(uid);
            forgetDraftImages(uid);
            notifySent();
        } else {
            forgetDraftImages(uid);
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
export async function retrySend(request: SendRequest, client?: ApiClient): Promise<void> {
    if (await alreadyAccepted(request, client)) {
        dismiss(failureNotificationId(request.draft.uid));
        markOutgoingSending(request.draft.uid);
        notify({ id: `already-sent:${request.draft.uid}`, kind: "info", title: "This message is already on its way", timeoutMs: 5_000 });
        return;
    }
    startSend({ ...request, saved: undefined }, client);
}
