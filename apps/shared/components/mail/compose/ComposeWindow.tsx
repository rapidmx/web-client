///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ChangeEvent, useEffect, useRef, useState } from "react";
import {
    HiOutlineArrowsPointingIn,
    HiOutlineArrowsPointingOut,
    HiOutlineChevronDown,
    HiOutlineMinus,
    HiOutlinePaperClip,
    HiOutlineTrash,
    HiOutlineXMark,
} from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    Attachment,
    ComposeRecipientInput,
    Mailbox,
    Message,
    assembleDraft,
    assembleDraftRaw,
    attachmentContentUrl,
    createDraft,
    getMailbox,
    listFolders,
    sendMessage,
    setMessageRequestReceipt,
    setMessageScheduledSendTime,
    uploadAttachment,
} from "@rapidmx/react-shared/mail/mailApi.js";
import { listMailSignatures } from "@rapidmx/react-shared/mail/mailSignaturesApi.js";
import { decideMessageEncryption, resolveRecipientEncryption, RecipientEncryptionStatus } from "@rapidmx/react-shared/crypto/composeSecurity.js";
import { getUnlockedKeys } from "@rapidmx/react-shared/crypto/keySession.js";
import { EncryptionPolicy, getEncryptionPolicy, lookupKeys } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { fromBase64 } from "@rapidmx/react-shared/crypto/encoding.js";
import { ProtectedHeaders, applyBaselineOuterHeaders, assembleOutboundMime, buildEncryptedMessage, buildSignedOnlyMessage } from "@rapidmx/react-shared/crypto/smimeMessage.js";
import useIsMobile from "@rapidmx/react-shared/util/useIsMobile.js";
import type { ComposeSession } from "./ComposeContext.js";
import RichTextEditor from "./RichTextEditor.js";
import ScheduleSendPicker from "./ScheduleSendPicker.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

export interface ComposeWindowProps {
    session: ComposeSession;
    onClose: () => void;
    onToggleMinimize: () => void;
}

const FIELD_ROW = "flex items-center gap-2 px-3 py-1.5 border-b border-border";
const FIELD_INPUT = "flex-1 min-w-0 text-sm bg-transparent outline-none";

const MIN_WIDTH = 320;
const MIN_HEIGHT = 320;
// Kept well clear of the viewport edge, not flush against it — this is a resize *ceiling* (the drag
// handles below clamp to it), not the "expanded" preset's own size, which stays a plain `85vh`
// Tailwind class precisely so it never needs `window.innerHeight` at all: that'd have to be read at
// module-evaluation time to live alongside these other constants, and `window` doesn't exist yet
// during this app's SSR pass (see `ReactRoute`) — referencing it here would crash every page render,
// not just this component's.
const VIEWPORT_MARGIN = 24;

interface Size {
    width: number;
    height: number;
}

type ResizeEdge = "left" | "top" | "corner";

function parseAddresses(value: string): ComposeRecipientInput[] {
    return value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((address) => ({ address }));
}

function HeaderButton({ label, onClick, icon: Icon }: { label: string; onClick: () => void; icon: React.ComponentType<{ size?: number }> }) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            onClick={onClick}
            className="w-6 h-6 flex items-center justify-center rounded-sm text-white/80 hover:bg-white/15 hover:text-white"
        >
            <Icon size={14} />
        </button>
    );
}

/**
 * A floating, Gmail-style compose window — overlays whatever app is currently showing instead of
 * navigating to a dedicated page (see `ComposeContext.tsx`'s doc comment for why: a full-page compose
 * form meant losing your place in the inbox/calendar/contacts view behind it, and every navigation to
 * `/compose` re-ran this whole app's full mailbox/folder resolution waterfall from scratch). Owns its
 * own draft lifecycle end to end (unlike the old page, which read the Drafts folder from `MailShell`'s
 * context — this window can be opened from apps that never mount `MailShell` at all, e.g. Contacts'
 * "Email" action, so it resolves its own Drafts folder from just a `mailboxUid`).
 *
 * Below the `md` breakpoint, a non-minimized session instead renders as a full-screen sheet (there's no
 * room for a floating window, and the click-drag resize handles below become meaningless full-screen) —
 * see `ComposeContext.tsx`'s own doc comment for how that interacts with several sessions being open at
 * once.
 */
export default function ComposeWindow({ session, onClose, onToggleMinimize }: ComposeWindowProps) {
    const { id, mailboxUid, initialTo, initialCc, initialSubject, initialQuotedHtml, signatureContext, minimized } = session;
    const isMobile = useIsMobile();

    const windowRef = useRef<HTMLDivElement>(null);
    const [draftsFolderUid, setDraftsFolderUid] = useState<string | undefined>();
    const [folderError, setFolderError] = useState<string | null>(null);
    const [draft, setDraft] = useState<Message | null>(null);
    const [draftError, setDraftError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState(false);
    const [manualSize, setManualSize] = useState<Size | null>(null);
    const [to, setTo] = useState(initialTo ?? "");
    const [cc, setCc] = useState(initialCc ?? "");
    const [bcc, setBcc] = useState("");
    const [showCcBcc, setShowCcBcc] = useState(!!initialCc);
    const [subject, setSubject] = useState(initialSubject ?? "");
    const [html, setHtml] = useState("");
    const [contentReady, setContentReady] = useState(false);
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [attachError, setAttachError] = useState<string | null>(null);
    const [sendError, setSendError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [requestReceipt, setRequestReceipt] = useState(false);
    const [schedulePickerOpen, setSchedulePickerOpen] = useState(false);
    const scheduleButtonRef = useRef<HTMLButtonElement>(null);
    const [mailbox, setMailbox] = useState<Mailbox | null>(null);
    const [encryptionPolicy, setEncryptionPolicy] = useState<EncryptionPolicy | null>(null);
    const [signEnabled, setSignEnabled] = useState(true);
    const [encryptRequested, setEncryptRequested] = useState(false);
    const [encryptionBlocked, setEncryptionBlocked] = useState<RecipientEncryptionStatus[] | null>(null);

    // Best-effort, same as the signature-list fetch below: a mailbox with no keys enrolled yet (or a
    // failed fetch) just means sign/encrypt stay unavailable for this compose session, never a blocking
    // error - encryption is optional and gradual by design (see `KeyEnrollmentGate`'s own doc comment).
    // `cryptoContextReady` (below) gates Send/Send-later until both calls have settled either way, so a
    // send that happens to race this fetch can't silently skip encryption the spec says should apply.
    const [cryptoContextReady, setCryptoContextReady] = useState(false);
    useEffect(() => {
        let cancelled = false;
        setCryptoContextReady(false);
        let mailboxSettled = false;
        let policySettled = false;
        function checkReady() {
            if (!cancelled && mailboxSettled && policySettled) {
                setCryptoContextReady(true);
            }
        }
        getMailbox(mailboxUid)
            .then((result) => {
                if (!cancelled) {
                    setMailbox(result);
                }
            })
            .catch(() => undefined)
            .finally(() => {
                mailboxSettled = true;
                checkReady();
            });
        getEncryptionPolicy()
            .then((result) => {
                if (!cancelled) {
                    setEncryptionPolicy(result);
                }
            })
            .catch(() => undefined)
            .finally(() => {
                policySettled = true;
                checkReady();
            });
        return () => {
            cancelled = true;
        };
    }, [mailboxUid]);

    useEffect(() => {
        listFolders(mailboxUid)
            .then((folders) => setDraftsFolderUid(folders.find((f) => f.type === "drafts")?.uid))
            .catch((err) => setFolderError(err instanceof ApiRequestError ? err.message : "Could not load your Drafts folder."));
    }, [mailboxUid]);

    // Resolves the mailbox's default signature (if any) for `signatureContext` and seeds `html` with it
    // plus any quoted original message, before `RichTextEditor` ever mounts (gated by `contentReady`
    // below) — `RichTextEditor`'s own doc comment is explicit that `value` only seeds its *initial*
    // content and never re-syncs from a later prop change, so this has to resolve before that first
    // mount, not after. A signature-list failure is best-effort, same as every other supplementary,
    // non-blocking fetch in this codebase (e.g. `ConversationThreadPane`'s attachment fetch) — no
    // signature is a completely legitimate outcome, so this falls back to just the quoted content
    // (if any) rather than surfacing an error over what's a cosmetic nicety.
    useEffect(() => {
        listMailSignatures(mailboxUid)
            .then((signatures) => {
                const signature = signatures.find((s) =>
                    signatureContext === "new" ? s.isDefaultForNewMessages : s.isDefaultForReplyForward,
                );
                const signatureHtml = signature?.contentHtml ? `${signature.contentHtml}<p></p>` : "";
                setHtml(`${signatureHtml}${initialQuotedHtml ?? ""}`);
            })
            .catch(() => setHtml(initialQuotedHtml ?? ""))
            .finally(() => setContentReady(true));
    }, [mailboxUid, signatureContext, initialQuotedHtml]);

    useEffect(() => {
        if (!draftsFolderUid || draft) {
            return;
        }
        createDraft(mailboxUid, draftsFolderUid)
            .then(setDraft)
            .catch((err) => setDraftError(err instanceof ApiRequestError ? err.message : "Could not start a new draft."));
    }, [mailboxUid, draftsFolderUid, draft]);

    /**
     * Click-and-drag resize, from the window's own top/left edges (and the top-left corner, for both
     * at once) — the window is anchored bottom-right (see `ComposeContext.tsx`'s stack), so growing it
     * always means extending up and/or left, never down/right. `onMove`/`onUp` are fresh closures
     * created per drag gesture (captured over this gesture's own start position/size) rather than
     * stable component-level functions, specifically so `removeEventListener` in `onUp` always removes
     * the exact listener `onMove`/`onUp` themselves just added — a version defined once per render and
     * reused across gestures would need extra ref-juggling to avoid removing a stale (already-replaced)
     * listener instead of the current one.
     */
    function handleResizeStart(edge: ResizeEdge) {
        return (e: React.PointerEvent) => {
            e.preventDefault();
            const rect = windowRef.current!.getBoundingClientRect();
            const startX = e.clientX;
            const startY = e.clientY;
            const startWidth = rect.width;
            const startHeight = rect.height;

            function onMove(ev: PointerEvent) {
                const maxWidth = window.innerWidth - VIEWPORT_MARGIN;
                const maxHeight = window.innerHeight - VIEWPORT_MARGIN;
                const width = edge === "top" ? startWidth : Math.min(Math.max(startWidth - (ev.clientX - startX), MIN_WIDTH), maxWidth);
                const height = edge === "left" ? startHeight : Math.min(Math.max(startHeight - (ev.clientY - startY), MIN_HEIGHT), maxHeight);
                setManualSize({ width, height });
            }
            function onUp() {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
            }
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
        };
    }

    function toggleExpanded() {
        setExpanded((v) => !v);
        setManualSize(null);
    }

    /** Uploads `file` as an attachment on the current draft, resolving to a URL the editor can preview
     * it at immediately — see `BaseMailComposeRoute.rewriteInlineImageSources()`'s doc comment for how
     * that URL gets swapped for the message's real inline `cid:` reference at send time. Resolves to
     * `null` (surfacing `attachError` itself, reusing the same state "Attach files" already has) rather
     * than throwing: unlike "Attach files" (`disabled={!draft}`), "Insert image" in the formatting
     * toolbar is only gated on the *editor* being mounted, not on the draft existing yet — those two
     * things load in parallel, so a real (if narrow) window exists where the button is clickable before
     * `draft` resolves, and this needs to fail gracefully rather than crash on a null draft.
     */
    async function handleUploadImage(file: File): Promise<string | null> {
        if (!draft) {
            setAttachError("Please wait for the draft to finish loading before inserting an image.");
            return null;
        }
        try {
            const attachment = await uploadAttachment(draft.uid, file);
            return attachmentContentUrl(attachment.uid);
        } catch (err) {
            setAttachError(err instanceof ApiRequestError ? err.message : "Could not upload image.");
            return null;
        }
    }

    // The "Attach files" input is itself `disabled` until `draft` resolves (see its `disabled={!draft}`
    // below), so this can only ever fire once `draft` is set — no defensive null check needed, matching
    // this codebase's established pattern for the same class of "always non-null by the time it's
    // called" value (e.g. `ComposeToolbar.run()`). No separate empty-`files` guard either: the loop
    // below is already a no-op when there's nothing to iterate.
    async function handleFilesSelected(e: ChangeEvent<HTMLInputElement>) {
        const files = Array.from(e.target.files ?? []);
        e.target.value = "";
        setAttachError(null);
        for (const file of files) {
            try {
                const attachment = await uploadAttachment(draft!.uid, file);
                setAttachments((prev) => [...prev, attachment]);
            } catch (err) {
                setAttachError(err instanceof ApiRequestError ? err.message : "Could not upload attachment.");
            }
        }
    }

    /**
     * Builds this draft's final body — plaintext, signed-only, or signed+encrypted per
     * `specs/end-to-end_encryption.md` — then stores it via `assembleDraft()`/`assembleDraftRaw()`.
     * Shared by `handleSend()`/`handleScheduleSend()` (and the "Send without encryption" conflict button
     * rendered below, via `forcePlaintext`) so the sign/encrypt decision lives in exactly one place.
     *
     * Returns `"blocked"` (never throws for this case) when encryption was requested but not every
     * recipient can currently be encrypted to — the spec's "Multiple Recipients" all-or-nothing rule.
     * Sets `encryptionBlocked` as a side effect so the window can render that prompt; callers must stop
     * (not send) when they get this back.
     *
     * Discovery (`lookupKeys()`) and the resulting sign/encrypt decision only run at this, the final
     * pre-send step — not live as recipients are typed. A compose-time recipient-entry indicator (key
     * icons, live discovery as each address is entered) is Phase 4's "Discovery & contacts UI" work, not
     * this pass; this still satisfies the spec's "MUST be called lazily at compose time, not on receipt"
     * requirement, just without a live UI reflecting it before Send is clicked.
     */
    async function assembleForSend(
        toRecipients: ComposeRecipientInput[],
        ccRecipients: ComposeRecipientInput[],
        bccRecipients: ComposeRecipientInput[],
        forcePlaintext: boolean,
    ): Promise<Message | "blocked"> {
        const unlocked = getUnlockedKeys(mailboxUid);
        // `mailbox` is required to build protected headers (own From address) whenever signing or
        // encrypting - not just guarded on the encryption branch below, since a signed-only message
        // needs it too. A mailbox fetch failure just means no crypto for this send, never a crash.
        const canSign = signEnabled && !!mailbox && !!unlocked?.signingPrivateKey && !!unlocked.signingCertDer;
        const canEncryptSelf = !!unlocked?.encryptionPrivateKey && !!unlocked.encryptionCertDer;
        const allRecipients = [...toRecipients, ...ccRecipients, ...bccRecipients];

        let wantEncrypt = false;
        let recipientCertDers: Uint8Array[] = [];
        if (!forcePlaintext && canEncryptSelf && mailbox && encryptionPolicy && allRecipients.length > 0) {
            const ownPrefersMutual = mailbox.encryptPreference?.preferEncrypt === "mutual";
            const lookups = await Promise.all(allRecipients.map((r) => lookupKeys(mailboxUid, r.address).catch(() => undefined)));
            const statuses = allRecipients.map((r, i) =>
                resolveRecipientEncryption(mailbox.primarySmtpAddress, ownPrefersMutual, encryptionPolicy, r.address, lookups[i]),
            );
            const decision = decideMessageEncryption(statuses);
            wantEncrypt = encryptRequested || decision.autoEncrypt;
            if (wantEncrypt) {
                if (!decision.canEncryptAll) {
                    setEncryptionBlocked(decision.blockedRecipients);
                    return "blocked";
                }
                recipientCertDers = [unlocked!.encryptionCertDer!, ...statuses.map((s) => fromBase64(s.encryptCert!.publicKey))];
            }
        }

        if ((wantEncrypt || canSign) && attachments.length > 0) {
            // Matches BaseMailComposeRoute.assembleRaw()'s own server-side rejection, surfaced here with a
            // clearer explanation than that route's generic 400 rather than via a round trip.
            throw new ApiRequestError("A signed or encrypted message cannot include file attachments yet - remove them before sending.", 400);
        }

        if (!wantEncrypt && !canSign) {
            // See the old compose page's identical note: `sanitize-html` is Node-oriented and the server-side
            // gate in `BaseMailComposeRoute.assemble()` is the sole authoritative sanitizer regardless, so no
            // client-side pass is done here either.
            return assembleDraft(draft!.uid, { to: toRecipients, cc: ccRecipients, bcc: bccRecipients, subject, html });
        }

        const domain = mailbox!.primarySmtpAddress.split("@")[1] ?? "localhost";
        const protectedHeaders: ProtectedHeaders = {
            from: mailbox!.displayName
                ? `"${mailbox!.displayName.replace(/"/g, '\\"')}" <${mailbox!.primarySmtpAddress}>`
                : mailbox!.primarySmtpAddress,
            to: toRecipients.map((r) => r.address).join(", "),
            cc: ccRecipients.length > 0 ? ccRecipients.map((r) => r.address).join(", ") : undefined,
            date: new Date().toUTCString(),
            subject,
            messageId: `<${crypto.randomUUID()}@${domain}>`,
        };
        const bodyContentType = 'text/html; charset="utf-8"';
        const signing = canSign ? { certDer: unlocked!.signingCertDer!, privateKey: unlocked!.signingPrivateKey! } : undefined;

        const outerHeaders = wantEncrypt ? applyBaselineOuterHeaders(protectedHeaders) : protectedHeaders;
        const mimePart = wantEncrypt
            ? await buildEncryptedMessage(bodyContentType, html, protectedHeaders, outerHeaders, recipientCertDers, signing)
            : await buildSignedOnlyMessage(bodyContentType, html, protectedHeaders, signing!.certDer, signing!.privateKey);
        const rawMime = assembleOutboundMime(outerHeaders, mimePart);
        return assembleDraftRaw(draft!.uid, { to: toRecipients, cc: ccRecipients, bcc: bccRecipients, subject: outerHeaders.subject, rawMime });
    }

    // Same reasoning as `handleFilesSelected` above: the Send button is itself `disabled` until `draft`
    // resolves, so this is never reachable with a null `draft`.
    async function handleSend(forcePlaintext = false) {
        const toRecipients = parseAddresses(to);
        if (toRecipients.length === 0) {
            setSendError("At least one recipient is required.");
            return;
        }

        setSending(true);
        setSendError(null);
        try {
            const assembled = await assembleForSend(toRecipients, parseAddresses(cc), parseAddresses(bcc), forcePlaintext);
            if (assembled === "blocked") {
                return;
            }
            const withReceipt = requestReceipt ? await setMessageRequestReceipt(assembled, true) : assembled;
            await sendMessage(withReceipt.uid);
            onClose();
        } catch (err) {
            setSendError(err instanceof ApiRequestError ? err.message : "Could not send this message.");
        } finally {
            setSending(false);
        }
    }

    // Same reasoning as `handleSend` above (and the "Send later" caret is itself `disabled` alongside
    // Send until `draft` resolves) — never reachable with a null `draft`. Assembles the draft first
    // (same as an immediate send), then sets `scheduledSendTime` on the *freshly assembled* copy before
    // calling `sendMessage()` — `send()` itself is what reads the field and defers relay into Outbox
    // instead of sending immediately (see `mailApi.ts`'s own doc comment on `setMessageScheduledSendTime`).
    async function handleScheduleSend(scheduledSendTimeIso: string) {
        const toRecipients = parseAddresses(to);
        setSchedulePickerOpen(false);
        if (toRecipients.length === 0) {
            setSendError("At least one recipient is required.");
            return;
        }

        setSending(true);
        setSendError(null);
        try {
            const assembled = await assembleForSend(toRecipients, parseAddresses(cc), parseAddresses(bcc), false);
            if (assembled === "blocked") {
                return;
            }
            const withReceipt = requestReceipt ? await setMessageRequestReceipt(assembled, true) : assembled;
            const scheduled = await setMessageScheduledSendTime(withReceipt, scheduledSendTimeIso);
            await sendMessage(scheduled.uid);
            onClose();
        } catch (err) {
            setSendError(err instanceof ApiRequestError ? err.message : "Could not schedule this message.");
        } finally {
            setSending(false);
        }
    }

    // A plain read from keySession.ts's module-level session store, not React state - see that module's
    // own doc comment. Cheap enough to read fresh on every render rather than caching in state.
    const unlockedKeys = getUnlockedKeys(mailboxUid);

    const title = subject.trim() || "New Message";
    const titleId = `compose-title-${id}`;

    if (minimized) {
        return (
            <div role="dialog" aria-label={title} className="w-64 shrink-0 bg-surface border border-border border-b-0 rounded-t-md shadow-modal">
                <div
                    className="h-10 flex items-center justify-between gap-2 px-3 rounded-t-md bg-primary-darker text-white cursor-pointer"
                    onClick={onToggleMinimize}
                >
                    <span className="text-sm font-medium truncate">{title}</span>
                    <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                        <HeaderButton label="Restore" onClick={onToggleMinimize} icon={HiOutlineArrowsPointingOut} />
                        <HeaderButton
                            label="Discard draft"
                            onClick={onClose}
                            icon={HiOutlineXMark}
                        />
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            ref={windowRef}
            role="dialog"
            aria-labelledby={titleId}
            style={!isMobile && manualSize ? { width: manualSize.width, height: manualSize.height } : undefined}
            className={[
                "relative shrink-0 flex flex-col bg-surface border border-border shadow-modal overflow-hidden",
                isMobile
                    ? "fixed inset-0 w-full h-full rounded-none border-0"
                    : ["border-b-0 rounded-t-md", manualSize ? "" : expanded ? "w-[720px] h-[85vh]" : "w-[480px] h-[520px]"].join(" "),
            ].join(" ")}
        >
            {!isMobile && (
                <>
                    <div
                        onPointerDown={handleResizeStart("top")}
                        aria-hidden="true"
                        className="absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize z-20"
                    />
                    <div
                        onPointerDown={handleResizeStart("left")}
                        aria-hidden="true"
                        className="absolute top-0 left-0 bottom-0 w-1.5 cursor-ew-resize z-20"
                    />
                    <div
                        onPointerDown={handleResizeStart("corner")}
                        role="separator"
                        aria-label="Resize"
                        className="absolute top-0 left-0 w-3 h-3 cursor-nwse-resize z-30"
                    />
                </>
            )}

            <div
                className="h-10 shrink-0 flex items-center justify-between gap-2 px-3 bg-primary-darker text-white cursor-pointer"
                onClick={onToggleMinimize}
            >
                <span id={titleId} className="text-sm font-medium truncate">
                    {title}
                </span>
                <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                    <HeaderButton label="Minimize" onClick={onToggleMinimize} icon={HiOutlineMinus} />
                    {!isMobile && (
                        <HeaderButton
                            label={expanded ? "Collapse" : "Expand"}
                            onClick={toggleExpanded}
                            icon={expanded ? HiOutlineArrowsPointingIn : HiOutlineArrowsPointingOut}
                        />
                    )}
                    <HeaderButton label="Close" onClick={onClose} icon={HiOutlineXMark} />
                </div>
            </div>

            <div className="flex-1 min-h-0 flex flex-col">
                {(folderError || draftError || sendError || attachError) && (
                    <div className="px-3 pt-2">
                        {folderError && <Alert>{folderError}</Alert>}
                        {draftError && <Alert>{draftError}</Alert>}
                        {sendError && <Alert>{sendError}</Alert>}
                        {attachError && <Alert>{attachError}</Alert>}
                    </div>
                )}

                {encryptionBlocked && (
                    <div className="px-3 pt-2">
                        <Alert>
                            <p className="mb-2">
                                This message can&rsquo;t be encrypted for everyone: {encryptionBlocked.map((r) => r.address).join(", ")}
                                {encryptionBlocked[0]?.prohibitedReason ? ` — ${encryptionBlocked[0].prohibitedReason}` : " has no encryption key on file"}.
                                Remove {encryptionBlocked.length > 1 ? "these recipients" : "this recipient"} from To/Cc/Bcc, or send the
                                whole message in plaintext.
                            </p>
                            <Button
                                type="button"
                                onClick={() => {
                                    setEncryptionBlocked(null);
                                    void handleSend(true);
                                }}
                            >
                                Send without encryption
                            </Button>
                        </Alert>
                    </div>
                )}

                <div className={FIELD_ROW}>
                    <label htmlFor={`compose-to-${id}`} className="text-xs text-text-muted shrink-0">
                        To
                    </label>
                    <input
                        id={`compose-to-${id}`}
                        type="text"
                        className={FIELD_INPUT}
                        value={to}
                        onChange={(e) => setTo(e.target.value)}
                    />
                    {!showCcBcc && (
                        <button
                            type="button"
                            onClick={() => setShowCcBcc(true)}
                            className="text-xs text-text-muted hover:text-text shrink-0"
                        >
                            Cc Bcc
                        </button>
                    )}
                </div>

                {showCcBcc && (
                    <>
                        <div className={FIELD_ROW}>
                            <label htmlFor={`compose-cc-${id}`} className="text-xs text-text-muted shrink-0">
                                Cc
                            </label>
                            <input id={`compose-cc-${id}`} type="text" className={FIELD_INPUT} value={cc} onChange={(e) => setCc(e.target.value)} />
                        </div>
                        <div className={FIELD_ROW}>
                            <label htmlFor={`compose-bcc-${id}`} className="text-xs text-text-muted shrink-0">
                                Bcc
                            </label>
                            <input id={`compose-bcc-${id}`} type="text" className={FIELD_INPUT} value={bcc} onChange={(e) => setBcc(e.target.value)} />
                        </div>
                    </>
                )}

                <div className={FIELD_ROW}>
                    <input
                        aria-label="Subject"
                        type="text"
                        placeholder="Subject"
                        className={FIELD_INPUT}
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                    />
                </div>

                <div className="flex-1 min-h-0 p-2">
                    {contentReady && <RichTextEditor value={html} onChange={setHtml} fill onUploadImage={handleUploadImage} />}
                </div>

                {attachments.length > 0 && (
                    <ul className="flex flex-wrap gap-2 px-3 pb-2">
                        {attachments.map((attachment) => (
                            <li key={attachment.uid} className="text-xs font-medium py-1 px-2.5 rounded-pill bg-surface-alt text-text-muted">
                                {attachment.filename}
                            </li>
                        ))}
                    </ul>
                )}

                <label className="flex items-center gap-1.5 px-3 pb-1 text-xs text-text-muted">
                    <input type="checkbox" checked={requestReceipt} onChange={(e) => setRequestReceipt(e.target.checked)} />
                    Request a read receipt
                </label>

                {/* Only rendered once this session actually has a usable signing/encryption key - see
                    `assembleForSend()`'s own doc comment for why signing rarely shows today (no signing
                    certificate exists until RFC 8823 ACME enrollment lands). */}
                {unlockedKeys?.signingPrivateKey && (
                    <label className="flex items-center gap-1.5 px-3 pb-1 text-xs text-text-muted">
                        <input type="checkbox" checked={signEnabled} onChange={(e) => setSignEnabled(e.target.checked)} />
                        Digitally sign this message
                    </label>
                )}
                {unlockedKeys?.encryptionPrivateKey && (
                    <label className="flex items-center gap-1.5 px-3 pb-1 text-xs text-text-muted">
                        <input type="checkbox" checked={encryptRequested} onChange={(e) => setEncryptRequested(e.target.checked)} />
                        Encrypt this message
                    </label>
                )}

                <div className="shrink-0 flex items-center gap-1 px-3 py-2 border-t border-border">
                    <div className="flex items-center rounded-pill bg-primary text-white overflow-hidden">
                        <button
                            type="button"
                            onClick={() => handleSend()}
                            disabled={!draft || sending || !cryptoContextReady}
                            className="py-1.5 pl-5 pr-3 font-semibold text-sm hover:not-disabled:bg-primary-dark disabled:opacity-55 disabled:cursor-not-allowed"
                        >
                            {sending ? "Sending…" : "Send"}
                        </button>
                        <button
                            ref={scheduleButtonRef}
                            type="button"
                            aria-label="Send later"
                            aria-haspopup="true"
                            aria-expanded={schedulePickerOpen}
                            disabled={!draft || sending || !cryptoContextReady}
                            onClick={() => setSchedulePickerOpen((o) => !o)}
                            className="py-1.5 px-2 border-l border-white/30 hover:not-disabled:bg-primary-dark disabled:opacity-55 disabled:cursor-not-allowed"
                        >
                            <HiOutlineChevronDown size={14} />
                        </button>
                    </div>
                    {schedulePickerOpen && (
                        <ScheduleSendPicker
                            anchorRef={scheduleButtonRef}
                            onClose={() => setSchedulePickerOpen(false)}
                            onSchedule={handleScheduleSend}
                        />
                    )}

                    <label
                        aria-label="Attach files"
                        title="Attach files"
                        className="w-8 h-8 flex items-center justify-center rounded-full text-text-muted hover:bg-surface-alt hover:text-text cursor-pointer has-[:disabled]:opacity-40 has-[:disabled]:cursor-not-allowed"
                    >
                        <HiOutlinePaperClip size={18} />
                        <input type="file" multiple disabled={!draft} onChange={handleFilesSelected} className="sr-only" />
                    </label>

                    <button
                        type="button"
                        aria-label="Discard draft"
                        title="Discard draft"
                        onClick={onClose}
                        className="ml-auto w-8 h-8 flex items-center justify-center rounded-full text-text-muted hover:bg-surface-alt hover:text-text"
                    >
                        <HiOutlineTrash size={18} />
                    </button>
                </div>
            </div>
        </div>
    );
}
