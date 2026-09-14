///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ChangeEvent, useEffect, useRef, useState } from "react";
import {
    HiOutlineArrowsPointingIn,
    HiOutlineArrowsPointingOut,
    HiOutlineChevronDown,
    HiOutlineLockClosed,
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
    deleteMessage,
    getMailbox,
    listFolders,
    listMailboxes,
    sendMessage,
    setMessageRequestReceipt,
    setMessageScheduledSendTime,
    uploadAttachment,
} from "@rapidmx/react-shared/mail/mailApi.js";
import { listMailSignatures } from "@rapidmx/react-shared/mail/mailSignaturesApi.js";
import { peekMailboxWritability, useMailboxWritability } from "../writableMailboxes.js";
import { decideMessageEncryption, resolveRecipientEncryption, RecipientEncryptionStatus } from "@rapidmx/react-shared/crypto/composeSecurity.js";
import { getUnlockedKeys, subscribeKeySession } from "@rapidmx/react-shared/crypto/keySession.js";
import { EncryptionPolicy, findActivePublicKey, getEncryptionPolicy, lookupKeys } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { useUnlockPrompt } from "../../layout/UnlockPromptProvider.js";
import { fromBase64 } from "@rapidmx/react-shared/crypto/encoding.js";
import { ProtectedHeaders, applyBaselineOuterHeaders, assembleOutboundMime, buildEncryptedMessage, buildSignedOnlyMessage } from "@rapidmx/react-shared/crypto/smimeMessage.js";
import useIsMobile from "@rapidmx/react-shared/util/useIsMobile.js";
import type { ComposeSession } from "./ComposeContext.js";
import RichTextEditor from "./RichTextEditor.js";
import ScheduleSendPicker from "./ScheduleSendPicker.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

export interface ComposeWindowProps {
    session: ComposeSession;
    onClose: () => void;
    onToggleMinimize: () => void;
    /** The signed-in user - identifies their own ("primary") mailbox, the default From when the session
     * doesn't name a mailbox. */
    userUid?: string;
    /** The caller holds a trusted (admin) role - every mailbox is writable, so no per-mailbox access checks. */
    trusted?: boolean;
    /** How long (ms) after the last edit the draft is autosaved. Defaults to `DEFAULT_AUTOSAVE_DELAY_MS`;
     * only overridden by tests. */
    autosaveDelayMs?: number;
}

/** Debounce between the last edit and the draft autosave. */
export const DEFAULT_AUTOSAVE_DELAY_MS = 2000;

/** Signed/encrypted bodies are built client-side from the editor's HTML verbatim, so an inline image
 * (an uploaded attachment previewed via its content URL, or a `cid:` reference) would never be carried -
 * only `assembleDraft()`'s server-side plaintext path rewrites those into real MIME parts. */
const INLINE_IMAGE_PATTERN = /<img\b[^>]*\bsrc\s*=\s*["']?(?:cid:|[^"'\s>]*\/mail\/attachments\/[^"'\s>]+\/content)/i;

const KEYS_LOCKED_SIGN_MESSAGE =
    "This message can't be signed right now - your signing key is locked or your mailbox details couldn't be loaded. Unlock and send again, or send it without signing.";
const KEYS_LOCKED_ENCRYPT_MESSAGE =
    "This message can't be encrypted right now - your encryption key is locked. Unlock and send again, or send it without encryption.";
const POLICY_UNAVAILABLE_MESSAGE =
    "Your encryption settings couldn't be loaded, so this message can't be encrypted right now. Try again, or send it without encryption.";
const BCC_ENCRYPTED_MESSAGE = "Bcc recipients can't be used with encrypted messages. Remove Bcc recipients or turn off encryption.";

const SAVE_STATUS_LABEL = { idle: "", saving: "Saving…", saved: "Draft saved", error: "Couldn't save draft" } as const;

interface SecurityBlock {
    message: string;
    overrideLabel: string;
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
export default function ComposeWindow({
    session,
    onClose,
    onToggleMinimize,
    userUid,
    trusted,
    autosaveDelayMs = DEFAULT_AUTOSAVE_DELAY_MS,
}: ComposeWindowProps) {
    const { id, initialTo, initialCc, initialSubject, initialQuotedHtml, signatureContext, suppressSigning, minimized } = session;
    // The sending ("From") mailbox. A reply/forward session names the original message's mailbox; a fresh
    // compose leaves it unset and defaults to the caller's own mailbox once `listMailboxes()` resolves.
    // Everything mailbox-scoped below (Drafts folder, draft, signatures, crypto context) keys off this.
    const [fromMailboxUid, setFromMailboxUid] = useState<string | undefined>(session.mailboxUid);
    const mailboxUid = fromMailboxUid;
    const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
    // Attachments and inline images upload onto the current draft's uid, which lives in one mailbox's
    // Drafts folder - so once anything has been uploaded the sender can no longer be switched.
    const [hasUploads, setHasUploads] = useState(false);
    const isMobile = useIsMobile();
    const { requestUnlock } = useUnlockPrompt();
    // Bumped after a successful on-demand unlock to force a re-render - `getUnlockedKeys()` below is a
    // plain read from a module-level store, not React state, so nothing else would pick up the change.
    const [, setUnlockRefresh] = useState(0);

    const windowRef = useRef<HTMLDivElement>(null);
    const [draftsFolderUid, setDraftsFolderUid] = useState<string | undefined>();
    const [folderError, setFolderError] = useState<string | null>(null);
    const [draft, setDraft] = useState<Message | null>(null);
    // Drafts replaced by a From switch, awaiting deletion until their replacement has actually been created.
    const supersededDraftsRef = useRef<Message[]>([]);
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
    // Defaults off when replying to a detected mailing list (spec's own "Mailing lists" note under
    // Digital Signatures - a list that appends a footer after signing invalidates the signature) - see
    // `MessageDetailPane.tsx`'s handleReply()/handleReplyAll() for where this is computed. The user can
    // still turn it back on; this only changes the default.
    const [signEnabled, setSignEnabled] = useState(!suppressSigning);
    const [encryptRequested, setEncryptRequested] = useState(false);
    const [encryptionBlocked, setEncryptionBlocked] = useState<RecipientEncryptionStatus[] | null>(null);
    // Compose-time discovery (spec: "Discovery occurs ... when the user addresses a new message to a
    // recipient", never on receipt) - keyed by address so a recipient already looked up isn't re-fetched
    // just because the user re-focuses the field. Only ever grows via `checkRecipientDiscovery()` below;
    // never cleared, so switching focus between To/Cc/Bcc repeatedly doesn't re-trigger lookups.
    const [recipientStatuses, setRecipientStatuses] = useState<Record<string, RecipientEncryptionStatus>>({});
    // A send refused because signing/encryption was wanted but can't happen right now (keys locked, the
    // encryption policy/mailbox couldn't be loaded, or Bcc recipients on an encrypted message) - never a
    // silent downgrade to plaintext; the user has to explicitly pick the override.
    const [securityBlock, setSecurityBlock] = useState<SecurityBlock | null>(null);
    // The schedule time of the send that got blocked (undefined for an immediate send), so the banners'
    // override buttons replay the same kind of send the user originally asked for.
    const [blockedScheduleIso, setBlockedScheduleIso] = useState<string | undefined>();
    // Which crypto toggles were ever shown during this compose session (per sending mailbox). Keys that
    // lock after that point must block the send rather than quietly dropping the signature/encryption.
    const offeredCryptoRef = useRef({ sign: false, encrypt: false });

    // Draft autosave / discard bookkeeping.
    const [seededHtml, setSeededHtml] = useState<string | undefined>();
    const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
    const [discardPrompt, setDiscardPrompt] = useState<string | null>(null);
    /** `<draftUid>:<content key>` of the last successful save. */
    const lastSavedRef = useRef<string | null>(null);
    /** An edit is waiting on the autosave debounce - flushed if the window unmounts first. */
    const pendingSaveRef = useRef(false);
    /** The latest autosave request, if any - always settles (never rejects). */
    const saveInFlightRef = useRef<Promise<Message | undefined> | null>(null);
    /** Set once the window has been sent/closed/discarded - nothing more gets autosaved after that. */
    const finishedRef = useRef(false);

    // Best-effort, same as the signature-list fetch below: a mailbox with no keys enrolled yet (or a
    // failed fetch) just means sign/encrypt stay unavailable for this compose session, never a blocking
    // error - encryption is optional and gradual by design (see `KeyEnrollmentGate`'s own doc comment).
    // `cryptoContextReady` (below) gates Send/Send-later until both calls have settled either way, so a
    // send that happens to race this fetch can't silently skip encryption the spec says should apply.
    const [cryptoContextReady, setCryptoContextReady] = useState(false);

    useEffect(() => {
        let cancelled = false;
        listMailboxes({ limit: 100 })
            .then((result) => {
                if (cancelled) {
                    return;
                }
                setMailboxes(result);
                // Never default to a mailbox already known to be view-only (see the effect below for one
                // that turns out to be).
                const candidates = result.filter((mb) => peekMailboxWritability(mb, userUid, trusted) !== false);
                setFromMailboxUid((current) => current ?? (candidates.find((mb) => mb.ownerUserUid === userUid) ?? candidates[0])?.uid);
            })
            .catch((err) => {
                // Only fatal when there's no mailbox to fall back on - a session that already names one just
                // loses the From picker.
                if (!cancelled && !session.mailboxUid) {
                    setFolderError(err instanceof ApiRequestError ? err.message : "Could not load your mailboxes.");
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!mailboxUid) {
            return;
        }
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
        if (!mailboxUid) {
            return;
        }
        // Cancellable so a slow response for a mailbox the user has since switched away from can't point
        // the new draft at the wrong mailbox's Drafts folder.
        let cancelled = false;
        listFolders(mailboxUid)
            .then((folders) => {
                if (!cancelled) {
                    setDraftsFolderUid(folders.find((f) => f.type === "drafts")?.uid);
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setFolderError(err instanceof ApiRequestError ? err.message : "Could not load your Drafts folder.");
                }
            });
        return () => {
            cancelled = true;
        };
    }, [mailboxUid]);

    /**
     * Runs discovery for whichever of `addresses` haven't already been looked up this compose session,
     * caching the result so the small per-recipient indicator below the recipient fields can update
     * without waiting for Send. Called from the To/Cc/Bcc fields' own `onBlur` - not on every keystroke,
     * and not the same lookup `assembleForSend()` performs again at send time (deliberately: this is a
     * best-effort UI hint, not something a stale value here should be trusted to skip at send time).
     * A failed lookup or a mailbox/policy fetch that hasn't resolved yet just leaves that address with no
     * indicator rather than surfacing an error over what's a cosmetic nicety.
     */
    function checkRecipientDiscovery(addresses: ComposeRecipientInput[]) {
        if (!mailbox || !encryptionPolicy) {
            return;
        }
        const ownPrefersMutual = mailbox.encryptPreference?.preferEncrypt === "mutual";
        const unchecked = addresses.filter((r) => !(r.address in recipientStatuses));
        for (const recipient of unchecked) {
            void lookupKeys(mailbox.uid, recipient.address)
                .catch(() => undefined)
                .then((lookup) => {
                    const status = resolveRecipientEncryption(mailbox.primarySmtpAddress, ownPrefersMutual, encryptionPolicy, recipient.address, lookup);
                    setRecipientStatuses((prev) => ({ ...prev, [recipient.address]: status }));
                });
        }
    }

    // Resolves the mailbox's default signature (if any) for `signatureContext` and seeds `html` with it
    // plus any quoted original message, before `RichTextEditor` ever mounts (gated by `contentReady`
    // below) — `RichTextEditor`'s own doc comment is explicit that `value` only seeds its *initial*
    // content and never re-syncs from a later prop change, so this has to resolve before that first
    // mount, not after. A signature-list failure is best-effort, same as every other supplementary,
    // non-blocking fetch in this codebase (e.g. `ConversationThreadPane`'s attachment fetch) — no
    // signature is a completely legitimate outcome, so this falls back to just the quoted content
    // (if any) rather than surfacing an error over what's a cosmetic nicety.
    useEffect(() => {
        // Seeds the body once, from whichever mailbox is the sender when compose opens - switching From
        // later must not overwrite what the user has already written (the editor itself never re-syncs).
        if (!mailboxUid || contentReady) {
            return;
        }
        listMailSignatures(mailboxUid)
            .then((signatures) => {
                const signature = signatures.find((s) =>
                    signatureContext === "new" ? s.isDefaultForNewMessages : s.isDefaultForReplyForward,
                );
                const signatureHtml = signature?.contentHtml ? `${signature.contentHtml}<p></p>` : "";
                const seeded = `${signatureHtml}${initialQuotedHtml ?? ""}`;
                setHtml(seeded);
                setSeededHtml(seeded);
            })
            .catch(() => {
                setHtml(initialQuotedHtml ?? "");
                setSeededHtml(initialQuotedHtml ?? "");
            })
            .finally(() => setContentReady(true));
    }, [mailboxUid, signatureContext, initialQuotedHtml]);

    useEffect(() => {
        if (!mailboxUid || !draftsFolderUid || draft) {
            return;
        }
        let cancelled = false;
        createDraft(mailboxUid, draftsFolderUid)
            .then((created) => {
                if (cancelled) {
                    // The sender changed while this was in flight - discard the now-orphaned draft.
                    void deleteMessage(created.uid, created.version).catch(() => undefined);
                    return;
                }
                setDraft(created);
                // Only now that the replacement exists is it safe to discard the draft(s) a From switch
                // superseded - if creating this one had failed, the earlier draft is still there.
                for (const superseded of supersededDraftsRef.current.splice(0)) {
                    void deleteMessage(superseded.uid, superseded.version).catch(() => undefined);
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setDraftError(err instanceof ApiRequestError ? err.message : "Could not start a new draft.");
                }
            });
        return () => {
            cancelled = true;
        };
    }, [mailboxUid, draftsFolderUid, draft]);

    // Drafts a From switch superseded are otherwise only deleted once their replacement exists - closing the
    // window (or sending, which closes it) first would orphan them.
    useEffect(
        () => () => {
            for (const superseded of supersededDraftsRef.current.splice(0)) {
                void deleteMessage(superseded.uid, superseded.version).catch(() => undefined);
            }
        },
        [],
    );

    // The From picker lists every mailbox straight away and drops view-only ones as each check answers - only
    // mailboxes the caller can create a draft in are worth offering.
    const writability = useMailboxWritability(mailboxes, userUid, trusted);
    const fromOptions = mailboxes.filter((mb) => mb.uid === mailboxUid || writability[mb.uid] !== false);

    // The sender turned out to be view-only (e.g. a reply to a message in a mailbox shared read-only, or a
    // first-listed shared mailbox): switch to one the caller can actually send from, preferring their own.
    const fromIsViewOnly = !!mailboxUid && writability[mailboxUid] === false;
    useEffect(() => {
        if (!fromIsViewOnly || hasUploads) {
            return;
        }
        const ordered = [...mailboxes.filter((mb) => mb.ownerUserUid === userUid), ...mailboxes.filter((mb) => mb.ownerUserUid !== userUid)];
        const alternative = ordered.find((mb) => writability[mb.uid] === true) ?? ordered.find((mb) => writability[mb.uid] === undefined);
        if (alternative) {
            handleFromChange(alternative.uid);
        }
    }, [fromIsViewOnly, writability]);

    /** Switches the sending mailbox: supersedes the current (unsent, upload-free) draft and resets the
     * per-mailbox state, so the effects above start a fresh draft and crypto context in the new mailbox -
     * the old draft is deleted only once the new one has been created. Recipients, subject, and body are
     * kept. */
    function handleFromChange(nextMailboxUid: string) {
        if (nextMailboxUid === mailboxUid || hasUploads) {
            return;
        }
        if (draft) {
            supersededDraftsRef.current.push(draft);
        }
        setDraft(null);
        setDraftsFolderUid(undefined);
        setDraftError(null);
        setFolderError(null);
        setMailbox(null);
        setRecipientStatuses({});
        setEncryptRequested(false);
        setEncryptionBlocked(null);
        setSecurityBlock(null);
        offeredCryptoRef.current = { sign: false, encrypt: false };
        setFromMailboxUid(nextMailboxUid);
    }

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
            setHasUploads(true);
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
                setHasUploads(true);
                setAttachments((prev) => [...prev, attachment]);
            } catch (err) {
                setAttachError(err instanceof ApiRequestError ? err.message : "Could not upload attachment.");
            }
        }
    }

    /**
     * Builds this draft's final body — plaintext, signed-only, or signed+encrypted per
     * `specs/end-to-end_encryption.md` — then stores it via `assembleDraft()`/`assembleDraftRaw()`.
     * Shared by immediate and scheduled sends (and the banners' override buttons rendered below, via
     * `forcePlaintext`) so the sign/encrypt decision lives in exactly one place.
     *
     * Returns `"blocked"` (never throws for this case) whenever the message can't go out the way the user
     * asked for — never a silent downgrade to plaintext:
     * encryption was requested (or auto-applies) but not every recipient can currently be encrypted to -
     * the spec's "Multiple Recipients" all-or-nothing rule (sets `encryptionBlocked`); signing/encryption was
     * on offer this session but the keys have since locked, or the mailbox/encryption policy needed to decide
     * couldn't be loaded (sets `securityBlock`, and re-prompts the unlock dialog when the keys are merely
     * locked); or the message would be encrypted but has Bcc recipients - every recipient's certificate goes
     * into one shared envelope, which would disclose the Bcc list to every other recipient, and the send API
     * has no per-recipient-copy submission to avoid that (sets `securityBlock`).
     * Callers must stop (not send) when they get this back. `forcePlaintext` (the user's explicit choice
     * from one of those banners) skips every one of these checks and never encrypts; signing still
     * happens if it's currently possible.
     *
     * Discovery (`lookupKeys()`) and the resulting sign/encrypt decision only run at this, the final
     * pre-send step — `checkRecipientDiscovery()`'s on-blur badges are a best-effort hint only.
     */
    async function assembleForSend(
        toRecipients: ComposeRecipientInput[],
        ccRecipients: ComposeRecipientInput[],
        bccRecipients: ComposeRecipientInput[],
        forcePlaintext: boolean,
    ): Promise<Message | "blocked"> {
        // Only reachable once a draft exists, which itself requires `mailboxUid` to have resolved.
        const unlocked = getUnlockedKeys(mailboxUid!);
        // `mailbox` is required to build protected headers (own From address) whenever signing or
        // encrypting - not just guarded on the encryption branch below, since a signed-only message
        // needs it too.
        const canSign = signEnabled && !!mailbox && !!unlocked?.signingPrivateKey && !!unlocked.signingCertDer;
        const canEncryptSelf = !!unlocked?.encryptionPrivateKey && !!unlocked.encryptionCertDer;
        const allRecipients = [...toRecipients, ...ccRecipients, ...bccRecipients];

        // The Sign toggle was shown (and is still checked), but signing can't actually happen any more.
        if (!forcePlaintext && signEnabled && offeredCryptoRef.current.sign && !canSign) {
            return blockSend(KEYS_LOCKED_SIGN_MESSAGE, "Send without signing or encryption", !unlocked);
        }

        let wantEncrypt = false;
        let recipientCertDers: Uint8Array[] = [];
        if (!forcePlaintext && (canEncryptSelf || offeredCryptoRef.current.encrypt)) {
            if (!mailbox || !encryptionPolicy) {
                // Without both, there's no telling whether policy auto-encrypts this message.
                return blockSend(POLICY_UNAVAILABLE_MESSAGE, "Send without encryption", false);
            }
            const ownPrefersMutual = mailbox.encryptPreference?.preferEncrypt === "mutual";
            const lookups = await Promise.all(allRecipients.map((r) => lookupKeys(mailboxUid!, r.address).catch(() => undefined)));
            const statuses = allRecipients.map((r, i) =>
                resolveRecipientEncryption(mailbox.primarySmtpAddress, ownPrefersMutual, encryptionPolicy, r.address, lookups[i]),
            );
            const decision = decideMessageEncryption(statuses);
            wantEncrypt = encryptRequested || decision.autoEncrypt;
            if (wantEncrypt) {
                if (!canEncryptSelf) {
                    return blockSend(KEYS_LOCKED_ENCRYPT_MESSAGE, "Send without encryption", !unlocked);
                }
                if (!decision.canEncryptAll) {
                    setEncryptionBlocked(decision.blockedRecipients);
                    return "blocked";
                }
                if (bccRecipients.length > 0) {
                    return blockSend(BCC_ENCRYPTED_MESSAGE, "Send without encryption", false);
                }
                recipientCertDers = [unlocked.encryptionCertDer!, ...statuses.map((s) => fromBase64(s.encryptCert!.publicKey))];
            }
        }

        if ((wantEncrypt || canSign) && attachments.length > 0) {
            // Matches BaseMailComposeRoute.assembleRaw()'s own server-side rejection, surfaced here with a
            // clearer explanation than that route's generic 400 rather than via a round trip.
            throw new ApiRequestError("A signed or encrypted message cannot include file attachments yet - remove them before sending.", 400);
        }
        if ((wantEncrypt || canSign) && INLINE_IMAGE_PATTERN.test(html)) {
            throw new ApiRequestError("A signed or encrypted message cannot include inline images yet - remove them before sending.", 400);
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
        const signing = canSign ? { certDer: unlocked.signingCertDer!, privateKey: unlocked.signingPrivateKey! } : undefined;

        const outerHeaders = wantEncrypt ? applyBaselineOuterHeaders(protectedHeaders) : protectedHeaders;
        const mimePart = wantEncrypt
            ? await buildEncryptedMessage(bodyContentType, html, protectedHeaders, outerHeaders, recipientCertDers, signing)
            : await buildSignedOnlyMessage(bodyContentType, html, protectedHeaders, signing!.certDer, signing!.privateKey);
        const rawMime = assembleOutboundMime(outerHeaders, mimePart);
        return assembleDraftRaw(draft!.uid, { to: toRecipients, cc: ccRecipients, bcc: bccRecipients, subject: outerHeaders.subject, rawMime });
    }

    /** Records why a send was refused (see `assembleForSend()`), re-prompting the unlock dialog when the
     * cause is keys that are enrolled but locked. */
    function blockSend(message: string, overrideLabel: string, keysLocked: boolean): "blocked" {
        setSecurityBlock({ message, overrideLabel });
        if (keysLocked && (hasEnrolledSigningKey || hasEnrolledEncryptionKey)) {
            void handleUnlockForCrypto();
        }
        return "blocked";
    }

    /**
     * Sends (or, given `scheduledSendTimeIso`, schedules) the draft. Same reasoning as `handleFilesSelected`
     * above: Send and the "Send later" caret are both `disabled` until `draft` resolves, so this is never
     * reachable with a null `draft`. A scheduled send assembles the draft first (same as an immediate send),
     * then sets `scheduledSendTime` on the *freshly assembled* copy before calling `sendMessage()` — `send()`
     * itself is what reads the field and defers relay into Outbox instead of sending immediately (see
     * `mailApi.ts`'s own doc comment on `setMessageScheduledSendTime`). A blocked send remembers its schedule
     * time so the banners' override buttons replay it as the same kind of send.
     */
    async function submit(forcePlaintext: boolean, scheduledSendTimeIso?: string) {
        const toRecipients = parseAddresses(to);
        if (toRecipients.length === 0) {
            setSendError("At least one recipient is required.");
            return;
        }

        setSending(true);
        setSendError(null);
        setSecurityBlock(null);
        setEncryptionBlocked(null);
        pendingSaveRef.current = false;
        try {
            // An autosave already on the wire must never land after (and overwrite) the send's own assembly.
            await saveInFlightRef.current;
            const assembled = await assembleForSend(toRecipients, parseAddresses(cc), parseAddresses(bcc), forcePlaintext);
            if (assembled === "blocked") {
                setBlockedScheduleIso(scheduledSendTimeIso);
                return;
            }
            // The draft now holds exactly this content (possibly signed/encrypted) - don't autosave a
            // plaintext copy over it if the rest of the send fails.
            lastSavedRef.current = `${assembled.uid}:${contentKey}`;
            const withReceipt = requestReceipt ? await setMessageRequestReceipt(assembled, true) : assembled;
            const ready = scheduledSendTimeIso ? await setMessageScheduledSendTime(withReceipt, scheduledSendTimeIso) : withReceipt;
            await sendMessage(ready.uid);
            finishedRef.current = true;
            onClose();
        } catch (err) {
            const fallback = scheduledSendTimeIso ? "Could not schedule this message." : "Could not send this message.";
            setSendError(err instanceof ApiRequestError ? err.message : fallback);
        } finally {
            setSending(false);
        }
    }

    function handleScheduleSend(scheduledSendTimeIso: string) {
        setSchedulePickerOpen(false);
        void submit(false, scheduledSendTimeIso);
    }

    async function handleUnlockForCrypto() {
        try {
            // Only reachable when hasEnrolledSigningKey/hasEnrolledEncryptionKey found a real enrolled key
            // in mailbox.keys (the unlock button below, or blockSend()), so neither is empty/undefined here.
            await requestUnlock(mailbox!.uid, mailbox!.keys!);
            setUnlockRefresh((n) => n + 1);
        } catch {
            // User dismissed the unlock dialog - nothing to do, the toggles below simply stay hidden.
        }
    }

    /**
     * Saves the window's current recipients/subject/body onto its server draft via `assembleDraft()` (the
     * same plaintext assembly a normal send uses). Reads `latestRef` rather than render-time values so the
     * unmount flush below saves what was last typed. Never rejects.
     */
    function saveDraftNow(): Promise<Message | undefined> {
        const current = latestRef.current;
        const target = current.draft!;
        const savedKey = `${target.uid}:${current.contentKey}`;
        pendingSaveRef.current = false;
        setSaveStatus("saving");
        const request = assembleDraft(target.uid, {
            to: parseAddresses(current.to),
            cc: parseAddresses(current.cc),
            bcc: parseAddresses(current.bcc),
            subject: current.subject,
            html: current.html,
        })
            .then((saved) => {
                lastSavedRef.current = savedKey;
                // A From switch may have replaced the draft while this was in flight - never resurrect it,
                // but do keep its superseded copy's version current so its pending delete still matches.
                setDraft((prev) => (prev?.uid === saved.uid ? saved : prev));
                const superseded = supersededDraftsRef.current.find((d) => d.uid === saved.uid);
                if (superseded) {
                    superseded.version = saved.version;
                }
                setSaveStatus("saved");
                return saved;
            })
            .catch(() => {
                setSaveStatus("error");
                return undefined;
            });
        saveInFlightRef.current = request;
        return request;
    }

    /** Deletes this window's server draft - once any autosave already on the wire has landed, so the delete
     * carries the draft's current version - and closes the window. */
    function discardNow() {
        finishedRef.current = true;
        pendingSaveRef.current = false;
        setDiscardPrompt(null);
        const current = draft;
        if (current) {
            const inFlight = saveInFlightRef.current;
            void (async () => {
                const saved = await inFlight;
                const target = saved?.uid === current.uid ? saved : current;
                await deleteMessage(target.uid, target.version);
            })().catch(() => undefined);
        }
        onClose();
    }

    /** "Discard draft": confirms first whenever there's anything the user would lose. */
    function handleDiscard() {
        if (hasUserContent) {
            setDiscardPrompt("This permanently deletes this draft and everything you've written in it.");
        } else {
            discardNow();
        }
    }

    /** "Close": keeps the draft (saving any unsaved edits first) - unless there's nothing in it worth keeping,
     * or it can't be saved at all because it's headed for encryption, which needs the same confirmation as a
     * discard. */
    function handleClose() {
        if (!hasUserContent) {
            discardNow();
            return;
        }
        if (autosaveSuppressed) {
            setDiscardPrompt("Encrypted messages aren't saved as drafts, so closing this window discards what you've written.");
            return;
        }
        finishedRef.current = true;
        if (draft && contentReady && lastSavedRef.current !== `${draft.uid}:${contentKey}`) {
            void saveDraftNow();
        }
        onClose();
    }

    // A plain read from keySession.ts's module-level session store, not React state - see that module's
    // own doc comment. Cheap enough to read fresh on every render rather than caching in state.
    const unlockedKeys = mailboxUid ? getUnlockedKeys(mailboxUid) : undefined;
    const hasEnrolledSigningKey = !!findActivePublicKey(mailbox?.keys ?? [], "sign");
    const hasEnrolledEncryptionKey = !!findActivePublicKey(mailbox?.keys ?? [], "encrypt");
    // This mailbox has a real signing/encryption key on file, but this session hasn't unlocked it yet -
    // the sign/encrypt toggles below stay hidden until it has, so this is the only way to reach them
    // without first stumbling into Mail generally (which no longer force-prompts on its own - see
    // `MailShell`'s `blocking={false}`). `getUnlockedKeys()` is re-read as a plain module value above, so
    // bumping `unlockRefresh` (after a successful unlock, or on any key-session event for this mailbox -
    // see the `subscribeKeySession()` effect) is what makes this line (and the toggles it gates) reflect
    // it on the next render.
    const needsUnlockForCrypto = (hasEnrolledSigningKey || hasEnrolledEncryptionKey) && !unlockedKeys;

    // Keys locking (idle timeout, logout elsewhere, ...) or unlocking from another window must update the
    // toggles/unlock affordance right away, not on whatever unrelated render happens next.
    useEffect(() => subscribeKeySession((event) => {
        if (event.mailboxUid === mailboxUid) {
            setUnlockRefresh((n) => n + 1);
        }
    }), [mailboxUid]);

    useEffect(() => {
        offeredCryptoRef.current = {
            sign: offeredCryptoRef.current.sign || !!unlockedKeys?.signingPrivateKey,
            encrypt: offeredCryptoRef.current.encrypt || !!unlockedKeys?.encryptionPrivateKey,
        };
    });

    // Autosave. "User content" is anything beyond what compose opened with (prefilled recipients/subject,
    // seeded signature/quote) - an untouched window has nothing worth saving or confirming a discard of.
    const contentKey = JSON.stringify([to, cc, bcc, subject, html]);
    const baselineKey = JSON.stringify([initialTo ?? "", initialCc ?? "", "", initialSubject ?? "", seededHtml ?? ""]);
    const hasUserContent = contentKey !== baselineKey || hasUploads;
    // A message headed for encryption is never autosaved: the draft would store its plaintext server-side,
    // defeating end-to-end encryption.
    const autosaveSuppressed = encryptRequested || Object.values(recipientStatuses).some((s) => s.autoEncrypt);
    const latestRef = useRef({ draft, to, cc, bcc, subject, html, contentKey });
    latestRef.current = { draft, to, cc, bcc, subject, html, contentKey };

    useEffect(() => {
        const due =
            !!draft &&
            contentReady &&
            !sending &&
            !autosaveSuppressed &&
            hasUserContent &&
            lastSavedRef.current !== `${draft.uid}:${contentKey}`;
        pendingSaveRef.current = due;
        if (!due) {
            return;
        }
        const timer = setTimeout(() => void saveDraftNow(), autosaveDelayMs);
        return () => clearTimeout(timer);
    }, [draft, contentReady, sending, autosaveSuppressed, hasUserContent, contentKey]);

    // Unmounting with an edit still waiting on the debounce (e.g. the whole app shell unmounting) saves it
    // right away rather than losing it.
    useEffect(
        () => () => {
            if (pendingSaveRef.current && !finishedRef.current) {
                void saveDraftNow();
            }
        },
        [],
    );

    const title = subject.trim() || "New Message";
    const titleId = `compose-title-${id}`;

    const discardModal = (
        <Modal open={discardPrompt !== null} onClose={() => setDiscardPrompt(null)} title="Discard this draft?">
            <p className="text-sm text-text-muted mb-4">{discardPrompt}</p>
            <div className="flex gap-3">
                <Button type="button" onClick={discardNow} className="!w-auto">
                    Discard
                </Button>
                <Button type="button" variant="secondary" onClick={() => setDiscardPrompt(null)} className="!w-auto">
                    Keep editing
                </Button>
            </div>
        </Modal>
    );

    if (minimized) {
        return (
            <>
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
                            onClick={handleDiscard}
                            icon={HiOutlineXMark}
                        />
                    </div>
                </div>
            </div>
            {discardModal}
            </>
        );
    }

    return (
        <>
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
                    <HeaderButton label="Close" onClick={handleClose} icon={HiOutlineXMark} />
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
                            <Button type="button" disabled={sending} onClick={() => void submit(true, blockedScheduleIso)}>
                                Send without encryption
                            </Button>
                        </Alert>
                    </div>
                )}

                {securityBlock && (
                    <div className="px-3 pt-2">
                        <Alert>
                            <p className="mb-2">{securityBlock.message}</p>
                            <Button type="button" disabled={sending} onClick={() => void submit(true, blockedScheduleIso)}>
                                {securityBlock.overrideLabel}
                            </Button>
                        </Alert>
                    </div>
                )}

                {fromOptions.length > 1 && (
                    <div className={FIELD_ROW}>
                        <label htmlFor={`compose-from-${id}`} className="text-xs text-text-muted shrink-0">
                            From
                        </label>
                        <select
                            id={`compose-from-${id}`}
                            className={`${FIELD_INPUT} disabled:opacity-55`}
                            value={mailboxUid ?? ""}
                            disabled={hasUploads || sending}
                            title={hasUploads ? "The sender can't be changed after adding attachments or images." : undefined}
                            onChange={(e) => handleFromChange(e.target.value)}
                        >
                            {fromOptions.map((mb) => (
                                <option key={mb.uid} value={mb.uid}>
                                    {mb.displayName ? `${mb.displayName} <${mb.primarySmtpAddress}>` : mb.primarySmtpAddress}
                                    {mb.ownerUserUid ? "" : " (shared)"}
                                </option>
                            ))}
                        </select>
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
                        onBlur={() => checkRecipientDiscovery(parseAddresses(to))}
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
                            <input
                                id={`compose-cc-${id}`}
                                type="text"
                                className={FIELD_INPUT}
                                value={cc}
                                onChange={(e) => setCc(e.target.value)}
                                onBlur={() => checkRecipientDiscovery(parseAddresses(cc))}
                            />
                        </div>
                        <div className={FIELD_ROW}>
                            <label htmlFor={`compose-bcc-${id}`} className="text-xs text-text-muted shrink-0">
                                Bcc
                            </label>
                            <input
                                id={`compose-bcc-${id}`}
                                type="text"
                                className={FIELD_INPUT}
                                value={bcc}
                                onChange={(e) => setBcc(e.target.value)}
                                onBlur={() => checkRecipientDiscovery(parseAddresses(bcc))}
                            />
                        </div>
                    </>
                )}

                {(() => {
                    const knownRecipients = [...parseAddresses(to), ...parseAddresses(cc), ...parseAddresses(bcc)]
                        .map((r) => recipientStatuses[r.address])
                        .filter((status): status is RecipientEncryptionStatus => !!status);
                    if (knownRecipients.length === 0) {
                        return null;
                    }
                    return (
                        <ul className="flex flex-wrap gap-1.5 px-3 pt-1.5" aria-label="Recipient encryption availability">
                            {knownRecipients.map((status) => (
                                <li
                                    key={status.address}
                                    className={`text-xs font-medium py-0.5 px-2 rounded-pill ${
                                        status.canEncrypt ? "bg-primary/10 text-primary-dark" : "bg-surface-alt text-text-muted"
                                    }`}
                                >
                                    {status.address} {status.canEncrypt ? "supports encryption" : "no encryption key found"}
                                </li>
                            ))}
                        </ul>
                    );
                })()}

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

                {needsUnlockForCrypto && (
                    <div className="px-3 pb-1">
                        <button
                            type="button"
                            onClick={handleUnlockForCrypto}
                            className="inline-flex items-center gap-1 text-xs font-medium text-primary-dark hover:underline"
                        >
                            <HiOutlineLockClosed size={12} aria-hidden="true" />
                            Unlock to sign or encrypt this message
                        </button>
                    </div>
                )}

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
                            onClick={() => void submit(false)}
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

                    <span role="status" aria-live="polite" className="ml-auto text-xs text-text-muted">
                        {SAVE_STATUS_LABEL[saveStatus]}
                    </span>

                    <button
                        type="button"
                        aria-label="Discard draft"
                        title="Discard draft"
                        onClick={handleDiscard}
                        className="w-8 h-8 flex items-center justify-center rounded-full text-text-muted hover:bg-surface-alt hover:text-text"
                    >
                        <HiOutlineTrash size={18} />
                    </button>
                </div>
            </div>
        </div>
        {discardModal}
        </>
    );
}
