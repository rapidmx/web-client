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
    HiOutlineMoon,
    HiOutlineNoSymbol,
    HiOutlineSun,
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
import MoveToFolderDialog from "./MoveToFolderDialog.js";
import InviteCard from "./InviteCard.js";
import { isCalendarAttachment } from "./invite/inviteFormat.js";
import { useMessageInvite } from "./invite/inviteStore.js";
import { getUnlockedKeys, subscribeKeySession } from "@rapidmx/react-shared/crypto/keySession.js";
import type { MessageSecurityResult, SignatureFailureReason } from "@rapidmx/react-shared/crypto/messageSecurity.js";
import { extractAddresses, type MimeAttachment } from "@rapidmx/react-shared/crypto/mime.js";
import { SignerKeyConflictError, signingKeyFingerprints, trustSigner } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { isLikelyMailingList } from "@rapidmx/react-shared/crypto/composeSecurity.js";
import { SenderKeyState, clearPinnedSignerCache, getPinnedSignerFingerprints, getSignerKeyState } from "./pinnedSigners.js";
import { currentVerificationSeal, getVaultGeneration, sendVerificationSeal } from "./verificationSeals.js";
import { getMyMailboxAccess } from "@rapidmx/react-shared/mail/mailboxAccessApi.js";
import KeyChangeReview from "../contacts/KeyChangeReview.js";
import { KEY_CHANGE_STALE_MESSAGE, sameFingerprint } from "../contacts/contactKeys.js";
import { ComposeLateInput, prefetchComposeWindow, useCompose } from "./compose/ComposeContext.js";
import { loadOriginalMessage, prefetchOriginalMessage } from "./compose/quotedBody.js";
import { formatRecipient } from "./compose/recipients.js";
import { formatMailAddress } from "@rapidmx/react-shared/mail/mailAddress.js";
import MailAddress, { RecipientLine } from "./MailAddress.js";
import { useMailShell } from "./layout/MailShell.js";
import { ariaKeyShortcuts, withHint } from "../../keyboard/format.js";
import { SHORTCUTS, ShortcutDef } from "../../keyboard/keymap.js";
import { useKeyEnvironment } from "../../keyboard/ShortcutProvider.js";
import { useShortcut } from "../../keyboard/useShortcut.js";
import { useUnlockPrompt } from "../layout/UnlockPromptProvider.js";
import { moveLocalEntity } from "../../search/localIndexRpcClient.js";
import { useNavigate } from "../../navigation/routerContext.js";
import { notify } from "../../notifications/store.js";
import { notifyApiError } from "../../notifications/apiErrors.js";
import { useMailboxUpdateAccess } from "../../mail/useMailboxUpdateAccess.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import LabelMenuButton from "./labelMenu.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import EncryptedBody from "./reading/EncryptedBody.js";
import { displaySubject } from "./reading/EncryptedPreview.js";
import MessageBody, { BodySkeleton } from "./reading/MessageBody.js";
import { BODY_FONT_STYLE, CardShell, SenderAvatar, SubjectCard } from "./reading/MessageCard.js";
import MessageMoreMenu, { MessageMenuActions } from "./reading/MessageMoreMenu.js";
import MessageSourceDialog, { SourceMode, SourceState } from "./reading/MessageSourceDialog.js";
import { useMessageActions } from "./reading/useMessageActions.js";
import { saveAsEml } from "./reading/messageExport.js";
import { buildPrintDocument, printDocument } from "./reading/printMessage.js";
import { type BodyContent, fetchBodyContent } from "./reading/bodyContent.js";
import { useViewOriginal } from "./reading/viewOriginal.js";
import { ROW_FOCUS_CLASS, UnreadLabel, dateClass, senderClass } from "./unreadStyle.js";

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
/** The look of the card's round icon buttons, shared with the "More actions" trigger. */
const ICON_BUTTON_CLASS =
    "inline-flex items-center justify-center p-1.5 rounded-md border border-border text-sm text-text hover:bg-surface-alt disabled:opacity-50 disabled:hover:bg-transparent";

function IconAction({
    icon,
    label,
    onClick,
    disabled,
    reason,
    busy,
    onPrefetch,
    shortcut,
}: {
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    /** Why the button is disabled, when it is: the tooltip says so instead of naming the action. */
    reason?: string;
    busy?: boolean;
    /** Called when the pointer or keyboard reaches the button - the moment to start fetching what a click will need. */
    onPrefetch?: () => void;
    /** The keyboard shortcut that does what this button does, when it is registered right now: named in the tooltip (`Reply (Ctrl+R)`) and
     * in `aria-keyshortcuts` - the accessible name stays the bare label. */
    shortcut?: ShortcutDef;
}) {
    const env = useKeyEnvironment();
    return (
        <button
            type="button"
            aria-label={label}
            title={reason ?? (shortcut ? withHint(label, shortcut, env) : label)}
            aria-keyshortcuts={shortcut ? ariaKeyShortcuts(shortcut, env) : undefined}
            aria-busy={busy || undefined}
            disabled={disabled}
            onClick={onClick}
            onPointerEnter={onPrefetch}
            onFocus={onPrefetch}
            className={ICON_BUTTON_CLASS}
        >
            {icon}
        </button>
    );
}

function SecurityIndicator({ security }: { security: MessageSecurityResult }) {
    const { label, className } = SECURITY_INDICATOR[security.state];
    if (security.state !== "verified_at_first_open") {
        // Every encrypted state carries a small lock, so the badge reads at a glance; the words are unchanged.
        const encrypted = security.state.startsWith("encrypted");
        return (
            <span className={`inline-flex items-center gap-1 text-xs font-medium shrink-0 py-1 px-2.5 rounded-pill ${className}`}>
                {encrypted && <HiOutlineLockClosed size={12} aria-hidden="true" />}
                {label}
            </span>
        );
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
    /** Called with the server's updated copy (and the copy it replaces) after the card's More actions menu marked the message read or unread, or
     * flagged or unflagged it - it stays where it is, so a caller patches it in place, as it does for `onLabelsChanged`. The menu's Delete, Report
     * junk and Block move the message out of its folder and are reported through `onMoved`, which is what makes a thread's card leave it and the
     * pane advance, exactly as after Archive. */
    onChanged?: (updated: Message, previous?: Message) => void;
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
    /** Rendered as one message of a thread (`ConversationThreadPane`) rather than as the pane itself: only its card is drawn - the thread
     * owns the subject card, the scrolling and the `h1` - and the message's own subject appears (as an `h3`) only when it differs from the
     * thread's (`threadSubject`). Everything else - the badges, the actions, the body - is identical. */
    inThread?: boolean;
    /** The thread's subject, for a message of a thread to tell whether its own subject is worth showing. */
    threadSubject?: string;
    /** In a thread, what makes the sender line of this expanded card the button that collapses it: the id of the body it controls, whether the
     * message is unread (which draws the accent bar and tint), what it does, and where to put its ref. */
    threadHeader?: {
        bodyId: string;
        unread: boolean;
        onToggle: () => void;
        buttonRef: (node: HTMLButtonElement | null) => void;
    };
    /** Draw the Reply and Forward buttons at the foot of the card - by default for the single-message pane, and in a thread only where the
     * caller asks (the newest expanded message). */
    footer?: boolean;
    /**
     * Registers this pane's keyboard shortcuts - Reply, Reply all, Forward, Archive, Move to - so they act on this message. Only the message
     * the keyboard is acting on should set it: the one pane beside the list, or the opened message of a thread (each expanded message of a
     * thread is a pane, and two of them must not both claim Ctrl+R). Also puts the shortcut in those buttons' tooltips.
     */
    shortcuts?: boolean;
}

/** A subject without its \`Re:\`/\`Fwd:\` prefixes. */
function withoutSubjectPrefixes(subject: string | undefined): string {
    return (subject ?? "").replace(/^(\s*(re|fw|fwd|aw|sv)\s*:)+/i, "").trim();
}

/** A subject without its \`Re:\`/\`Fwd:\` prefixes, lower-cased - what makes two messages of one thread the same subject. */
function subjectCore(subject: string | undefined): string {
    return withoutSubjectPrefixes(subject).toLowerCase();
}

/** Whether a message's subject says nothing its thread's subject doesn't. */
function sameSubject(subject: string, threadSubject: string | undefined): boolean {
    return subjectCore(subject) === subjectCore(threadSubject);
}

function formatBytes(bytes: number): string {
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
    return `${bytes} B`;
}

/**
 * A message's reading pane - a subject card, and under it the message as a card: header (sender, recipients, time, actions), notices, attachments,
 * the body (`reading/MessageBody`: an isolated frame exactly as tall as its content, or text) and a footer. Rendered with `inThread`, only the card.
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
    onChanged,
    labels,
    onLabelsChanged,
    onLabelCreated,
    inThread,
    threadSubject,
    threadHeader,
    footer,
    shortcuts,
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
    const { mailboxes, trackMessageChange } = useMailShell();
    const { requestUnlock } = useUnlockPrompt();
    // Bumped after a successful on-demand unlock to re-run the effect below - it's not a dependency the
    // effect could read reactively otherwise (getUnlockedKeys() is a plain module-level read, not React
    // state; see keySession.ts's own doc comment).
    const [unlockRefresh, setUnlockRefresh] = useState(0);
    // "View original": this message exactly as its author wrote it instead of adapted to the theme, remembered for the session. Offered only
    // once the body says adapting would change something (`MessageBody`'s `onAdaptable`), or when the reader already chose it.
    const [viewOriginal, setViewOriginal] = useViewOriginal(messageProp.uid);
    const [adaptable, setAdaptable] = useState(viewOriginal);
    // The locked body's Unlock button is waiting on the unlock prompt; and, once it has answered, the focus is to move to the body region.
    const [unlocking, setUnlocking] = useState(false);
    const focusBodyRef = useRef(false);
    const bodyRegionRef = useRef<HTMLDivElement>(null);

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
                // The S/MIME code (PKI.js and the ASN.1/X.509 libraries) loads here, only for a message that is signed or
                // encrypted - it is over half a megabyte, and the pane opens plain messages without it.
                const messageSecurity = await import("@rapidmx/react-shared/crypto/messageSecurity.js");
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
                    result = await messageSecurity.evaluateMessageSecurityWithSeal(rawMime, unlocked, pinned, primaryAddress, {
                        mailboxUid: message.mailboxUid,
                        messageUid: message.uid,
                        ...currentVerificationSeal(message),
                        masterKeyGeneration: sealContext.generation,
                        signerKeys,
                    }).catch(() =>
                        // Only a lock while sealing throws: evaluate as locked (the lock itself re-evaluates too).
                        messageSecurity.evaluateMessageSecurity(rawMime, undefined, pinned, primaryAddress),
                    );
                    if (result.sealToWrite) {
                        // Best effort and in the background: never awaited, never shown.
                        void sendVerificationSeal(message.uid, result.sealToWrite);
                    }
                } else {
                    result = await messageSecurity.evaluateMessageSecurity(rawMime, unlocked, pinned, primaryAddress);
                }
                // Only one reader address can be checked per evaluation: a message sent to one of this mailbox's
                // aliases isn't "not addressed to you", so each alias is tried before saying so.
                for (const alias of aliasAddresses) {
                    if (!result.notAddressedToReader) {
                        break;
                    }
                    const viaAlias = await messageSecurity.evaluateMessageSecurity(rawMime, unlocked, pinned, alias);
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

    // Whether the body is the locked state right now (an encrypted message this device holds no unlocked keys for), for the subscription below.
    const lockedRef = useRef(false);
    lockedRef.current = security?.decryptError !== undefined && !getUnlockedKeys(message.mailboxUid);

    // After an unlock from the button, the message (or the reason it can't be read) is where the reader's attention is: the focus moves to it once it is
    // there, since the button that had it is gone.
    useEffect(() => {
        if (focusBodyRef.current && security !== null) {
            focusBodyRef.current = false;
            bodyRegionRef.current?.focus({ preventScroll: true });
        }
    }, [security]);

    // Decrypted plaintext must not outlive the key session that produced it: the moment this mailbox's
    // keys are destroyed (logout, idle timeout, explicit lock), drop the recovered html/text and
    // re-evaluate - an encrypted message then falls back to its locked state. And the other way round: keys unlocked
    // from anywhere (compose, another message, the unlock prompt) open a message that was waiting on them, in place.
    useEffect(
        () =>
            subscribeKeySession((event) => {
                if (event.mailboxUid !== message.mailboxUid) {
                    return;
                }
                if (event.state === "locked") {
                    setSecurity(null);
                    setUnlockRefresh((n) => n + 1);
                } else if (lockedRef.current) {
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
        setUnlocking(true);
        try {
            await requestUnlock(mailboxUid, mailboxKeys);
            // The Unlock button is about to be replaced by the message (or by why it can't be read): the focus goes there, once it has been evaluated.
            focusBodyRef.current = true;
            setUnlockRefresh((n) => n + 1);
        } catch {
            // User dismissed the unlock dialog - security state stays exactly as it was.
        } finally {
            setUnlocking(false);
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

    /** Starts fetching what Reply/Reply All/Forward will need (the compose window's code, the original's body) as the
     * pointer or keyboard reaches one of their buttons, so the click itself finds it already on its way or here. */
    function prefetchReply() {
        prefetchComposeWindow();
        prefetchOriginalMessage(message);
    }

    /**
     * Opens the compose window at once from what is already in memory - the message's own subject and sender, and the
     * mailbox it was read in - and fetches what needs the network meanwhile: the original's body to quote, and for Reply All
     * the recipients its headers name. Both reach the window through `OpenComposeInput.pending` when they arrive, so the
     * window is on screen on the click's own frame rather than after two or three sequential requests.
     */
    async function handleReplyOrForward(kind: "reply" | "replyAll" | "forward") {
        setPreparingCompose(true);
        try {
            const encrypt = !!message.encrypted;
            // What makes the new message part of this one's thread rather than a conversation of its own:
            // the server composes the MIME from the recipients, subject and HTML alone, so nothing else
            // recovers what is being replied to. A forward carries it for the same reason - it continues
            // the thread it came from, which is where its recipient will file the reply to it.
            const threading = buildReplyThreading(message);
            const format = (list: Recipient[]) => list.map((r) => formatRecipient(r)).join(", ");
            // Known without a request when the shell has already listed the mailbox; otherwise fetched with the body, and
            // the window's recipients are corrected by `late` below if that changes who they are.
            const knownOwn = readerAddressesKey ? readerAddressesKey.split(" ") : undefined;
            // Never rejects: loadOriginalMessage() and ownAddresses() don't, and the rest is pure.
            const late = (async (): Promise<ComposeLateInput> => {
                const [original, own] = await Promise.all([
                    loadOriginalMessage(message, security, { recipients: kind === "replyAll" }),
                    kind === "forward" ? [] : (knownOwn ?? ownAddresses()),
                ]);
                if (kind === "forward") {
                    return { quotedHtml: buildForwardQuote(message, original.body) };
                }
                // The message's own recipients are only the envelope recipient of a delivered message, so Reply All
                // answers whoever its headers actually name, with anything the record holds that they don't.
                const known = new Set((original.recipients ?? []).map((r) => r.address.trim().toLowerCase()));
                const recipients = buildReplyRecipients(
                    { ...message, recipients: [...(original.recipients ?? []), ...message.recipients.filter((r) => !known.has(r.address.trim().toLowerCase()))] },
                    own,
                    kind === "replyAll",
                );
                return { quotedHtml: buildReplyQuote(message, original.body), to: format(recipients.to), cc: format(recipients.cc) };
            })();
            if (kind === "forward") {
                openCompose({
                    mailboxUid: message.mailboxUid,
                    subject: forwardSubject(message.subject),
                    signatureContext: "reply_forward",
                    encrypt,
                    threading,
                    pending: late,
                });
            } else {
                const first = buildReplyRecipients(message, knownOwn ?? [], kind === "replyAll");
                openCompose({
                    mailboxUid: message.mailboxUid,
                    to: format(first.to),
                    cc: first.cc.length > 0 ? format(first.cc) : undefined,
                    subject: replySubject(message.subject),
                    signatureContext: "reply_forward",
                    suppressSigning: isLikelyMailingList({ listUnsubscribe: message.listUnsubscribeHeader }),
                    encrypt,
                    threading,
                    pending: late,
                });
            }
            // Held until the quote is in, so a second click can't open a second window for the same message meanwhile.
            await late;
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
            // Out of Outbox, into Drafts: both folders' badges.
            trackMessageChange(message, updated).settle();
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
            trackMessageChange(message, updated).settle();
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
        // Move to, Delete and Report junk are all this: the source folder's badge goes down, the target's up.
        trackMessageChange(message, updated).settle();
        onMoved?.(updated);
    }

    // Keyboard shortcuts for the message this pane shows. They call the same handlers as the buttons below, and exist only where the
    // button does (Archive not for Drafts/Outbox, Move to only with folders to move to). A shortcut pressed while its action is already
    // running is consumed and does nothing, exactly as the disabled button would: a browser must not act on Ctrl+R meanwhile.
    const archivable = !inOutbox && message.folderUid !== draftsFolderUid;
    const movable = !!folders && folders.length > 0;
    const keyboard = !!shortcuts;
    useShortcut(SHORTCUTS.mail.reply, () => void (!preparingCompose && handleReplyOrForward("reply")), { enabled: keyboard });
    useShortcut(SHORTCUTS.mail.replyAll, () => void (!preparingCompose && handleReplyOrForward("replyAll")), { enabled: keyboard });
    useShortcut(SHORTCUTS.mail.forward, () => void (!preparingCompose && handleReplyOrForward("forward")), { enabled: keyboard });
    useShortcut(SHORTCUTS.mail.archive, () => void (!archiving && handleArchive()), { enabled: keyboard && archivable });
    useShortcut(SHORTCUTS.mail.move, () => setMovePrompt(true), { enabled: keyboard && movable });

    // The card's Report junk button and "More actions" menu: they act on this message, in the mailbox it is in. Nothing of them applies to a message
    // being written or sent (Drafts, Outbox), and Report junk and Block are not for mail the reader sent.
    const folderType = folders?.find((folder) => folder.uid === message.folderUid)?.type;
    const inJunk = folderType === "junk";
    const inDeletedItems = folderType === "deleted_items";
    const reportable = archivable && !isSentItems;
    const writable = useMailboxUpdateAccess(readerMailbox);
    const remember = (updated: Message) => {
        latestLabelsMessageRef.current = updated;
        setLabelsMessage(updated);
    };
    const messageActions = useMessageActions({
        message,
        newest: () => (message.version >= latestLabelsMessageRef.current.version ? message : latestLabelsMessageRef.current),
        remember,
        folders,
        inJunk,
        inDeletedItems,
        trackMessageChange,
        onMoved,
        onChanged,
        onFolderCreated,
    });
    const navigate = useNavigate();
    const [sourceView, setSourceView] = useState<{ mode: SourceMode; source: SourceState } | null>(null);
    // Which "View source" request the dialog is waiting for: one answering after the dialog was closed (or another was opened) is not shown.
    const sourceRequestRef = useRef(0);

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

    const shownSubject = (protectedSubject ?? displaySubject(message.subject)) || "(no subject)";
    // What the body area shows. Text or HTML the client recovered from a signed or encrypted message is shown as it is (its own sanitizing
    // happens in `MessageBody`, like every body's); anything else is the server's own `/content`. An encrypted message has nothing worth
    // fetching until it has been decrypted (the server only has the ciphertext), so it shows the skeleton meanwhile.
    const bodyContent: BodyContent | undefined =
        security?.text !== undefined
            ? { kind: "text", text: security.text }
            : security?.html !== undefined
              ? { kind: "html", html: security.html }
              : undefined;
    const bodyTitle = message.subject || "Message content";
    const answered = message.flags.answered === true;
    const forwarded = message.flags.forwarded === true;
    const cardUnread = threadHeader?.unread ?? false;
    const showFooter = footer ?? !inThread;
    // Only a message the server can read and that carries a calendar file is worth asking about an invitation. An encrypted message is out: the
    // server holds only its ciphertext (the calendar file is inside it), so there is nothing for it to find. Drafts and Outbox hold messages
    // that are being written or sent, not received invitations.
    const mayHoldInvite = !message.encrypted && !inOutbox && message.folderUid !== draftsFolderUid && attachments.some(isCalendarAttachment);
    // The calendar file of a message whose invitation card is drawn is the card, not a chip in the attachment list (a nameless "attachment" to click):
    // it is listed again if the card could not be drawn (no invitation the server can read, or the lookup failed), so the file is never out of reach.
    const { invite: shownInvite } = useMessageInvite(message.uid, mayHoldInvite);
    const listedAttachments = shownInvite ? attachments.filter((attachment) => !isCalendarAttachment(attachment)) : attachments;

    const senderRecipient = { displayName: senderName, address: senderAddress };
    const sendingStatus = (
        <>
            {sendInProgress && (
                <span className="text-xs font-medium text-text-muted shrink-0 py-1 px-2.5 rounded-pill bg-surface-alt">Sending&hellip;</span>
            )}
            {isSentItems &&
                (message.recallRequestedAt ? (
                    <span className="text-xs font-medium text-text-muted shrink-0 py-1 px-2.5 rounded-pill bg-surface-alt">Recall requested</span>
                ) : (
                    <Button type="button" variant="secondary" className="!w-auto shrink-0" onClick={() => setConfirming(true)}>
                        Recall this message
                    </Button>
                ))}
            {inOutbox && !sendInProgress && message.scheduledSendTime && (
                <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs font-medium text-text-muted py-1 px-2.5 rounded-pill bg-surface-alt">
                        Scheduled for {new Date(message.scheduledSendTime).toLocaleString()}
                    </span>
                    <Button type="button" variant="secondary" className="!w-auto" loading={canceling} disabled={canceling} onClick={handleCancelScheduledSend}>
                        Cancel
                    </Button>
                </div>
            )}
            {/* A message left in Outbox with no active schedule - a scheduled send that failed or was refused
                (restapi's ScheduledSendJob clears scheduledSendTime and leaves it there), which can't be sent
                again from Outbox (409) or archived - would otherwise be stuck. Moving it back to Drafts works for
                any Outbox message. */}
            {inOutbox && !sendInProgress && !message.scheduledSendTime && draftsFolderUid && (
                <Button type="button" variant="secondary" className="!w-auto shrink-0" loading={canceling} disabled={canceling} onClick={handleCancelScheduledSend}>
                    Move to Drafts
                </Button>
            )}
        </>
    );

    // ---- The "More actions" menu's own rows (Print, View, Save as, Create rule); the rest are `messageActions`. ----

    /** Prints this one message: its header lines and the body the pane shows (what was decrypted or verified here, else the server's sanitized
     * body), in a frame of its own - see `printMessage.ts`. */
    async function handlePrint() {
        try {
            const content = bodyContent ?? (await fetchBodyContent(message.uid, message.version));
            const format = (list: Recipient[]) => list.map((r) => formatMailAddress(r)).join(", ");
            const printable = buildPrintDocument({
                subject: shownSubject,
                headers: [
                    { name: "From", value: senderLabel },
                    { name: "To", value: format(message.recipients.filter((r) => r.type !== "cc" && r.type !== "bcc")) },
                    { name: "Cc", value: format(message.recipients.filter((r) => r.type === "cc")) },
                    { name: "Date", value: new Date(message.receivedDate).toLocaleString() },
                ],
                content,
                attachments,
                inlineParts: innerAttachments,
            });
            if (printable === undefined) {
                notify({ kind: "warning", title: "This message is too large to print here" });
                return;
            }
            printDocument(printable);
        } catch (err) {
            notifyApiError(err, "Couldn't print this message");
        }
    }

    /** Opens the source (or just the headers) of the message as the server has it - for an encrypted message, its ciphertext. */
    function openSource(mode: SourceMode) {
        const request = ++sourceRequestRef.current;
        setSourceView({ mode, source: { status: "loading" } });
        getMessageRawContent(message.uid).then(
            (raw) => {
                if (sourceRequestRef.current === request) {
                    setSourceView({ mode, source: { status: "ready", raw } });
                }
            },
            (err) => {
                if (sourceRequestRef.current === request) {
                    setSourceView({ mode, source: { status: "error", message: err instanceof ApiRequestError ? err.message : "Could not load this message's source." } });
                }
            },
        );
    }

    function closeSource() {
        sourceRequestRef.current++;
        setSourceView(null);
    }

    async function handleSaveAsEml() {
        try {
            saveAsEml(await getMessageRawContent(message.uid), protectedSubject ?? displaySubject(message.subject));
        } catch (err) {
            notifyApiError(err, "Couldn't save this message");
        }
    }

    /** The rules page's "New mail filter", started from this message: its sender and (for a message the server can read) its subject. */
    function handleCreateRule() {
        const params = new URLSearchParams({ mailboxUid: message.mailboxUid, from: message.from.address });
        const subject = message.encrypted ? "" : withoutSubjectPrefixes(message.subject);
        if (subject) {
            params.set("subject", subject);
        }
        navigate(`/settings/filters/new?${params.toString()}`);
    }

    const menuActions: MessageMenuActions = {
        replyAll: () => void handleReplyOrForward("replyAll"),
        forward: () => void handleReplyOrForward("forward"),
        deleteMessage: () => void messageActions.deleteMessage(),
        toggleRead: () => void messageActions.toggleRead(),
        toggleFlag: () => void messageActions.toggleFlag(),
        reportJunk: () => void messageActions.reportJunk(),
        reportPhishing: () => void messageActions.reportPhishing(),
        blockSender: () => void messageActions.blockSender(),
        neverBlockSender: () => void messageActions.neverBlockSender(),
        print: () => void handlePrint(),
        viewSource: () => openSource("source"),
        viewDetails: () => openSource("headers"),
        saveAsEml: () => void handleSaveAsEml(),
        createRule: handleCreateRule,
    };
    // An encrypted message can be printed once it has been opened here: while it is still opening, or when it can't be, there is nothing to print.
    const printReason = !message.encrypted
        ? undefined
        : security === null
          ? "Still opening this message"
          : security.decryptError === undefined
            ? undefined
            : lockedRef.current
              ? "Unlock this message to print it"
              : "This message can't be read, so it can't be printed";
    const reportReason = !writable ? "View-only mailbox" : inJunk ? "Already in Junk Email" : undefined;

    const card = (
        <CardShell unread={cardUnread}>
            {/* Header row: who it is from, when, and what can be done with it. Wraps: on a phone the actions drop under the sender. */}
            <div className={["flex flex-wrap items-start gap-x-3 gap-y-1 px-4 pt-3 pb-2", cardUnread ? "bg-primary/[0.07]" : ""].join(" ")}>
                <SenderAvatar from={senderRecipient} />
                <div className="flex-1 min-w-[12rem]">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {threadHeader ? (
                            // The sender line of a message in a thread is the button that collapses it again.
                            <h2 className="min-w-0 flex-1" style={BODY_FONT_STYLE}>
                                <button
                                    type="button"
                                    ref={threadHeader.buttonRef}
                                    onClick={threadHeader.onToggle}
                                    aria-expanded={true}
                                    aria-controls={threadHeader.bodyId}
                                    className={[
                                        "w-full text-left rounded-sm text-sm",
                                        ROW_FOCUS_CLASS,
                                    ].join(" ")}
                                >
                                    <UnreadLabel unread={cardUnread} />
                                    <MailAddress recipient={senderRecipient} className={senderClass(cardUnread)} />
                                </button>
                            </h2>
                        ) : (
                            <p className="text-sm break-words min-w-0">
                                From <span className="font-semibold text-text">{senderLabel}</span>
                            </p>
                        )}
                        {security && <SecurityIndicator security={security} />}
                    </div>
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
                </div>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
                    <time dateTime={message.receivedDate} className={["text-xs mr-1", dateClass(cardUnread)].join(" ")}>
                        {new Date(message.receivedDate).toLocaleString()}
                    </time>
                    {adaptable && (
                        <button
                            type="button"
                            aria-label="View original"
                            aria-pressed={viewOriginal}
                            title={viewOriginal ? "Follow the theme" : "View original"}
                            onClick={() => setViewOriginal(!viewOriginal)}
                            className={[
                                "inline-flex items-center justify-center p-1.5 rounded-md border border-border text-sm text-text hover:bg-surface-alt",
                                viewOriginal ? "bg-primary/10" : "",
                            ].join(" ")}
                        >
                            {viewOriginal ? <HiOutlineMoon size={16} aria-hidden="true" /> : <HiOutlineSun size={16} aria-hidden="true" />}
                        </button>
                    )}
                    {/* Wraps: in a thread the pane can be as narrow as the reading pane gets (the list takes
                        384px of it), and these are six controls. */}
                    <IconAction
                        icon={<HiOutlineArrowUturnLeft size={16} aria-hidden="true" />}
                        label="Reply"
                        shortcut={keyboard ? SHORTCUTS.mail.reply : undefined}
                        disabled={preparingCompose}
                        onPrefetch={prefetchReply}
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
                        shortcut={keyboard ? SHORTCUTS.mail.replyAll : undefined}
                        disabled={preparingCompose}
                        onPrefetch={prefetchReply}
                        onClick={() => void handleReplyOrForward("replyAll")}
                    />
                    <IconAction
                        icon={<HiOutlineArrowUturnRight size={16} aria-hidden="true" />}
                        label="Forward"
                        shortcut={keyboard ? SHORTCUTS.mail.forward : undefined}
                        disabled={preparingCompose}
                        onPrefetch={prefetchReply}
                        onClick={() => void handleReplyOrForward("forward")}
                    />
                    {archivable && (
                        <IconAction
                            icon={<HiOutlineArchiveBox size={16} aria-hidden="true" />}
                            label="Archive"
                            shortcut={keyboard ? SHORTCUTS.mail.archive : undefined}
                            busy={archiving}
                            disabled={archiving}
                            onClick={handleArchive}
                        />
                    )}
                    {movable && (
                        <IconAction
                            icon={<HiOutlineFolderArrowDown size={16} aria-hidden="true" />}
                            label="Move to"
                            shortcut={keyboard ? SHORTCUTS.mail.move : undefined}
                            onClick={() => setMovePrompt(true)}
                        />
                    )}
                    {reportable && (
                        <IconAction
                            icon={<HiOutlineNoSymbol size={16} aria-hidden="true" />}
                            label="Report junk"
                            busy={messageActions.busy}
                            disabled={messageActions.busy || reportReason !== undefined}
                            reason={reportReason}
                            onClick={() => void messageActions.reportJunk()}
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
                    {archivable && (
                        <MessageMoreMenu
                            actions={menuActions}
                            senderAddress={message.from.address}
                            read={currentLabelsMessage.flags.read === true}
                            flagged={currentLabelsMessage.flags.flagged === true}
                            writable={writable}
                            busy={messageActions.busy}
                            inJunk={inJunk}
                            inDeletedItems={inDeletedItems}
                            sent={!!isSentItems}
                            ownSender={readerAddressesKey.toLowerCase().split(" ").includes(message.from.address.toLowerCase())}
                            printReason={printReason}
                            composing={preparingCompose}
                            triggerClassName={ICON_BUTTON_CLASS}
                        />
                    )}
                </div>
            </div>

            {/* A slim bar for what has been done with the message. */}
            {(answered || forwarded) && (
                <p className="px-4 py-1.5 text-xs text-text-muted bg-surface-alt border-y border-border">
                    {answered && forwarded ? "You replied to and forwarded this message." : answered ? "You replied to this message." : "You forwarded this message."}
                </p>
            )}

            <div id={threadHeader?.bodyId} className="px-4 pb-3 flex flex-col gap-2">
                {inThread && (subjectDiffers || !sameSubject(shownSubject, threadSubject)) && (
                    <h3 className="text-sm font-semibold break-words">{shownSubject}</h3>
                )}
                <div className="flex flex-wrap items-center gap-2 empty:hidden">{sendingStatus}</div>
                {inOutbox && message.scheduledSendError && <Alert>This message wasn&rsquo;t sent: {message.scheduledSendError}</Alert>}
                {cancelError && <Alert>{cancelError}</Alert>}
                {keyChangeNotice && (
                    <p role="status" className="py-2 px-3 rounded-sm text-sm bg-surface-alt text-text">
                        {keyChangeNotice}
                    </p>
                )}
                {security && UNVERIFIED_SIGNER_STATES.has(security.state) && (
                    // Informational: the signature is intact, but nothing ties its certificate to this sender - anyone can
                    // create a certificate naming any address. "Trust this signer" (below) pins it once the reader has
                    // confirmed the fingerprint.
                    <p role="status" className="py-2 px-3 rounded-sm text-sm bg-surface-alt text-text">
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
                    <p role="status" className="py-2 px-3 rounded-sm text-sm bg-warning/15 text-text">
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
                    <div>
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
                    <p role="status" className="py-2 px-3 rounded-sm text-sm bg-surface-alt text-text">
                        The subject shown above is the one the sender signed. It differs from the subject this message was
                        delivered with (&ldquo;{message.subject}&rdquo;), which may have been changed on the way, e.g. by a
                        mailing list.
                    </p>
                )}
                {security?.headerTamperDetected && (
                    <Alert>
                        This message's visible From/To/Cc/Date/Subject don't match what the sender actually signed or
                        encrypted — an intermediary may have altered them after sending. Treat the fields shown above with
                        caution.
                    </Alert>
                )}
                {security?.state === "verified_at_first_open" && (
                    // A seal outranks only a key-status failure (see `evaluateMessageSecurityWithSeal()`). A signer key
                    // later reported compromised is a warning, never reassurance.
                    <p
                        role="status"
                        className={`py-2 px-3 rounded-sm text-sm text-text ${security.laterCompromised ? "bg-warning/15" : "bg-surface-alt"}`}
                    >
                        {verifiedAtFirstOpenMessage(security)}
                    </p>
                )}
                {keyChanged && (
                    <section aria-label="Signing key changed" className="py-3 px-3 rounded-sm text-sm bg-warning/15 text-text flex flex-col gap-2">
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
                    <p role="status" className="py-2 px-3 rounded-sm text-sm bg-surface-alt text-text">
                        {security.signatureFailureReason
                            ? SIGNATURE_FAILURE_MESSAGE[security.signatureFailureReason]
                            : GENERIC_SIGNATURE_FAILURE_MESSAGE}
                    </p>
                )}
                {verifiedOrSealed && !security.protectedHeaders && (
                    // A legacy S/MIME sender signs only the body: the outer Subject/To/Cc shown here were never signed.
                    <p role="status" className="py-2 px-3 rounded-sm text-sm bg-surface-alt text-text">
                        The signature covers this message&rsquo;s content and attachments only. Its Subject, To and Cc
                        weren&rsquo;t signed, so they could have been changed after it was sent.
                    </p>
                )}
                {security?.notAddressedToReader && !isSentItems && (
                    // Informational, like the notice above: a Bcc recipient legitimately sees this too. Never shown in Sent
                    // Items: the sender's own address is (by design, see ComposeWindow/sendJob) never one of the protected
                    // To/Cc headers of a message it sent to someone else, so this would otherwise fire on every ordinary sent
                    // message rather than the genuine forwarded/re-sent/Bcc cases it's meant to flag.
                    <p role="status" className="py-2 px-3 rounded-sm text-sm bg-surface-alt text-text">
                        The recipients this message was signed or encrypted for don&rsquo;t include this mailbox - it may have
                        been forwarded or re-sent to you unchanged, or you were Bcc&rsquo;d.
                    </p>
                )}
                {archiveError && <Alert>{archiveError}</Alert>}
                {labelsError && <Alert>{labelsError}</Alert>}
                {labels && (currentLabelsMessage.labelUids?.length ?? 0) > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
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
                        <div key={type} className="flex flex-wrap items-center gap-2 py-2 px-3 rounded-sm bg-surface-alt text-sm">
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
                            <Button type="button" variant="text" disabled={receiptBusy !== null} onClick={() => handleReceipt(type, "decline")}>
                                Decline
                            </Button>
                        </div>
                    ))}
                {receiptError && <Alert>{receiptError}</Alert>}
                {mayHoldInvite && <InviteCard messageUid={message.uid} headingLevel={inThread ? 3 : 2} />}
                {security?.state === "signature_failed" && innerAttachments && innerAttachments.length > 0 && (
                    <p role="status" className="py-2 px-3 rounded-sm text-sm bg-warning/15 text-text">
                        These attachments come from a message whose signature couldn&rsquo;t be verified. Open them only if
                        you trust the sender.
                    </p>
                )}
                {innerAttachments
                    ? innerAttachments.length > 0 && (
                          <ul className="flex flex-wrap gap-2">
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
                    : listedAttachments.length > 0 && (
                          <ul className="flex flex-wrap gap-2">
                              {listedAttachments.map((attachment) => (
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
                {/* The body: an isolated frame exactly as tall as its content (or text), in the card's own place. A decrypted or verified
                    body never came through the server's own sanitizer (the server never saw the plaintext); `MessageBody` sanitizes every body
                    client-side regardless, behind a no-remote-loads CSP, in a frame that runs no script. */}
                <div ref={bodyRegionRef} tabIndex={-1} className="outline-none">
                    {message.encrypted && security === null ? (
                        <BodySkeleton />
                    ) : security?.decryptError !== undefined ? (
                        // An encrypted message that could not be read: locked (no unlocked keys - the button asks the app's own unlock prompt, and the message
                        // then decrypts in place) or genuinely unreadable (keys unlocked and it still didn't open - the reason, and nothing to click).
                        <EncryptedBody locked={lockedRef.current} reason={security.decryptError} unlocking={unlocking} onUnlock={() => void handleUnlockToView()} />
                    ) : (
                        <MessageBody
                            messageUid={message.uid}
                            messageVersion={message.version}
                            title={bodyTitle}
                            content={bodyContent}
                            attachments={attachments}
                            inlineParts={innerAttachments}
                            original={viewOriginal}
                            onAdaptable={setAdaptable}
                        />
                    )}
                </div>
            </div>

            {showFooter && (
                <div className="flex flex-wrap gap-2 px-4 py-3 border-t border-border print:hidden">
                    <Button
                        type="button"
                        variant="secondary"
                        className="!w-auto"
                        aria-label="Reply to this message"
                        disabled={preparingCompose}
                        onClick={() => void handleReplyOrForward("reply")}
                    >
                        Reply
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        className="!w-auto"
                        aria-label="Reply all to this message"
                        disabled={preparingCompose}
                        onClick={() => void handleReplyOrForward("replyAll")}
                    >
                        Reply All
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        className="!w-auto"
                        aria-label="Forward this message"
                        disabled={preparingCompose}
                        onClick={() => void handleReplyOrForward("forward")}
                    >
                        Forward
                    </Button>
                </div>
            )}
        </CardShell>
    );

    return (
        // `h-full` outside a thread only: the standalone message route renders this pane straight into a
        // *block* (`MailShell`'s own `<main>`), where nothing stretches it and a percentage of that block's
        // own resolved height is the height. Inside a thread the card is one row of the thread's own list.
        <div className={inThread ? "min-w-0" : "flex-1 min-w-0 min-h-0 flex flex-col h-full"}>
            {inThread ? (
                card
            ) : (
                <>
                    {backHref && (
                        <a href={backHref} className="text-sm text-primary-dark hover:underline block px-4 pt-3">
                            &larr; Back to messages
                        </a>
                    )}
                    {/* The subject has a card of its own, above the message, that stays put while the message scrolls. */}
                    <SubjectCard subject={shownSubject} />
                    <div className="flex-1 min-h-0 overflow-y-auto p-2 sm:p-3 flex flex-col gap-3">{card}</div>
                </>
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
            {messageActions.dialog}
            <MessageSourceDialog
                open={sourceView !== null}
                onClose={closeSource}
                mode={sourceView?.mode ?? "source"}
                source={sourceView?.source ?? { status: "loading" }}
                encrypted={!!message.encrypted}
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
