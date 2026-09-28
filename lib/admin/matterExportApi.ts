///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s eDiscovery Matter export (`BaseMatterExportRequestRoute`,
 * mounted at `escrow/matter-export-requests`) — holder-gated throughout (`requireEscrowHolder()` against
 * the matter's own `escrowScopeId`), never admin-gated. Lives under `admin/` only because that's where
 * every other Matter/Escrow-family wrapper in this package lives (see `mattersApi.ts`'s own doc
 * comment) — consumed exclusively by `apps/escrow`. Export runs asynchronously (restapi's own
 * `MatterExportJob`, not this client) — `createMatterExportRequest()` only stages a `pending` request;
 * poll `listMatterExportRequests()` for `status` to become `"ready"` (or `"failed"`).
 */
import { ApiClient, apiUrl, withClient } from "../util/api.js";
import { RequestListParams, buildRequestListQuery } from "../util/apiQuery.js";

export type { RequestListParams };

export type MatterExportStatus = "pending" | "processing" | "ready" | "failed";

export interface MatterExportRequest {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    matterId: string;
    requestedByUserUid: string;
    status: MatterExportStatus;
    blobKey?: string;
    errorMessage?: string;
    /** How many times the server job has claimed this request into `"processing"` (a stalled claim is reclaimed
     * back to `"pending"` until the job's max attempts, then marked `"failed"`). */
    processingAttempts?: number;
}

/** `client`, given by every function below that isn't a plain URL builder, is an explicit `ApiClient` from
 * `createApiClient()` (e.g. one account of a multi-account app) to call instead of the default global
 * `apiFetch()` - see `withClient()`'s own doc comment in `util/api.ts`. Omitted (the default), every
 * function here behaves exactly as before. */
export function createMatterExportRequest(matterId: string, client?: ApiClient): Promise<MatterExportRequest> {
    return withClient(client, `/escrow/matter-export-requests`, {
        method: "POST",
        body: JSON.stringify({ matterId }),
    });
}

/** Scoped server-side to matters under scopes the caller holds — never all requests, even for a trusted
 * admin who isn't also a holder. Newest first; `params` pages through them (`limit` capped at 500
 * server-side) and/or narrows to one `matterId`. */
export function listMatterExportRequests(params: RequestListParams = {}, client?: ApiClient): Promise<MatterExportRequest[]> {
    return withClient(client, `/escrow/matter-export-requests${buildRequestListQuery(params)}`);
}

export function getMatterExportRequest(uid: string, client?: ApiClient): Promise<MatterExportRequest> {
    return withClient(client, `/escrow/matter-export-requests/${encodeURIComponent(uid)}`);
}

/** A plain URL, not a fetch wrapper — same "let the browser download it natively" pattern
 * `dataExportApi.ts`'s `exportRequestDownloadUrl()` already establishes. 404s until `status === "ready"`. */
export function matterExportRequestDownloadUrl(uid: string): string {
    return apiUrl(`/escrow/matter-export-requests/${encodeURIComponent(uid)}/download`);
}
