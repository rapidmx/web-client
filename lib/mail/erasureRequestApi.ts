///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s GDPR Article 17 ("right to erasure") request
 * (`BaseDataSubjectErasureRequestRoute`, mounted at `mail/erasure-requests`). Unlike
 * `dataExportApi.ts`/`mailboxImportApi.ts`, `create()` is self-service only — there is no
 * admin-on-behalf-of path, and no `mailboxUid` parameter to override; it is always the caller's own
 * mailbox. `approve()`/`deny()` are trusted-admin-only server-side. The actual destructive cascade is
 * asynchronous (restapi's own `ErasureExecutionJob`, not this client) and irreversible once it runs — an
 * approved request 409s during approval, and is retried indefinitely (never failed) by the job itself,
 * while the target mailbox is a custodian on an active legal hold.
 */
import { ApiClient, withClient } from "../util/api.js";
import { RequestListParams, buildRequestListQuery } from "../util/apiQuery.js";

export type { RequestListParams };

export type DataSubjectErasureStatus = "pending" | "approved" | "in_progress" | "denied" | "completed";

export interface DataSubjectErasureRequest {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    mailboxUid: string;
    requestedByUserUid: string;
    status: DataSubjectErasureStatus;
    reviewedByUserUid?: string;
    /** Only ever set by `denyErasureRequest()` — never required or meaningful for an approval. */
    reason?: string;
    /** Set once `status === "completed"` — a single aggregate count, not a per-row manifest. */
    purgedCount?: number;
    /** Set when an administrator filed this request for the data a deleted mailbox left behind (see `admin/leftoverMailboxApi.ts`) - it
     * was approved when filed, and never removes a mailbox. */
    leftoverOnly?: boolean;
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */

/** Always the caller's own mailbox — 409s if a `pending` request for it already exists. */
export function createErasureRequest(client?: ApiClient): Promise<DataSubjectErasureRequest> {
    return withClient(client, `/mail/erasure-requests`, { method: "POST" });
}

/** A trusted caller sees every request; anyone else sees only their own (`requestedByUserUid`). Newest
 * first; `params` pages through them (`limit` capped at 500 server-side). */
export function listErasureRequests(params: RequestListParams = {}, client?: ApiClient): Promise<DataSubjectErasureRequest[]> {
    return withClient(client, `/mail/erasure-requests${buildRequestListQuery(params)}`);
}

export function getErasureRequest(uid: string, client?: ApiClient): Promise<DataSubjectErasureRequest> {
    return withClient(client, `/mail/erasure-requests/${encodeURIComponent(uid)}`);
}

/** 409s if the mailbox is a custodian on an active legal hold, naming the blocking Matter uid(s) in the
 * error message — surface this as-is, the same "server's own message wins" convention used everywhere
 * else in this codebase for a destructive-action error. */
export function approveErasureRequest(uid: string, client?: ApiClient): Promise<DataSubjectErasureRequest> {
    return withClient(client, `/mail/erasure-requests/${encodeURIComponent(uid)}/approve`, { method: "POST" });
}

export function denyErasureRequest(uid: string, reason: string, client?: ApiClient): Promise<DataSubjectErasureRequest> {
    return withClient(client, `/mail/erasure-requests/${encodeURIComponent(uid)}/deny`, {
        method: "POST",
        body: JSON.stringify({ reason }),
    });
}
