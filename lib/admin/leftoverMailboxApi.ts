///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over what `@rapidmx/restapi` offers for the data a deleted mailbox leaves behind. Deleting a mailbox removes
 * only the mailbox itself: its folders and everything in them stay, and a new mailbox at the same address is refused (409)
 * until that data is erased. An administrator (a trusted role AND an elevated session, like every admin-console call) lists
 * what is left (`listLeftoverMailboxes()`) and erases it (`eraseLeftoverMailbox()`), which files an already approved erasure
 * request that the server's `ErasureExecutionJob` then runs - poll it with `getErasureRequest()` (`erasureRequestApi.ts`).
 * The erasure is irreversible; a legal hold on the address makes the server refuse it (409, its message names the matter).
 */
import { ApiClient, ApiRequestError, withClient } from "../util/api.js";
import type { DataSubjectErasureRequest, DataSubjectErasureStatus } from "../mail/erasureRequestApi.js";

/** The newest erasure request filed for a leftover address. */
export interface LeftoverErasure {
    uid: string;
    status: DataSubjectErasureStatus;
    dateCreated: string;
}

/** A deleted mailbox that still has data. */
export interface LeftoverMailbox {
    /** The deleted mailbox's uid - its address. */
    mailboxUid: string;
    /** Folders it still has (trashed ones included). */
    folderCount: number;
    /** Messages it still has (trashed ones included). */
    messageCount: number;
    /** The newest erasure request filed for the address, when there is one. */
    erasure?: LeftoverErasure;
}

/** One page of `listLeftoverMailboxes()`. */
export interface LeftoverMailboxPage {
    items: LeftoverMailbox[];
    /** Pass as `after` to continue; absent at the end of the list. */
    next?: string;
}

export interface LeftoverMailboxListParams {
    /** At most this many (the server's default is 50 and its ceiling 100). */
    limit?: number;
    /** Continue after this mailbox uid - a previous page's `next`. */
    after?: string;
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */

/** Lists the deleted mailboxes that still have data, sorted by address. Administrators only (403 otherwise). */
export function listLeftoverMailboxes(params: LeftoverMailboxListParams = {}, client?: ApiClient): Promise<LeftoverMailboxPage> {
    const query = new URLSearchParams();
    if (params.limit !== undefined) {
        query.set("limit", String(params.limit));
    }
    if (params.after !== undefined) {
        query.set("after", params.after);
    }
    const suffix = query.toString();
    return withClient(client, `/mail/mailboxes/leftover${suffix ? `?${suffix}` : ""}`);
}

/**
 * Erases what the deleted mailbox `mailboxUid` (its address) left behind - permanently. Answers the erasure request, already
 * approved; it runs in the background, so poll `getErasureRequest()` until its status is `completed` (or `denied`). Repeating
 * the call returns the request already filed. Rejects with 409 while a legal hold covers the address (the message names the
 * matter) or when a mailbox exists at the address (a live mailbox is never erased this way), and with 404 when nothing is left.
 */
export function eraseLeftoverMailbox(mailboxUid: string, client?: ApiClient): Promise<DataSubjectErasureRequest> {
    return withClient(client, `/mail/erasure-requests/leftover`, {
        method: "POST",
        body: JSON.stringify({ mailboxUid }),
    });
}

/** Why creating a mailbox at an address was refused because of the data a deleted mailbox left there. */
export type LeftoverConflict =
    | {
          /** The data is still there: erasing it (`eraseLeftoverMailbox()`) is the way out. */
          reason: "mailbox-data-remaining";
          mailboxUid?: string;
      }
    | {
          /** An erasure of it is approved or running and has not finished: wait for it (poll `erasure.uid`). */
          reason: "mailbox-data-erasing";
          mailboxUid?: string;
          erasure: { uid: string; status: DataSubjectErasureStatus };
      };

/**
 * What `error` says about leftover data, when it is the 409 that `createMailbox()` answers for an address whose deleted mailbox
 * still has data - `undefined` for any other error. Read defensively: the server's body is untrusted data, and an error from
 * before the server said why (no `reason`) is not recognised.
 */
export function leftoverConflictOf(error: unknown): LeftoverConflict | undefined {
    if (!(error instanceof ApiRequestError) || error.status !== 409) {
        return undefined;
    }
    const body = error.details as { reason?: unknown; mailboxUid?: unknown; erasure?: { uid?: unknown; status?: unknown } } | undefined;
    const mailboxUid = typeof body?.mailboxUid === "string" ? body.mailboxUid : undefined;
    if (body?.reason === "mailbox-data-remaining") {
        return { reason: "mailbox-data-remaining", mailboxUid };
    }
    if (body?.reason === "mailbox-data-erasing" && typeof body.erasure?.uid === "string" && typeof body.erasure.status === "string") {
        return {
            reason: "mailbox-data-erasing",
            mailboxUid,
            erasure: { uid: body.erasure.uid, status: body.erasure.status as DataSubjectErasureStatus },
        };
    }
    return undefined;
}

/** Whether an erasure request is no longer going to change: it finished or was refused. */
export function isErasureSettled(status: DataSubjectErasureStatus): boolean {
    return status === "completed" || status === "denied";
}
