///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s `TransportRule` CRUD route (`BaseTransportRuleRoute`) —
 * trusted-role-only, org-wide (evaluated once per SMTP transaction, before per-mailbox fan-out). No
 * uid-derivation on create (unlike `Domain`/`Mailbox`/`DistributionList`) — a transport rule has no
 * natural address of its own.
 */

import { ApiClient, withClient } from "../util/api.js";
import { ListParams, buildQuery } from "../util/apiQuery.js";

export type { ListParams };

export type TransportRuleActionType = "reject" | "quarantine" | "add_header" | "add_recipient";

export interface TransportRuleAction {
    type: TransportRuleActionType;
    /** Required for `add_header`. */
    headerName?: string;
    /** Required for `add_header`. */
    headerValue?: string;
    /** Required for `add_recipient`. */
    recipientAddress?: string;
}

export interface TransportRuleConditions {
    fromContains?: string[];
    subjectContains?: string[];
    bodyContains?: string[];
    recipientContains?: string[];
    anyRecipientExternal?: boolean;
    hasAttachment?: boolean;
    attachmentNameContains?: string[];
}

export interface TransportRule {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    name: string;
    enabled: boolean;
    sequence: number;
    stopProcessingRules: boolean;
    conditions: TransportRuleConditions;
    actions: TransportRuleAction[];
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function listTransportRules(params: ListParams = {}, client?: ApiClient): Promise<TransportRule[]> {
    return withClient(client, `/mail/transport-rules?${buildQuery(params)}`);
}

export function getTransportRule(uid: string, client?: ApiClient): Promise<TransportRule> {
    return withClient(client, `/mail/transport-rules/${encodeURIComponent(uid)}`);
}

export interface CreateTransportRuleInput {
    name: string;
    enabled?: boolean;
    sequence?: number;
    stopProcessingRules?: boolean;
    conditions?: TransportRuleConditions;
    actions?: TransportRuleAction[];
}

export function createTransportRule(input: CreateTransportRuleInput, client?: ApiClient): Promise<TransportRule> {
    return withClient(client, "/mail/transport-rules", {
        method: "POST",
        body: JSON.stringify({
            enabled: true,
            sequence: 0,
            stopProcessingRules: false,
            conditions: {},
            actions: [],
            ...input,
        }),
    });
}

export interface UpdateTransportRuleInput {
    uid: string;
    version: number;
    name?: string;
    enabled?: boolean;
    sequence?: number;
    stopProcessingRules?: boolean;
    conditions?: TransportRuleConditions;
    actions?: TransportRuleAction[];
}

export function updateTransportRule(input: UpdateTransportRuleInput, client?: ApiClient): Promise<TransportRule> {
    return withClient(client, `/mail/transport-rules/${encodeURIComponent(input.uid)}`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

export function deleteTransportRule(uid: string, version: number, client?: ApiClient): Promise<void> {
    return withClient(client, `/mail/transport-rules/${encodeURIComponent(uid)}?version=${version}`, { method: "DELETE" });
}
