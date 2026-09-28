///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s `MailSignature` CRUD route (`BaseScopedChildRoute`,
 * `scopeProperty: "mailboxUid"`) — mailbox-scoped, same pattern as `mailFilterRulesApi.ts`. Composition
 * is entirely this app's own job: restapi never assembles a signature into a message body itself (see
 * its own `resolveDefaultSignature()` doc comment) — `ComposeWindow.tsx` is what actually inserts a
 * resolved signature's `contentHtml` into a new draft.
 */

import { ApiClient, withClient } from "../util/api.js";
import { ListParams, buildQuery } from "../util/apiQuery.js";

export type { ListParams };

export interface MailSignature {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    mailboxUid: string;
    name: string;
    contentHtml: string;
    /** At most one signature per mailbox should have this `true` — enforced by convention (the caller
     * toggles any previous default off itself), not by a database constraint. Applied to a fresh,
     * non-reply/forward compose. */
    isDefaultForNewMessages: boolean;
    /** Same single-default convention as `isDefaultForNewMessages`, applied to replies/forwards
     * instead — mirrors Outlook Web Access's separate "Replies/forwards" signature selector. */
    isDefaultForReplyForward: boolean;
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function listMailSignatures(mailboxUid: string, params: ListParams = {}, client?: ApiClient): Promise<MailSignature[]> {
    return withClient(client, `/mail/mail-signatures?${buildQuery(params, { mailboxUid })}`);
}

export function getMailSignature(uid: string, client?: ApiClient): Promise<MailSignature> {
    return withClient(client, `/mail/mail-signatures/${encodeURIComponent(uid)}`);
}

export interface CreateMailSignatureInput {
    mailboxUid: string;
    name: string;
    contentHtml?: string;
    isDefaultForNewMessages?: boolean;
    isDefaultForReplyForward?: boolean;
}

export function createMailSignature(input: CreateMailSignatureInput, client?: ApiClient): Promise<MailSignature> {
    return withClient(client, "/mail/mail-signatures", {
        method: "POST",
        body: JSON.stringify({
            contentHtml: "",
            isDefaultForNewMessages: false,
            isDefaultForReplyForward: false,
            ...input,
        }),
    });
}

export interface UpdateMailSignatureInput {
    uid: string;
    version: number;
    name?: string;
    contentHtml?: string;
    isDefaultForNewMessages?: boolean;
    isDefaultForReplyForward?: boolean;
}

export function updateMailSignature(input: UpdateMailSignatureInput, client?: ApiClient): Promise<MailSignature> {
    return withClient(client, `/mail/mail-signatures/${encodeURIComponent(input.uid)}`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

export function deleteMailSignature(uid: string, version: number, client?: ApiClient): Promise<void> {
    return withClient(client, `/mail/mail-signatures/${encodeURIComponent(uid)}?version=${version}`, { method: "DELETE" });
}
