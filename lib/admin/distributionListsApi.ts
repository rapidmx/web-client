///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s `DistributionList` CRUD route (`BaseDistributionListRoute`) —
 * trusted-role-only, no self-service creation or per-list delegated ownership (v1).
 */

import { ApiClient, withClient } from "../util/api.js";
import { ListParams, buildQuery, sortQuery } from "../util/apiQuery.js";

export type { ListParams };

export interface DistributionList {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    primarySmtpAddress: string;
    aliasAddresses?: string[];
    name: string;
    description?: string;
    /** Informational only — v1 has no delegated-ownership enforcement; list management is trusted-role-only. */
    ownerUserUid?: string;
    memberAddresses: string[];
    restrictSenders?: boolean;
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function listDistributionLists(params: ListParams = {}, client?: ApiClient): Promise<DistributionList[]> {
    return withClient(client, `/mail/distribution-lists?${buildQuery(params, sortQuery({ uid: "ASC" }))}`);
}

export function getDistributionList(uid: string, client?: ApiClient): Promise<DistributionList> {
    return withClient(client, `/mail/distribution-lists/${encodeURIComponent(uid)}`);
}

export interface CreateDistributionListInput {
    primarySmtpAddress: string;
    aliasAddresses?: string[];
    name: string;
    description?: string;
    ownerUserUid?: string;
    memberAddresses?: string[];
    restrictSenders?: boolean;
}

export function createDistributionList(input: CreateDistributionListInput, client?: ApiClient): Promise<DistributionList> {
    return withClient(client, "/mail/distribution-lists", {
        method: "POST",
        body: JSON.stringify({ aliasAddresses: [], memberAddresses: [], ...input }),
    });
}

export interface UpdateDistributionListInput {
    uid: string;
    version: number;
    name?: string;
    description?: string;
    aliasAddresses?: string[];
    memberAddresses?: string[];
    restrictSenders?: boolean;
}

export function updateDistributionList(input: UpdateDistributionListInput, client?: ApiClient): Promise<DistributionList> {
    return withClient(client, `/mail/distribution-lists/${encodeURIComponent(input.uid)}`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

export function deleteDistributionList(uid: string, version: number, client?: ApiClient): Promise<void> {
    return withClient(client, `/mail/distribution-lists/${encodeURIComponent(uid)}?version=${version}`, { method: "DELETE" });
}
