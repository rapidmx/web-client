///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s `EscrowAccessRequest` route (`BaseEscrowAccessRequestRoute`) —
 * a bespoke (non-`CRUDRoute`) route: no `update`/`delete`/`count`, and `create()` only ever accepts
 * `{matterId, mailboxUid}` (everything else is derived server-side). Holder-gated throughout, same as
 * `mattersApi.ts`. `find()`/`findById()` auto-scope to matters under scopes the caller holds; `approve()`/
 * `deny()` mutate in place and return the updated request; `material()` is only ever readable once the
 * request is `approved`/`fulfilled`, and returns still-encrypted `MasterKeyWraps` this server can't
 * decrypt either — see `EscrowAccessMaterial`'s own doc comment.
 */

import { ApiClient, withClient } from "../util/api.js";
import { ListParams, RequestListParams, buildQuery } from "../util/apiQuery.js";

export type { ListParams, RequestListParams };

export interface EscrowAccessRequestApproval {
    holderUserUid: string;
    /** ISO 8601 timestamp. */
    approvedAt: string;
}

export type EscrowAccessRequestStatus = "pending" | "approved" | "denied" | "fulfilled";

export interface EscrowAccessRequest {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    matterId: string;
    mailboxUid: string;
    requestedByUserUid: string;
    approvals: EscrowAccessRequestApproval[];
    /** Snapshotted from `EscrowScope.requiredHolders` at creation time — see this type's own restapi doc
     * comment on why it's never re-read live. */
    requiredHoldersAtCreation: number;
    status: EscrowAccessRequestStatus;
    /** Set the first time `getAccessRequestMaterial()` is successfully called — informational only. */
    fulfilledAt?: string;
    deniedByUserUid?: string;
    deniedAt?: string;
}

/** Mirrors `@rapidmx/restapi`'s `MasterKeyWrap` — same shape `crypto/keyvaultApi.ts` already defines for
 * the mailbox-owner side of this feature, duplicated here rather than cross-imported (same convention
 * every other `*Api.ts` wrapper in this package already follows for overlapping wire shapes). */
export interface MasterKeyWrap {
    method: "password" | "passkey" | "recovery" | "escrow";
    methodId?: string;
    escrowScopeId?: string;
    ciphertext: string;
    nonce: string;
    salt: string;
    kdf: string;
    schemeVersion: number;
    createdAt: number;
}

/** The wire shape `getAccessRequestMaterial()` returns — only ever the escrow-method wraps scoped to the
 * matter's own escrow scope, never `wrappedKeys` or any other unlock method. This app deliberately never
 * attempts to decrypt these — they're surfaced as-is for the holder to copy into their own offline
 * tooling, per `specs/end-to-end_encryption.md`'s "this server never holds the scope's private key". */
export interface EscrowAccessMaterial {
    masterKeyWraps: MasterKeyWrap[];
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
/** Newest first. Every request belongs to one Matter, so `params.matterId` narrows the list to that
 * Matter's requests (still only ever within scopes the caller holds). */
export function listAccessRequests(params: RequestListParams = {}, client?: ApiClient): Promise<EscrowAccessRequest[]> {
    const { matterId, ...paging } = params;
    return withClient(client, `/escrow/access-requests?${buildQuery(paging, matterId ? { matterId } : {})}`);
}

export function getAccessRequest(uid: string, client?: ApiClient): Promise<EscrowAccessRequest> {
    return withClient(client, `/escrow/access-requests/${encodeURIComponent(uid)}`);
}

export interface CreateAccessRequestInput {
    matterId: string;
    mailboxUid: string;
}

/** The requester's own creation counts as their first approval — auto-approved immediately if
 * `EscrowScope.requiredHolders` is `1`. */
export function createAccessRequest(input: CreateAccessRequestInput, client?: ApiClient): Promise<EscrowAccessRequest> {
    return withClient(client, "/escrow/access-requests", { method: "POST", body: JSON.stringify(input) });
}

/** 409s if the request isn't `pending`; 400s if the caller already approved it. */
export function approveAccessRequest(uid: string, client?: ApiClient): Promise<EscrowAccessRequest> {
    return withClient(client, `/escrow/access-requests/${encodeURIComponent(uid)}/approve`, { method: "POST" });
}

/** 409s if the request isn't `pending`. */
export function denyAccessRequest(uid: string, client?: ApiClient): Promise<EscrowAccessRequest> {
    return withClient(client, `/escrow/access-requests/${encodeURIComponent(uid)}/deny`, { method: "POST" });
}

/** 403s ("Dual control threshold not yet met.") unless the request is `approved`/`fulfilled`. Marks the
 * request `fulfilled` server-side as a side effect of a successful call, and records an
 * `EscrowAuditAction.MATERIAL_READ` entry — see `escrowAuditLogApi.ts`. */
export function getAccessRequestMaterial(uid: string, client?: ApiClient): Promise<EscrowAccessMaterial> {
    return withClient(client, `/escrow/access-requests/${encodeURIComponent(uid)}/material`);
}
