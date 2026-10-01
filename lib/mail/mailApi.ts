///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s REST surface. Shared by `apps/admin` and (from Phase 3 on)
 * `apps/www` — there is no separate admin-only endpoint set to isolate: every route here is gated entirely
 * by the ACL system, so the exact same call returns the caller's own data and what is shared with them - an
 * administrator's included: no role reads another user's mail. The one exception is the administration scope
 * (`scope: "admin"` -> `?scope=admin`), which ONLY the admin console passes: mailboxes then come back as
 * administrative metadata (no keys, settings or content) and every call is audited; an administrator who needs
 * to see somebody's mail impersonates them (`impersonateUser()`). See `BaseMailboxRoute`'s doc comment in
 * `@rapidmx/restapi` and this repo's `.claude/NOTES.md`.
 */

import { ApiClient, ApiRequestError, apiFetch, apiUrl, authApiFetch, withClient, withCsrfHeader } from "../util/api.js";
import { ListParams, buildQuery } from "../util/apiQuery.js";
import { deviceTimeZone } from "../util/timeZone.js";
import type { EncryptionPreference, PublicKey } from "../crypto/keyvaultApi.js";
import { bytesToBinaryString } from "../crypto/mime.js";
import { newContentId, parseDataImage } from "./inlineImages.js";
import type { ResolvedPrincipal } from "./mailboxAccessApi.js";

export type { ListParams };
export type { EncryptionPreference, PublicKey };
export type { ResolvedPrincipal };

/** Whether `mailbox` is one shared with the caller rather than their own: a delegate grant on somebody's mailbox, or a mailbox with no
 * owner at all (a shared/org mailbox they were granted). */
export function isSharedWithMe(mailbox: Pick<Mailbox, "accessRole" | "ownerUserUid">): boolean {
    return mailbox.accessRole ? mailbox.accessRole === "delegate" : !mailbox.ownerUserUid;
}

/** `?scope=admin`: the administration scope, for the admin console only (trusted + elevated callers; audited). A mailbox
 * then carries administrative metadata only - see `Mailbox.shared`. */
export interface AdminScopeParams {
    scope?: "admin";
}

/** The `scope` query parameter of `params`, when set. */
function scopeQuery(params: AdminScopeParams): Record<string, string> {
    return params.scope ? { scope: params.scope } : {};
}

/** Who may see a mailbox's free/busy times (`POST /calendar-events/free-busy`): `"domain"` - anyone signed in who owns a mailbox in the same domain (the default);
 * `"shared"` - only people who already hold access to the mailbox or its calendars; `"nobody"` - only the owner and delegates with full access;
 * `"everyone"` - anyone signed in to this server. */
export type FreeBusyVisibility = "domain" | "shared" | "nobody" | "everyone";

/** The free/busy visibility `mailbox` has: `"domain"` when it says none (a mailbox stored before the setting existed). */
export function freeBusyVisibilityOf(mailbox: Pick<Mailbox, "freeBusyVisibility">): FreeBusyVisibility {
    return mailbox.freeBusyVisibility ?? "domain";
}

export interface Mailbox {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    /** Absent for a true ownerless shared mailbox (e.g. `support@example.com`) — access is ACL-only. */
    ownerUserUid?: string;
    primarySmtpAddress: string;
    aliasAddresses: string[];
    displayName: string;
    timezone: string;
    quotaBytes: number;
    usedBytes: number;
    /** `true` for a bookable resource (Exchange's "room"/"equipment" mailbox concept) rather than a
     * person — trusted-role-only to create, same gate as any other ownerless mailbox. */
    isResource?: boolean;
    /** Only meaningful when `isResource` is `true`. */
    resourceType?: "room" | "equipment";
    /** Informational only — not used by any accept/decline logic. */
    resourceCapacity?: number;
    /** Mirrors Exchange's `AutomateProcessing AutoAccept` — off by default. Has no effect unless
     * `isResource` is also `true`. */
    autoAcceptBookings?: boolean;
    /** When set, every request is auto-accepted regardless of existing bookings. */
    allowConflicts?: boolean;
    /** A request starting further out than this many days is auto-declined. `undefined` means no limit. */
    bookingWindowDays?: number;
    /** A request longer than this many minutes is auto-declined. `undefined` means no limit. */
    maxDurationMinutes?: number;
    /** `true` if this mailbox's out-of-office auto-reply is currently enabled. Always present on a real
     * `Mailbox` (defaults to `false` server-side) — optional here only because some older test fixtures
     * predate this field, matching this file's existing convention for every other boolean flag above. */
    oofEnabled?: boolean;
    /** The out-of-office auto-reply message body — a single combined message rather than per-audience
     * variants, matching `@rapidmx/restapi`'s own deliberate simplification. Always present (defaults to
     * `""`), same caveat as `oofEnabled` above. */
    oofMessage?: string;
    /** When set together with `oofEndTime`, the auto-reply is only active within this window rather than
     * indefinitely while `oofEnabled` is `true`. */
    oofStartTime?: string;
    oofEndTime?: string;
    /** Whether `send()` attaches a real RFC 3798 receipt request to every outgoing message by default, for
     * internal vs. external recipients respectively — a per-draft `Message.requestReceipt` (see
     * `setMessageRequestReceipt()`) always overrides both at once when explicitly set. Always present on a
     * real `Mailbox` (defaults `true`/`false` server-side respectively), same optional-for-old-fixtures
     * caveat as `oofEnabled`. */
    alwaysRequestReceiptInternal?: boolean;
    /** Same as `alwaysRequestReceiptInternal`/`External`, for a recipient in a *different* organisation
     * that has opted into federation with this one - a third tier between same-org and fully external. */
    alwaysRequestReceiptFederated?: boolean;
    alwaysRequestReceiptExternal?: boolean;
    /** Whether this mailbox, as the *recipient* of a receipt request, sends one back immediately versus
     * holding it for the owner's explicit approval (`approveReceipt()`/`declineReceipt()`) — classifies the
     * requester, not the recipient. Always present (defaults `true`/`false` respectively), same caveat. */
    autoSendReceiptsInternal?: boolean;
    /** The federated-tier counterpart of `autoSendReceiptsInternal`/`External`. */
    autoSendReceiptsFederated?: boolean;
    autoSendReceiptsExternal?: boolean;
    /** This mailbox's own encryption preference, per `specs/end-to-end_encryption.md` — a client
     * defaults to encrypting only when *both* sender and recipient report `"mutual"`. Absent is
     * equivalent to `{ preferEncrypt: "nopreference" }` (no keys enrolled yet). */
    encryptPreference?: EncryptionPreference;
    /** This mailbox's published public keys (signing and/or encryption) — safe to expose publicly,
     * per the spec's own `PublicKey` doc comment. Absent/empty means no keys enrolled yet
     * (`KeyEnrollmentGate` handles that state). */
    keys?: PublicKey[];
    /** How the caller reaches this mailbox: `"owner"` (theirs) or `"delegate"` (shared with them). Set by the plain list and read of
     * mailboxes - not in an administration-scope answer - so a client can label the shared ones; see `isSharedWithMe()`. */
    accessRole?: "owner" | "delegate";
    /** Only in an administration-scope answer (`scope: "admin"`): the mailbox has no single owner. Such an answer
     * carries administrative metadata only, so the fields it leaves out (`oofMessage`, `keys`, ...) are `undefined`. */
    shared?: boolean;
    /** The `EscrowScope` this mailbox is currently assigned to, if any — an admin-only assignment
     * (`specs/end-to-end_encryption.md`'s Escrow Scoping). Assigning this alone does **not** create any
     * `MasterKeyWrap` — the mailbox owner must separately wrap MK against the scope's public key (see
     * `crypto/keyvaultApi.ts`'s `getEscrowInfo()` and `crypto/masterKeyWraps.ts`'s `buildEscrowWrap()`).
     * Absent means this mailbox has no escrow scope assigned. */
    escrowScopeId?: string;
    /** Who may see when this mailbox is busy - see `FreeBusyVisibility`. Absent on a mailbox from before the setting existed, which reads as `"domain"`
     * (`freeBusyVisibilityOf()`). Only the owner (or a delegate with full access) may change it. */
    freeBusyVisibility?: FreeBusyVisibility;
    /** This mailbox's Blocked Senders list (Outlook's): lowercase addresses (`user@example.com`) and domains (`@example.com`, that exact domain
     * and not its subdomains), at most 1,000 of them, never also on `safeSenders`. Mail from one goes to Junk Email. Absent on a mailbox from
     * before the list existed, or from a server without it - read it with `blockedSendersOf()`. Change it with `addBlockedSender()` and
     * `removeBlockedSender()` (full access to the mailbox), not by writing the whole array. */
    blockedSenders?: string[];
    /** This mailbox's Safe Senders list, the same shape as `blockedSenders`. Authenticated mail from one is not sent to Junk Email for the spam
     * filter's verdict. Read it with `safeSendersOf()`; change it with `addSafeSender()` and `removeSafeSender()`. */
    safeSenders?: string[];
}

/** The blocked senders `mailbox` has: none when it says none (a mailbox stored before the list existed, or `null` from an SQL row). */
export function blockedSendersOf(mailbox: Pick<Mailbox, "blockedSenders">): string[] {
    return mailbox.blockedSenders ?? [];
}

/** The safe senders `mailbox` has: none when it says none. */
export function safeSendersOf(mailbox: Pick<Mailbox, "safeSenders">): string[] {
    return mailbox.safeSenders ?? [];
}

/** Lists the mailboxes the caller owns or has been granted - the same for everyone, an administrator included. With
 * `scope: "admin"` (admin console only) it lists every mailbox as administrative metadata instead. */
export function listMailboxes(params: ListParams & AdminScopeParams = {}, client?: ApiClient): Promise<Mailbox[]> {
    return withClient(client, `/mail/mailboxes?${buildQuery(params, scopeQuery(params))}`);
}

/** One mailbox the caller owns or has been granted; with `scope: "admin"` (admin console only), its administrative metadata. */
export function getMailbox(uid: string, options: AdminScopeParams = {}, client?: ApiClient): Promise<Mailbox> {
    return withClient(client, `/mail/mailboxes/${encodeURIComponent(uid)}${options.scope ? `?scope=${options.scope}` : ""}`);
}

/** Lists bookable resource mailboxes (rooms/equipment) visible to the caller — same ACL scoping as
 * `listMailboxes()`, just pre-filtered server-side to `isResource: true` so `ResourcePicker` doesn't
 * need to fetch and filter the caller's entire mailbox list client-side. */
export function listResourceMailboxes(params: ListParams = {}, client?: ApiClient): Promise<Mailbox[]> {
    return withClient(client, `/mail/mailboxes?${buildQuery(params, { isResource: "true" })}`);
}

export interface CreateMailboxInput {
    /** Omit entirely to create a true ownerless shared mailbox — trusted-role-only (see BaseMailboxRoute). */
    ownerUserUid?: string;
    primarySmtpAddress: string;
    aliasAddresses?: string[];
    displayName: string;
    timezone: string;
    quotaBytes: number;
    isResource?: boolean;
    resourceType?: "room" | "equipment";
    resourceCapacity?: number;
    autoAcceptBookings?: boolean;
    allowConflicts?: boolean;
    bookingWindowDays?: number;
    maxDurationMinutes?: number;
}

export function createMailbox(input: CreateMailboxInput, client?: ApiClient): Promise<Mailbox> {
    return withClient(client, "/mail/mailboxes", {
        method: "POST",
        body: JSON.stringify({ aliasAddresses: [], usedBytes: 0, ...input }),
    });
}

/**
 * Who a typed principal - a mailbox address, an auth-server username or e-mail alias, or a user uid - is, for an
 * administrator naming a mailbox's owner (a new mailbox here, or a future reassignment) to confirm before saving.
 * Rejects with a 404 `ApiRequestError` ("No user found for ...") for nobody. Trusted-role-only
 * (`BaseMailboxRoute.resolveOwner()` in `@rapidmx/restapi`) - the same exact-match resolution
 * `resolveMailboxPrincipal()` (`mailboxAccessApi.ts`) uses for sharing.
 */
export function resolveMailboxOwner(principal: string, client?: ApiClient): Promise<ResolvedPrincipal> {
    return withClient(client, `/mail/mailboxes/resolve-owner?principal=${encodeURIComponent(principal)}`);
}

/** This server's configured domain list (`mail:domains`) — empty when unconfigured, meaning no
 * restriction applies and a `primarySmtpAddress` may be on any domain. */
export function listMailboxDomains(client?: ApiClient): Promise<string[]> {
    return withClient(client, "/mail/mailboxes/domains");
}

/** One (name alias, domain) combination the caller could register as their mailbox address. */
export interface MailboxAutoProvisionAliasOption {
    alias: string;
    domain: string;
    primarySmtpAddress: string;
}

export type MailboxAutoProvisionResult =
    | { status: "created"; mailbox: Mailbox }
    | { status: "existing"; mailbox: Mailbox }
    | { status: "needs_selection"; options: MailboxAutoProvisionAliasOption[] };

/**
 * Self-service mailbox creation for a user with none yet — see `BaseMailboxRoute.autoProvision()`'s own
 * doc comment in `@rapidmx/restapi` for the full contract. Call with no `selection` first; if the
 * result is `needs_selection`, call again with the option the user picked from that list.
 */
export function autoProvisionMailbox(
    selection?: { alias: string; domain: string },
    client?: ApiClient,
): Promise<MailboxAutoProvisionResult> {
    return withClient(client, "/mail/mailboxes/auto-provision", {
        method: "POST",
        // The device's time zone goes with every call, for the mailbox this may create.
        body: JSON.stringify({ ...selection, timezone: deviceTimeZone() }),
    });
}

/**
 * A partial mailbox update. The fields typed `| null` are the ones `@rapidmx/restapi`'s `Mailbox` model
 * copies whenever the key is *present* in the body (not only when it's non-`undefined`), so sending
 * `null` clears them - `JSON.stringify()` drops an `undefined` value entirely, which would instead leave
 * the old value in place.
 */
export interface UpdateMailboxInput {
    uid: string;
    version: number;
    displayName?: string;
    timezone?: string;
    quotaBytes?: number;
    aliasAddresses?: string[];
    isResource?: boolean;
    resourceType?: "room" | "equipment" | null;
    resourceCapacity?: number | null;
    autoAcceptBookings?: boolean;
    allowConflicts?: boolean;
    bookingWindowDays?: number | null;
    maxDurationMinutes?: number | null;
    oofEnabled?: boolean;
    oofMessage?: string;
    oofStartTime?: string | null;
    oofEndTime?: string | null;
    alwaysRequestReceiptInternal?: boolean;
    alwaysRequestReceiptFederated?: boolean;
    alwaysRequestReceiptExternal?: boolean;
    autoSendReceiptsInternal?: boolean;
    autoSendReceiptsFederated?: boolean;
    autoSendReceiptsExternal?: boolean;
    /** Trusted-caller-only server-side. `null` (or `""`) unassigns the mailbox's escrow scope; the
     * referenced `EscrowScope` must exist otherwise. See `Mailbox.escrowScopeId`. */
    escrowScopeId?: string | null;
    /** The owner's own record only (403 for anyone without full access to the mailbox; 400 for a value that is not one of the four). */
    freeBusyVisibility?: FreeBusyVisibility;
}

export function updateMailbox(input: UpdateMailboxInput, client?: ApiClient): Promise<Mailbox> {
    return withClient(client, `/mail/mailboxes/${encodeURIComponent(input.uid)}`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

/**
 * Deletes a mailbox. Only the mailbox itself goes: its folders and everything in them stay - and the address can't be used for a
 * new mailbox - until that data is erased. `erase: true` (administrators only; anybody else is refused 403 before anything is
 * deleted) also files that erasure in the same step, which the server then runs in the background; without it the data is left for
 * `admin/leftoverMailboxApi.ts` to list and erase later.
 */
export function deleteMailbox(uid: string, version: number, options: { erase?: boolean } = {}, client?: ApiClient): Promise<void> {
    return withClient(
        client,
        `/mail/mailboxes/${encodeURIComponent(uid)}?version=${version}${options.erase ? "&erase=true" : ""}`,
        { method: "DELETE" },
    );
}

export type QuarantineReason = "infected" | "spam_policy" | "transport_rule" | "other";

export interface QuarantineEntry {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    mailboxUid: string;
    originalMessageUid?: string;
    reason: QuarantineReason;
    scanResultUid: string;
    rawBlobKey: string;
    releasedAt?: string;
    releasedByUserUid?: string;
}

/** Lists quarantined mail for a mailbox the caller owns or has been granted; with `scope: "admin"` (admin console only), for any mailbox. */
export function listQuarantine(
    mailboxUid: string,
    params: ListParams & AdminScopeParams = {},
    client?: ApiClient,
): Promise<QuarantineEntry[]> {
    return withClient(client, `/mail/quarantine?${buildQuery(params, { mailboxUid, ...scopeQuery(params) })}`);
}

/**
 * Marks a quarantined entry released. This only updates the record's metadata — it does not re-inject the
 * message into normal delivery (see `@rapidmx/restapi`'s NOTES.md for why that's an explicit non-goal here).
 */
export function releaseQuarantineEntry(
    uid: string,
    version: number,
    releasedByUserUid: string,
    client?: ApiClient,
): Promise<QuarantineEntry> {
    return withClient(client, `/mail/quarantine/${encodeURIComponent(uid)}`, {
        method: "PUT",
        body: JSON.stringify({ uid, version, releasedAt: new Date().toISOString(), releasedByUserUid }),
    });
}

export type IngestStatus = "pending" | "scanning" | "delivered" | "failed";

export interface IngestQueueEntry {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    mailboxUid: string;
    envelopeFrom: string;
    envelopeTo: string[];
    rawBlobKey: string;
    status: IngestStatus;
    errorMessage?: string;
    /** How many times scanning has failed for this entry; unset until the first failure. */
    attempts?: number;
    /** ISO 8601 - when a `failed` entry becomes eligible for its next retry; unset once retries are exhausted. */
    nextAttemptAt?: string;
    /** ISO 8601 - while `scanning`, when the claiming worker's lease expires (after which the entry can be
     * claimed again). */
    scanLeaseExpiresAt?: string;
}

/** Lists ingest-queue entries for a mailbox the caller owns or has been granted - useful for diagnosing stuck delivery; with
 * `scope: "admin"` (admin console only), for any mailbox. */
export function listIngestQueue(
    mailboxUid: string,
    params: ListParams & AdminScopeParams = {},
    client?: ApiClient,
): Promise<IngestQueueEntry[]> {
    return withClient(client, `/mail/ingest-queue?${buildQuery(params, { mailboxUid, ...scopeQuery(params) })}`);
}

export interface AclRecord {
    userOrRoleId: string;
    actions: string[];
}

export interface AccessControlList {
    uid: string;
    version: number;
    parentUid?: string;
    records: AclRecord[];
}

/** Fetches a mailbox's own ACL — its `records` are its owner's/delegates' grants (see BaseACLRoute). The server only answers a
 * caller who holds full access to that mailbox as themselves (never through a trusted role): to list, grant or revoke a mailbox's
 * members use `listMailboxAccess()`/`setMailboxAccess()`/`removeMailboxAccess()` (`mailboxAccessApi.ts`), which is also the
 * audited way an administrator shares an ownerless mailbox. */
export function getMailboxAcl(mailboxUid: string, client?: ApiClient): Promise<AccessControlList> {
    return withClient(client, `/acls/${encodeURIComponent(mailboxUid)}`);
}

/**
 * Grants (or replaces, if `userOrRoleId` already has a record) a delegate's access to a mailbox — the
 * mechanism behind Exchange-style shared mailboxes. Read-modify-write against the ACL's own optimistic
 * `version`, so concurrent grants can conflict; the caller should retry on a 409/version-mismatch.
 */
export async function grantMailboxAccess(
    mailboxUid: string,
    userOrRoleId: string,
    actions: string[],
    client?: ApiClient,
): Promise<AccessControlList> {
    const acl = await getMailboxAcl(mailboxUid, client);
    const records = acl.records.filter((r) => r.userOrRoleId !== userOrRoleId);
    records.push({ userOrRoleId, actions });
    return withClient(client, `/acls/${encodeURIComponent(mailboxUid)}`, {
        method: "PUT",
        body: JSON.stringify({ uid: mailboxUid, version: acl.version, records }),
    });
}

/** Revokes a delegate's access to a mailbox previously granted via `grantMailboxAccess`. */
export async function revokeMailboxAccess(mailboxUid: string, userOrRoleId: string, client?: ApiClient): Promise<AccessControlList> {
    const acl = await getMailboxAcl(mailboxUid, client);
    const records = acl.records.filter((r) => r.userOrRoleId !== userOrRoleId);
    return withClient(client, `/acls/${encodeURIComponent(mailboxUid)}`, {
        method: "PUT",
        body: JSON.stringify({ uid: mailboxUid, version: acl.version, records }),
    });
}

export type FolderType =
    | "inbox"
    | "sent_items"
    | "drafts"
    | "deleted_items"
    | "outbox"
    | "junk"
    | "archive"
    | "calendar"
    | "contacts"
    | "tasks"
    | "notes"
    | "user";

export interface Folder {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    mailboxUid: string;
    name: string;
    type: FolderType;
    parentFolderUid?: string;
    unreadCount: number;
    totalCount: number;
    /** Display color for a `calendar`-type folder (a hex string or palette key) — unused by every other
     * folder type. Absent on a mailbox's original auto-provisioned calendar; see `calendarColors.ts`'s
     * `colorForFolder` for the fallback every caller should use instead of reading this field directly. */
    color?: string;
}

/** Lists a mailbox's folders — visible to its owner, any delegate the mailbox is shared with, or (trusted) anyone. */
export function listFolders(mailboxUid: string, client?: ApiClient): Promise<Folder[]> {
    return withClient(client, `/mail/folders?${buildQuery({ limit: 200 }, { mailboxUid })}`);
}

export interface CreateFolderInput {
    mailboxUid: string;
    name: string;
    type: FolderType;
    parentFolderUid?: string;
    color?: string;
}

/** Creates a new folder — e.g. an additional `calendar`-type folder for multi-calendar support. Nothing
 * about folder creation is type-restricted server-side (see the Phase 4 plan's own note on
 * `BaseFolderRoute.create()`), so this is just a thin wrapper, not a new backend capability. */
export function createFolder(input: CreateFolderInput, client?: ApiClient): Promise<Folder> {
    return withClient(client, "/mail/folders", {
        method: "POST",
        body: JSON.stringify({ unreadCount: 0, totalCount: 0, ...input }),
    });
}

export interface UpdateFolderInput {
    uid: string;
    version: number;
    name?: string;
    color?: string;
}

export function updateFolder(input: UpdateFolderInput, client?: ApiClient): Promise<Folder> {
    return withClient(client, `/mail/folders/${encodeURIComponent(input.uid)}`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

export type RecipientType = "to" | "cc" | "bcc";

export interface Recipient {
    address: string;
    displayName?: string;
    type: RecipientType;
}

export interface MessageFlags {
    read: boolean;
    flagged: boolean;
    answered: boolean;
    forwarded: boolean;
}

export type MessageImportance = "low" | "normal" | "high";

/** Mirrors `@rapidmx/restapi`'s `MessageClassification` enum values exactly (`classify()`'s `classifyAs`
 * body field only accepts these two literal strings). */
export type MessageClassification = "focused" | "other";

export interface Message {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    folderUid: string;
    mailboxUid: string;
    messageId: string;
    subject: string;
    from: Recipient;
    recipients: Recipient[];
    sentDate: string;
    receivedDate: string;
    bodyPreview: string;
    flags: MessageFlags;
    /** Server-managed mirror of `flags.read`, which exists only so the *server* can filter and sort on it
     * (`flags` is one JSON column, so nothing can index into it). Read `flags.read`, not this: it is never
     * accepted in a request body, and a message stored before these fields existed carries none of them. */
    read?: boolean;
    /** Server-managed mirror of `flags.flagged` — see `read`. */
    flagged?: boolean;
    /** Server-managed mirror of `from.address`, lowercased and trimmed — see `read`. */
    fromAddress?: string;
    importance: MessageImportance;
    /** Server-managed sortable rank of `importance` (low 0, normal 1, high 2) — see `read`. */
    importanceRank?: number;
    hasAttachments: boolean;
    /** Set once `recallMessage()` has been called on this message — a recall is asynchronous and
     * best-effort (see that function's own doc comment), so this is the only signal a caller gets;
     * there is no separate "recalled successfully"/"failed" outcome synced onto the record itself. */
    recallRequestedAt?: string;
    /** Set by `sendMessage()` with a future `scheduledSendTime` option, which defers relay until then instead of
     * sending immediately — mirrors Outlook's "Do not deliver before". The message sits in the mailbox's
     * `outbox` folder (lazily created on the first scheduled send — never eagerly provisioned the way
     * Drafts/Sent Items are) until `@rapidmx/restapi`'s own `ScheduledSendJob` relays it and clears
     * this field. */
    scheduledSendTime?: string;
    /** Consecutive failed `ScheduledSendJob` attempts for the current scheduled send - each failure pushes
     * `scheduledSendTime` forward; cleared on success and when the job gives up. */
    scheduledSendAttempts?: number;
    /** Why `ScheduledSendJob` gave up on (or refused) this scheduled send. Set together with clearing
     * `scheduledSendTime`, so the message stays in Outbox unsent - show it so the user can fix and resend.
     * Cleared on a successful send. */
    scheduledSendError?: string;
    /** Set once the transport accepted this message; cleared when it is filed into Sent Items. */
    scheduledSendRelayedAt?: string;
    /** The in-flight marker of a send (the claim's lease expiry). While it lies in the future the message can't be
     * moved out of Outbox. */
    scheduledSendLeaseExpiresAt?: string;
    /** Absent means Focused — see `classifyMessage()` and `@rapidmx/restapi`'s own
     * `FocusedInboxUtils.classifyMessage()` doc comment for the full precedence rule this reflects. */
    inferenceClassification?: MessageClassification;
    /** Set on a draft before `sendMessage()` to request a receipt, overriding the mailbox's own
     * `alwaysRequestReceiptInternal`/`External` defaults — see `setMessageRequestReceipt()`. Meaningless
     * once the message has actually been sent. */
    requestReceipt?: boolean;
    /** `true` when a delivery/read receipt was requested but this (recipient) mailbox's
     * `autoSendReceiptsInternal`/`External` setting held it for the owner's explicit approval instead of
     * sending it immediately — see `approveReceipt()`/`declineReceipt()`. Always present on a real
     * delivered `Message` (defaults `false`), same optional-for-old-fixtures caveat as `Mailbox.oofEnabled`. */
    deliveryReceiptPending?: boolean;
    readReceiptPending?: boolean;
    /** The per-recipient delivery/read roster on a *sent* message — the client-visible tracking indicator.
     * `undefined` (not an empty array) when no receipt was ever requested for this message. */
    receiptStatus?: MessageReceiptEntry[];
    /** `true` when this message's body is S/MIME (CMS) encrypted — computed server-side by
     * `@rapidmx/restapi`'s `ScanPipeline` from the actual stored MIME structure, not something a
     * client ever sets directly. Says nothing about whether it's *signed* — see
     * `specs/end-to-end_encryption.md`'s Message Security Indicators (encryption and signing are
     * separate guarantees); signature verification happens client-side by decrypting/parsing the
     * stored body, not from a flag this API exposes. Always present on a real `Message` (defaults
     * `false` server-side), same optional-for-old-fixtures caveat as `Mailbox.oofEnabled`. */
    encrypted?: boolean;
    /** The raw RFC 2369/8058 `List-Unsubscribe` header value, if present — computed server-side by
     * `@rapidmx/restapi`'s `ScanPipeline` from the stored MIME, the strongest single bulk-mail signal it
     * captures. Used client-side to detect list traffic when replying, per
     * `specs/end-to-end_encryption.md`'s "Mailing lists" note under Digital Signatures: a list that
     * appends a footer after signing invalidates the signature, so composing a reply to one SHOULD
     * default signing off. `undefined` for ordinary mail — never computed or guessed client-side. */
    listUnsubscribeHeader?: string;
    /** `Label.uid`s applied to this message (Gmail-style labels, `labelsApi.ts`) - either set directly
     * (`setMessageLabels()`) or auto-applied server-side by a `MailFilterActionType.APPLY_LABEL` rule.
     * `undefined`/empty means no labels. */
    labelUids?: string[];
    /** An opaque client-written verification seal (at most 2048 characters of `[A-Za-z0-9+/=_.:-]`) recording that this
     * message's signature verified when first opened - see `crypto/verificationSeal.ts` and
     * `setMessageVerificationSeal()`. The server stores it as given, never interprets it, and never copies it to another
     * message. Absent until a client writes one. */
    verificationSeal?: string;
    /** The vault `masterKeyGeneration` `verificationSeal` was written under, as sent to `setMessageVerificationSeal()`. */
    verificationSealGeneration?: number;
    /** What the reader reported this message as (`reportMessage()`); server-managed, never written by a client. Absent (or `null`) when never reported. */
    reportedAs?: MessageReportKind | null;
    /** When `reportedAs` was last set. */
    dateReported?: string | null;
    /** The `messageId` of the message this one replies to (RFC 5322 `In-Reply-To`, angle brackets stripped) -
     * parsed from the MIME on a delivered message, and what a compose client passes to `createDraft()` when it
     * opens a reply. Absent on a message that replies to nothing. */
    inReplyTo?: string;
    /** This message's thread, oldest first (RFC 5322 `References`, angle brackets stripped): the thread root's
     * `messageId`, then each reply's down to the one this message replies to. Empty, or absent on a message
     * stored before the field existed. See `buildReplyThreading()` in `compose/composeQuoting.ts`. */
    references?: string[];
    /** Server-assigned: the thread this message is grouped under in a conversation list (`conversationsApi.ts`).
     * Derived at delivery/send time from `references`/`inReplyTo`, never accepted in a request body. */
    conversationId?: string;
    /** Server-managed: the iTIP `METHOD` of the calendar file this message carries - `"REQUEST"`, `"REPLY"`, `"CANCEL"`,
     * `"PUBLISH"` or `"COUNTER"`, or `""` when the file names none - set on delivery for any message with a readable calendar file.
     * Absent on a message with none. Lets a list mark meeting requests without opening every message. */
    meetingMethod?: string;
    /** Server-managed: what the reader answered a meeting request with (`respondToMessageInvite()`), when they have. */
    meetingResponse?: "accepted" | "tentative" | "declined";
}

export interface MessageReceiptEntry {
    recipientAddress: string;
    deliveredAt?: string;
    readAt?: string;
}

/**
 * The sort keys `listMessages()` accepts, mirroring `@rapidmx/restapi`'s own `MESSAGE_LIST_SORTS` exactly —
 * anything else is refused with a 400. This is the whole set this data model can support: Outlook's sort menu
 * also offers Category, Flag status due date, Size and Type, and a RapidMX `Message` has no field behind any of
 * those (labels are multi-valued, so there is no single category to order by; there is no follow-up due date,
 * no stored message size and no message class). "Flag status" is `flagged`.
 */
export type MessageListSort = "date" | "sentDate" | "from" | "subject" | "importance" | "flagged";

/**
 * Outlook's "Newest on top" (`desc`) / "Oldest on top" (`asc`). Left off, the server picks the direction that
 * reads naturally for the key — newest/highest/flagged first for `date`/`sentDate`/`importance`/`flagged`, A-Z
 * for `from`/`subject`.
 */
export type MessageSortOrder = "asc" | "desc";

/**
 * The named filters `listMessages()` accepts, mirroring `@rapidmx/restapi`'s own `MESSAGE_LIST_FILTERS`
 * exactly. `focused`/`other` are the Focused Inbox split (only meaningful in the Inbox; `focused` includes a
 * message carrying no classification at all, which is what absent means).
 *
 * Outlook's filter menu additionally offers "To me", "Mentions me" and "Has calendar invites"; none of the
 * three is a server-side filter here, because nothing on a `Message` records them.
 */
export type MessageListFilter = "all" | "unread" | "read" | "flagged" | "hasAttachments" | "focused" | "other";

/**
 * The most labels one list request may filter by, matching `@rapidmx/restapi`'s own
 * `MAX_MESSAGE_LABEL_FILTER_UIDS` — a longer set is refused with a 400, so a label menu offering multiple
 * selection should stop the user here rather than send it.
 */
export const MAX_MESSAGE_LABEL_FILTER = 20;

/** Paging plus the mail list's own sort/filter vocabulary. */
export interface MessageListParams extends ListParams {
    sortBy?: MessageListSort;
    sortOrder?: MessageSortOrder;
    filter?: MessageListFilter;
    /**
     * `Label.uid`s to filter by (list the mailbox's labels with `listLabels()` in `labelsApi.ts`). A message is
     * listed if it carries ANY of them, which is then ANDed with `filter` — so `{ filter: "unread", labelUids:
     * [red, blue] }` is "unread, and labelled red or blue". Order is irrelevant and duplicates are ignored. An
     * empty array is no filter at all, and a uid naming no label (or one belonging to another mailbox) matches
     * nothing. At most `MAX_MESSAGE_LABEL_FILTER` of them, each a real uid — anything else is a 400.
     */
    labelUids?: string[];
}

/** Only the sort/filter params actually set, so a default list sends the same URL it always did. */
export function messageListQuery(params: MessageListParams): Record<string, string> {
    const query: Record<string, string> = {};
    if (params.sortBy) {
        query.sortBy = params.sortBy;
    }
    if (params.sortOrder) {
        query.sortOrder = params.sortOrder;
    }
    if (params.filter) {
        query.filter = params.filter;
    }
    // One comma-separated value, the only form the server parses. An empty selection sends no parameter at all
    // rather than an empty one, so a filter menu with nothing ticked makes the request it always made.
    if (params.labelUids?.length) {
        query.labelUids = params.labelUids.join(",");
    }
    return query;
}

/**
 * Lists messages in a folder — newest received first unless `sortBy`/`sortOrder` say otherwise, and unfiltered
 * unless `filter`/`labelUids` say otherwise. All of them are applied by the *database*, over the whole folder
 * rather than over the page this call happens to return, so `page`/`limit` stay correct under a filter and a
 * sort. Ties are broken by `uid`, so a message never appears on two pages or on neither.
 */
export function listMessages(folderUid: string, params: MessageListParams = {}, client?: ApiClient): Promise<Message[]> {
    return withClient(client, `/mail/messages?${buildQuery(params, { folderUid, ...messageListQuery(params) })}`);
}

export function getMessage(uid: string, client?: ApiClient): Promise<Message> {
    return withClient(client, `/mail/messages/${encodeURIComponent(uid)}`);
}

/**
 * Attempts to recall a message this mailbox previously sent — only valid for a message currently in
 * Sent Items (enforced server-side). Asynchronous and best-effort: this composes and relays a control
 * message to every original recipient, but the actual delete-if-still-unread mutation happens later on
 * each recipient's own mail system — there is no synchronous "recalled" outcome to report back, and the
 * only visible effect here is `recallRequestedAt` getting set on the response.
 */
export function recallMessage(uid: string, client?: ApiClient): Promise<Message> {
    return withClient(client, `/mail/messages/${encodeURIComponent(uid)}/recall`, { method: "POST" });
}

/**
 * Moves a message into the mailbox's Archive folder (`FolderType.ARCHIVE`), lazily created on first use
 * server-side — same pattern as Sent Items/Outbox, no client-side folder-creation step needed. Rejects
 * (400, surfaced as an `ApiRequestError`) for a message currently in Drafts or Outbox. Idempotent —
 * archiving an already-archived message is a no-op that still returns the message.
 */
export function archiveMessage(uid: string, client?: ApiClient): Promise<Message> {
    return withClient(client, `/mail/messages/${encodeURIComponent(uid)}/archive`, { method: "POST" });
}

/**
 * Moves a message between the Focused and Other halves of the Inbox — Outlook's "Move to Other" gesture.
 * With `applyToSender: true` ("Always move to Other"), also upserts a standing `FocusedInboxOverride` for
 * every future message from the same sender (see `focusedInboxOverridesApi.ts`) in the same round trip.
 */
export function classifyMessage(
    uid: string,
    classifyAs: MessageClassification,
    applyToSender = false,
    client?: ApiClient,
): Promise<Message> {
    return withClient(client, `/mail/messages/${encodeURIComponent(uid)}/classify`, {
        method: "POST",
        body: JSON.stringify({ classifyAs, applyToSender }),
    });
}

/**
 * Marks a message read/unread in place. `folderUid` must be included even though it isn't changing — every
 * `Message` update is scoped by its owning folder (see `BaseScopedChildRoute`), and this framework's `PUT`
 * routes replace the whole record rather than patch individual fields.
 */
export function setMessageRead(message: Message, read: boolean, client?: ApiClient): Promise<Message> {
    return withClient(client, `/mail/messages/${encodeURIComponent(message.uid)}`, {
        method: "PUT",
        body: JSON.stringify({ uid: message.uid, version: message.version, flags: { ...message.flags, read } }),
    });
}

/** Flags/unflags a message in place — Outlook's flag-status toggle, and what `listMessages({ filter:
 * "flagged" })` and `listFlaggedMessages()` select on. */
export function setMessageFlagged(message: Message, flagged: boolean, client?: ApiClient): Promise<Message> {
    return withClient(client, `/mail/messages/${encodeURIComponent(message.uid)}`, {
        method: "PUT",
        body: JSON.stringify({ uid: message.uid, version: message.version, flags: { ...message.flags, flagged } }),
    });
}

/** Moves a message into another folder of the same mailbox — how "Move to", "Archive" (to the Archive folder),
 * "Report junk" (to Junk) and "Delete" (to Deleted Items) are all expressed. */
export function moveMessage(message: Message, folderUid: string, client?: ApiClient): Promise<Message> {
    return withClient(client, `/mail/messages/${encodeURIComponent(message.uid)}`, {
        method: "PUT",
        body: JSON.stringify({ uid: message.uid, version: message.version, folderUid }),
    });
}

/** What a message can be reported as - see `reportMessage()`. */
export type MessageReportKind = "junk" | "phishing" | "not_junk";

/** Why the server did not teach its spam filter from a report: `encrypted` (it has no plaintext to teach), `disabled` (learning is switched off),
 * `unsupported` (no spam engine, or one that cannot learn), `too_large` (over the size it reads) or `failed` (the engine could not be reached,
 * refused, or the message could not be read). The report itself still happened. */
export type MessageLearnSkipped = "encrypted" | "disabled" | "unsupported" | "too_large" | "failed";

/** What `reportMessage()` answers. */
export interface MessageReportResult {
    uid: string;
    kind: MessageReportKind;
    /** The message changed folder; `false` when it was already where the report sends it. */
    moved: boolean;
    /** The folder the message is in now: the mailbox's Junk Email (`junk`, `phishing`) or Inbox (`not_junk`). */
    folderUid: string;
    /** The spam filter was taught from the message. */
    learned: boolean;
    /** Why it was not, when `learned` is `false` (absent when it was). */
    learnSkipped?: MessageLearnSkipped;
    /** The address added to the mailbox's safe senders, for `alwaysTrustSender`; absent when none was asked or the message names no usable one. */
    safeSender?: string;
}

/** What `reportMessage()` may also ask for. */
export interface ReportMessageOptions {
    /** With `not_junk` only (else a 400): also add the message's From address to the mailbox's safe senders. Needs full access to the mailbox (403 otherwise,
     * before anything is done). */
    alwaysTrustSender?: boolean;
}

/**
 * Reports a message as junk, phishing or not junk - `POST /mail/messages/:uid/report`. The SERVER moves it (`junk` and `phishing` to the mailbox's Junk Email,
 * `not_junk` to its Inbox; a message already there is not moved), records what was reported, teaches its spam filter (never for an encrypted message) and
 * writes an audit entry; a caller needs no folder uid and no `version`. Rejects with a 400 for a message in Drafts or Outbox, a 403 without the right to change
 * the message (or, for `alwaysTrustSender`, without full access to the mailbox), a 404 for an unknown message - and also for a server that predates the route,
 * where a caller falls back to `moveMessage()`.
 */
export function reportMessage(
    uid: string,
    kind: MessageReportKind,
    options: ReportMessageOptions = {},
    client?: ApiClient,
): Promise<MessageReportResult> {
    return withClient(client, `/mail/messages/${encodeURIComponent(uid)}/report`, {
        method: "POST",
        body: JSON.stringify({ kind, ...(options.alwaysTrustSender ? { alwaysTrustSender: true } : {}) }),
    });
}

/**
 * The most updates `bulkUpdateMessages()` puts in one request, matching `@rapidmx/restapi`'s own
 * `MAX_BULK_UPDATE` — a longer list is refused with a 400, so the helper below chunks rather than sending it.
 */
export const MAX_BULK_MESSAGE_UPDATE = 100;

/** One element of a bulk update: `uid` and the caller's last-known `version` (the server rejects a stale one
 * with a 409), plus whichever fields are changing. */
export interface MessageUpdate {
    uid: string;
    version: number;
    [field: string]: unknown;
}

/**
 * Applies `updates` through `PUT /mail/messages`, the bulk form of the single-message update — one request per
 * `MAX_BULK_MESSAGE_UPDATE` updates instead of one per message, with every permission, folder and legal-hold
 * check the single-message path makes.
 *
 * Deliberately NOT atomic, on either side of the wire: the server applies each element in order and the first
 * failure (a stale `version`, a refused move) aborts the rest of *that* request, leaving the elements before it
 * applied; this helper then stops and rejects rather than sending the remaining chunks. So a caller should
 * refetch the list after a rejection instead of assuming nothing happened, and should send fresh `version`s -
 * a bulk action over a stale selection is the common way to hit a 409. For a per-element outcome, call the
 * single-message functions instead.
 *
 * Resolves with every message actually updated, in request order.
 */
export async function bulkUpdateMessages(updates: MessageUpdate[], client?: ApiClient): Promise<Message[]> {
    const updated: Message[] = [];
    for (let i = 0; i < updates.length; i += MAX_BULK_MESSAGE_UPDATE) {
        const chunk = updates.slice(i, i + MAX_BULK_MESSAGE_UPDATE);
        updated.push(...(await withClient<Message[]>(client, "/mail/messages", { method: "PUT", body: JSON.stringify(chunk) })));
    }
    return updated;
}

/** Marks a whole selection read/unread in one pass — see `bulkUpdateMessages()` for the failure semantics. */
export function setMessagesRead(messages: Message[], read: boolean, client?: ApiClient): Promise<Message[]> {
    return bulkUpdateMessages(
        messages.map((message) => ({ uid: message.uid, version: message.version, flags: { ...message.flags, read } })),
        client,
    );
}

/** Flags/unflags a whole selection in one pass — see `bulkUpdateMessages()`. */
export function setMessagesFlagged(messages: Message[], flagged: boolean, client?: ApiClient): Promise<Message[]> {
    return bulkUpdateMessages(
        messages.map((message) => ({ uid: message.uid, version: message.version, flags: { ...message.flags, flagged } })),
        client,
    );
}

/** Moves a whole selection into `folderUid` — bulk Move, Archive, Report junk and Delete (to Deleted Items)
 * are all this call with a different target folder. See `bulkUpdateMessages()`. */
export function moveMessages(messages: Message[], folderUid: string, client?: ApiClient): Promise<Message[]> {
    return bulkUpdateMessages(
        messages.map((message) => ({ uid: message.uid, version: message.version, folderUid })),
        client,
    );
}

/** Sets the full `labelUids` list on a whole selection — see `setMessageLabels()` and `bulkUpdateMessages()`. */
export function setMessagesLabels(messages: Message[], labelUids: string[], client?: ApiClient): Promise<Message[]> {
    return bulkUpdateMessages(
        messages.map((message) => ({ uid: message.uid, version: message.version, labelUids })),
        client,
    );
}

/** Sets a message's full `labelUids` list (not an add/remove delta - the caller computes the complete
 * new set, same convention as `Note`/`Task` label-like fields elsewhere in restapi). Deleting a label
 * elsewhere already strips it server-side from every message (`labelsApi.ts#deleteLabel()`'s own doc
 * comment) - this is only for a user explicitly applying/removing labels on one message. */
export function setMessageLabels(message: Message, labelUids: string[], client?: ApiClient): Promise<Message> {
    return withClient(client, `/mail/messages/${encodeURIComponent(message.uid)}`, {
        method: "PUT",
        body: JSON.stringify({ uid: message.uid, version: message.version, labelUids }),
    });
}

/**
 * Cancels a scheduled send by moving the message out of Outbox into `draftsFolderUid` (the mailbox's Drafts
 * folder, which the caller resolves). The server clears `scheduledSendTime` itself on any move out of Outbox;
 * the `null` sent here is accepted and ignored.
 */
export function cancelScheduledSend(message: Message, draftsFolderUid: string, client?: ApiClient): Promise<Message> {
    return withClient(client, `/mail/messages/${encodeURIComponent(message.uid)}`, {
        method: "PUT",
        body: JSON.stringify({ uid: message.uid, version: message.version, scheduledSendTime: null, folderUid: draftsFolderUid }),
    });
}

/**
 * Sets a draft's `requestReceipt` ahead of calling `sendMessage()`, overriding the mailbox's own
 * `alwaysRequestReceiptInternal`/`External` defaults for this one message — same ordinary-`PUT`-before-
 * `send()` convention.
 */
export function setMessageRequestReceipt(message: Message, requestReceipt: boolean, client?: ApiClient): Promise<Message> {
    return withClient(client, `/mail/messages/${encodeURIComponent(message.uid)}`, {
        method: "PUT",
        body: JSON.stringify({ uid: message.uid, version: message.version, requestReceipt }),
    });
}

/**
 * Thrown by `setMessageVerificationSeal()` when restapi answers `409`: the message already carries a different seal the
 * server won't replace (it replaces one only when the stored seal's generation is older than the vault's current
 * `masterKeyGeneration` and the request's generation equals the current one). Still an `ApiRequestError` (`status` 409).
 * A caller writing seals best effort should ignore it.
 */
export class VerificationSealConflictError extends ApiRequestError {
    constructor(message: string, code?: string) {
        super(message, 409, code);
        this.name = "VerificationSealConflictError";
    }
}

/**
 * Stores a verification seal on a message (`PUT /mail/messages/:id/verification-seal` with
 * `{ seal, masterKeyGeneration }`), normally `MessageSecurityResult.sealToWrite`'s two fields from
 * `crypto/messageSecurity.ts`'s `evaluateMessageSecurityWithSeal()`. Resolves with the updated message; storing the
 * identical seal again succeeds. Rejects with `VerificationSealConflictError` on `409` (a different seal is stored and
 * isn't replaceable - see that class), and a plain `ApiRequestError` for `400` (an invalid seal or generation) and
 * `403`/`404`.
 */
export async function setMessageVerificationSeal(
    messageUid: string,
    seal: string,
    masterKeyGeneration: number,
    client?: ApiClient,
): Promise<Message> {
    try {
        return await withClient<Message>(client, `/mail/messages/${encodeURIComponent(messageUid)}/verification-seal`, {
            method: "PUT",
            body: JSON.stringify({ seal, masterKeyGeneration }),
        });
    } catch (err) {
        if (err instanceof ApiRequestError && err.status === 409) {
            throw new VerificationSealConflictError(err.message, err.code);
        }
        throw err;
    }
}

export type ReceiptType = "delivery" | "read";

/** Sends a delivery/read receipt this mailbox held pending the owner's explicit approval (see
 * `Message.deliveryReceiptPending`/`readReceiptPending`). */
export function approveReceipt(uid: string, type: ReceiptType, client?: ApiClient): Promise<Message> {
    return withClient(client, `/mail/messages/${encodeURIComponent(uid)}/receipt/approve`, {
        method: "POST",
        body: JSON.stringify({ type }),
    });
}

/** Permanently declines a pending receipt — no later re-prompt for that same event. */
export function declineReceipt(uid: string, type: ReceiptType, client?: ApiClient): Promise<Message> {
    return withClient(client, `/mail/messages/${encodeURIComponent(uid)}/receipt/decline`, {
        method: "POST",
        body: JSON.stringify({ type }),
    });
}

export interface Attachment {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    messageUid: string;
    folderUid: string;
    mailboxUid: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    isInline: boolean;
    /** The part's `Content-ID`, without angle brackets: what an inline image's `cid:` reference names. */
    contentId?: string;
}

/** Lists the attachments belonging to a single message. */
export function listAttachments(folderUid: string, messageUid: string, client?: ApiClient): Promise<Attachment[]> {
    return withClient(client, `/mail/attachments?${buildQuery({ limit: 200 }, { folderUid, messageUid })}`);
}

/** Removes an attachment (from a draft). The server re-derives the message's `hasAttachments` itself. */
export function deleteAttachment(uid: string, version: number, client?: ApiClient): Promise<void> {
    return withClient(client, `/mail/attachments/${encodeURIComponent(uid)}?version=${version}`, { method: "DELETE" });
}

/** The URL to download/display an attachment's binary content — not fetched via `apiFetch`, used directly as
 * a link/image `href`/`src`. Honors `configureApiBaseUrl()` (see `apiUrl()`). */
export function attachmentContentUrl(uid: string): string {
    return apiUrl(`/mail/attachments/${encodeURIComponent(uid)}/content`);
}

/**
 * Uploads a file's raw bytes as a new attachment on a not-yet-sent draft. Bypasses `apiFetch` — that helper
 * always forces `Content-Type: application/json`, which would corrupt binary content; this sends the file's
 * own bytes/type directly instead, matching `BaseAttachmentRoute.upload`'s expectation of a raw request body.
 */
export async function uploadAttachment(messageUid: string, file: File, options: { inline?: boolean; contentId?: string } = {}): Promise<Attachment> {
    // Percent-encoded, not form-encoded (`URLSearchParams` writes a space as `+`, which the server reads as a plus sign: "My+photo.png").
    const query: Record<string, string> = { messageUid, filename: file.name, mimeType: file.type || "application/octet-stream" };
    if (options.inline) {
        // An image shown in the text of the message: it goes out as an inline part, which the text refers to by this `Content-ID`
        // (`BaseMailComposeRoute.rewriteInlineImageSources()` turns the editor's preview URL into that `cid:` reference).
        query.isInline = "true";
        query.contentId = options.contentId ?? newContentId();
    }
    const params = Object.entries(query)
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
        .join("&");
    const res = await fetch(apiUrl(`/mail/attachments/upload?${params}`), {
        method: "POST",
        credentials: "include",
        headers: withCsrfHeader({ "Content-Type": file.type || "application/octet-stream" }),
        body: file,
    });
    const contentType = res.headers.get("content-type") ?? "";
    const responseBody = contentType.includes("application/json") ? await res.json().catch(() => undefined) : undefined;
    if (!res.ok) {
        const message = (responseBody && (responseBody.message || responseBody.error)) || res.statusText || "Upload failed.";
        throw new ApiRequestError(message, res.status, responseBody?.code);
    }
    return responseBody as Attachment;
}

export interface ComposeRecipientInput {
    address: string;
    displayName?: string;
}

export interface AssembleDraftInput {
    to: ComposeRecipientInput[];
    cc?: ComposeRecipientInput[];
    bcc?: ComposeRecipientInput[];
    subject?: string;
    html: string;
}

/** What a draft records about the thread it belongs to - see `createDraft()`. */
export interface DraftThreading {
    /** The `messageId` of the message being replied to (`Message.inReplyTo`). */
    inReplyTo?: string;
    /** The thread's `References` chain, oldest first, ending with `inReplyTo` (`Message.references`). */
    references?: string[];
}

/**
 * Creates a blank draft `Message` in the given folder (normally the mailbox's Drafts folder) to compose into.
 *
 * A reply MUST pass `threading` (build it with `buildReplyThreading()` from the message being replied to).
 * `@rapidmx/restapi` writes those values into the `In-Reply-To`/`References` headers of the MIME it relays and
 * groups the message into the replied-to message's conversation; a reply created without them is relayed with no
 * threading headers at all, and every recipient - and the sender's own Sent Items copy - files it as a brand-new
 * conversation. Nothing else recovers them: this server composes the MIME from the recipients, subject and HTML
 * passed to `assembleDraft()`, which say nothing about what is being replied to.
 */
export function createDraft(
    mailboxUid: string,
    folderUid: string,
    threading?: DraftThreading,
    client?: ApiClient,
): Promise<Message> {
    return withClient(client, "/mail/messages", {
        method: "POST",
        body: JSON.stringify({
            mailboxUid,
            folderUid,
            messageId: `${crypto.randomUUID()}@webmail`,
            ...(threading?.inReplyTo ? { inReplyTo: threading.inReplyTo } : {}),
            ...(threading?.references?.length ? { references: threading.references } : {}),
        }),
    });
}

/** Deletes a message - e.g. an unsent draft that's no longer needed because compose switched to a different
 * sending mailbox. */
export function deleteMessage(uid: string, version: number, client?: ApiClient): Promise<void> {
    return withClient(client, `/mail/messages/${encodeURIComponent(uid)}?version=${version}`, { method: "DELETE" });
}

/**
 * Permanently deletes one message - `DELETE /mail/messages/:uid?purge=true`, the hard delete: the row and its search
 * document are gone and it cannot be restored, unlike `deleteMessage()` (a soft delete the server can bring back) or a
 * move into Deleted Items. Whoever may delete in the message's folder may do this - the mailbox's owner, or a delegate
 * granted `delete` - there is nothing administrative about it.
 *
 * Takes no `version`: one that no longer matches (another device flipped a flag since the list was fetched) would make
 * the server answer "not found", which is no reason to keep a message the reader has asked to erase. Refused with a
 * `409` for a message under an active legal hold (the response's message says so) or with a send in flight, and with a
 * `403` without the `delete` grant. Nothing about the message changes when it is refused, so a caller deleting several
 * reports each refusal and carries on with the rest.
 */
export function purgeMessage(uid: string, client?: ApiClient): Promise<void> {
    return withClient(client, `/mail/messages/${encodeURIComponent(uid)}?purge=true`, { method: "DELETE" });
}

/**
 * Permanently deletes every message in a folder in one request - `DELETE /mail/messages?folderUid=` (the collection
 * `truncate`, always a hard delete). All or nothing: the server checks every message for a legal hold first and refuses
 * the whole request with a `409` if any is held, and with a `403` unless the caller holds the `truncate` grant on the
 * mailbox (its owner or a manager - not a delegate who may merely delete). Resolves without saying how many messages
 * went, so a caller that needs to says so from what it knew. Messages already soft-deleted are not part of it.
 *
 * After a refusal, fall back to `purgeMessage()` per message: that removes what may be removed and says which may not.
 */
export function emptyFolder(folderUid: string, client?: ApiClient): Promise<void> {
    return withClient(client, `/mail/messages?${new URLSearchParams({ folderUid }).toString()}`, { method: "DELETE" });
}

/**
 * Assembles a draft's structured compose input (recipients/subject/HTML body, plus whatever attachments have
 * already been `uploadAttachment()`-ed onto it) into RFC 5322 MIME and stores it as the draft's `bodyBlobKey`
 * — see `BaseMailComposeRoute` (this app's own compose-assembly glue, since `@rapidmx/restapi`'s `send()`
 * itself does no MIME composition). Does not send the message.
 */
export async function assembleDraft(messageUid: string, input: AssembleDraftInput, client?: ApiClient): Promise<Message> {
    const html = await attachDataImages(messageUid, input.html);
    return withClient(client, `/mail/compose/${encodeURIComponent(messageUid)}/assemble`, {
        method: "POST",
        body: JSON.stringify({ ...input, html }),
    });
}

/** `data:` images already attached to a draft: its uid and the image, to the URL of the attachment it became. */
const attachedDataImages = new Map<string, string>();

const DATA_IMAGE_TAG = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(data:image\/[^"']*)\2/gi;

/** Names a picture by its type, for the attachment it becomes. */
function pictureName(contentType: string): string {
    return `image.${contentType.split("/")[1].replace(/\+.*/, "").replace("jpeg", "jpg")}`;
}

/**
 * `html` with each `<img>` that embeds its picture as a `data:` URI (a quoted original's image, one pasted into the editor) pointed at an
 * attachment of the draft instead: the server drops `data:` images from the message it composes, and an attachment is what it makes an
 * inline part of. A picture is attached once per draft however often the draft is saved.
 */
async function attachDataImages(messageUid: string, html: string): Promise<string> {
    const found = Array.from(html.matchAll(DATA_IMAGE_TAG));
    if (found.length === 0) {
        return html;
    }
    const urls = new Map<string, string>();
    for (const [, , , uri] of found) {
        const key = `${messageUid}\n${uri}`;
        const known = attachedDataImages.get(key);
        if (known) {
            urls.set(uri, known);
            continue;
        }
        const image = parseDataImage(uri);
        if (!image) {
            continue;
        }
        const attachment = await uploadAttachment(messageUid, new File([image.bytes as BlobPart], pictureName(image.contentType), { type: image.contentType }), { inline: true });
        const url = attachmentContentUrl(attachment.uid);
        attachedDataImages.set(key, url);
        urls.set(uri, url);
    }
    return html.replace(DATA_IMAGE_TAG, (match, start: string, quote: string, uri: string) => (urls.has(uri) ? `${start}${quote}${urls.get(uri)}${quote}` : match));
}

export interface AssembleDraftRawInput {
    to: ComposeRecipientInput[];
    cc?: ComposeRecipientInput[];
    bcc?: ComposeRecipientInput[];
    /** The message's own top-level `Subject` — for an encrypted message this MUST be the outer,
     * RFC 9788 `hcp_baseline`-obscured value (`"[...]"`, see `crypto/smimeMessage.ts`'s
     * `applyBaselineOuterHeaders()`), matching what's already in `rawMime`'s own outer header. */
    subject: string;
    /** The complete RFC 5322 message source, already finalized client-side — see
     * `crypto/smimeMessage.ts`'s `buildSignedOnlyMessage()`/`buildEncryptedMessage()`, combined with
     * the outer envelope headers (`From`/`To`/`Cc`/`Date`/`Message-ID`/`MIME-Version`) by the caller. */
    rawMime: string;
}

/**
 * Stores an already-signed/encrypted draft's raw MIME source as its `bodyBlobKey`, completely
 * unmodified — the E2E counterpart to `assembleDraft()`, for when the message body was built
 * client-side via `crypto/smimeMessage.ts` rather than from plain HTML. Does not send the message. A
 * draft assembled this way cannot carry file attachments yet — see `BaseMailComposeRoute.assembleRaw()`'s
 * own doc comment in `server`.
 */
export function assembleDraftRaw(messageUid: string, input: AssembleDraftRawInput, client?: ApiClient): Promise<Message> {
    return withClient(client, `/mail/compose/${encodeURIComponent(messageUid)}/assemble-raw`, {
        method: "POST",
        body: JSON.stringify(input),
    });
}

/** Options for `sendMessage()`. */
export interface SendMessageOptions {
    /** A future time (ISO 8601) to queue the message in Outbox until, instead of sending now. */
    scheduledSendTime?: string;
}

/**
 * Scans, relays, and moves an already-assembled draft into Sent Items - or, with a future
 * `scheduledSendTime`, queues it in Outbox for `@rapidmx/restapi`'s `ScheduledSendJob`. A message already in
 * Outbox or Sent Items is refused (409); move it back to Drafts first.
 */
export function sendMessage(messageUid: string, options?: SendMessageOptions, client?: ApiClient): Promise<Message> {
    return withClient(client, `/mail/messages/${encodeURIComponent(messageUid)}/send`, {
        method: "POST",
        ...(options?.scheduledSendTime ? { body: JSON.stringify({ scheduledSendTime: options.scheduledSendTime }) } : {}),
    });
}

/** What `queueMessageSend()` resolves with. */
export interface QueuedSend {
    /** `true`: the server accepted the message and will relay it in the background (`202 { status: "queued", message }`) - the
     * outcome arrives as a `send-succeeded`/`send-failed`/`send-retrying` push event (see `sendEvents.ts`). `false`: a server that
     * doesn't queue relayed it before answering, so the message has already been sent (`message` is its Sent Items copy). */
    queued: boolean;
    /** The message as the server holds it now - in Outbox, with its send in flight, when `queued`. */
    message: Message;
}

/**
 * Sends an already-assembled draft *in the background*: `POST /mail/messages/:id/send` with `{ background: true }`. The server
 * checks the message, moves it into Outbox with a lease and answers `202 { status: "queued", message }` at once - relaying happens
 * afterwards, and its outcome is published as push events on the mailbox's, Outbox's and Sent Items' channels rather than answered
 * here. Rejects with the server's own error (validation, permissions: the message was not queued). A server that has no queue
 * relays first and answers with the message, which resolves as `{ queued: false }` - as does a message class with no send job, which
 * answers a background send `501`: it is then sent the ordinary, synchronous way.
 */
export async function queueMessageSend(messageUid: string, client?: ApiClient): Promise<QueuedSend> {
    let result: Message | { status?: string; message?: Message };
    try {
        result = await withClient<Message | { status?: string; message?: Message }>(
            client,
            `/mail/messages/${encodeURIComponent(messageUid)}/send`,
            { method: "POST", body: JSON.stringify({ background: true }) },
        );
    } catch (err) {
        if (err instanceof ApiRequestError && err.status === 501) {
            return { queued: false, message: await sendMessage(messageUid, undefined, client) };
        }
        throw err;
    }
    const queued = result as { status?: string; message?: Message };
    if (queued.status === "queued" && queued.message) {
        return { queued: true, message: queued.message };
    }
    return { queued: false, message: result as Message };
}

/**
 * Fetches a message's raw RFC 5322 MIME source — for client-side E2E decrypt/signature-verification
 * only (`crypto/smimeMessage.ts`), never for display. Bypasses `apiFetch()` (which only ever decodes a
 * JSON response body): this server-local route (`BaseMessageRawContentRoute.ts` in `server`, mounted
 * alongside `@rapidmx/restapi`'s own `MessageRoute`) returns `message/rfc822`, not JSON — the one thing
 * that library's own `GET /:id/content` deliberately never serves (see that route's own doc comment).
 *
 * Returns a *binary string* - the response bytes decoded as Latin-1, exactly one character per byte -
 * rather than `res.text()`'s UTF-8 decoding, which would replace every invalid byte of a non-UTF-8 8bit
 * part with U+FFFD before its own `charset` is known and break any signature over those bytes. Pass it
 * straight to `evaluateMessageSecurity()` (see `crypto/mime.ts`'s doc comment on binary strings); it is
 * not display text.
 */
export async function getMessageRawContent(messageUid: string): Promise<string> {
    const res = await fetch(apiUrl(`/mail/messages/${encodeURIComponent(messageUid)}/raw`), { credentials: "include" });
    if (!res.ok) {
        const contentType = res.headers.get("content-type") ?? "";
        const body = contentType.includes("application/json") ? await res.json().catch(() => undefined) : undefined;
        const message = (body && (body.message || body.error)) || res.statusText || "Could not load this message's raw content.";
        throw new ApiRequestError(message, res.status, body?.code);
    }
    // Not `new TextDecoder("latin1")`: WHATWG maps that label to windows-1252, which remaps 0x80-0x9F and so
    // isn't byte-preserving. `bytesToBinaryString()` is an exact byte -> code unit conversion.
    return bytesToBinaryString(new Uint8Array(await res.arrayBuffer()));
}

export interface ImpersonationResult {
    token: string;
    user: { uid: string; roles: string[]; scopes: string[] };
}

/**
 * Trusted-role-only: starts an admin "log in as user" session. In production this calls auth-server
 * directly (not this app's own API) since only auth-server can mint a token carrying `userUid`'s real
 * roles/scopes the way its own sign-in flow would — see `@rapidrest/auth`'s `BaseImpersonationRoute` and
 * this repo's `.claude/NOTES.md`. The browser's `jwt` cookie is swapped for the freshly-minted token, and
 * the caller's own session is stashed (`jwt_impersonator`) so `stopImpersonating()` can restore it later.
 * The caller is responsible for navigating to `/` afterward — this call only swaps the cookie, it doesn't
 * redirect.
 *
 * @param impersonationBaseUrl The origin to call — the real auth-server in production, or `""` under
 * `yarn dev` (see `AdminConsoleRoute`/`wwwRoute`'s `fetchProps`) to instead call this app's own local
 * dev-only endpoint (`DevImpersonationRoute`), since a real auth-server isn't running locally.
 */
export function impersonateUser(impersonationBaseUrl: string, userUid: string): Promise<ImpersonationResult> {
    const init: RequestInit = { method: "POST", body: JSON.stringify({ userUid }) };
    return impersonationBaseUrl
        ? authApiFetch(impersonationBaseUrl, "/admin/impersonate", init)
        : apiFetch("/admin/impersonate", init);
}

/**
 * Ends an active impersonation session, restoring the admin's own — a no-op (`restored: false`) if none is
 * active. POST, not GET: this mutates state (swaps the active `jwt` cookie back), and a state-changing GET
 * is exploitable via a bare navigation — no form or script required at all — bypassing CSRF defenses
 * entirely, since they only ever apply to non-safe methods. See `@rapidrest/auth`'s `BaseImpersonationRoute`.
 */
export function stopImpersonating(impersonationBaseUrl: string): Promise<{ restored: boolean }> {
    return impersonationBaseUrl
        ? authApiFetch(impersonationBaseUrl, "/admin/impersonate/stop", { method: "POST" })
        : apiFetch("/admin/impersonate/stop", { method: "POST" });
}
