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
    attachmentContentUrl,
    createDraft,
    deleteMessage,
    getMailbox,
    getMessage,
    listFolders,
    listMailboxes,
    uploadAttachment,
} from "@rapidmx/react-shared/mail/mailApi.js";
import { listMailSignatures } from "@rapidmx/react-shared/mail/mailSignaturesApi.js";
import { buildComposeBodyHtml } from "@rapidmx/react-shared/mail/compose/composeQuoting.js";
import { peekMailboxWritability, useMailboxWritability } from "../writableMailboxes.js";
import { resolveRecipientEncryption, RecipientEncryptionStatus } from "@rapidmx/react-shared/crypto/composeSecurity.js";
import { getUnlockedKeys, subscribeKeySession } from "@rapidmx/react-shared/crypto/keySession.js";
import { EncryptionPolicy, findActivePublicKey, getEncryptionPolicy, lookupKeys } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { useUnlockPrompt } from "../../layout/UnlockPromptProvider.js";
import useIsMobile from "@rapidmx/react-shared/util/useIsMobile.js";
import { notify } from "../../../notifications/store.js";
import { evaluateEncryptionRequirement } from "./encryptionRequirement.js";
import { decideSend, SendBlock } from "../../../mail/outbox/sendDecision.js";
import { SendRequest, sendDecisionInput, startSend } from "../../../mail/outbox/sendJob.js";
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

/** Automatic, silent retries of a failed mailbox/encryption-policy (or recipient key) load, one entry per retry - a flapping gateway is waited out
 * in the background, without a word to the user. */
export const DEFAULT_CRYPTO_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000, 60000];

/** Thrown by `deleteDraft()` when the server copy is no longer this window's draft (sent or scheduled elsewhere). */
const NO_LONGER_A_DRAFT_MESSAGE = "This message was already sent or scheduled from another window, so it wasn't deleted.";

/** Whether `fresh` (a re-read of a draft) is still an unsent draft in `folderUid`: never delete a message another
 * window has since sent, scheduled, or started sending. */
function isStillDraft(fresh: Message, folderUid: string): boolean {
    return fresh.folderUid === folderUid && !fresh.scheduledSendTime && !fresh.scheduledSendLeaseExpiresAt && !fresh.scheduledSendRelayedAt;
}

const SAVE_STATUS_LABEL = { idle: "", saving: "Saving…", saved: "Draft saved", error: "Couldn't save draft" } as const;

const DISCARD_TITLE = "Discard this draft?";
/** Shown only for a message that is actually headed for encryption (asked for, or applied by the loaded policy) - see `encryptionRequirement.ts`. */
const ENCRYPTED_CLOSE_MESSAGE = "Encrypted messages aren't saved as drafts, so closing this window discards what you've written.";

/** The confirmation shown before a Close/Discard throws content away (or when a Close couldn't save it). */
interface ClosePrompt {
    title: string;
    message: string;
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

/**
 * Normalizes an address into the key `recipientStatuses`/the in-flight and failure trackers below use -
 * matching `classifyRecipientTier()`'s own lowercase-domain comparison (`@rapidmx/react-shared`'s
 * `composeSecurity.ts`), but applied to the whole address rather than just the domain. Without this, the
 * same mailbox typed with different casing across To/Cc/Bcc (plausible via autocomplete vs. a pasted
 * signature block) is tracked as two independent recipients: if one lookup lags or fails while the other
 * succeeds, `decideMessageEncryption()`'s all-or-nothing check sees a spurious unresolved recipient and
 * denies auto-encryption even though every *real* recipient resolved fine. Only ever used as an internal
 * cache key - `ComposeRecipientInput.address` itself (what is actually sent as the recipient) is untouched.
 */
function addressCacheKey(address: string): string {
    return address.trim().toLowerCase();
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
    const { id, initialTo, initialCc, initialSubject, initialQuotedHtml, initialEncrypt, signatureContext, suppressSigning, minimized, quotePending, late, resume } = session;
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
    const [hasUploads, setHasUploads] = useState(!!resume && resume.attachments.length > 0);
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
    // A window re-opened around a message that was already composed (a failed send's "Open draft") continues that server draft and starts with
    // every field as it was typed; its body is not seeded from a signature or a quote.
    const [draft, setDraft] = useState<Message | null>(resume?.draft ?? null);
    // Drafts replaced by a From switch, awaiting deletion until their replacement has actually been created.
    const supersededDraftsRef = useRef<Message[]>([]);
    const [draftError, setDraftError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState(false);
    const [manualSize, setManualSize] = useState<Size | null>(null);
    const [to, setTo] = useState(resume?.to ?? initialTo ?? "");
    const [cc, setCc] = useState(resume?.cc ?? initialCc ?? "");
    const [bcc, setBcc] = useState(resume?.bcc ?? "");
    const [showCcBcc, setShowCcBcc] = useState(!!(resume ? resume.cc || resume.bcc : initialCc));
    const [subject, setSubject] = useState(resume?.subject ?? initialSubject ?? "");
    const [html, setHtml] = useState(resume?.html ?? "");
    const [contentReady, setContentReady] = useState(!!resume);
    const [attachments, setAttachments] = useState<Attachment[]>(resume?.attachments ?? []);
    const [attachError, setAttachError] = useState<string | null>(null);
    // A problem with the message as composed (no recipient, an attachment that can't be signed): shown here, and the window stays open. What
    // goes wrong after Send was accepted is a pop-up instead (see `sendJob.ts`).
    const [sendError, setSendError] = useState<string | null>(null);
    // Send was pressed while an attachment was still uploading: the window waits (and says so) rather than send without it.
    const [waitingForUploads, setWaitingForUploads] = useState(false);
    const [requestReceipt, setRequestReceipt] = useState(!!resume?.requestReceipt);
    const [schedulePickerOpen, setSchedulePickerOpen] = useState(false);
    const scheduleButtonRef = useRef<HTMLButtonElement>(null);
    const [mailbox, setMailbox] = useState<Mailbox | null>(null);
    const [encryptionPolicy, setEncryptionPolicy] = useState<EncryptionPolicy | null>(null);
    // Defaults off when replying to a detected mailing list (spec's own "Mailing lists" note under
    // Digital Signatures - a list that appends a footer after signing invalidates the signature) - see
    // `MessageDetailPane.tsx`'s handleReply()/handleReplyAll() for where this is computed. The user can
    // still turn it back on; this only changes the default.
    const [signEnabled, setSignEnabled] = useState(resume ? resume.signEnabled : !suppressSigning);
    // A reply to or forward of an encrypted message starts (and, after a From switch, restarts) with encryption
    // requested - see `OpenComposeInput.encrypt`.
    const [encryptRequested, setEncryptRequested] = useState(resume ? resume.encryptRequested : !!initialEncrypt);
    // Compose-time discovery (spec: "Discovery occurs ... when the user addresses a new message to a
    // recipient", never on receipt) - keyed by address so a recipient already looked up isn't re-fetched
    // just because the user re-focuses the field. Only ever grows via `checkRecipientDiscovery()` below;
    // never cleared, so switching focus between To/Cc/Bcc repeatedly doesn't re-trigger lookups.
    const [recipientStatuses, setRecipientStatuses] = useState<Record<string, RecipientEncryptionStatus>>({});
    // Addresses whose lookup is on the wire (so the blur handlers and the prefilled-recipient effect don't
    // look one up twice), and a counter bumped by a From switch so a lookup for the previous sender is dropped.
    const lookupsInFlightRef = useRef(new Set<string>());
    const discoveryGenerationRef = useRef(0);
    // A failed lookup stores no status: the recipient is simply "not known to be encryptable" (fail open - see `encryptionRequirement.ts`), and
    // the lookup is retried in the background with the same backoff as the mailbox/policy load, without a word to the user.
    const lookupFailuresRef = useRef(new Map<string, number>());
    const lookupRetryTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
    const [lookupRetryToken, setLookupRetryToken] = useState(0);
    // A send refused *before it left* because signing/encryption was asked for (or the loaded policy applies it) but can't happen right now
    // (keys locked, Bcc recipients on an encrypted message, a recipient without a key) - never a silent downgrade to plaintext; the user
    // has to explicitly pick the override.
    const [securityBlock, setSecurityBlock] = useState<SendBlock | null>(null);
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
    /** Send was pressed and is being validated/handed over: a second press (a double click, the shortcut held or repeated) does nothing. */
    const submittingRef = useRef(false);
    /** Attachment/inline-image uploads on the wire, and who is waiting for them to finish (Send pressed meanwhile). */
    const uploadsInFlightRef = useRef(0);
    const uploadWaitersRef = useRef<(() => void)[]>([]);
    /** The latest save request, if any - each save is chained after the one before it. Always settles (never
     * rejects), to the saved message, or `undefined` when that save failed. */
    const saveInFlightRef = useRef<Promise<Message | undefined>>(Promise.resolve(undefined));
    /** Set once the window has been sent/closed/discarded - nothing more gets autosaved after that. */
    const finishedRef = useRef(false);

    // A mailbox with no keys enrolled yet just means sign/encrypt stay unavailable for this compose session -
    // encryption is optional and gradual by design (see `KeyEnrollmentGate`'s own doc comment).
    // The mailbox and the encryption policy load in the background and *nothing waits for them*: until both have loaded, the message is treated as
    // not encrypted - its draft saves, Close and Send work, and no message about it is shown (see `encryptionRequirement.ts`). A failed load is
    // retried silently with backoff (`cryptoRetryDelaysMs`); if it later turns out the message must be encrypted, `encryptionDecided` (below) starts
    // to apply - see the transition rules there.

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
            if (!cancelled && (!mailboxLoaded || !policyLoaded) && retries < cryptoRetryDelaysMs.length) {
                timer = setTimeout(() => void load(), cryptoRetryDelaysMs[retries++]);
            }
        }
        void load();
        return () => {
            cancelled = true;
            clearTimeout(timer);
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
     * and not the lookup the background send (`sendJob.ts`) performs again at send time (deliberately: this is a
     * best-effort UI hint, not something a stale value here should be trusted to skip at send time).
     * A mailbox/policy fetch that hasn't resolved yet just leaves that address with no indicator - the effect
     * below runs it again for every current recipient once both have loaded. A failed lookup leaves it without
     * a status too, and is retried silently after `cryptoRetryDelaysMs` (then only on blur).
     *
     * The statuses also drive `encryptionRequirement.ts`: only when every recipient has one, and the loaded policy
     * auto-encrypts for all of them, does the message turn into one that is never saved as a plaintext draft.
     */
    function checkRecipientDiscovery(addresses: ComposeRecipientInput[]) {
        if (!mailbox || !encryptionPolicy) {
            return;
        }
        const ownPrefersMutual = mailbox.encryptPreference?.preferEncrypt === "mutual";
        const generation = discoveryGenerationRef.current;
        const inFlight = lookupsInFlightRef.current;
        const unchecked = addresses.filter((r) => !(addressCacheKey(r.address) in recipientStatuses) && !inFlight.has(addressCacheKey(r.address)));
        for (const recipient of unchecked) {
            const key = addressCacheKey(recipient.address);
            inFlight.add(key);
            void lookupKeys(mailbox.uid, recipient.address)
                .then(
                    (lookup) => ({ lookup }),
                    () => null,
                )
                .then((result) => {
                    inFlight.delete(key);
                    if (generation !== discoveryGenerationRef.current) {
                        return;
                    }
                    if (!result) {
                        noteLookupFailed(key);
                        return;
                    }
                    lookupFailuresRef.current.delete(key);
                    const status = resolveRecipientEncryption(mailbox.primarySmtpAddress, ownPrefersMutual, encryptionPolicy, recipient.address, result.lookup);
                    setRecipientStatuses((prev) => ({ ...prev, [key]: status }));
                });
        }
    }

    /** Schedules the next automatic, silent retry of a failed lookup (until the backoff has run out; a later blur tries again). */
    function noteLookupFailed(address: string) {
        const failures = (lookupFailuresRef.current.get(address) ?? 0) + 1;
        lookupFailuresRef.current.set(address, failures);
        if (failures > cryptoRetryDelaysMs.length) {
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

    // Resolves the mailbox's default signature (if any) for `signatureContext` and seeds `html` with it (not for a window re-opened around a composed message)
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
        setEncryptRequested(!!initialEncrypt);
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
        uploadStarted();
        try {
            const attachment = await uploadAttachment(draft.uid, file);
            setHasUploads(true);
            void refreshDraftVersion(draft.uid);
            return attachmentContentUrl(attachment.uid);
        } catch (err) {
            setAttachError(err instanceof ApiRequestError ? err.message : "Could not upload image.");
            return null;
        } finally {
            uploadFinished();
        }
    }

    /** Send waits for every upload started before it: see `submit()`. */
    function uploadStarted() {
        uploadsInFlightRef.current += 1;
    }
    function uploadFinished() {
        uploadsInFlightRef.current -= 1;
        if (uploadsInFlightRef.current === 0) {
            for (const resolve of uploadWaitersRef.current.splice(0)) {
                resolve();
            }
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
        uploadStarted();
        try {
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
        } finally {
            uploadFinished();
        }
    }

    /**
     * Send (or, given `scheduledSendTimeIso`, Send later) - and get out of the way. The window is the place the message is *written*; nothing
     * about getting it to the server is waited for here.
     *
     * 1. **Validate synchronously**, from what the window already knows (no request): a recipient is required; and if the message is one
     * that must be signed or encrypted and can't be right now (keys locked, Bcc on an encrypted message, a recipient with no key, an
     * attachment that can't be signed) that is shown right here and the window stays open - the sender fixes it or picks the override.
     * An attachment still uploading is waited for, inline (Send says so), never left behind.
     * 2. **Close immediately** (`onClose()`): `startSend()` (see `sendJob.ts`) takes over with a snapshot of the message. From here the only
     * feedback is the Outbox indicator; a failure at any stage is a sticky pop-up with the reason and Retry / Open draft.
     *
     * Pressed twice (a double click, the shortcut repeated) it sends once: the first press sets `submittingRef` before any `await`, and
     * `startSend()` itself refuses a draft that is already being sent. `forcePlaintext` is the override buttons' choice.
     */
    async function submit(forcePlaintext: boolean, scheduledSendTimeIso?: string) {
        if (submittingRef.current || finishedRef.current) {
            return;
        }
        if (parseAddresses(latestRef.current.to).length === 0) {
            setSendError("At least one recipient is required.");
            return;
        }
        submittingRef.current = true;
        setSendError(null);
        setSecurityBlock(null);
        try {
            if (uploadsInFlightRef.current > 0) {
                setWaitingForUploads(true);
                await new Promise<void>((resolve) => uploadWaitersRef.current.push(resolve));
                // The editor puts an image it has just uploaded into the message a moment after the upload resolves: let the window catch up.
                await new Promise((resolve) => setTimeout(resolve, 0));
                setWaitingForUploads(false);
            }
            const current = latestRef.current;
            const request: SendRequest = {
                draft: current.draft!,
                mailboxUid: current.mailboxUid!,
                mailbox: current.mailbox ?? undefined,
                policy: current.encryptionPolicy ?? undefined,
                toText: current.to,
                ccText: current.cc,
                bccText: current.bcc,
                to: parseAddresses(current.to),
                cc: parseAddresses(current.cc),
                bcc: parseAddresses(current.bcc),
                subject: current.subject,
                html: current.html,
                attachments: current.attachments,
                requestReceipt: current.requestReceipt,
                scheduledSendTime: scheduledSendTimeIso,
                signEnabled: current.signEnabled,
                offeredSign: offeredCryptoRef.current.sign,
                offeredEncrypt: offeredCryptoRef.current.encrypt,
                encryptRequested: current.encryptRequested,
                forcePlaintext,
                saved: saveInFlightRef.current,
            };
            if (request.to.length === 0) {
                setSendError("At least one recipient is required.");
                return;
            }
            const early = decideSend(sendDecisionInput(request, request.mailbox, request.policy, current.statuses, false));
            if (early.action === "rejected") {
                setSendError(early.message);
                return;
            }
            if (early.action === "blocked") {
                setBlockedScheduleIso(scheduledSendTimeIso);
                setSecurityBlock(early.block);
                if (early.block.keysLocked && (hasEnrolledSigningKey || hasEnrolledEncryptionKey)) {
                    void handleUnlockForCrypto();
                }
                return;
            }
            pendingSaveRef.current = false;
            finishedRef.current = true;
            if (!startSend(request)) {
                finishedRef.current = false;
                setSendError("This message is already being sent.");
                return;
            }
            onClose();
        } finally {
            submittingRef.current = false;
            setWaitingForUploads(false);
        }
    }

    function handleScheduleSend(scheduledSendTimeIso: string) {
        setSchedulePickerOpen(false);
        void submit(false, scheduledSendTimeIso);
    }

    async function handleUnlockForCrypto() {
        try {
            // Only reachable when hasEnrolledSigningKey/hasEnrolledEncryptionKey found a real enrolled key
            // in mailbox.keys (the unlock button below, or a blocked send()), so neither is empty/undefined here.
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
     * turned on, a recipient that auto-encrypts), or the window may have been sent or finished - then it
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
            if (current.autosaveSuppressed || finishedRef.current) {
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
     * unless there's nothing in it worth keeping, or it can't be saved because it's really headed for encryption
     * (asked for, or applied by the loaded policy): that needs the same confirmation as a discard. Whatever is
     * *unknown* (settings loading or failed, a lookup pending) is not a reason to hold the window: it is saved like any
     * other message. A failed save keeps the window open with Discard / Keep editing. */
    async function handleClose() {
        if (!hasUserContent) {
            void discardNow();
            return;
        }
        if (encryptionDecided) {
            setClosePrompt({ title: DISCARD_TITLE, message: ENCRYPTED_CLOSE_MESSAGE });
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
                setClosePrompt({ title: DISCARD_TITLE, message: ENCRYPTED_CLOSE_MESSAGE });
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
    // Whether this message is *really* headed for encryption - `encryptionRequirement.ts` decides, and it fails open: the message is plain (its
    // draft saves, Close and Send work, nothing is shown) unless the user asked for encryption or the policy was loaded and applies it to every
    // recipient (whose keys were all looked up). What has not loaded, or failed to, is not held against the message.
    //
    // Transitions, when a later load turns a plain message into an encrypted one (the policy arrives, a slow lookup answers, a recipient is
    // added): (1) autosave stops at once (`autosaveSuppressed`); (2) a plaintext copy this window already saved is *replaced by an empty draft*
    // (`scrubSavedDraft()` below) so the plaintext doesn't sit on the server; (3) Close asks first ("Encrypted messages aren't saved as drafts");
    // (4) Send encrypts (or is refused, with the override, when it can't) - never silently plaintext. And back: when it stops being encrypted
    // (a recipient removed) autosave simply resumes.
    const currentAddresses = [...parseAddresses(to), ...parseAddresses(cc), ...parseAddresses(bcc)].map((r) => r.address);
    const currentStatuses = currentAddresses.map((address) => recipientStatuses[addressCacheKey(address)]);
    const hasEncryptionKey = !!unlockedKeys?.encryptionPrivateKey || hasEnrolledEncryptionKey || offeredCryptoRef.current.encrypt;
    const requirement = evaluateEncryptionRequirement({
        encryptRequested,
        policy: encryptionPolicy ?? undefined,
        mailboxLoaded: !!mailbox,
        hasEncryptionKey,
        recipients: currentStatuses,
    });
    const encryptionDecided = requirement.required;
    const autosaveSuppressed = encryptionDecided;
    const latestRef = useRef({
        draft, mailboxUid, mailbox, encryptionPolicy, to, cc, bcc, subject, html, attachments, requestReceipt, signEnabled, encryptRequested,
        statuses: currentStatuses, seededHtml, contentKey, saveStatus, hasUserContent, autosaveSuppressed, encryptionDecided,
    });
    latestRef.current = {
        draft, mailboxUid, mailbox, encryptionPolicy, to, cc, bcc, subject, html, attachments, requestReceipt, signEnabled, encryptRequested,
        statuses: currentStatuses, seededHtml, contentKey, saveStatus, hasUserContent, autosaveSuppressed, encryptionDecided,
    };

    /** A message that turned out to need encryption after a plaintext copy of it was saved: the saved copy is replaced by an empty draft (the same
     * uid, so attachments and the folder are undisturbed), chained after any save still on the wire. Best effort - a failure is reported once. */
    function scrubSavedDraft(target: Message) {
        lastSavedRef.current = null;
        setSaveStatus("idle");
        const previous = saveInFlightRef.current;
        const scrub = (async (): Promise<Message | undefined> => {
            await previous;
            try {
                // Its answer (the new version) is what a later delete waits for through `saveInFlightRef`, like any save's.
                return await assembleDraft(target.uid, { to: [], cc: [], bcc: [], subject: "", html: "" });
            } catch {
                notify({
                    id: `scrub-draft:${target.uid}`,
                    kind: "warning",
                    title: "An earlier draft copy is still saved",
                    message: "This message needs encryption, but the copy saved before that was known couldn't be replaced. Discarding the draft removes it.",
                });
                return undefined;
            }
        })();
        saveInFlightRef.current = scrub;
    }
    // Only a message that was really saved (`lastSavedRef` names its draft) has a plaintext copy to replace.
    useEffect(() => {
        if (encryptionDecided && draft && lastSavedRef.current?.startsWith(`${draft.uid}:`)) {
            scrubSavedDraft(draft);
        }
    }, [encryptionDecided, draft?.uid]);

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
            !autosaveSuppressed &&
            hasUserContent &&
            lastSavedRef.current !== `${draft.uid}:${contentKey}`;
        pendingSaveRef.current = due;
        if (!due) {
            return;
        }
        const timer = setTimeout(() => void saveDraftNow(), autosaveDelayMs);
        return () => clearTimeout(timer);
    }, [draft, contentReady, autosaveSuppressed, hasUserContent, contentKey]);

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
            if (finishedRef.current || isSigningOut()) {
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
    const isReplyOrForward = initialQuotedHtml !== undefined || !!quotePending || !!resume;
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
    // Send never waits for the encryption settings to load (fail open, see `encryptionRequirement.ts`); it only needs the draft to exist. Pressed
    // while an earlier press is still being handled it does nothing (`submit()` guards that itself).
    const canSend = !!draft && !closing && !waitingForUploads;
    useShortcut(SHORTCUTS.compose.send, () => void (canSend && submit(false)), { container: windowRef });
    useShortcut(
        SHORTCUTS.compose.saveDraft,
        () => {
            // Autosave's own conditions: never a draft that must not be stored as plaintext.
            if (draft && contentReady && !closing && !autosaveSuppressed && hasUserContent) {
                void saveDraftNow();
            }
        },
        { container: windowRef },
    );
    useShortcut(
        SHORTCUTS.compose.close,
        () => {
            if (!closing) {
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
                <Button type="button" onClick={() => void discardNow()} disabled={closing} className="!w-auto">
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
                    <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                        <HeaderButton label="Restore" onClick={onToggleMinimize} icon={HiOutlineArrowsPointingOut} />
                        <HeaderButton label="Discard draft" onClick={handleDiscard} icon={HiOutlineXMark} disabled={closing} />
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
                "shrink-0 flex flex-col bg-surface border border-border shadow-modal overflow-hidden",
                // `fixed` and `relative` may not both be on the element: Tailwind emits `.relative` after `.fixed`, so it wins and the
                // sheet sat in the flow of the little fixed container the windows are stacked in instead of covering the screen.
                isMobile
                    ? "fixed inset-0 w-full h-full rounded-none border-0"
                    : ["relative border-b-0 rounded-t-md", manualSize ? "" : expanded ? "w-[720px] h-[85vh]" : "w-[480px] h-[520px]"].join(" "),
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
                    <HeaderButton label="Close" onClick={() => void handleClose()} icon={HiOutlineXMark} disabled={closing} shortcut={SHORTCUTS.compose.close} />
                </div>
            </div>

            <div className="flex-1 min-h-0 flex flex-col">
                {(folderError || draftError || sendError || attachError || discardError) && (
                    // Scrolls inside the window when it is tall, instead of pushing the editor and the Send button out of the window's
                    // fixed height, where they can't be reached.
                    <div className="px-3 pt-2 shrink-0 max-h-[45%] overflow-y-auto">
                        {folderError && <Alert>{folderError}</Alert>}
                        {draftError && <Alert>{draftError}</Alert>}
                        {sendError && <Alert>{sendError}</Alert>}
                        {attachError && <Alert>{attachError}</Alert>}
                        {discardError && <Alert>{discardError}</Alert>}
                    </div>
                )}

                {securityBlock && (
                    <div className="px-3 pt-2">
                        <Alert>
                            <p className="mb-2">{securityBlock.message}</p>
                            <Button type="button" onClick={() => void submit(true, blockedScheduleIso)}>
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
                            disabled={hasUploads}
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
                    // De-duplicated by the same normalized key `recipientStatuses` itself is keyed by - two
                    // fields (or one field twice) naming the same mailbox in different casing now resolve to
                    // one shared status object (see `addressCacheKey()`'s own doc comment), so without this
                    // the list below would render - and React would warn about - two `<li key=...>`s sharing
                    // the exact same key.
                    const seenKeys = new Set<string>();
                    const knownRecipients = [...parseAddresses(to), ...parseAddresses(cc), ...parseAddresses(bcc)]
                        .filter((r) => {
                            const key = addressCacheKey(r.address);
                            if (seenKeys.has(key)) {
                                return false;
                            }
                            seenKeys.add(key);
                            return true;
                        })
                        .map((r) => recipientStatuses[addressCacheKey(r.address)])
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
                    `sendJob.ts`'s signing path for why signing rarely shows today (no signing
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
                            disabled={!draft || closing || waitingForUploads}
                            className="py-1.5 pl-5 pr-3 font-semibold text-sm hover:not-disabled:bg-primary-dark disabled:opacity-55 disabled:cursor-not-allowed"
                        >
                            Send
                        </button>
                        <button
                            ref={scheduleButtonRef}
                            type="button"
                            aria-label="Send later"
                            aria-haspopup="true"
                            aria-expanded={schedulePickerOpen}
                            disabled={!draft || closing || waitingForUploads}
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
                        {waitingForUploads ? "Waiting for attachments to finish uploading…" : SAVE_STATUS_LABEL[saveStatus]}
                    </span>

                    <button
                        type="button"
                        aria-label="Discard draft"
                        title="Discard draft"
                        onClick={handleDiscard}
                        disabled={closing}
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
