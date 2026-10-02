///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s GDPR data-portability import (`BaseMailboxImportRoute`,
 * mounted at `mail/mailbox-import-requests`) — the counterpart to `dataExportApi.ts`. Import runs
 * asynchronously (restapi's own `MailboxImportJob`, not this client) — `uploadMailboxImport()` only
 * stages the upload and returns the `pending` request; poll `getImportRequest()`/`listImportRequests()`
 * for `status` to become `"completed"` (with `importedCount`/`failedCount`) or `"failed"`.
 */
import { ApiClient, withClient, withClientRaw } from "../util/api.js";
import { RequestListParams, buildRequestListQuery } from "../util/apiQuery.js";

export type { RequestListParams };

export type MailboxImportFormat = "mbox" | "pst";
export type MailboxImportStatus = "pending" | "processing" | "completed" | "failed";

export interface MailboxImportRequest {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    mailboxUid: string;
    requestedByUserUid: string;
    targetFolderUid: string;
    format: MailboxImportFormat;
    sourceBlobKey: string;
    status: MailboxImportStatus;
    importedCount?: number;
    failedCount?: number;
    errorMessage?: string;
    /** How many times the server job has claimed this request into `"processing"` (a stalled claim is reclaimed
     * back to `"pending"` until the job's max attempts, then marked `"failed"`). */
    processingAttempts?: number;
}

export interface UploadMailboxImportInput {
    format: MailboxImportFormat;
    targetFolderUid: string;
    /** Only honored when the caller is a trusted admin — an ordinary caller's own mailbox is always
     * used, regardless of what (if anything) is supplied here. */
    mailboxUid?: string;
}

/**
 * Uploads `file`'s raw bytes as a new mailbox-import request. Bypasses `apiFetch` — that helper always
 * forces `Content-Type: application/json`, which would corrupt binary content; this sends the file's own
 * bytes directly instead, matching `BaseMailboxImportRoute.create()`'s expectation of a raw request body
 * with `format`/`targetFolderUid`/`mailboxUid` as query-string parameters, not a JSON body — the same
 * shape `mailApi.ts`'s `uploadAttachment()` already establishes for a raw-bytes upload.
 */
export function uploadMailboxImport(file: File, input: UploadMailboxImportInput, client?: ApiClient): Promise<MailboxImportRequest> {
    const params = new URLSearchParams({ format: input.format, targetFolderUid: input.targetFolderUid });
    if (input.mailboxUid) {
        params.set("mailboxUid", input.mailboxUid);
    }
    return withClientRaw(
        client,
        `/mail/mailbox-import-requests?${params.toString()}`,
        "POST",
        file,
        input.format === "pst" ? "application/vnd.ms-outlook" : "application/mbox",
    );
}

/** `client`, given by every function below that isn't a raw-bytes upload, is an explicit `ApiClient` from
 * `createApiClient()` (e.g. one account of a multi-account app) to call instead of the default global
 * `apiFetch()` - see `withClient()`'s own doc comment in `util/api.ts`. Omitted (the default), every
 * function here behaves exactly as before. */

/** A trusted caller sees every request; anyone else sees only their own (`requestedByUserUid`). Newest
 * first; `params` pages through them (`limit` capped at 500 server-side). */
export function listImportRequests(params: RequestListParams = {}, client?: ApiClient): Promise<MailboxImportRequest[]> {
    return withClient(client, `/mail/mailbox-import-requests${buildRequestListQuery(params)}`);
}

export function getImportRequest(uid: string, client?: ApiClient): Promise<MailboxImportRequest> {
    return withClient(client, `/mail/mailbox-import-requests/${encodeURIComponent(uid)}`);
}
