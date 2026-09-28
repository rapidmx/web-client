///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s `Matter` CRUD route (`BaseMatterRoute`) — deliberately
 * **holder-gated, not admin-gated**, unlike every other file in `admin/`: a trusted administrator who
 * isn't a holder of the matter's own `escrowScopeId` gets the same 403 as anyone else (see
 * `escrowScopesApi.ts`, `specs/end-to-end_encryption.md`'s "Separation of duties"). Lives under `admin/`
 * only because that's where every other CRUD-wrapper module in this package lives, not because it's an
 * admin-only feature — it's consumed exclusively by `apps/escrow`, never `apps/admin`.
 */

import { ApiClient, withClient } from "../util/api.js";
import { ListParams, buildQuery } from "../util/apiQuery.js";

export type { ListParams };

export interface Matter {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    name: string;
    description?: string;
    /** Immutable after creation — see `BaseMatterRoute.update()`. */
    escrowScopeId: string;
    custodianMailboxUids: string[];
    /** ISO 8601 timestamp. */
    dateRangeStart: string;
    /** ISO 8601 timestamp. */
    dateRangeEnd: string;
    /** Once set, this matter is permanently closed — one-way, see `closeMatter()`. */
    closedAt?: string;
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function listMatters(params: ListParams = {}, client?: ApiClient): Promise<Matter[]> {
    return withClient(client, `/escrow/matters?${buildQuery(params)}`);
}

export function getMatter(uid: string, client?: ApiClient): Promise<Matter> {
    return withClient(client, `/escrow/matters/${encodeURIComponent(uid)}`);
}

export interface CreateMatterInput {
    name: string;
    description?: string;
    escrowScopeId: string;
    custodianMailboxUids: string[];
    dateRangeStart: string;
    dateRangeEnd: string;
}

export function createMatter(input: CreateMatterInput, client?: ApiClient): Promise<Matter> {
    return withClient(client, "/escrow/matters", { method: "POST", body: JSON.stringify(input) });
}

export interface UpdateMatterInput {
    uid: string;
    version: number;
    name?: string;
    description?: string;
    custodianMailboxUids?: string[];
    dateRangeStart?: string;
    dateRangeEnd?: string;
}

export function updateMatter(input: UpdateMatterInput, client?: ApiClient): Promise<Matter> {
    return withClient(client, `/escrow/matters/${encodeURIComponent(input.uid)}`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

export function deleteMatter(uid: string, version: number, client?: ApiClient): Promise<void> {
    return withClient(client, `/escrow/matters/${encodeURIComponent(uid)}?version=${version}`, { method: "DELETE" });
}

/** One-way — `BaseMatterRoute.close()` 400s if the matter is already closed, and once closed no further
 * `updateMatter()`/`createAccessRequest()` against it will succeed. */
export function closeMatter(uid: string, client?: ApiClient): Promise<Matter> {
    return withClient(client, `/escrow/matters/${encodeURIComponent(uid)}/close`, { method: "POST" });
}
