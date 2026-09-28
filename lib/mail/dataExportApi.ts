///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s GDPR data-portability export (`BaseDataExportRoute`, mounted
 * at `mail/data-export-requests`). `create()` is both self-service (a mailbox owner exports their own
 * mail) and admin-mediated (a trusted caller may supply an explicit `mailboxUid`) — an ordinary caller's
 * own mailbox is always used regardless of what they send, only a trusted caller's supplied `mailboxUid`
 * is honored. Export runs asynchronously (restapi's own `DataExportJob`, not this client) — `create()`
 * only stages a `pending` request; poll `getExportRequest()`/`listExportRequests()` for `status` to
 * become `"ready"` (or `"failed"`) before offering the download.
 */
import { ApiClient, apiUrl, withClient } from "../util/api.js";
import { RequestListParams, buildRequestListQuery } from "../util/apiQuery.js";

export type { RequestListParams };

export type DataExportFormat = "json" | "mbox";
/** `processing` while a worker is building the export (restapi's `DataExportJob` claims `pending` requests). */
export type DataExportStatus = "pending" | "processing" | "ready" | "failed";

export interface DataExportRequest {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    mailboxUid: string;
    requestedByUserUid: string;
    format: DataExportFormat;
    status: DataExportStatus;
    blobKey?: string;
    errorMessage?: string;
    /** How many times the server job has claimed this request into `"processing"` (a stalled claim is reclaimed
     * back to `"pending"` until the job's max attempts, then marked `"failed"`). */
    processingAttempts?: number;
}

export interface CreateDataExportRequestInput {
    format: DataExportFormat;
    /** Only honored when the caller is a trusted admin — an ordinary caller's own mailbox is always
     * used, regardless of what (if anything) is supplied here. */
    mailboxUid?: string;
}

/** `client`, given by every function below that isn't a plain URL builder, is an explicit `ApiClient` from
 * `createApiClient()` (e.g. one account of a multi-account app) to call instead of the default global
 * `apiFetch()` - see `withClient()`'s own doc comment in `util/api.ts`. Omitted (the default), every
 * function here behaves exactly as before. */
export function createExportRequest(input: CreateDataExportRequestInput, client?: ApiClient): Promise<DataExportRequest> {
    return withClient(client, `/mail/data-export-requests`, {
        method: "POST",
        body: JSON.stringify(input),
    });
}

/** A trusted caller sees every request; anyone else sees only their own (`requestedByUserUid`). Newest
 * first; `params` pages through them (`limit` capped at 500 server-side). */
export function listExportRequests(params: RequestListParams = {}, client?: ApiClient): Promise<DataExportRequest[]> {
    return withClient(client, `/mail/data-export-requests${buildRequestListQuery(params)}`);
}

export function getExportRequest(uid: string, client?: ApiClient): Promise<DataExportRequest> {
    return withClient(client, `/mail/data-export-requests/${encodeURIComponent(uid)}`);
}

/** A plain URL, not a fetch wrapper — the server streams the export's raw bytes back with its own
 * `content-disposition: attachment` header, so a caller renders this directly as `<a href={...}>`
 * (the browser's own native download, no JS fetch/blob needed) — same pattern `mailApi.ts`'s
 * `attachmentContentUrl()` already establishes. 404s until `status === "ready"`. */
export function exportRequestDownloadUrl(uid: string): string {
    return apiUrl(`/mail/data-export-requests/${encodeURIComponent(uid)}/download`);
}
