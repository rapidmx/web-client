///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s `FocusedInboxOverride` CRUD route (`BaseScopedChildRoute`,
 * `scopeProperty: "mailboxUid"`) — the standing "always classify mail from this sender as Focused/Other"
 * rules `BaseMessageRoute.classify()` (see `classifyMessage()` in `mailApi.ts`) upserts when a caller sets
 * `applyToSender: true`. This file lets a Settings page list/remove those rules directly, and add one by
 * hand without first receiving a matching message.
 */

import { ApiClient, withClient } from "../util/api.js";
import { ListParams, buildQuery } from "../util/apiQuery.js";
import { MessageClassification } from "./mailApi.js";

export type { ListParams };

export interface FocusedInboxOverride {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    mailboxUid: string;
    senderAddress: string;
    classifyAs: MessageClassification;
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function listFocusedInboxOverrides(mailboxUid: string, params: ListParams = {}, client?: ApiClient): Promise<FocusedInboxOverride[]> {
    return withClient(client, `/mail/focused-inbox-overrides?${buildQuery(params, { mailboxUid })}`);
}

export interface CreateFocusedInboxOverrideInput {
    mailboxUid: string;
    senderAddress: string;
    classifyAs: MessageClassification;
}

export function createFocusedInboxOverride(input: CreateFocusedInboxOverrideInput, client?: ApiClient): Promise<FocusedInboxOverride> {
    return withClient(client, "/mail/focused-inbox-overrides", {
        method: "POST",
        body: JSON.stringify(input),
    });
}

export interface UpdateFocusedInboxOverrideInput {
    uid: string;
    version: number;
    classifyAs: MessageClassification;
}

export function updateFocusedInboxOverride(input: UpdateFocusedInboxOverrideInput, client?: ApiClient): Promise<FocusedInboxOverride> {
    return withClient(client, `/mail/focused-inbox-overrides/${encodeURIComponent(input.uid)}`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

export function deleteFocusedInboxOverride(uid: string, version: number, client?: ApiClient): Promise<void> {
    return withClient(client, `/mail/focused-inbox-overrides/${encodeURIComponent(uid)}?version=${version}`, { method: "DELETE" });
}
