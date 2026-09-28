///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s `MailFilterRule` CRUD route (`BaseScopedChildRoute`,
 * `scopeProperty: "mailboxUid"`) — mailbox-scoped (unlike `TransportRule`, which is trusted-role-only
 * and org-wide): every list/create call must carry `mailboxUid`, checked against that mailbox's own
 * ACL, same pattern as `Message`/`Task`/`Note`/`Contact`. Evaluated by `ScanQueueJob` immediately after
 * a message is verdicted "deliver" and before it's filed into the mailbox's Inbox — a live, enforced
 * feature, not a data-model-only stub.
 */

import { ApiClient, withClient } from "../util/api.js";
import { ListParams, buildQuery } from "../util/apiQuery.js";
import { MessageImportance } from "./mailApi.js";

export type { ListParams };

export type MailFilterActionType = "move_to_folder" | "copy_to_folder" | "delete" | "mark_as_read" | "forward" | "apply_label";

export interface MailFilterAction {
    type: MailFilterActionType;
    /** Required for `move_to_folder`/`copy_to_folder`. */
    folderUid?: string;
    /** Required for `forward`. */
    forwardTo?: string;
    /** The `Label.uid` to apply (`labelsApi.ts`). Required for `apply_label`. */
    labelUid?: string;
}

export interface MailFilterConditions {
    /** Substrings of the From header, case-insensitive: `ann@x.com` also matches `joann@x.com`. Use `fromEquals` to name one sender exactly. */
    fromContains?: string[];
    /** Plain addresses, matched exactly and case-insensitively against the From header's address OR the envelope sender (`ann@x.com` does not match `joann@x.com`).
     * At most 100. A server before this condition ignores it, so the rule would match every message. */
    fromEquals?: string[];
    /** Domains (`x.com`, no `@`), matched exactly against the domain of the From header's address or of the envelope sender (`x.com` is not `mail.x.com`). At most 100. */
    fromDomainEquals?: string[];
    subjectContains?: string[];
    bodyContains?: string[];
    toCcContains?: string[];
    hasAttachment?: boolean;
    importance?: MessageImportance;
}

export interface MailFilterRule {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    mailboxUid: string;
    name: string;
    enabled: boolean;
    sequence: number;
    stopProcessingRules: boolean;
    conditions: MailFilterConditions;
    actions: MailFilterAction[];
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function listMailFilterRules(mailboxUid: string, params: ListParams = {}, client?: ApiClient): Promise<MailFilterRule[]> {
    return withClient(client, `/mail/mail-filter-rules?${buildQuery(params, { mailboxUid })}`);
}

export function getMailFilterRule(uid: string, client?: ApiClient): Promise<MailFilterRule> {
    return withClient(client, `/mail/mail-filter-rules/${encodeURIComponent(uid)}`);
}

export interface CreateMailFilterRuleInput {
    mailboxUid: string;
    name: string;
    enabled?: boolean;
    sequence?: number;
    stopProcessingRules?: boolean;
    conditions?: MailFilterConditions;
    actions?: MailFilterAction[];
}

export function createMailFilterRule(input: CreateMailFilterRuleInput, client?: ApiClient): Promise<MailFilterRule> {
    return withClient(client, "/mail/mail-filter-rules", {
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

export interface UpdateMailFilterRuleInput {
    uid: string;
    version: number;
    name?: string;
    enabled?: boolean;
    sequence?: number;
    stopProcessingRules?: boolean;
    conditions?: MailFilterConditions;
    actions?: MailFilterAction[];
}

export function updateMailFilterRule(input: UpdateMailFilterRuleInput, client?: ApiClient): Promise<MailFilterRule> {
    return withClient(client, `/mail/mail-filter-rules/${encodeURIComponent(input.uid)}`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

export function deleteMailFilterRule(uid: string, version: number, client?: ApiClient): Promise<void> {
    return withClient(client, `/mail/mail-filter-rules/${encodeURIComponent(uid)}?version=${version}`, { method: "DELETE" });
}
