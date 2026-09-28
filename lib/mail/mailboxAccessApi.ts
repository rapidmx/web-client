///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s `BaseMailboxAccessRoute` (`GET/PUT/DELETE /mail/mailboxes/:id/
 * access[/:userOrRoleId]`, `GET /mail/mailboxes/lookup-by-email`) - a friendlier, purpose-built layer over
 * mailbox delegate access than this package's own `getMailboxAcl()`/`grantMailboxAccess()`/
 * `revokeMailboxAccess()` (`mailApi.ts`), which stay as-is for their one existing caller (the admin-only
 * `ShareAccessCard`). Those wrap the fully generic `BaseACLRoute` directly (raw `ACLRecord.actions[]`,
 * requires the caller hold literal `ACLAction.FULL`); this module's routes are gated at plain `"update"`
 * and speak a simple 2-tier `"viewer"`/`"manager"` vocabulary instead, so a non-admin mailbox owner or
 * delegate can use them too.
 */
import { ApiClient, withClient } from "../util/api.js";

/** A role that can be granted. */
export type MailboxAccessRole = "viewer" | "manager";

/** A member's role as listed: `"custom"` for any other set of actions granted outside this API, which can't be set
 * here - see `actions` for what it allows. */
export type MailboxAccessMemberRole = MailboxAccessRole | "custom";

export interface MailboxAccessMember {
    userOrRoleId: string;
    role: MailboxAccessMemberRole;
    /** The ACL actions the member holds. */
    actions?: string[];
    /** `userOrRoleId` is not a user uid (a username or address typed in free text, say): a person's token carries a uid, never
     * that string, so the entry almost certainly grants nothing to anyone. Replace it with the user it was meant for. */
    noEffect?: boolean;
}

/** The person a typed principal - a mailbox address, an auth-server username or e-mail alias, or a user uid - resolved to. */
export interface ResolvedPrincipal {
    /** The user uid every grant is stored against. */
    userUid: string;
    /** Known when the person owns a mailbox on this server. */
    displayName?: string;
    address?: string;
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */

/** Who a typed principal is, without granting anything - rejects with a 404 `ApiRequestError` ("No user found for ...") for nobody. */
export function resolveMailboxPrincipal(mailboxUid: string, principal: string, client?: ApiClient): Promise<ResolvedPrincipal> {
    return withClient(client, `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/access/resolve?principal=${encodeURIComponent(principal)}`);
}

export interface MailboxOwnerLookup {
    userUid: string;
    displayName: string;
}

/** Lists a mailbox's delegate members (excludes the owner's own implicit grant) - rejects with a 403
 * `ApiRequestError` if the caller doesn't hold at least `"update"` on the mailbox (an administrator, trusted + elevated, may
 * list any mailbox's members through the audited administration path). */
export function listMailboxAccess(mailboxUid: string, client?: ApiClient): Promise<MailboxAccessMember[]> {
    return withClient(client, `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/access`);
}

/** Grants (or, if already a member, updates the role of) a delegate's access to a mailbox. `userOrRoleId` names the PERSON - a user
 * uid, or anything the server resolves to one (a mailbox address, an auth-server username or e-mail alias): only the resolved uid is
 * stored, and a name that resolves to nobody rejects with a 400 `ApiRequestError` ("No user found for ..."). */
export function setMailboxAccess(mailboxUid: string, userOrRoleId: string, role: MailboxAccessRole, client?: ApiClient): Promise<MailboxAccessMember> {
    return withClient(client, `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/access/${encodeURIComponent(userOrRoleId)}`, {
        method: "PUT",
        body: JSON.stringify({ role }),
    });
}

/** What the signed-in caller may do in a mailbox, as the server's ACLs evaluate it: their own and delegate access - a
 * trusted role adds nothing, so an administrator with no grant on a mailbox gets `false` throughout. */
export interface MyMailboxAccess {
    canRead: boolean;
    /** Create items in the mailbox: drafts, events, contacts, to-dos. */
    canCreate: boolean;
    canUpdate: boolean;
    canDelete: boolean;
    /** Manage who else has access. */
    canManage: boolean;
}

/** The signed-in caller's own access to a mailbox. */
export function getMyMailboxAccess(mailboxUid: string, client?: ApiClient): Promise<MyMailboxAccess> {
    return withClient(client, `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/access/me`);
}

/** Revokes a delegate's access to a mailbox - never rejects for a `userOrRoleId` that wasn't a member. */
export function removeMailboxAccess(mailboxUid: string, userOrRoleId: string, client?: ApiClient): Promise<void> {
    return withClient(client, `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/access/${encodeURIComponent(userOrRoleId)}`, { method: "DELETE" });
}

/**
 * Resolves an email address to the person who owns the mailbox at that address, for a "share this
 * mailbox with someone" UI to grant access by uid after the caller types an email - there is no separate
 * user/identity directory anywhere in this platform (see `BaseMailboxAccessRoute`'s own doc comment), so
 * this only ever matches an existing `Mailbox`'s own address. Resolves to `null` (not a thrown error) for
 * an address with no matching mailbox, or one that only matches a shared (ownerless) mailbox - both are
 * "no person found," a normal, expected outcome, not a failure.
 */
export function lookupMailboxOwnerByEmail(email: string, client?: ApiClient): Promise<MailboxOwnerLookup | null> {
    return withClient(client, `/mail/mailboxes/lookup-by-email?email=${encodeURIComponent(email)}`);
}
