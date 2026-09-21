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
    getMessage,
    listFolders,
    listMailboxes,
    sendMessage,
    setMessageRequestReceipt,
    uploadAttachment,
} from "@rapidmx/react-shared/mail/mailApi.js";
import { listMailSignatures } from "@rapidmx/react-shared/mail/mailSignaturesApi.js";
import { describeSendFailure } from "@rapidmx/react-shared/mail/sendFailure.js";
import { buildComposeBodyHtml } from "@rapidmx/react-shared/mail/compose/composeQuoting.js";
import { peekMailboxWritability, useMailboxWritability } from "../writableMailboxes.js";
import { decideMessageEncryption, resolveRecipientEncryption, RecipientEncryptionStatus } from "@rapidmx/react-shared/crypto/composeSecurity.js";
import { getUnlockedKeys, subscribeKeySession } from "@rapidmx/react-shared/crypto/keySession.js";
import { EncryptionPolicy, findActivePublicKey, getEncryptionPolicy, lookupKeys } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { useUnlockPrompt } from "../../layout/UnlockPromptProvider.js";
import { fromBase64 } from "@rapidmx/react-shared/crypto/encoding.js";
import type { ProtectedHeaders } from "@rapidmx/react-shared/crypto/smimeMessage.js";
import useIsMobile from "@rapidmx/react-shared/util/useIsMobile.js";
import { useCompose, type ComposeSession } from "./ComposeContext.js";
import { ariaKeyShortcuts, withHint } from "../../../keyboard/format.js";
import { SHORTCUTS, ShortcutDef } from "../../../keyboard/keymap.js";
import { useKeyEnvironment } from "../../../keyboard/ShortcutProvider.js";
import { useShortcut } from "../../../keyboard/useShortcut.js";
import { isSigningOut, registerComposeFlush } from "./composeFlushRegistry.js";
import { markComposePhase } from "./composePerf.js";
import RecipientInput from "./RecipientInput.js";
import { parseRecipientList } from "./recipients.js";
import RichTextEditor from "./RichTextEditor.js";
import ScheduleSendPicker from "./ScheduleSendPicker.js";
import SendFailureAlert from "./SendFailureAlert.js";
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
    /** Backoff (ms) between automatic retries of a failed mailbox/encryption-policy load, one entry per retry.
     * Defaults to `DEFAULT_CRYPTO_RETRY_DELAYS_MS`; only overridden by tests. */
    cryptoRetryDelaysMs?: number[];
}

/** Debounce between the last edit and the draft autosave. */
export const DEFAULT_AUTOSAVE_DELAY_MS = 2000;

/** Automatic retries of a failed mailbox/encryption-policy load; after the last one only "Retry" tries again. */
export const DEFAULT_CRYPTO_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

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
const LOOKUP_UNAVAILABLE_MESSAGE =
    "Your recipients' encryption keys couldn't be checked, so this message might go out unencrypted when it should be encrypted. Try again, or send it without encryption.";
/** Thrown by `deleteDraft()` when the server copy is no longer this window's draft (sent or scheduled elsewhere). */
const NO_LONGER_A_DRAFT_MESSAGE = "This message was already sent or scheduled from another window, so it wasn't deleted.";

/** The server refuses signed/encrypted mail whose From display name differs from its own safe form, which drops a
 * name containing `@` (or a look-alike) or a line break. */
const UNSAFE_DISPLAY_NAME_PATTERN = /[@＠﹫\r\n]/;

/** Whether `fresh` (a re-read of a draft) is still an unsent draft in `folderUid`: never delete a message another
 * window has since sent, scheduled, or started sending. */
function isStillDraft(fresh: Message, folderUid: string): boolean {
    return fresh.folderUid === folderUid && !fresh.scheduledSendTime && !fresh.scheduledSendLeaseExpiresAt && !fresh.scheduledSendRelayedAt;
}

/** Any tier of `policy` auto-encrypts - only then can a message with recipients still to be added turn out encrypted
 * without the user asking. */
function policyCanAutoEncrypt(policy: EncryptionPolicy): boolean {
    return [policy.encryptSameOrg, policy.encryptFederated, policy.encryptExternal].includes("automatic");
}

const SAVE_STATUS_LABEL = { idle: "", saving: "Saving…", saved: "Draft saved", error: "Couldn't save draft" } as const;

const DISCARD_TITLE = "Discard this draft?";
const ENCRYPTED_CLOSE_MESSAGE = "Encrypted messages aren't saved as drafts, so closing this window discards what you've written.";
const CHECKING_CLOSE_MESSAGE =
    "This message may be encrypted, and that's still being checked, so it can't be saved as a draft yet. Keep editing and close again in a moment, or discard it.";
const CRYPTO_UNAVAILABLE_MESSAGE =
    "Your encryption settings couldn't be checked, so this draft isn't being saved - it might be a message that must be encrypted.";
const NO_RECIPIENTS_CLOSE_MESSAGE =
    "This message may be encrypted once its recipients are known, so it isn't saved as a draft until you add them. Add a recipient and close again, or discard it.";

const SEND_FAILED_TITLE = "This message wasn't sent";
function sendFailedCloseMessage(reason: string): string {
    return `Sending it failed (${reason.replace(/\.$/, "")}). Closing keeps it as a draft, unsent. Keep editing to try again, or discard it.`;
}

/** The confirmation shown before a Close/Discard throws content away (or when a Close couldn't save it). */
interface ClosePrompt {
    title: string;
    message: string;
    /** Also offer "Retry" for loading the encryption settings. */
    retry?: boolean;
    /** Also offer "Close, keep draft": a failed send's close prompt, where closing keeps the unsent draft as it is. */
    closeAnyway?: boolean;
}

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

/** A To/Cc/Bcc field's recipients - see `recipients.ts` for the format. */
function parseAddresses(value: string): ComposeRecipientInput[] {
    return parseRecipientList(value);
}

function HeaderButton({
    label,
    onClick,
    icon: Icon,
    disabled,
    shortcut,
}: {
    label: string;
    onClick: () => void;
    icon: React.ComponentType<{ size?: number }>;
    disabled?: boolean;
    /** The keyboard shortcut that does the same, named in the tooltip and `aria-keyshortcuts`. */
    shortcut?: ShortcutDef;
}) {
    const env = useKeyEnvironment();
    return (
        <button
            type="button"
            aria-label={label}
            title={shortcut ? withHint(label, shortcut, env) : label}
            aria-keyshortcuts={shortcut ? ariaKeyShortcuts(shortcut, env) : undefined}
            onClick={onClick}
            disabled={disabled}
            className="w-6 h-6 flex items-center justify-center rounded-sm text-white/80 hover:bg-white/15 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
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
    cryptoRetryDelaysMs = DEFAULT_CRYPTO_RETRY_DELAYS_MS,
}: ComposeWindowProps) {
    const { id, initialTo, initialCc, initialSubject, initialQuotedHtml, initialEncrypt, signatureContext, suppressSigning, minimized, quotePending, late } = session;
    // What a reply worked out after this window opened (see `OpenComposeInput.pending`): better recipients, applied below
    // only to fields still exactly as they opened - so these, not `initialTo`/`initialCc`, are what "untouched" is measured against.
    const baselineTo = late?.to ?? initialTo;
    const baselineCc = late?.cc ?? initialCc;
    useEffect(() => {
        markComposePhase(id, "shell");
        markComposePhase(id, "chunk");
    }, []);
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
    const { openCompose } = useCompose();
    const keyEnv = useKeyEnvironment();
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
    // The technical facts behind `sendError` (per-recipient SMTP results, a transport error), when the server gave any.
    const [sendDetails, setSendDetails] = useState<string[]>([]);
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
    // A reply to or forward of an encrypted message starts (and, after a From switch, restarts) with encryption
    // requested - see `OpenComposeInput.encrypt`.
    const [encryptRequested, setEncryptRequested] = useState(!!initialEncrypt);
    const [encryptionBlocked, setEncryptionBlocked] = useState<RecipientEncryptionStatus[] | null>(null);
    // Compose-time discovery (spec: "Discovery occurs ... when the user addresses a new message to a
    // recipient", never on receipt) - keyed by address so a recipient already looked up isn't re-fetched
    // just because the user re-focuses the field. Only ever grows via `checkRecipientDiscovery()` below;
    // never cleared, so switching focus between To/Cc/Bcc repeatedly doesn't re-trigger lookups.
    const [recipientStatuses, setRecipientStatuses] = useState<Record<string, RecipientEncryptionStatus>>({});
    // Addresses whose lookup is on the wire (so the blur handlers and the prefilled-recipient effect don't
    // look one up twice), and a counter bumped by a From switch so a lookup for the previous sender is dropped.
    const lookupsInFlightRef = useRef(new Set<string>());
    const discoveryGenerationRef = useRef(0);
    // A failed lookup stores no status (it would read as "no key" and let a message that must be encrypted autosave
    // or send as plaintext): it's retried with the same backoff as the mailbox/policy load, and once those retries
    // run out the address is "exhausted" - shown as a check that couldn't be done, with Retry.
    const lookupFailuresRef = useRef(new Map<string, number>());
    const lookupRetryTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
    const [lookupRetryToken, setLookupRetryToken] = useState(0);
    const [exhaustedLookups, setExhaustedLookups] = useState<Record<string, true>>({});
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
    const [closePrompt, setClosePrompt] = useState<ClosePrompt | null>(null);
    /** A Close (saving) or Discard (deleting) is on the wire - the window closes once it succeeds. */
    const [closing, setClosing] = useState(false);
    const [discardError, setDiscardError] = useState<string | null>(null);
    /** Why the last save failed, cleared by the next successful one. */
    const saveErrorRef = useRef<string | null>(null);
    /** `<draftUid>:<content key>` of the last successful save. */
    const lastSavedRef = useRef<string | null>(null);
    /** An edit is waiting on the autosave debounce - flushed if the window unmounts first. */
    const pendingSaveRef = useRef(false);
    /** Mirrors `sending` for the page-leave/sign-out flushes, which run outside React's render cycle. */
    const sendingRef = useRef(false);
    /** The latest save request, if any - each save is chained after the one before it. Always settles (never
     * rejects), to the saved message, or `undefined` when that save failed. */
    const saveInFlightRef = useRef<Promise<Message | undefined>>(Promise.resolve(undefined));
    /** Set once the window has been sent/closed/discarded - nothing more gets autosaved after that. */
    const finishedRef = useRef(false);

    // A mailbox with no keys enrolled yet just means sign/encrypt stay unavailable for this compose session -
    // encryption is optional and gradual by design (see `KeyEnrollmentGate`'s own doc comment).
    // `cryptoContextReady` (below) gates Send/Send-later until both calls have settled either way, so a
    // send that happens to race this fetch can't silently skip encryption the spec says should apply.
    // A failed load is retried with backoff (`cryptoRetryDelaysMs`), then on demand ("Retry"): until both have
    // loaded, whether this message must be encrypted is unknown, so it isn't autosaved (see `autosaveSuppressed`).
    const [cryptoContextReady, setCryptoContextReady] = useState(false);
    const [cryptoLoadFailed, setCryptoLoadFailed] = useState(false);
    const [cryptoRetryToken, setCryptoRetryToken] = useState(0);

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
        let timer: ReturnType<typeof setTimeout> | undefined;
        // A retry only fetches what's still missing.
        let mailboxLoaded = mailbox?.uid === mailboxUid;
        let policyLoaded = !!encryptionPolicy;
        let retries = 0;
        setCryptoContextReady(false);
        setCryptoLoadFailed(false);
        async function load() {
            await Promise.all([
                mailboxLoaded ||
                    getMailbox(mailboxUid!).then(
                        (result) => {
                            mailboxLoaded = true;
                            if (!cancelled) {
                                setMailbox(result);
                            }
                        },
                        () => undefined,
                    ),
                policyLoaded ||
                    getEncryptionPolicy().then(
                        (result) => {
                            policyLoaded = true;
                            if (!cancelled) {
                                setEncryptionPolicy(result);
                            }
                        },
                        () => undefined,
                    ),
            ]);
            if (cancelled) {
                return;
            }
            const failed = !mailboxLoaded || !policyLoaded;
            setCryptoContextReady(true);
            setCryptoLoadFailed(failed);
            if (failed && retries < cryptoRetryDelaysMs.length) {
                timer = setTimeout(() => void load(), cryptoRetryDelaysMs[retries++]);
            }
        }
        void load();
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [mailboxUid, cryptoRetryToken]);

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
     * A mailbox/policy fetch that hasn't resolved yet just leaves that address with no indicator - the effect
     * below runs it again for every current recipient once both have loaded. A failed lookup leaves it without
     * a status too, and is retried after `cryptoRetryDelaysMs` (then only on blur, Close or Retry).
     *
     * The statuses also drive autosave: a recipient without one yet (lookup pending, failed or never run) or a
     * decision that would auto-encrypt keeps the plaintext draft save off (see `autosaveSuppressed`).
     */
    function checkRecipientDiscovery(addresses: ComposeRecipientInput[]) {
        if (!mailbox || !encryptionPolicy) {
            return;
        }
        const ownPrefersMutual = mailbox.encryptPreference?.preferEncrypt === "mutual";
        const generation = discoveryGenerationRef.current;
        const inFlight = lookupsInFlightRef.current;
        const unchecked = addresses.filter((r) => !(r.address in recipientStatuses) && !inFlight.has(r.address));
        for (const recipient of unchecked) {
            inFlight.add(recipient.address);
            void lookupKeys(mailbox.uid, recipient.address)
                .then(
                    (lookup) => ({ lookup }),
                    () => null,
                )
                .then((result) => {
                    inFlight.delete(recipient.address);
                    if (generation !== discoveryGenerationRef.current) {
                        return;
                    }
                    if (!result) {
                        noteLookupFailed(recipient.address);
                        return;
                    }
                    lookupFailuresRef.current.delete(recipient.address);
                    const status = resolveRecipientEncryption(mailbox.primarySmtpAddress, ownPrefersMutual, encryptionPolicy, recipient.address, result.lookup);
                    setRecipientStatuses((prev) => ({ ...prev, [recipient.address]: status }));
                });
        }
    }

    /** Schedules the next automatic retry of a failed lookup, or marks the address exhausted once they've run out. */
    function noteLookupFailed(address: string) {
        const failures = (lookupFailuresRef.current.get(address) ?? 0) + 1;
        lookupFailuresRef.current.set(address, failures);
        if (failures > cryptoRetryDelaysMs.length) {
            setExhaustedLookups((prev) => ({ ...prev, [address]: true }));
            return;
        }
        const timer = setTimeout(() => {
            lookupRetryTimersRef.current.delete(timer);
            setLookupRetryToken((n) => n + 1);
        }, cryptoRetryDelaysMs[failures - 1]);
        lookupRetryTimersRef.current.add(timer);
    }

    useEffect(
        () => () => {
            for (const timer of lookupRetryTimersRef.current) {
                clearTimeout(timer);
            }
        },
        [],
    );

    // Prefilled recipients (a reply's To/Cc) are never blurred, and a blur before the mailbox/policy loaded
    // was ignored - look every current recipient up as soon as both are available (and again on a lookup retry).
    useEffect(() => {
        checkRecipientDiscovery([...parseAddresses(to), ...parseAddresses(cc), ...parseAddresses(bcc)]);
    }, [mailbox, encryptionPolicy, lookupRetryToken]);

    // Resolves the mailbox's default signature (if any) for `signatureContext` and seeds `html` with it
    // plus any quoted original message (laid out by `buildComposeBodyHtml()`: an empty first paragraph for the
    // caret, then the signature, then the quote), before `RichTextEditor` ever mounts (gated by `contentReady`
    // below) — `RichTextEditor`'s own doc comment is explicit that `value` only seeds its *initial*
    // content and never re-syncs from a later prop change, so this has to resolve before that first
    // mount, not after. A signature-list failure is best-effort, same as every other supplementary,
    // non-blocking fetch in this codebase (e.g. `ConversationList`'s own child-message fetch) — no
    // signature is a completely legitimate outcome, so this falls back to just the quoted content
    // (if any) rather than surfacing an error over what's a cosmetic nicety.
    //
    // A reply or forward opens before its quoted original has been fetched (`quotePending`, see
    // `OpenComposeInput.pending`). The body is seeded as soon as the signature is here, without the quote, so the editor is usable
    // at once however slow the original is to come; the quote is added at the end of the editor's document when it arrives
    // (`appendHtml` below) - the same place, under the signature, that a body seeded with it would have had it.
    const [defaultSignature, setDefaultSignature] = useState<{ html?: string } | undefined>();
    useEffect(() => {
        // Fetched once, for whichever mailbox is the sender when compose opens - switching From later must not
        // overwrite what the user has already written (the editor itself never re-syncs).
        if (!mailboxUid || contentReady || defaultSignature) {
            return;
        }
        listMailSignatures(mailboxUid)
            .then((signatures) => {
                const signature = signatures.find((s) =>
                    signatureContext === "new" ? s.isDefaultForNewMessages : s.isDefaultForReplyForward,
                );
                setDefaultSignature({ html: signature?.contentHtml });
            })
            .catch(() => setDefaultSignature({}));
    }, [mailboxUid, signatureContext]);
    const [seededWithoutQuote, setSeededWithoutQuote] = useState(false);
    useEffect(() => {
        if (contentReady || !defaultSignature) {
            return;
        }
        const seeded = buildComposeBodyHtml(defaultSignature.html, quotePending ? undefined : initialQuotedHtml);
        setHtml(seeded);
        setSeededHtml(seeded);
        setSeededWithoutQuote(!!quotePending);
        setContentReady(true);
        markComposePhase(id, "body");
    }, [defaultSignature, quotePending, initialQuotedHtml]);
    /** What the editor adds to the end of its document once the quote a reply was opened without has arrived. */
    const lateQuoteHtml =
        seededWithoutQuote && !quotePending && initialQuotedHtml && defaultSignature
            ? buildComposeBodyHtml(defaultSignature.html, initialQuotedHtml).slice(buildComposeBodyHtml(defaultSignature.html) === "" ? "<p></p>".length : buildComposeBodyHtml(defaultSignature.html).length)
            : undefined;

    useEffect(() => {
        if (!mailboxUid || !draftsFolderUid || draft) {
            return;
        }
        let cancelled = false;
        // `session.threading` is what makes a reply a reply: the server writes it into the relayed MIME's
        // `In-Reply-To`/`References` and groups the message into the thread being answered. Recorded on
        // every draft this window creates, including the replacement one a From switch makes - the thread
        // doesn't change because the sending mailbox did.
        createDraft(mailboxUid, draftsFolderUid, session.threading)
            .then((created) => {
                if (cancelled) {
                    // The sender changed while this was in flight - discard the now-orphaned draft.
                    void deleteMessage(created.uid, created.version).catch(() => undefined);
                    return;
                }
                setDraft(created);
                markComposePhase(id, "draft");
                // Only now that the replacement exists is it safe to discard the draft(s) a From switch
                // superseded - if creating this one had failed, the earlier draft is still there.
                for (const superseded of supersededDraftsRef.current.splice(0)) {
                    void deleteSupersededDraft(superseded);
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
    }, [mailboxUid, draftsFolderUid, draft, session.threading]);

    // Drafts a From switch superseded are otherwise only deleted once their replacement exists - closing the
    // window (or sending, which closes it) first would orphan them.
    useEffect(
        () => () => {
            for (const superseded of supersededDraftsRef.current.splice(0)) {
                void deleteSupersededDraft(superseded);
            }
        },
        [],
    );

    /**
     * Deletes a draft a From switch replaced. An autosave of it may still be on the wire - it bumps the
     * draft's version (see `saveDraftNow()`, which keeps `superseded.version` current while it's queued), so
     * the delete waits for it and uses its version; a delete that still fails (e.g. another save of it landed
     * meanwhile) is retried once with the version the server currently holds - unless it's no longer a draft
     * (another window sent or scheduled it), which is left alone.
     * Best-effort, never rejects.
     */
    async function deleteSupersededDraft(superseded: Message): Promise<void> {
        const saved = await saveInFlightRef.current;
        // Once it's out of `supersededDraftsRef` a landing save can't update `superseded.version` any more.
        const version = saved?.uid === superseded.uid ? saved.version : superseded.version;
        try {
            await deleteMessage(superseded.uid, version);
        } catch {
            try {
                const fresh = await getMessage(superseded.uid);
                if (isStillDraft(fresh, superseded.folderUid)) {
                    await deleteMessage(fresh.uid, fresh.version);
                }
            } catch {
                // Already gone, or the server is unreachable - nothing more to do from here.
            }
        }
    }

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
        discoveryGenerationRef.current += 1;
        lookupsInFlightRef.current = new Set();
        lookupFailuresRef.current = new Map();
        setExhaustedLookups({});
        setEncryptRequested(!!initialEncrypt);
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
            void refreshDraftVersion(draft.uid);
            return attachmentContentUrl(attachment.uid);
        } catch (err) {
            setAttachError(err instanceof ApiRequestError ? err.message : "Could not upload image.");
            return null;
        }
    }

    /** Uploading an attachment bumps the draft's version server-side (it records `hasAttachments`), so a later
     * Discard would otherwise send a stale `?version=`. Best-effort: Discard also retries with the server's
     * current version. */
    async function refreshDraftVersion(uid: string) {
        try {
            const fresh = await getMessage(uid);
            setDraft((prev) => (prev?.uid === fresh.uid && fresh.version > prev.version ? { ...prev, version: fresh.version } : prev));
        } catch {
            // Discard's own retry covers a version this couldn't refresh.
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
                void refreshDraftVersion(draft!.uid);
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
        // Keys are read at the moment they're needed, and again after any await: they can lock (idle
        // timeout, sign-out elsewhere) mid-send, and a destroyed `UnlockedKeys` object must count as locked.
        // Only reachable once a draft exists, which itself requires `mailboxUid` to have resolved.
        function readKeys() {
            const stored = getUnlockedKeys(mailboxUid!);
            const unlocked = stored?.destroyed ? undefined : stored;
            return {
                unlocked,
                // `mailbox` is required to build protected headers (own From address) whenever signing or
                // encrypting - not just guarded on the encryption branch below, since a signed-only message
                // needs it too.
                canSign: signEnabled && !!mailbox && !!unlocked?.signingPrivateKey && !!unlocked.signingCertDer,
                canEncryptSelf: !!unlocked?.encryptionPrivateKey && !!unlocked.encryptionCertDer,
            };
        }
        let keys = readKeys();
        const allRecipients = [...toRecipients, ...ccRecipients, ...bccRecipients];

        // The Sign toggle was shown (and is still checked), but signing can't actually happen any more.
        const signingLost = () => !forcePlaintext && signEnabled && offeredCryptoRef.current.sign && !keys.canSign;
        if (signingLost()) {
            return blockSend(KEYS_LOCKED_SIGN_MESSAGE, "Send without signing or encryption", !keys.unlocked);
        }

        if (!forcePlaintext && !mailbox) {
            // The mailbox's enrolled keys are what say whether this message could be encrypted at all - with keys
            // that aren't unlocked in this session, a failed mailbox load would otherwise skip encryption silently.
            return blockSend(POLICY_UNAVAILABLE_MESSAGE, "Send without encryption", false);
        }

        let wantEncrypt = false;
        let recipientCertDers: Uint8Array[] = [];
        // Entered whenever this message could be encrypted at all - including a mailbox with an enrolled
        // encryption key that this session never unlocked: policy may still auto-encrypt, and that must block
        // (and prompt to unlock) rather than quietly send plaintext.
        if (!forcePlaintext && (keys.canEncryptSelf || offeredCryptoRef.current.encrypt || hasEnrolledEncryptionKey)) {
            if (!encryptionPolicy) {
                // Without it, there's no telling whether policy auto-encrypts this message.
                return blockSend(POLICY_UNAVAILABLE_MESSAGE, "Send without encryption", false);
            }
            // Reachable only with `mailbox` loaded (checked above).
            const ownPrefersMutual = mailbox!.encryptPreference?.preferEncrypt === "mutual";
            const lookups = await Promise.all(
                allRecipients.map((r) =>
                    lookupKeys(mailboxUid!, r.address).then(
                        (lookup) => ({ lookup }),
                        () => null,
                    ),
                ),
            );
            keys = readKeys();
            if (signingLost()) {
                return blockSend(KEYS_LOCKED_SIGN_MESSAGE, "Send without signing or encryption", !keys.unlocked);
            }
            // A failed lookup isn't "no key": treating it as one could send plaintext that policy would encrypt.
            if (lookups.some((result) => !result) && (encryptRequested || policyCanAutoEncrypt(encryptionPolicy))) {
                return blockSend(LOOKUP_UNAVAILABLE_MESSAGE, "Send without encryption", false);
            }
            const statuses = allRecipients.map((r, i) =>
                resolveRecipientEncryption(mailbox!.primarySmtpAddress, ownPrefersMutual, encryptionPolicy, r.address, lookups[i]?.lookup),
            );
            const decision = decideMessageEncryption(statuses);
            wantEncrypt = encryptRequested || decision.autoEncrypt;
            if (wantEncrypt) {
                if (!keys.canEncryptSelf) {
                    return blockSend(KEYS_LOCKED_ENCRYPT_MESSAGE, "Send without encryption", !keys.unlocked);
                }
                if (!decision.canEncryptAll) {
                    setEncryptionBlocked(decision.blockedRecipients);
                    return "blocked";
                }
                if (bccRecipients.length > 0) {
                    return blockSend(BCC_ENCRYPTED_MESSAGE, "Send without encryption", false);
                }
                recipientCertDers = [keys.unlocked!.encryptionCertDer!, ...statuses.map((s) => fromBase64(s.encryptCert!.publicKey))];
            }
        }

        const { canSign } = keys;
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
        const displayName = mailbox!.displayName && !UNSAFE_DISPLAY_NAME_PATTERN.test(mailbox!.displayName) ? mailbox!.displayName : "";
        const protectedHeaders: ProtectedHeaders = {
            from: displayName
                ? `"${displayName.replace(/"/g, '\\"')}" <${mailbox!.primarySmtpAddress}>`
                : mailbox!.primarySmtpAddress,
            to: toRecipients.map((r) => r.address).join(", "),
            cc: ccRecipients.length > 0 ? ccRecipients.map((r) => r.address).join(", ") : undefined,
            date: new Date().toUTCString(),
            subject,
            messageId: `<${crypto.randomUUID()}@${domain}>`,
        };
        const bodyContentType = 'text/html; charset="utf-8"';
        const signing = canSign ? { certDer: keys.unlocked!.signingCertDer!, privateKey: keys.unlocked!.signingPrivateKey! } : undefined;

        // The S/MIME code (PKI.js and the ASN.1/X.509 libraries, over half a megabyte) is only needed here, to sign or
        // encrypt - a plain message never loads it, and it is kept out of the compose window's own chunk.
        const { applyBaselineOuterHeaders, assembleOutboundMime, buildEncryptedMessage, buildSignedOnlyMessage } = await import(
            "@rapidmx/react-shared/crypto/smimeMessage.js"
        );
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
        sendingRef.current = true;
        setSendError(null);
        setSendDetails([]);
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
            await sendMessage(withReceipt.uid, scheduledSendTimeIso ? { scheduledSendTime: scheduledSendTimeIso } : undefined);
            finishedRef.current = true;
            onClose();
        } catch (err) {
            // The window stays open with the draft exactly as it was; nothing here closes, discards or saves over it.
            const failure = describeSendFailure(
                err,
                scheduledSendTimeIso ? "Could not schedule this message." : "Could not send this message.",
            );
            setSendError(failure.message);
            setSendDetails(failure.lines);
        } finally {
            sendingRef.current = false;
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
     * same plaintext assembly a normal send uses). Chained after any save already on the wire - two
     * overlapping assemblies of the same draft race on its version and the later one is rejected - and reads
     * `latestRef` only once it actually runs, so it saves what was last typed (skipping the request when the
     * save before it already stored exactly that). Whether a save may happen at all is re-checked at that same
     * moment: while it waited, the message may have become one that must not be stored as plaintext (Encrypt
     * turned on, a recipient that auto-encrypts), or the window may have started sending or finished - then it
     * resolves `{ skipped: true }` without a request (`message` then being the previous save's result). Never
     * rejects; `message` is `undefined` when the save failed.
     */
    function saveDraftNow(): Promise<{ message?: Message; skipped?: boolean }> {
        const target = latestRef.current.draft!;
        const previous = saveInFlightRef.current;
        pendingSaveRef.current = false;
        setSaveStatus("saving");
        const outcome = (async (): Promise<{ message?: Message; skipped?: boolean }> => {
            const before = await previous;
            const current = latestRef.current;
            if (current.autosaveSuppressed || sendingRef.current || finishedRef.current) {
                setSaveStatus("idle");
                // Still the newest copy the server holds, for the version a later delete needs.
                return { skipped: true, message: before };
            }
            const savedKey = `${target.uid}:${current.contentKey}`;
            if (before?.uid === target.uid && lastSavedRef.current === savedKey) {
                setSaveStatus("saved");
                return { message: before };
            }
            try {
                const saved = await assembleDraft(target.uid, {
                    to: parseAddresses(current.to),
                    cc: parseAddresses(current.cc),
                    bcc: parseAddresses(current.bcc),
                    subject: current.subject,
                    html: current.html,
                });
                lastSavedRef.current = savedKey;
                saveErrorRef.current = null;
                // A From switch may have replaced the draft while this was in flight - never resurrect it,
                // but do keep its superseded copy's version current so its pending delete still matches.
                setDraft((prev) => (prev?.uid === saved.uid ? saved : prev));
                const superseded = supersededDraftsRef.current.find((d) => d.uid === saved.uid);
                if (superseded) {
                    superseded.version = saved.version;
                }
                setSaveStatus("saved");
                return { message: saved };
            } catch (err) {
                saveErrorRef.current = err instanceof ApiRequestError ? err.message : "the server couldn't be reached";
                setSaveStatus("error");
                return {};
            }
        })();
        saveInFlightRef.current = outcome.then((result) => result.message);
        return outcome;
    }

    /** Keeps the window open after its content couldn't be saved, offering Discard or Keep editing. */
    function showSaveFailedPrompt() {
        setClosePrompt({
            title: "Couldn't save this draft",
            message: `It couldn't be saved (${saveErrorRef.current!.replace(/\.$/, "")}). Keep editing and try again, or discard it.`,
        });
    }

    /**
     * Deletes `current` (this window's server draft) once any save already on the wire has landed, so the delete
     * carries the draft's current version. A delete rejected for a stale version (404/409: e.g. an attachment
     * upload bumped it) is retried once with the version the server holds - and a draft the server no longer has
     * counts as deleted. The retry only happens while the server copy is still an unsent draft in the same folder.
     * Rejects when the draft couldn't be deleted.
     */
    async function deleteDraft(current: Message): Promise<void> {
        const saved = await saveInFlightRef.current;
        const version = Math.max(current.version, saved?.uid === current.uid ? saved.version : 0);
        try {
            await deleteMessage(current.uid, version);
        } catch (err) {
            if (!(err instanceof ApiRequestError) || (err.status !== 404 && err.status !== 409)) {
                throw err;
            }
            const fresh = await getMessage(current.uid).catch((getErr: unknown) => {
                if (getErr instanceof ApiRequestError && getErr.status === 404) {
                    return null;
                }
                throw getErr;
            });
            if (!fresh) {
                return;
            }
            // The version changed because another window sent or scheduled it - that message isn't ours to delete.
            if (!isStillDraft(fresh, current.folderUid)) {
                throw new ApiRequestError(NO_LONGER_A_DRAFT_MESSAGE, 409);
            }
            await deleteMessage(fresh.uid, fresh.version);
        }
    }

    /**
     * Discards the window's draft and closes it. With nothing the user would lose (a blank draft) it closes
     * straight away and deletes the draft in the background; otherwise it closes only once the draft is
     * deleted, and a delete that fails keeps the window open with the error.
     */
    async function discardNow() {
        finishedRef.current = true;
        pendingSaveRef.current = false;
        setClosePrompt(null);
        setDiscardError(null);
        const current = draft;
        if (!current || !hasUserContent) {
            if (current) {
                void deleteDraft(current).catch(() => undefined);
            }
            onClose();
            return;
        }
        setClosing(true);
        try {
            await deleteDraft(current);
        } catch (err) {
            finishedRef.current = false;
            setClosing(false);
            setDiscardError(`Couldn't discard this draft: ${err instanceof ApiRequestError ? err.message : "the server couldn't be reached."}`);
            return;
        }
        onClose();
    }

    /** "Discard draft": confirms first whenever there's anything the user would lose. */
    function handleDiscard() {
        if (hasUserContent) {
            setClosePrompt({ title: DISCARD_TITLE, message: "This permanently deletes this draft and everything you've written in it." });
        } else {
            void discardNow();
        }
    }

    /** "Close": keeps the draft (saving any unsaved edits first, and closing only once that save succeeded) -
     * unless there's nothing in it worth keeping, or it can't be saved because it's headed for encryption, or
     * whether it is can't be told yet (settings loading or unavailable, recipient lookups pending): those need
     * the same confirmation as a discard. A failed save keeps the window open with Discard / Keep editing.
     * Close and Discard are both disabled while a send is in progress: deleting the draft, or saving a
     * plaintext copy over the message the send just assembled, mid-send would lose or leak it. */
    async function handleClose(sendFailureAcknowledged = false) {
        if (!hasUserContent) {
            void discardNow();
            return;
        }
        if (sendError && !sendFailureAcknowledged) {
            // Closing would keep the draft and say nothing, which reads as if it had been sent.
            setClosePrompt({ title: SEND_FAILED_TITLE, message: sendFailedCloseMessage(sendError), closeAnyway: true });
            return;
        }
        if (encryptionDecided) {
            setClosePrompt({ title: DISCARD_TITLE, message: ENCRYPTED_CLOSE_MESSAGE });
            return;
        }
        if (cryptoCheckUnavailable) {
            setClosePrompt({ title: DISCARD_TITLE, message: CRYPTO_UNAVAILABLE_MESSAGE, retry: true });
            return;
        }
        if (awaitingRecipients) {
            setClosePrompt({ title: DISCARD_TITLE, message: NO_RECIPIENTS_CLOSE_MESSAGE });
            return;
        }
        if (encryptionUndetermined) {
            // A recipient typed but never blurred has no lookup running yet.
            checkRecipientDiscovery([...parseAddresses(to), ...parseAddresses(cc), ...parseAddresses(bcc)]);
            setClosePrompt({ title: DISCARD_TITLE, message: CHECKING_CLOSE_MESSAGE });
            return;
        }
        if (!draft || !contentReady) {
            saveErrorRef.current = draftError ?? "the draft hasn't been created yet";
            showSaveFailedPrompt();
            return;
        }
        if (lastSavedRef.current !== `${draft.uid}:${contentKey}`) {
            setClosing(true);
            const outcome = await saveDraftNow();
            setClosing(false);
            if (outcome.skipped) {
                // It became a message that mustn't be saved as plaintext while waiting on an earlier save.
                setClosePrompt({ title: DISCARD_TITLE, message: latestRef.current.encryptionDecided ? ENCRYPTED_CLOSE_MESSAGE : CHECKING_CLOSE_MESSAGE });
                return;
            }
            if (!outcome.message) {
                showSaveFailedPrompt();
                return;
            }
        }
        finishedRef.current = true;
        onClose();
    }

    function retryCryptoContext() {
        setClosePrompt(null);
        setCryptoRetryToken((n) => n + 1);
        lookupFailuresRef.current = new Map();
        setExhaustedLookups({});
        setLookupRetryToken((n) => n + 1);
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
    const baselineKey = JSON.stringify([baselineTo ?? "", baselineCc ?? "", "", initialSubject ?? "", seededHtml ?? ""]);
    const hasUserContent = contentKey !== baselineKey || hasUploads;
    // A message headed for encryption is never autosaved: the draft would store its plaintext server-side,
    // defeating end-to-end encryption. Until it's known not to be, it isn't either: while the mailbox (whose
    // enrolled keys say whether encryption is possible at all) or the encryption policy hasn't loaded, and -
    // whenever this message could be encrypted (an unlocked or enrolled encryption key) - while the policy is
    // missing or any current recipient's lookup is still pending (or failed, or hasn't run) - and while there are no
    // recipients at all when policy auto-encrypts some tier, since the first one added may turn encryption on.
    const currentAddresses = [...parseAddresses(to), ...parseAddresses(cc), ...parseAddresses(bcc)].map((r) => r.address);
    const currentStatuses = currentAddresses.map((address) => recipientStatuses[address]);
    const encryptionPossible = !!unlockedKeys?.encryptionPrivateKey || hasEnrolledEncryptionKey || offeredCryptoRef.current.encrypt;
    /** Could be auto-encrypted, but has no recipients yet to decide by. */
    const awaitingRecipients = encryptionPossible && !!encryptionPolicy && currentAddresses.length === 0 && policyCanAutoEncrypt(encryptionPolicy);
    const encryptionUndetermined =
        !cryptoContextReady || !mailbox || awaitingRecipients || (encryptionPossible && (!encryptionPolicy || currentStatuses.some((s) => !s)));
    /** Known to be headed for encryption: requested, or policy auto-encrypts it. */
    const encryptionDecided = encryptRequested || (!encryptionUndetermined && encryptionPossible && decideMessageEncryption(currentStatuses).autoEncrypt);
    const autosaveSuppressed = encryptionDecided || encryptionUndetermined;
    /** Loading the mailbox/policy failed (retries may still be pending) and this message's encryption hinges on it, or
     * a current recipient's key lookup kept failing. */
    const cryptoCheckUnavailable =
        (cryptoContextReady && cryptoLoadFailed && (!mailbox || (encryptionPossible && !encryptionPolicy))) ||
        (encryptionPossible && currentAddresses.some((address) => exhaustedLookups[address] && !recipientStatuses[address]));
    const latestRef = useRef({ draft, to, cc, bcc, subject, html, seededHtml, contentKey, saveStatus, hasUserContent, autosaveSuppressed, encryptionDecided });
    latestRef.current = { draft, to, cc, bcc, subject, html, seededHtml, contentKey, saveStatus, hasUserContent, autosaveSuppressed, encryptionDecided };

    // Recipients a reply could only work out after this window opened (Reply All: whoever the original's headers name)
    // replace the ones it opened with - but only in a field the user hasn't touched, never over what they typed.
    useEffect(() => {
        if (!late) {
            return;
        }
        const current = latestRef.current;
        if (late.to !== undefined && current.to === (initialTo ?? "")) {
            setTo(late.to);
        }
        if (late.cc !== undefined && current.cc === (initialCc ?? "")) {
            setCc(late.cc);
            setShowCcBcc((shown) => shown || late.cc !== "");
        }
    }, [late]);

    useEffect(() => {
        const due =
            !!draft &&
            contentReady &&
            cryptoContextReady &&
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
    }, [draft, contentReady, cryptoContextReady, sending, autosaveSuppressed, hasUserContent, contentKey]);

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

    /** Saves an edit still waiting on the debounce now, and resolves once that save - or one already on the
     * wire - has settled, to whether the window's content is saved. A save that failed keeps the window open
     * with Discard / Keep editing. A send clears `pendingSaveRef` before it starts, so this never saves mid-send. */
    async function flushPendingSave(): Promise<boolean> {
        if (pendingSaveRef.current && !finishedRef.current) {
            const outcome = await saveDraftNow();
            if (outcome.skipped) {
                // Not saved, but not a failure either: it may be headed for encryption (or was sent/discarded meanwhile).
                return finishedRef.current;
            }
            if (!outcome.message) {
                showSaveFailedPrompt();
            }
            return !!outcome.message;
        }
        await saveInFlightRef.current;
        const latest = latestRef.current;
        if (finishedRef.current || !latest.hasUserContent || (!!latest.draft && lastSavedRef.current === `${latest.draft.uid}:${latest.contentKey}`)) {
            return true;
        }
        // Unsaved because the last save failed (rather than, say, an encrypted message never being saved).
        if (saveErrorRef.current) {
            showSaveFailedPrompt();
        }
        return false;
    }

    // Sign Out (AppShell) waits for this before ending the session.
    useEffect(() => registerComposeFlush(flushPendingSave), []);

    // Leaving the page (reload, closing the tab, following a link) with anything not saved: start a save that's
    // waiting on the debounce straight away and ask the browser to confirm, so the last couple of seconds of
    // typing (or content that can't be saved as a draft, or failed to) aren't lost silently. Never while signing
    // out - that navigation must not be cancellable.
    useEffect(() => {
        function handleBeforeUnload(event: BeforeUnloadEvent) {
            if (finishedRef.current || sendingRef.current || isSigningOut()) {
                return;
            }
            const latest = latestRef.current;
            const unsaved =
                pendingSaveRef.current ||
                latest.saveStatus === "saving" ||
                (latest.hasUserContent && lastSavedRef.current !== `${latest.draft?.uid}:${latest.contentKey}`);
            if (!unsaved) {
                return;
            }
            void flushPendingSave();
            event.preventDefault();
            event.returnValue = "";
        }
        window.addEventListener("beforeunload", handleBeforeUnload);
        return () => window.removeEventListener("beforeunload", handleBeforeUnload);
    }, []);

    // Where the caret starts, once per session: a reply/forward in the body (at its top), a new message in To - or,
    // with To already filled in (e.g. Contacts' "Email"), in Subject. Minimizing unmounts the fields, so restoring a
    // window must not move the caret there again.
    const isReplyOrForward = initialQuotedHtml !== undefined || !!quotePending;
    const fieldsFocusedRef = useRef(false);
    const bodyFocusedRef = useRef(false);
    const focusToOnMount = !isReplyOrForward && !initialTo && !fieldsFocusedRef.current;
    const focusSubjectOnMount = !isReplyOrForward && !!initialTo && !fieldsFocusedRef.current;
    const focusBodyOnMount = isReplyOrForward && !bodyFocusedRef.current;

    // The editor serializes the seeded body its own way (see `RichTextEditor`'s `onInitialized`). While the body is
    // still exactly what compose seeded, that serialization becomes the baseline - so an untouched reply or signature
    // isn't mistaken for an edit (and autosaved) just because the editor was focused or clicked.
    /** The quote has been added: unless the reader has typed something already, that is still exactly what compose seeded. */
    function handleQuoteAppended(normalized: string) {
        const latest = latestRef.current;
        if (latest.html === latest.seededHtml) {
            setHtml(normalized);
            setSeededHtml(normalized);
        }
    }
    function handleEditorInitialized(normalized: string) {
        markComposePhase(id, "editor");
        const latest = latestRef.current;
        if (latest.html === latest.seededHtml && normalized !== latest.html) {
            setHtml(normalized);
            setSeededHtml(normalized);
        }
    }
    useEffect(() => {
        if (!minimized) {
            fieldsFocusedRef.current = true;
            bodyFocusedRef.current ||= contentReady;
        }
    }, [minimized, contentReady]);

    // Keyboard shortcuts, active while the focus is inside this window (`container`; the scope attribute on its root is what tells the
    // dispatcher the focus is in a compose window at all). They do what the Send and Close buttons and autosave do, under the same conditions -
    // a shortcut pressed while its button would be disabled is consumed and does nothing.
    const canSend = !!draft && !sending && !closing && cryptoContextReady;
    useShortcut(SHORTCUTS.compose.send, () => void (canSend && submit(false)), { container: windowRef });
    useShortcut(
        SHORTCUTS.compose.saveDraft,
        () => {
            // Autosave's own conditions: never a draft that must not be stored as plaintext, and nothing while a send is on the wire.
            if (draft && contentReady && cryptoContextReady && !sending && !closing && !autosaveSuppressed && hasUserContent) {
                void saveDraftNow();
            }
        },
        { container: windowRef },
    );
    useShortcut(
        SHORTCUTS.compose.close,
        () => {
            if (!sending && !closing) {
                void handleClose();
            }
        },
        { container: windowRef },
    );
    useShortcut(SHORTCUTS.compose.create, () => openCompose({ mailboxUid }), { container: windowRef });

    const title = subject.trim() || "New Message";
    const titleId = `compose-title-${id}`;

    const discardModal = (
        <Modal open={closePrompt !== null} onClose={() => setClosePrompt(null)} title={closePrompt?.title ?? DISCARD_TITLE}>
            <p className="text-sm text-text-muted mb-4">{closePrompt?.message}</p>
            <div className="flex gap-3">
                {closePrompt?.retry && (
                    <Button type="button" onClick={retryCryptoContext} className="!w-auto">
                        Retry
                    </Button>
                )}
                {closePrompt?.closeAnyway && (
                    <Button
                        type="button"
                        onClick={() => {
                            setClosePrompt(null);
                            void handleClose(true);
                        }}
                        disabled={sending || closing}
                        className="!w-auto"
                    >
                        Close, keep draft
                    </Button>
                )}
                <Button type="button" onClick={() => void discardNow()} disabled={sending || closing} className="!w-auto">
                    Discard
                </Button>
                <Button type="button" variant="secondary" onClick={() => setClosePrompt(null)} className="!w-auto">
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
                    {sendError && <span className="shrink-0 text-xs font-bold uppercase tracking-wide">Not sent</span>}
                    <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                        <HeaderButton label="Restore" onClick={onToggleMinimize} icon={HiOutlineArrowsPointingOut} />
                        <HeaderButton label="Discard draft" onClick={handleDiscard} icon={HiOutlineXMark} disabled={sending || closing} />
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
            data-shortcut-scope="compose"
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
                    <HeaderButton label="Close" onClick={() => void handleClose()} icon={HiOutlineXMark} disabled={sending || closing} shortcut={SHORTCUTS.compose.close} />
                </div>
            </div>

            <div className="flex-1 min-h-0 flex flex-col">
                {(folderError || draftError || sendError || attachError || discardError) && (
                    // Scrolls inside the window when it is tall (a failed send's expanded Technical details), instead of pushing the
                    // editor and the Send button out of the window's fixed height, where they can't be reached.
                    <div className="px-3 pt-2 shrink-0 max-h-[45%] overflow-y-auto">
                        {folderError && <Alert>{folderError}</Alert>}
                        {draftError && <Alert>{draftError}</Alert>}
                        {sendError && <SendFailureAlert message={sendError} lines={sendDetails} />}
                        {attachError && <Alert>{attachError}</Alert>}
                        {discardError && <Alert>{discardError}</Alert>}
                    </div>
                )}

                {cryptoCheckUnavailable && (
                    <div className="px-3 pt-2">
                        <Alert>
                            <p className="mb-2">{CRYPTO_UNAVAILABLE_MESSAGE}</p>
                            <Button type="button" variant="secondary" className="!w-auto" onClick={retryCryptoContext}>
                                Retry
                            </Button>
                        </Alert>
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
                    <RecipientInput
                        id={`compose-to-${id}`}
                        label="To"
                        value={to}
                        mailboxUid={mailboxUid}
                        onChange={setTo}
                        onBlur={(value) => checkRecipientDiscovery(parseAddresses(value))}
                        onCommit={(value) => checkRecipientDiscovery(parseAddresses(value))}
                        autoFocus={focusToOnMount}
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
                            <RecipientInput
                                id={`compose-cc-${id}`}
                                label="Cc"
                                value={cc}
                                mailboxUid={mailboxUid}
                                onChange={setCc}
                                onBlur={(value) => checkRecipientDiscovery(parseAddresses(value))}
                                onCommit={(value) => checkRecipientDiscovery(parseAddresses(value))}
                            />
                        </div>
                        <div className={FIELD_ROW}>
                            <label htmlFor={`compose-bcc-${id}`} className="text-xs text-text-muted shrink-0">
                                Bcc
                            </label>
                            <RecipientInput
                                id={`compose-bcc-${id}`}
                                label="Bcc"
                                value={bcc}
                                mailboxUid={mailboxUid}
                                onChange={setBcc}
                                onBlur={(value) => checkRecipientDiscovery(parseAddresses(value))}
                                onCommit={(value) => checkRecipientDiscovery(parseAddresses(value))}
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
                        autoFocus={focusSubjectOnMount}
                        onChange={(e) => setSubject(e.target.value)}
                    />
                </div>

                <div className="flex-1 min-h-0 p-2">
                    {contentReady && (
                        <RichTextEditor
                            appendHtml={lateQuoteHtml}
                            onAppended={handleQuoteAppended}
                            value={html}
                            onChange={setHtml}
                            fill
                            onUploadImage={handleUploadImage}
                            autoFocusStart={focusBodyOnMount}
                            onInitialized={handleEditorInitialized}
                        />
                    )}
                </div>

                {quotePending && (
                    <p role="status" className="px-3 pb-1 text-xs text-text-muted">
                        Loading the original message&hellip;
                    </p>
                )}

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
                            title={withHint("Send", SHORTCUTS.compose.send, keyEnv)}
                            aria-keyshortcuts={ariaKeyShortcuts(SHORTCUTS.compose.send, keyEnv)}
                            disabled={!draft || sending || closing || !cryptoContextReady}
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
                            disabled={!draft || sending || closing || !cryptoContextReady}
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
                        disabled={sending || closing}
                        className="w-8 h-8 flex items-center justify-center rounded-full text-text-muted hover:bg-surface-alt hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
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
