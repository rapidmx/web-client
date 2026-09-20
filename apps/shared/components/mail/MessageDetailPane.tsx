///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useRef, useState } from "react";
import {
    HiOutlineArchiveBox,
    HiOutlineArrowUturnLeft,
    HiOutlineArrowUturnRight,
    HiOutlineCheck,
    HiOutlineExclamationTriangle,
    HiOutlineFolderArrowDown,
    HiOutlineLockClosed,
} from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    Attachment,
    Folder,
    Message,
    ReceiptType,
    Recipient,
    approveReceipt,
    archiveMessage,
    attachmentContentUrl,
    cancelScheduledSend,
    declineReceipt,
    getMailbox,
    getMessage,
    getMessageRawContent,
    moveMessage,
    recallMessage,
    setMessageLabels,
} from "@rapidmx/react-shared/mail/mailApi.js";
import { Label } from "@rapidmx/react-shared/mail/labelsApi.js";
import {
    buildForwardQuote,
    buildReplyQuote,
    buildReplyRecipients,
    buildReplyThreading,
    forwardSubject,
    replySubject,
} from "@rapidmx/react-shared/mail/compose/composeQuoting.js";
import { sanitizeMessageBodyHtml } from "@rapidmx/react-shared/mail/messageBodySanitizer.js";
import MoveToFolderDialog from "./MoveToFolderDialog.js";
import { getUnlockedKeys, subscribeKeySession } from "@rapidmx/react-shared/crypto/keySession.js";
import {
    MessageSecurityResult,
    SignatureFailureReason,
    evaluateMessageSecurity,
    evaluateMessageSecurityWithSeal,
} from "@rapidmx/react-shared/crypto/messageSecurity.js";
import { extractAddresses, type MimeAttachment } from "@rapidmx/react-shared/crypto/mime.js";
import { SignerKeyConflictError, signingKeyFingerprints, trustSigner } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { isLikelyMailingList } from "@rapidmx/react-shared/crypto/composeSecurity.js";
import { SenderKeyState, clearPinnedSignerCache, getPinnedSignerFingerprints, getSignerKeyState } from "./pinnedSigners.js";
import { currentVerificationSeal, getVaultGeneration, sendVerificationSeal } from "./verificationSeals.js";
import { getMyMailboxAccess } from "@rapidmx/react-shared/mail/mailboxAccessApi.js";
import KeyChangeReview from "../contacts/KeyChangeReview.js";
import { KEY_CHANGE_STALE_MESSAGE, sameFingerprint } from "../contacts/contactKeys.js";
import { useCompose } from "./compose/ComposeContext.js";
import { loadOriginalMessage } from "./compose/quotedBody.js";
import { formatRecipient } from "./compose/recipients.js";
import { formatMailAddress } from "@rapidmx/react-shared/mail/mailAddress.js";
import { RecipientLine } from "./MailAddress.js";
import { useMailShell } from "./layout/MailShell.js";
import { useUnlockPrompt } from "../layout/UnlockPromptProvider.js";
import { moveLocalEntity } from "../../search/localIndexRpcClient.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import LabelMenuButton from "./labelMenu.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

/** Labels/styling for `specs/end-to-end_encryption.md`'s "Message Security Indicators" table - kept as
 * plain data (not JSX) so `SecurityIndicator` below stays a trivial lookup. "Signature failed" MUST NOT
 * read as a muted variant of "verified" (a failed signature is a stronger negative than no signature at
 * all), and "Unprotected" MUST NOT read as an error - the class pairs below are chosen so those two
 * never share styling with each other or with the verified states. */
const SECURITY_INDICATOR: Record<MessageSecurityResult["state"], { label: string; className: string }> = {
    unprotected: { label: "Unprotected", className: "bg-surface-alt text-text-muted" },
    encrypted: { label: "Encrypted", className: "bg-primary/10 text-primary-dark" },
    signed_verified: { label: "Signed & verified", className: "bg-success/10 text-success" },
    encrypted_verified: { label: "Encrypted & verified", className: "bg-success/10 text-success" },
    // A valid signature from a certificate the reader hasn't pinned - anyone can mint a certificate naming the
    // sender, so this must never look like the verified states.
    signed_unverified_signer: { label: "Signed - signer not verified", className: "bg-warning/15 text-text" },
    encrypted_unverified_signer: { label: "Encrypted - signer not verified", className: "bg-warning/15 text-text" },
    signature_failed: { label: "Signature failed", className: "bg-danger-bg text-danger" },
    // Verified when first opened (a verification seal), but not live: muted, never the green verified pill. A signer key
    // later reported compromised switches it to `LATER_COMPROMISED_INDICATOR_CLASS`.
    verified_at_first_open: { label: "Verified when first opened", className: "bg-surface-alt text-text-muted" },
};

/** The amber `verified_at_first_open` badge for a signer key since reported compromised. */
const LATER_COMPROMISED_INDICATOR_CLASS = "bg-warning/15 text-text";

/** Whether a result is (or, for `verified_at_first_open`, was live) a `signer_key_changed` failure. */
function signerKeyChanged(result: MessageSecurityResult): boolean {
    return result.signatureFailureReason === "signer_key_changed" || result.liveSignatureFailureReason === "signer_key_changed";
}

/** The detail line under a `verified_at_first_open` badge. */
export function verifiedAtFirstOpenMessage(result: MessageSecurityResult): string {
    const date = new Date(result.verifiedAt!).toLocaleDateString();
    if (result.laterCompromised) {
        return `This signature was verified on ${date}, but the sender's key was later reported compromised; treat this message with caution.`;
    }
    if (result.liveSignatureFailureReason === "signer_key_changed") {
        return `This signature was verified on ${date}. The sender has since started signing with a different key.`;
    }
    return `This signature was verified on ${date}. The sender's key is no longer trusted since then, for example because it was removed, replaced or revoked.`;
}

const VERIFIED_STATES = new Set<MessageSecurityResult["state"]>(["signed_verified", "encrypted_verified"]);
const UNVERIFIED_SIGNER_STATES = new Set<MessageSecurityResult["state"]>(["signed_unverified_signer", "encrypted_unverified_signer"]);

/** An `@`, or a look-alike a reader would take for one (fullwidth, small) - restapi's own `AT_SIGN_LIKE`. */
const AT_SIGN_LIKE = /[@\uFF20\uFE6B]/;

export interface SenderNameCheck {
    /** The display name contains an `@` or a look-alike - it reads as (part of) an address. */
    looksLikeAddress: boolean;
    /** It shows an address-shaped token that isn't `actualAddress` - e.g. `"ceo@corp.com" <x@corp-pay.com>`. */
    misleading: boolean;
}

/** Whether a sender's display name poses as an address, and whether that address differs from the one actually sent
 * from. Compatibility forms are folded first (NFKC turns the fullwidth and small @ into `@`), so a look-alike can't
 * hide the token. */
export function checkSenderName(displayName: string | undefined, actualAddress: string): SenderNameCheck {
    if (!displayName || !AT_SIGN_LIKE.test(displayName)) {
        return { looksLikeAddress: false, misleading: false };
    }
    const shown = /[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/.exec(displayName.normalize("NFKC"))?.[0];
    return { looksLikeAddress: true, misleading: shown !== undefined && shown.toLowerCase() !== actualAddress.toLowerCase() };
}

export const TRUST_SIGNER_CONFLICT_MESSAGE =
    "A different signing key is already trusted for this sender, so this one wasn't trusted. The sender's key may have changed; confirm with them before doing anything.";
export const TRUST_SIGNER_INVALID_MESSAGE = "This certificate can't be trusted for this sender.";
export const TRUST_SIGNER_FORBIDDEN_MESSAGE = "You don't have permission to trust signers for this mailbox.";
export const TRUST_SIGNER_GENERIC_MESSAGE = "Couldn't trust this signer. Try again.";
export const KEPT_CURRENT_SIGNING_KEY_MESSAGE = "You kept the current signing key for this sender. This message stays unverified.";

/** The error text for a failed `trustSigner()`. */
export function trustSignerErrorMessage(err: unknown): string {
    if (err instanceof SignerKeyConflictError) {
        return TRUST_SIGNER_CONFLICT_MESSAGE;
    }
    if (err instanceof ApiRequestError && err.status === 400) {
        return TRUST_SIGNER_INVALID_MESSAGE;
    }
    if (err instanceof ApiRequestError && err.status === 403) {
        return TRUST_SIGNER_FORBIDDEN_MESSAGE;
    }
    return TRUST_SIGNER_GENERIC_MESSAGE;
}

/** Groups a fingerprint into 4-character blocks (`AB12 CD34 ...`), ignoring any separators it came with, so it can be
 * read out and compared with the sender over another channel. */
export function formatFingerprint(fingerprint: string): string {
    const compact = fingerprint.replace(/[\s:]/g, "").toUpperCase();
    return compact.match(/.{1,4}/g)?.join(" ") ?? compact;
}

/** Saves one attachment recovered from inside a signed/encrypted entity. Always handed to the browser as an
 * opaque download (`application/octet-stream`), never rendered in this origin. */
function downloadMimeAttachment(attachment: MimeAttachment): void {
    // `decode()` is `undefined` only for invalid base64 - an empty file is the honest result then.
    const bytes = attachment.decode() ?? new Uint8Array(0);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = attachment.filename ?? "attachment";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Some browsers are still reading the blob after `click()` returns.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * One of the reading pane's own actions - Reply, Reply All, Forward, Archive, Move to Other - as an icon
 * button. The action's name is its `aria-label` *and* its tooltip, so it has the same accessible name a
 * labelled button had, and is never drawn beside the icon at any width: the row is icon-only everywhere,
 * the way Outlook's own reading-pane command bar is, so it reads the same in the ~396px pane beside the
 * message list and in a maximised window rather than changing shape at a breakpoint.
 *
 * A plain `<button>` rather than react-shared's `Button`, whose padding and minimum width are sized for a
 * text label. Ordinary DOM order, so the keyboard reaches these in the order they are read.
 */
function IconAction({
    icon,
    label,
    onClick,
    disabled,
    busy,
}: {
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    busy?: boolean;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            aria-busy={busy || undefined}
            disabled={disabled}
            onClick={onClick}
            className="inline-flex items-center justify-center p-1.5 rounded-md border border-border text-sm text-text hover:bg-surface-alt disabled:opacity-50 disabled:hover:bg-transparent"
        >
            {icon}
        </button>
    );
}

function SecurityIndicator({ security }: { security: MessageSecurityResult }) {
    const { label, className } = SECURITY_INDICATOR[security.state];
    if (security.state !== "verified_at_first_open") {
        return <span className={`text-xs font-medium shrink-0 py-1 px-2.5 rounded-pill ${className}`}>{label}</span>;
    }
    return (
        <span
            className={`inline-flex items-center gap-1 text-xs font-medium shrink-0 py-1 px-2.5 rounded-pill ${
                security.laterCompromised ? LATER_COMPROMISED_INDICATOR_CLASS : className
            }`}
        >
            {security.laterCompromised ? (
                <HiOutlineExclamationTriangle size={12} aria-hidden="true" />
            ) : (
                <HiOutlineCheck size={12} aria-hidden="true" />
            )}
            {label}
        </span>
    );
}

/** User-facing explanation for each `signatureFailureReason` - shown alongside the "Signature failed"
 * badge so an unverifiable (e.g. foreign/unparseable) signed message reads as "not verified, and here's
 * why" rather than as a bare error. The body itself stays visible either way. */
const SIGNATURE_FAILURE_MESSAGE: Record<SignatureFailureReason, string> = {
    invalid_signature:
        "This message's digital signature couldn't be verified - it may be malformed, use an unsupported format, or the content may have been altered after signing. Treat it as unverified.",
    untrusted_signer: "This message was signed with a certificate that doesn't match the sender's known key. Treat it as unverified.",
    // Never shown: the dedicated "signing key changed" notice replaces it. Present so every reason has copy.
    signer_key_changed: "This message was signed with a different key than the one you trust for this sender. Treat it as unverified.",
    signer_identity_mismatch:
        "This message's signing certificate doesn't belong to the sender shown in From. Treat it as unverified.",
    header_mismatch:
        "The sender/recipients this message was signed with don't match its visible From/To, or it repeats a From, To, Cc or Sender header. Treat it as unverified.",
};
const GENERIC_SIGNATURE_FAILURE_MESSAGE = "This message's digital signature couldn't be verified. Treat it as unverified.";

/** Fallback when the raw MIME for an encrypted message can't even be fetched/evaluated - an encrypted
 * message must never be mislabeled "Unprotected" just because loading failed. */
const ENCRYPTED_LOAD_ERROR = "Couldn't load this message's encrypted content.";

/** Content Security Policy prepended to every client-rendered (decrypted/verified) body's `srcDoc` - the
 * backstop behind the sanitizer below: nothing in the document may load any remote resource at all, only
 * inline styles and `data:`/`cid:` images. */
const BODY_CSP_META =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'\">";

/** Sanitizes a client-rendered body for `srcDoc` (DOMPurify plus every remote resource reference stripped - see
 * react-shared's `messageBodySanitizer.ts`), with the CSP meta as its very first element. */
export function buildSecureSrcDoc(html: string): string {
    return BODY_CSP_META + sanitizeMessageBodyHtml(html);
}

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
    /** Every folder of this message's own mailbox, for the Move to prompt's destination list. Absent or
     * empty simply hides the control — there is nowhere to move to. Each caller already resolves this to
     * work out `isSentItems`/`isOutbox`/`draftsFolderUid`, so nothing new is fetched for it. */
    folders?: Folder[];
    /** Called with the server's updated copy (now in the chosen folder) after a successful Move to. A move
     * takes the message out of whichever folder is being listed, so callers remove it from their list
     * rather than patching it — unlike `onClassified`, which this replaces. */
    onMoved?: (updated: Message) => void;
    /** A folder created from the Move to prompt, so the caller's own list and the folder sidebar pick it up
     * without a page load. */
    onFolderCreated?: (folder: Folder) => void;
    /** Called with the server's updated copy after approving/declining a pending delivery/read receipt —
     * mirrors `onRecalled`'s identical shape. No gating prop needed (unlike `isSentItems`/`isOutbox`):
     * `deliveryReceiptPending`/`readReceiptPending` already live directly on `message` and are only ever
     * `true` on a real delivered copy, so the banner below is self-gating. */
    onReceiptHandled?: (updated: Message) => void;
    /** Called with the server's updated copy (now filed under the mailbox's Archive folder) after a
     * successful archive — mirrors `onRecalled`'s identical shape. Archiving itself is offered for any
     * message except one currently in Drafts or Outbox (mirrors `BaseMessageRoute.archive()`'s own
     * server-side 400 guard); Drafts is detected via `draftsFolderUid` (already passed by every caller
     * for the Outbox-cancel flow) rather than a new prop. */
    onArchived?: (updated: Message) => void;
    /** Every label defined in this message's mailbox, for the label-assignment popover below — each
     * caller fetches its own mailbox's labels the same way it already resolves `draftsFolderUid`
     * (`listLabels()`). Absent/empty simply hides the Labels control - there's nothing to assign. */
    labels?: Label[];
    /** Called with the server's updated copy (carrying the new `labelUids`) after successfully toggling
     * a label — always patches in place, never removes from a caller's list (unlike `onArchived`):
     * changing labels never moves a message between folders. */
    onLabelsChanged?: (updated: Message) => void;
    /** Handed a label created from the Labels menu, for the caller to add to `labels`. Without it the menu
     * offers no "New label" row, only the link to where labels are managed. */
    onLabelCreated?: (label: Label) => void;
    /** Rendered as one message of a thread (`ConversationThreadPane`) rather than as the pane itself: the
     * subject becomes a heading under the thread's own, since a document has one `h1` and the thread's is
     * the conversation. Everything else - the badges, the actions, the body - is identical. */
    inThread?: boolean;
}

function formatBytes(bytes: number): string {
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
    return `${bytes} B`;
}

/**
 * A message's reading pane — header (subject/from/to/attachments) plus a sandboxed iframe for the body.
 * Shared by the desktop inline pane (`apps/www/index.tsx`, always visible alongside the message list),
 * and the mobile detail route (`apps/www/messages/[uid].tsx`, a full page on its own reached by tapping
 * a message row) — see each call site for how `message`/`attachments`/`isSentItems` are sourced. The
 * desktop pane shows whichever message the list opened, including one opened from a conversation row.
 */
export default function MessageDetailPane(props: MessageDetailPaneProps) {
    if (!props.message) {
        return <p className="p-8 text-sm text-text-muted">Select a message to read it.</p>;
    }
    // Keyed by uid so every piece of per-message state below (security result, open modals, in-flight
    // flags, errors) resets cleanly when a caller swaps `message` in place rather than remounting.
    return <MessageDetailContent key={props.message.uid} {...props} message={props.message} />;
}

/** Whether a message's raw MIME has to be fetched to evaluate its security state. `encrypted` is the
 * server's own classification; there is no server-side "signed" flag, but every S/MIME-signed shape
 * (detached `multipart/signed`'s `smime.p7s`, opaque-signed `smime.p7m`) is stored with its CMS part
 * surfaced as an attachment - so a message with neither flag can't carry a signature to verify, and
 * fetching its full raw source (attachments included) would be pure waste. */
function needsRawSecurityEvaluation(message: Message): boolean {
    return !!message.encrypted || message.hasAttachments;
}

function MessageDetailContent({
    message: messageProp,
    attachments,
    backHref,
    isSentItems,
    onRecalled,
    isOutbox,
    draftsFolderUid,
    onScheduledSendCanceled,
    folders,
    onMoved,
    onFolderCreated,
    onReceiptHandled,
    onArchived,
    labels,
    onLabelsChanged,
    onLabelCreated,
    inThread,
}: MessageDetailPaneProps & { message: Message }) {
    // A copy re-read from the server after an Outbox action was refused (409/403) or a send lease ran out - see
    // `reloadMessage()`. A prop copy newer by `version` wins; an equal-version reload is kept, since claiming a send
    // lease need not bump `version`.
    const [reloaded, setReloaded] = useState<Message | null>(null);
    const message = reloaded && reloaded.version >= messageProp.version ? reloaded : messageProp;
    // A reload that finds the message already moved on (sent, or moved to Drafts elsewhere) leaves Outbox.
    const inOutbox = !!isOutbox && message.folderUid === messageProp.folderUid;
    const { openCompose } = useCompose();
    const [confirming, setConfirming] = useState(false);
    const [recalling, setRecalling] = useState(false);
    const [canceling, setCanceling] = useState(false);
    const [archiving, setArchiving] = useState(false);
    const [archiveError, setArchiveError] = useState<string | null>(null);
    const [savingLabels, setSavingLabels] = useState(false);
    const [labelsError, setLabelsError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Kept separate from `error` (the Recall flow's own state) since this renders inline in the main
    // pane rather than inside a confirmation modal — the two flows never need to share one message.
    const [cancelError, setCancelError] = useState<string | null>(null);
    const [movePrompt, setMovePrompt] = useState(false);
    // Names which pending receipt (`"delivery"`/`"read"`) is currently being approved/declined, if any —
    // `deliveryReceiptPending`/`readReceiptPending` can both be true independently, so a single boolean
    // wouldn't distinguish which row's buttons should show a loading state.
    const [receiptBusy, setReceiptBusy] = useState<ReceiptType | null>(null);
    const [receiptError, setReceiptError] = useState<string | null>(null);
    const [security, setSecurity] = useState<MessageSecurityResult | null>(null);
    // Whether the pinned-signer lookup for the sender *succeeded* and found no signing keys - the only case "Trust this
    // signer" is offered in. A failed lookup could be hiding an existing pin, and trusting never replaces one.
    const [senderUnpinned, setSenderUnpinned] = useState(false);
    const [trustConfirmOpen, setTrustConfirmOpen] = useState(false);
    const [trusting, setTrusting] = useState(false);
    const [trustError, setTrustError] = useState<string | null>(null);
    // The sender's stored signing-key state, loaded for a `signer_key_changed` result (the comparison) and for an
    // unverified signer with no pins (a recorded conflict sends the reader to the contact instead of offering trust).
    // `undefined` when not needed or it couldn't be loaded.
    const [senderKeyState, setSenderKeyState] = useState<SenderKeyState | undefined>(undefined);
    // Whether the reader may update this mailbox (resolving a key change needs it) - `undefined` when unknown.
    const [canUpdateMailbox, setCanUpdateMailbox] = useState<boolean | undefined>(undefined);
    // "Keys changed while you were looking" after a 409, or the outcome of keeping the current key. Survives the
    // re-evaluation that follows.
    const [keyChangeNotice, setKeyChangeNotice] = useState<string | null>(null);
    // "Now", for deciding whether a scheduled send's lease is still live - advanced when the lease runs out.
    const [nowMs, setNowMs] = useState(() => Date.now());
    const { mailboxes } = useMailShell();
    const { requestUnlock } = useUnlockPrompt();
    // Bumped after a successful on-demand unlock to re-run the effect below - it's not a dependency the
    // effect could read reactively otherwise (getUnlockedKeys() is a plain module-level read, not React
    // state; see keySession.ts's own doc comment).
    const [unlockRefresh, setUnlockRefresh] = useState(0);

    // The newest copy of this message known to the Labels popover - normally just the `message` prop,
    // but a successful label toggle's server response is held here too, so a follow-up toggle always
    // builds on the latest `labelUids`/`version` even before (or without) the caller patching its own
    // state via `onLabelsChanged`. A prop copy at least as new (by `version`) always wins.
    const [labelsMessage, setLabelsMessage] = useState<Message>(message);
    const currentLabelsMessage = message.version >= labelsMessage.version ? message : labelsMessage;
    const latestLabelsMessageRef = useRef<Message>(message);
    const rawEvaluationNeeded = needsRawSecurityEvaluation(message);
    // Every address the viewing mailbox receives at (primary first), as one string so the effect below only
    // re-runs when they actually change.
    const readerMailbox = mailboxes.find((mb) => mb.uid === message.mailboxUid);
    const readerAddressesKey = readerMailbox ? [readerMailbox.primarySmtpAddress, ...(readerMailbox.aliasAddresses ?? [])].join(" ") : "";

    // Evaluates a message's security state from its raw MIME - only for a message that can actually be
    // encrypted or signed (see `needsRawSecurityEvaluation()`); anything else is "Unprotected" without a
    // fetch. A detached `multipart/signed` message needs its raw MIME read (a sanitized HTML body never
    // carries the signature part) to tell "Signed & verified" apart from plain "Unprotected". A
    // fetch/parse failure degrades to "Unprotected" (or, for a server-flagged encrypted message, to
    // "Encrypted" with an explanation) rather than hiding the message.
    //
    // `getMessageRawContent()` takes no `AbortSignal`, so a superseded fetch can't be aborted - its
    // result is ignored via `cancelled` instead (and never handed to `evaluateMessageSecurity()`).
    useEffect(() => {
        if (!rawEvaluationNeeded) {
            setSecurity({ state: "unprotected" });
            return;
        }
        let cancelled = false;
        setSecurity(null);
        setSenderUnpinned(false);
        setSenderKeyState(undefined);
        // The sender's trusted signing keys: what key discovery pinned on this mailbox's contacts, plus this
        // mailbox's own signing keys when it sent the message itself. A failed lookup means no pins, which can only
        // ever make a signature "signer not verified", never verified.
        const senderAddress = message.from.address;
        const pinsPromise = getPinnedSignerFingerprints(message.mailboxUid, senderAddress).then(
            (fingerprints) => ({ loaded: true, fingerprints }),
            () => ({ loaded: false, fingerprints: [] as string[] }),
        );
        // Verification seals (see `verificationSeals.ts`) need unlocked keys and the vault's current master key
        // generation; without either the message is evaluated exactly as before, with no seal. The sender's key records
        // are loaded alongside, so a seal can say when the signer key was later revoked as compromised.
        let keyStatePromise: Promise<SenderKeyState | undefined> | undefined;
        const loadKeyState = () => (keyStatePromise ??= getSignerKeyState(message.mailboxUid, senderAddress).catch(() => undefined));
        const sealContextPromise = getUnlockedKeys(message.mailboxUid)
            ? getVaultGeneration(message.mailboxUid).then(async (generation) =>
                  generation === undefined ? undefined : { generation, keyState: await loadKeyState() },
              )
            : undefined;
        getMessageRawContent(message.uid)
            .then(async (rawMime) => {
                if (cancelled) {
                    return;
                }
                const [primaryAddress, ...aliasAddresses] = readerAddressesKey ? readerAddressesKey.split(" ") : [];
                const ownAddresses = readerAddressesKey.toLowerCase().split(" ");
                const ownKeys = ownAddresses.includes(senderAddress.toLowerCase()) ? (readerMailbox!.keys ?? []) : [];
                const ownPins = signingKeyFingerprints(ownKeys);
                const [contactPins, sealContext] = await Promise.all([pinsPromise, sealContextPromise]);
                const pins = [...new Set([...contactPins.fingerprints, ...ownPins])];
                const pinned = pins.length > 0 ? pins : undefined;
                // The raw content is a byte string - only ever handed to evaluateMessageSecurity(), never shown. Keys
                // are read after the pin lookup's await, so a lock that happened meanwhile is honored.
                const unlocked = getUnlockedKeys(message.mailboxUid);
                let result: MessageSecurityResult;
                if (sealContext && unlocked) {
                    const signerKeys = [
                        ...(sealContext.keyState?.pinned ?? []),
                        ...(sealContext.keyState?.previous ?? []),
                        ...ownKeys,
                    ];
                    result = await evaluateMessageSecurityWithSeal(rawMime, unlocked, pinned, primaryAddress, {
                        mailboxUid: message.mailboxUid,
                        messageUid: message.uid,
                        ...currentVerificationSeal(message),
                        masterKeyGeneration: sealContext.generation,
                        signerKeys,
                    }).catch(() =>
                        // Only a lock while sealing throws: evaluate as locked (the lock itself re-evaluates too).
                        evaluateMessageSecurity(rawMime, undefined, pinned, primaryAddress),
                    );
                    if (result.sealToWrite) {
                        // Best effort and in the background: never awaited, never shown.
                        void sendVerificationSeal(message.uid, result.sealToWrite);
                    }
                } else {
                    result = await evaluateMessageSecurity(rawMime, unlocked, pinned, primaryAddress);
                }
                // Only one reader address can be checked per evaluation: a message sent to one of this mailbox's
                // aliases isn't "not addressed to you", so each alias is tried before saying so.
                for (const alias of aliasAddresses) {
                    if (!result.notAddressedToReader) {
                        break;
                    }
                    const viaAlias = await evaluateMessageSecurity(rawMime, unlocked, pinned, alias);
                    result = { ...result, notAddressedToReader: viaAlias.notAddressedToReader };
                }
                const unpinned = contactPins.loaded && pins.length === 0;
                const keyChanged = signerKeyChanged(result);
                const [keyState, access] = await Promise.all([
                    keyChanged || (unpinned && UNVERIFIED_SIGNER_STATES.has(result.state)) ? loadKeyState() : undefined,
                    keyChanged ? getMyMailboxAccess(message.mailboxUid).then((a) => a.canUpdate, () => undefined) : undefined,
                ]);
                if (!cancelled) {
                    setSecurity(result);
                    setSenderUnpinned(unpinned);
                    setSenderKeyState(keyState);
                    setCanUpdateMailbox(access);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setSecurity(
                        message.encrypted ? { state: "encrypted", decryptError: ENCRYPTED_LOAD_ERROR } : { state: "unprotected" },
                    );
                }
            });
        return () => {
            cancelled = true;
        };
    }, [message.uid, message.mailboxUid, message.from.address, message.encrypted, rawEvaluationNeeded, unlockRefresh, readerAddressesKey]);

    // Decrypted plaintext must not outlive the key session that produced it: the moment this mailbox's
    // keys are destroyed (logout, idle timeout, explicit lock), drop the recovered html/text and
    // re-evaluate - an encrypted message then falls back to its "Unlock to view" state.
    useEffect(
        () =>
            subscribeKeySession((event) => {
                if (event.mailboxUid === message.mailboxUid && event.state === "locked") {
                    setSecurity(null);
                    setUnlockRefresh((n) => n + 1);
                }
            }),
        [message.mailboxUid],
    );

    // While restapi's ScheduledSendJob holds a send lease the message is being relayed: cancelling or moving it would be
    // refused (409/403), so the Outbox controls are replaced by "Sending...". When the lease runs out the message is
    // re-read - it has either been sent (and left Outbox) or been released back to its schedule.
    const leaseExpiresMs = message.scheduledSendLeaseExpiresAt ? Date.parse(message.scheduledSendLeaseExpiresAt) : NaN;
    const sendInProgress = inOutbox && leaseExpiresMs > nowMs;
    useEffect(() => {
        if (!sendInProgress) {
            return;
        }
        const timer = setTimeout(() => {
            setNowMs(Date.now());
            void reloadMessage();
        }, leaseExpiresMs - nowMs + 1);
        return () => clearTimeout(timer);
    }, [sendInProgress, leaseExpiresMs, nowMs]);

    async function reloadMessage() {
        try {
            setReloaded(await getMessage(message.uid));
            setNowMs(Date.now());
        } catch {
            // Keep showing what we have - the next refused action or lease expiry tries again.
        }
    }

    // Offered only when this device genuinely has no unlocked session for this message's mailbox at all
    // (as opposed to being unlocked but still unable to decrypt - a wrong/since-rotated key, which
    // re-unlocking the same session can't fix) - see `evaluateMessageSecurity()`'s own doc comment on why
    // `decryptError` alone can't distinguish those two cases.
    async function handleUnlockToView() {
        const mailboxUid = message.mailboxUid;
        const mailboxKeys = mailboxes.find((mb) => mb.uid === mailboxUid)?.keys ?? [];
        try {
            await requestUnlock(mailboxUid, mailboxKeys);
            setUnlockRefresh((n) => n + 1);
        } catch {
            // User dismissed the unlock dialog - security state stays exactly as it was.
        }
    }

    // Only ever invoked from the "Trust this signer" dialog, which only opens for an unverified-signer result carrying
    // `signerCertificate`. The pin goes on the contact in the mailbox the message belongs to; the evaluation is then
    // re-run against a fresh pinned-signer lookup, so the badge turns verified.
    async function handleTrustSigner(address: string, certificate: string) {
        setTrusting(true);
        setTrustError(null);
        try {
            await trustSigner(message.mailboxUid, { address, certificate });
            clearPinnedSignerCache();
            setTrustConfirmOpen(false);
            setUnlockRefresh((n) => n + 1);
        } catch (err) {
            setTrustError(trustSignerErrorMessage(err));
        } finally {
            setTrusting(false);
        }
    }

    // After a key change was accepted or kept (or the pinned key moved meanwhile): the pinned signers are re-read and
    // the message re-evaluated, so an accepted key turns the badge verified.
    function refreshAfterKeyChange(notice: string | null) {
        setKeyChangeNotice(notice);
        clearPinnedSignerCache();
        setUnlockRefresh((n) => n + 1);
    }

    // Reply, Reply All and Forward first load the full body to quote (see `loadQuotedBody()`), so the buttons are
    // disabled meanwhile - a second click would open a second window. An encrypted original keeps its reply
    // encrypted, since the quote may carry its decrypted content.
    const [preparingCompose, setPreparingCompose] = useState(false);

    /** The replying mailbox's own addresses (primary and aliases), which a reply never goes to - from the mail shell's
     * mailbox list, else fetched; none when neither is available. */
    async function ownAddresses(): Promise<string[]> {
        const mailbox = readerMailbox ?? (await getMailbox(message.mailboxUid).catch(() => undefined));
        return mailbox ? [mailbox.primarySmtpAddress, ...(mailbox.aliasAddresses ?? [])] : [];
    }

    async function handleReplyOrForward(kind: "reply" | "replyAll" | "forward") {
        setPreparingCompose(true);
        try {
            const [original, own] = await Promise.all([
                loadOriginalMessage(message, security, { recipients: kind === "replyAll" }),
                kind === "forward" ? [] : ownAddresses(),
            ]);
            const encrypt = !!message.encrypted;
            // What makes the new message part of this one's thread rather than a conversation of its own:
            // the server composes the MIME from the recipients, subject and HTML alone, so nothing else
            // recovers what is being replied to. A forward carries it for the same reason - it continues
            // the thread it came from, which is where its recipient will file the reply to it.
            const threading = buildReplyThreading(message);
            if (kind === "forward") {
                openCompose({
                    mailboxUid: message.mailboxUid,
                    subject: forwardSubject(message.subject),
                    quotedHtml: buildForwardQuote(message, original.body),
                    signatureContext: "reply_forward",
                    encrypt,
                    threading,
                });
                return;
            }
            // The message's own recipients are only the envelope recipient of a delivered message, so Reply All
            // answers whoever its headers actually name, with anything the record holds that they don't.
            const known = new Set((original.recipients ?? []).map((r) => r.address.trim().toLowerCase()));
            const recipients = buildReplyRecipients(
                { ...message, recipients: [...(original.recipients ?? []), ...message.recipients.filter((r) => !known.has(r.address.trim().toLowerCase()))] },
                own,
                kind === "replyAll",
            );
            const format = (list: Recipient[]) => list.map((r) => formatRecipient(r)).join(", ");
            openCompose({
                mailboxUid: message.mailboxUid,
                to: format(recipients.to),
                cc: recipients.cc.length > 0 ? format(recipients.cc) : undefined,
                subject: replySubject(message.subject),
                quotedHtml: buildReplyQuote(message, original.body),
                signatureContext: "reply_forward",
                suppressSigning: isLikelyMailingList({ listUnsubscribe: message.listUnsubscribeHeader }),
                encrypt,
                threading,
            });
        } finally {
            setPreparingCompose(false);
        }
    }

    async function handleRecall() {
        // Only ever invoked from the confirmation modal below, which itself only renders once `message`
        // is loaded (the early return above covers the only other state) — the non-null assertion
        // reflects that real invariant, matching this codebase's established pattern for the same class
        // of always-true-in-practice guard.
        setRecalling(true);
        setError(null);
        try {
            const updated = await recallMessage(message.uid);
            setConfirming(false);
            onRecalled?.(updated);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not recall this message.");
        } finally {
            setRecalling(false);
        }
    }

    // Only ever invoked from the "Cancel" button below (`isOutbox` and `message.scheduledSendTime` both truthy -
    // `draftsFolderUid` is required whenever `isOutbox` is, see the prop's own doc comment), or from "Move to
    // Drafts" (an Outbox message with no active schedule, which checks `draftsFolderUid` itself), so the non-null
    // assertion reflects a real invariant, matching `handleRecall`'s identical pattern just above.
    async function handleCancelScheduledSend() {
        setCanceling(true);
        setCancelError(null);
        try {
            const updated = await cancelScheduledSend(message, draftsFolderUid!);
            // Keeps a `folder:`-scoped Tier 2 local search from still finding it in its old folder.
            void moveLocalEntity(updated.mailboxUid, updated.uid, updated.folderUid);
            onScheduledSendCanceled?.(updated);
        } catch (err) {
            const fallback = message.scheduledSendTime ? "Could not cancel this scheduled send." : "Could not move this message to Drafts.";
            setCancelError(err instanceof ApiRequestError ? err.message : fallback);
            // A conflict or refusal usually means the send job claimed (or already relayed) the message meanwhile -
            // re-read it so the pane shows "Sending..." or its new state instead of the stale controls.
            if (err instanceof ApiRequestError && (err.status === 409 || err.status === 403)) {
                void reloadMessage();
            }
        } finally {
            setCanceling(false);
        }
    }

    // Only ever invoked from the Archive button below, which itself only renders once `message` is
    // loaded and this isn't a Drafts/Outbox message (the button's own guard mirrors
    // `BaseMessageRoute.archive()`'s server-side 400) — same real invariant as `handleRecall` above.
    async function handleArchive() {
        setArchiving(true);
        setArchiveError(null);
        try {
            const updated = await archiveMessage(message.uid);
            void moveLocalEntity(updated.mailboxUid, updated.uid, updated.folderUid);
            onArchived?.(updated);
        } catch (err) {
            setArchiveError(err instanceof ApiRequestError ? err.message : "Could not archive this message.");
        } finally {
            setArchiving(false);
        }
    }

    // Only ever invoked from the Labels menu below, which itself only renders once `message` is loaded.
    // Several labels are ticked in the menu and saved together here, in one `setMessageLabels()` call:
    // that call replaces the whole `labelUids` list rather than patching one entry, so a menu that saved
    // per tick would send a request (and burn an optimistic-lock `version`) for every single tick.
    //
    // The list is computed from the newest copy known (`latestLabelsMessageRef`, never a stale render
    // closure), so a save that follows another still carries the `version` the server last handed back.
    async function handleApplyLabels(labelUids: string[]) {
        setSavingLabels(true);
        setLabelsError(null);
        try {
            const base = message.version >= latestLabelsMessageRef.current.version ? message : latestLabelsMessageRef.current;
            const updated = await setMessageLabels(base, labelUids);
            latestLabelsMessageRef.current = updated;
            setLabelsMessage(updated);
            onLabelsChanged?.(updated);
        } catch (err) {
            setLabelsError(err instanceof ApiRequestError ? err.message : "Could not update this message's labels.");
        } finally {
            setSavingLabels(false);
        }
    }

    /**
     * Moves this message into the folder picked in the Move to prompt. Deliberately *not* caught here:
     * `MoveToFolderDialog` shows a failure beside the destination that would retry it, and closes only
     * once the move has actually landed.
     *
     * The move is awaited on its own line rather than written as `onMoved?.(await moveMessage(...))` -
     * an optional call whose callee is absent never evaluates its arguments at all, so a caller that
     * passes no `onMoved` would have had nothing moved while the prompt closed as if it had.
     */
    async function handleMove(folderUid: string) {
        const updated = await moveMessage(message, folderUid);
        onMoved?.(updated);
    }

    // Only ever invoked from the pending-receipt banner below, which itself only renders once `message`
    // is loaded — same real invariant as every other handler above.
    async function handleReceipt(type: ReceiptType, action: "approve" | "decline") {
        setReceiptBusy(type);
        setReceiptError(null);
        try {
            const updated = await (action === "approve" ? approveReceipt : declineReceipt)(message.uid, type);
            onReceiptHandled?.(updated);
        } catch (err) {
            setReceiptError(err instanceof ApiRequestError ? err.message : "Could not handle this receipt request.");
        } finally {
            setReceiptBusy(null);
        }
    }

    const verified = security !== null && VERIFIED_STATES.has(security.state);
    // A seal proves the signature verified when first opened, and the live check still passed everything but the signer
    // key's status - so the signed Subject and attachments are shown as for a verified message, under its own badge.
    const verifiedOrSealed = verified || security?.state === "verified_at_first_open";
    // Under a verified badge, the Subject shown is the one the signature covers (RFC 9788 protected headers), when
    // the message carries one - the outer Subject is unsigned and anyone relaying the message could change it.
    const protectedSubject = verifiedOrSealed ? security.protectedHeaders?.subject : undefined;
    // Only meaningful for signed-only mail: an encrypted message's outer Subject is deliberately obscured. Not a
    // signature failure (mailing lists legitimately tag subjects), just worth pointing out.
    const subjectDiffers = protectedSubject !== undefined && (security!.state === "signed_verified" || security!.sealedState === "signed_verified") && protectedSubject !== message.subject;
    // Attachments inside the signed/decrypted entity. Under a verified badge only these are listed - the server's
    // attachment records also include parts outside the signature, which the badge doesn't vouch for. For decrypted
    // mail the server only ever saw the encrypted blob, so these are the real attachments.
    // A decrypted message whose signature failed still only has these (the server list is just `smime.p7m`); they're
    // listed with a warning. A signed-only failure never carries recovered attachments.
    const innerAttachments =
        security?.attachments !== undefined &&
        (verifiedOrSealed || security.state === "encrypted" || security.state === "encrypted_unverified_signer" || security.state === "signature_failed")
            ? security.attachments
            : undefined;
    // Any state that involves a signature shows the address actually signed for (the protected From when the message
    // carries one - it equals the outer From's address, or verification would have failed) next to the badge, never a
    // display name alone: anyone can put "ceo@corp.com" in the name of a message sent from x@corp-pay.com.
    const signatureShown = security !== null && security.state !== "unprotected" && security.state !== "encrypted";
    const senderAddress = (signatureShown ? extractAddresses(security.protectedHeaders?.from)[0] : undefined) ?? message.from.address;
    const senderName = message.from.displayName;
    const senderNameCheck = checkSenderName(senderName, senderAddress);
    // Always `Name <address>` (or the bare address): a name alone hides who a message is really from.
    const senderLabel = formatMailAddress({ displayName: senderName, address: senderAddress });
    // Offered only for a valid signature from a certificate nobody pinned for this sender - never to replace a pin.
    // A recorded signing-key conflict for this sender is resolved from the contact, never by trusting another key.
    const pendingConflict = senderUnpinned && senderKeyState?.conflict !== undefined;
    const trustableCertificate =
        security !== null && UNVERIFIED_SIGNER_STATES.has(security.state) && senderUnpinned && !pendingConflict
            ? security.signerCertificate
            : undefined;
    const keyChanged = security && signerKeyChanged(security) ? security : undefined;
    const pinnedSignerKey = senderKeyState?.pinned[0];
    const recordedConflict =
        keyChanged && sameFingerprint(senderKeyState?.conflict?.observedKey.fingerprint, keyChanged.signerFingerprint)
            ? senderKeyState!.conflict
            : undefined;

    const shownSubject = (protectedSubject ?? message.subject) || "(no subject)";
    /**
     * How tall the message body is - the one thing on this pane worth every pixel it can have.
     *
     * The same rule in both places: the pane is a full-height flex column and the body is its one growing
     * child, so it fills whatever the header leaves (`min-h-0` on both, or a tall body would stretch the
     * column past the pane instead of scrolling inside it). Inside a thread that height comes from the
     * message's own row, which `ConversationThreadPane` gives `min-h-full` of its scrolling list - so the
     * height is still the window's, resolved down the flex chain rather than written here as a `vh`
     * number, and it follows a resize with no breakpoint to cross.
     *
     * Why not size it to its content: that would need the document *inside* the frame to measure and
     * report itself, and these frames are `sandbox=""` - scripts off - because they render mail from
     * strangers. So a message longer than the pane keeps its own scrollbar, and everything shorter shows
     * whole with the frame reaching the bottom of the pane either way.
     */
    const bodyClassName = "flex-1 min-h-0 w-full";

    return (
        // `h-full` outside a thread only: the standalone message route renders this pane straight into a
        // *block* (`MailShell`'s own `<main>`), where nothing stretches it and a percentage of that block's
        // own resolved height is the height. Inside a thread the parent is a flex row whose own height came
        // out of the flex algorithm - Chrome won't resolve a percentage against that, and an explicit
        // height would also opt the pane out of the stretching that does size it correctly there.
        <div className={`flex-1 min-w-0 min-h-0 flex flex-col${inThread ? "" : " h-full"}`}>
            <div className="border-b border-border p-4">
                {backHref && (
                    <a href={backHref} className="text-sm text-primary-dark hover:underline block mb-2">
                        &larr; Back to messages
                    </a>
                )}
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                        {/* One `h1` per document: inside a thread the conversation's own subject is it. */}
                        {inThread ? (
                            <h3 className="text-sm font-semibold truncate">{shownSubject}</h3>
                        ) : (
                            <h1 className="text-lg font-bold tracking-tight truncate">{shownSubject}</h1>
                        )}
                        {security && <SecurityIndicator security={security} />}
                    </div>
                    {sendInProgress && (
                        <span className="text-xs font-medium text-text-muted shrink-0 py-1 px-2.5 rounded-pill bg-surface-alt">
                            Sending&hellip;
                        </span>
                    )}
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
                    {inOutbox && !sendInProgress && message.scheduledSendTime && (
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
                    {/* A message left in Outbox with no active schedule - a scheduled send that failed or was refused
                        (restapi's ScheduledSendJob clears scheduledSendTime and leaves it there), which can't be sent
                        again from Outbox (409) or archived - would otherwise be stuck. Moving it back to Drafts works for
                        any Outbox message. */}
                    {inOutbox && !sendInProgress && !message.scheduledSendTime && draftsFolderUid && (
                        <Button
                            type="button"
                            variant="secondary"
                            className="!w-auto shrink-0"
                            loading={canceling}
                            disabled={canceling}
                            onClick={handleCancelScheduledSend}
                        >
                            Move to Drafts
                        </Button>
                    )}
                </div>
                {inOutbox && message.scheduledSendError && (
                    <div className="mt-2">
                        <Alert>This message wasn&rsquo;t sent: {message.scheduledSendError}</Alert>
                    </div>
                )}
                {cancelError && (
                    <div className="mt-2">
                        <Alert>{cancelError}</Alert>
                    </div>
                )}
                {keyChangeNotice && (
                    <p role="status" className="mt-2 py-2 px-3 rounded-sm text-sm bg-surface-alt text-text">
                        {keyChangeNotice}
                    </p>
                )}
                {security && UNVERIFIED_SIGNER_STATES.has(security.state) && (
                    // Informational: the signature is intact, but nothing ties its certificate to this sender - anyone can
                    // create a certificate naming any address. "Trust this signer" (below) pins it once the reader has
                    // confirmed the fingerprint.
                    <p role="status" className="mt-2 py-2 px-3 rounded-sm text-sm bg-surface-alt text-text">
                        Signed, but the signer isn&rsquo;t a trusted contact key, so the sender isn&rsquo;t verified.
                        {security.signerEmails && security.signerEmails.length > 0 && <> Certificate for {security.signerEmails.join(", ")}.</>}
                        {security.signerFingerprint && (
                            <>
                                {" "}
                                Fingerprint <span className="font-mono text-xs break-all">{security.signerFingerprint}</span>.
                            </>
                        )}
                    </p>
                )}
                {pendingConflict && (
                    // Only an unverified signer's result loads the key state while the sender is unpinned, and a conflict
                    // always comes from a matching contact, so its uid is known.
                    <p role="status" className="mt-2 py-2 px-3 rounded-sm text-sm bg-warning/15 text-text">
                        This sender has a signing key change waiting for your review, so this signer can&rsquo;t be trusted from
                        here.{" "}
                        <a
                            href={`/contacts/${encodeURIComponent(senderKeyState.contactUid!)}`}
                            className="font-medium text-primary-dark hover:underline"
                        >
                            Review it in Contacts
                        </a>
                    </p>
                )}
                {trustableCertificate && (
                    <div className="mt-1.5">
                        <Button
                            type="button"
                            variant="secondary"
                            className="!w-auto"
                            disabled={trusting}
                            onClick={() => {
                                setTrustError(null);
                                setTrustConfirmOpen(true);
                            }}
                        >
                            Trust this signer
                        </Button>
                    </div>
                )}
                {subjectDiffers && (
                    <p role="status" className="mt-2 py-2 px-3 rounded-sm text-sm bg-surface-alt text-text">
                        The subject shown above is the one the sender signed. It differs from the subject this message was
                        delivered with (&ldquo;{message.subject}&rdquo;), which may have been changed on the way, e.g. by a
                        mailing list.
                    </p>
                )}
                {security?.headerTamperDetected && (
                    <div className="mt-2">
                        <Alert>
                            This message's visible From/To/Cc/Date/Subject don't match what the sender actually signed or
                            encrypted — an intermediary may have altered them after sending. Treat the fields shown above with
                            caution.
                        </Alert>
                    </div>
                )}
                {security?.state === "verified_at_first_open" && (
                    // A seal outranks only a key-status failure (see `evaluateMessageSecurityWithSeal()`). A signer key
                    // later reported compromised is a warning, never reassurance.
                    <p
                        role="status"
                        className={`mt-2 py-2 px-3 rounded-sm text-sm text-text ${security.laterCompromised ? "bg-warning/15" : "bg-surface-alt"}`}
                    >
                        {verifiedAtFirstOpenMessage(security)}
                    </p>
                )}
                {keyChanged && (
                    <section aria-label="Signing key changed" className="mt-2 py-3 px-3 rounded-sm text-sm bg-warning/15 text-text flex flex-col gap-2">
                        <h2 className="font-semibold">This sender&rsquo;s signing key changed</h2>
                        <p>
                            The signature on this message is valid and its certificate names {senderAddress}, but it was made
                            with a different key than the one you trust for this sender
                            {keyChanged.state === "verified_at_first_open" ? "." : <>, so it isn&rsquo;t verified.</>}
                        </p>
                        <KeyChangeReview
                            mailboxUid={message.mailboxUid}
                            address={senderAddress}
                            useType="sign"
                            ownerName="the sender"
                            current={pinnedSignerKey && { fingerprint: pinnedSignerKey.fingerprint, since: senderKeyState.pinnedSince! }}
                            proposed={{
                                fingerprint: keyChanged.signerFingerprint!,
                                emails: keyChanged.signerEmails,
                                observedAt: recordedConflict?.observedAt,
                                source: recordedConflict?.source,
                            }}
                            certificate={keyChanged.signerCertificate}
                            canReject={recordedConflict !== undefined}
                            canResolve={canUpdateMailbox}
                            onResolved={(action) => refreshAfterKeyChange(action === "reject" ? KEPT_CURRENT_SIGNING_KEY_MESSAGE : null)}
                            onPinnedKeyChanged={() => refreshAfterKeyChange(KEY_CHANGE_STALE_MESSAGE)}
                        />
                    </section>
                )}
                {security?.state === "signature_failed" && !keyChanged && (
                    // Deliberately an informational notice, not an error `Alert`: an unverifiable signature
                    // means "don't trust the signer", not "this message is broken" - the body stays readable.
                    <p role="status" className="mt-2 py-2 px-3 rounded-sm text-sm bg-surface-alt text-text">
                        {security.signatureFailureReason
                            ? SIGNATURE_FAILURE_MESSAGE[security.signatureFailureReason]
                            : GENERIC_SIGNATURE_FAILURE_MESSAGE}
                    </p>
                )}
                {verifiedOrSealed && !security.protectedHeaders && (
                    // A legacy S/MIME sender signs only the body: the outer Subject/To/Cc shown here were never signed.
                    <p role="status" className="mt-2 py-2 px-3 rounded-sm text-sm bg-surface-alt text-text">
                        The signature covers this message&rsquo;s content and attachments only. Its Subject, To and Cc
                        weren&rsquo;t signed, so they could have been changed after it was sent.
                    </p>
                )}
                {security?.notAddressedToReader && (
                    // Informational, like the notice above: a Bcc recipient legitimately sees this too.
                    <p role="status" className="mt-2 py-2 px-3 rounded-sm text-sm bg-surface-alt text-text">
                        The recipients this message was signed or encrypted for don&rsquo;t include this mailbox - it may have
                        been forwarded or re-sent to you unchanged, or you were Bcc&rsquo;d.
                    </p>
                )}
                <p className="text-sm text-text-muted mt-1 break-words">
                    From <span className="font-medium text-text">{senderLabel}</span> &middot;{" "}
                    {new Date(message.receivedDate).toLocaleString()}
                </p>
                {senderNameCheck.misleading && (
                    <p role="status" className="mt-2 py-2 px-3 rounded-sm text-sm bg-warning/15 text-text">
                        The sender&rsquo;s name &ldquo;{senderName}&rdquo; looks like an email address, but this message was
                        sent from <span className="font-medium">{senderAddress}</span>. Don&rsquo;t trust it based on the name.
                    </p>
                )}
                {/* Every recipient with their address, grouped as the sender addressed them; a long list folds. */}
                <RecipientLine label="To" recipients={message.recipients.filter((r) => r.type !== "cc" && r.type !== "bcc")} />
                <RecipientLine label="Cc" recipients={message.recipients.filter((r) => r.type === "cc")} />
                <RecipientLine label="Bcc" recipients={message.recipients.filter((r) => r.type === "bcc")} />
                {/* Wraps: in a thread the pane can be as narrow as the reading pane gets (the list takes
                    384px of it), and these are six controls. */}
                <div className="flex flex-wrap gap-1 mt-3">
                    <IconAction
                        icon={<HiOutlineArrowUturnLeft size={16} aria-hidden="true" />}
                        label="Reply"
                        disabled={preparingCompose}
                        onClick={() => void handleReplyOrForward("reply")}
                    />
                    <IconAction
                        icon={
                            // The conventional reply-all glyph: the reply arrow, doubled. `hi2` has no
                            // reply-all icon of its own, and nothing else in it means "answer everyone".
                            <span className="inline-flex items-center" aria-hidden="true">
                                <HiOutlineArrowUturnLeft size={16} />
                                <HiOutlineArrowUturnLeft size={16} className="-ml-2.5" />
                            </span>
                        }
                        label="Reply All"
                        disabled={preparingCompose}
                        onClick={() => void handleReplyOrForward("replyAll")}
                    />
                    <IconAction
                        icon={<HiOutlineArrowUturnRight size={16} aria-hidden="true" />}
                        label="Forward"
                        disabled={preparingCompose}
                        onClick={() => void handleReplyOrForward("forward")}
                    />
                    {!inOutbox && message.folderUid !== draftsFolderUid && (
                        <IconAction
                            icon={<HiOutlineArchiveBox size={16} aria-hidden="true" />}
                            label="Archive"
                            busy={archiving}
                            disabled={archiving}
                            onClick={handleArchive}
                        />
                    )}
                    {folders && folders.length > 0 && (
                        <IconAction
                            icon={<HiOutlineFolderArrowDown size={16} aria-hidden="true" />}
                            label="Move to"
                            onClick={() => setMovePrompt(true)}
                        />
                    )}
                    {labels && labels.length > 0 && (
                        <LabelMenuButton
                            aria-label="Labels"
                            label="Labels"
                            className="border border-border py-1.5"
                            labels={labels}
                            mailboxUid={message.mailboxUid}
                            onLabelCreated={onLabelCreated}
                            applied={currentLabelsMessage.labelUids ?? []}
                            onCommit={(labelUids) => void handleApplyLabels(labelUids)}
                            busy={savingLabels}
                            note="Ticked labels are applied to this message and unticked ones removed."
                            emptyNote="This mailbox has no labels yet."
                            commit={{ label: "Apply" }}
                            clear={{ label: "Remove all labels" }}
                        />
                    )}
                </div>
                {archiveError && (
                    <div className="mt-2">
                        <Alert>{archiveError}</Alert>
                    </div>
                )}
                {labelsError && (
                    <div className="mt-2">
                        <Alert>{labelsError}</Alert>
                    </div>
                )}
                {labels && (currentLabelsMessage.labelUids?.length ?? 0) > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                        {currentLabelsMessage
                            .labelUids!.map((uid) => labels.find((l) => l.uid === uid))
                            .filter((l): l is Label => !!l)
                            .map((l) => (
                                <span
                                    key={l.uid}
                                    className="inline-flex items-center gap-1.5 text-xs font-medium py-1 px-2.5 rounded-pill bg-surface-alt"
                                >
                                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: l.color ?? "#6366f1" }} />
                                    {l.name}
                                </span>
                            ))}
                    </div>
                )}
                {/* A failed reclassification is reported inside the confirmation dialog it was started
                    from, next to the Move button that would retry it - not out here behind it. */}
                {(["delivery", "read"] as const)
                    .filter((type) => (type === "delivery" ? message.deliveryReceiptPending : message.readReceiptPending))
                    .map((type) => (
                        <div
                            key={type}
                            className="flex flex-wrap items-center gap-2 mt-2 py-2 px-3 rounded-sm bg-surface-alt text-sm"
                        >
                            <span>
                                {senderLabel} requested a {type} receipt for this
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
                {security?.state === "signature_failed" && innerAttachments && innerAttachments.length > 0 && (
                    <p role="status" className="mt-3 py-2 px-3 rounded-sm text-sm bg-warning/15 text-text">
                        These attachments come from a message whose signature couldn&rsquo;t be verified. Open them only if
                        you trust the sender.
                    </p>
                )}
                {innerAttachments
                    ? innerAttachments.length > 0 && (
                          <ul className="flex flex-wrap gap-2 mt-3">
                              {innerAttachments.map((attachment, index) => (
                                  <li key={`${index}:${attachment.filename ?? ""}`}>
                                      <button
                                          type="button"
                                          onClick={() => downloadMimeAttachment(attachment)}
                                          className="text-xs font-medium py-1 px-2.5 rounded-pill bg-surface-alt text-text-muted hover:text-primary-dark"
                                      >
                                          {attachment.filename ?? `Unnamed ${attachment.contentType} attachment`}
                                      </button>
                                  </li>
                              ))}
                          </ul>
                      )
                    : attachments.length > 0 && (
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
            {security?.decryptError && (
                <div className="px-4 pt-2">
                    <Alert>{security.decryptError}</Alert>
                    {!getUnlockedKeys(message.mailboxUid) && (
                        <button
                            type="button"
                            onClick={handleUnlockToView}
                            className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary-dark hover:underline"
                        >
                            <HiOutlineLockClosed size={12} aria-hidden="true" />
                            Unlock to view this message
                        </button>
                    )}
                </div>
            )}
            {security?.text !== undefined ? (
                // A recovered text/plain body renders as text (React escapes it) - never as markup.
                <pre
                    aria-label={message.subject || "Message content"}
                    className={`${bodyClassName} overflow-auto p-4 m-0 text-sm font-sans whitespace-pre-wrap break-words`}
                >
                    {security.text}
                </pre>
            ) : security?.html !== undefined ? (
                // A decrypted/verified body never came through the server's own sanitize-html pass (it
                // couldn't - the server never saw the plaintext) - it's sanitized here, client-side, before
                // it ever touches the DOM (remote images/stylesheets/`url()`s stripped too, so opening it
                // can't ping a tracker), behind a no-remote-loads CSP, on top of the iframe's `sandbox=""`.
                <iframe
                    key={message.uid}
                    title={message.subject || "Message content"}
                    srcDoc={buildSecureSrcDoc(security.html)}
                    sandbox=""
                    className={`${bodyClassName} border-0`}
                />
            ) : (
                <iframe
                    key={message.uid}
                    title={message.subject || "Message content"}
                    src={`/api/mail/messages/${encodeURIComponent(message.uid)}/content`}
                    sandbox=""
                    className={`${bodyClassName} border-0`}
                />
            )}

            <MoveToFolderDialog
                open={movePrompt}
                onClose={() => setMovePrompt(false)}
                mailboxUid={message.mailboxUid}
                folders={folders ?? []}
                currentFolderUid={message.folderUid}
                onMove={handleMove}
                onFolderCreated={onFolderCreated}
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
            <Modal
                open={trustConfirmOpen && !!trustableCertificate}
                onClose={() => !trusting && setTrustConfirmOpen(false)}
                title="Trust this signer?"
            >
                <div className="flex flex-col gap-3 text-sm">
                    <p>
                        Mail from <span className="font-medium">{senderAddress}</span> signed with this certificate will show as
                        verified.
                    </p>
                    <dl className="flex flex-col gap-1">
                        <dt className="text-xs text-text-muted">Certificate issued to</dt>
                        <dd>{security?.signerEmails?.length ? security.signerEmails.join(", ") : "No email address"}</dd>
                        <dt className="text-xs text-text-muted">Fingerprint</dt>
                        <dd className="font-mono text-xs break-all">
                            {security?.signerFingerprint ? formatFingerprint(security.signerFingerprint) : "Unknown"}
                        </dd>
                    </dl>
                    <p className="text-text-muted">
                        Anyone can create a certificate naming any address. Before trusting it, confirm this fingerprint with
                        the sender through another channel, such as a phone call.
                    </p>
                    {trustError && <Alert>{trustError}</Alert>}
                    <div className="flex gap-3">
                        <Button
                            type="button"
                            className="!w-auto"
                            loading={trusting}
                            disabled={trusting}
                            onClick={() => handleTrustSigner(senderAddress, trustableCertificate!)}
                        >
                            Trust
                        </Button>
                        <Button
                            type="button"
                            variant="secondary"
                            className="!w-auto"
                            disabled={trusting}
                            onClick={() => setTrustConfirmOpen(false)}
                        >
                            Cancel
                        </Button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
