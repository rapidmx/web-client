///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Message, emptyFolder, listMessages, purgeMessage } from "@rapidmx/react-shared/mail/mailApi.js";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { displaySubject } from "../components/mail/reading/EncryptedPreview.js";
import { notifySessionExpired } from "../notifications/apiErrors.js";
import { notify } from "../notifications/store.js";
import { LIST_PAGE_SIZE, MAX_LIST_PAGES, listAllPages } from "./listAllPages.js";

/**
 * Permanent delete: what "Delete" does to a message that is already in Deleted Items (and what "Empty folder" does to Deleted Items and
 * Junk Email). Unlike a move into Deleted Items it cannot be undone, so it is never reached without a confirmation (see
 * `usePermanentDelete()`, which asks it, runs what is in here and tells the folder badges and the reader).
 *
 * Server side it is `DELETE /mail/messages/:uid?purge=true` (a hard delete - the row and its search document are gone, not a
 * recoverable soft delete) per message, and `DELETE /mail/messages?folderUid=` (`truncate`) for a whole folder. Both refuse a message under
 * an active legal hold with a `409`; the per-message form refuses one message at a time, so a selection is deleted as far as it can be and
 * each refusal is reported (`PurgeFailure`), rather than the first stopping the rest.
 */

/** How many purge requests are on the wire at once: a few at a time is quick, and the server publishes each folder's counts as they land. */
export const PURGE_CONCURRENCY = 4;

/** The folder types "Empty folder" is offered for: Outlook's Deleted Items and Junk Email. */
export const EMPTIABLE_FOLDER_TYPES: readonly string[] = ["deleted_items", "junk"];

/** A message the server refused to delete, and what it said. */
export interface PurgeFailure {
    message: Message;
    /** The server's own words (a legal hold names itself), or a stand-in when it did not answer. */
    reason: string;
    /** The response's status - `undefined` when there was no response. */
    status?: number;
}

/** What deleting several messages came to: those that are gone, and those that are not (with why). Together they are all that was asked for. */
export interface PurgeOutcome {
    deleted: Message[];
    failed: PurgeFailure[];
}

/** What emptying a folder came to. */
export interface EmptyFolderOutcome extends PurgeOutcome {
    /** Nothing is left in the folder as far as this knows: the whole-folder request went through, or every message listed was deleted. */
    emptied: boolean;
}

function describeFailure(err: unknown): { reason: string; status?: number } {
    if (err instanceof ApiRequestError) {
        return { reason: err.message || `The server answered ${err.status}.`, status: err.status };
    }
    return { reason: "The server couldn't be reached." };
}

/** `1 message`, `3 messages`. */
export function messageCount(count: number): string {
    return `${count} message${count === 1 ? "" : "s"}`;
}

/**
 * Permanently deletes `messages`, each in its own request, a few at a time. Never rejects: a refusal (a legal hold, a share without the right
 * to delete, a message that is already gone) is recorded against its message and the rest carry on. `deleted` and `failed` keep the order of
 * `messages`.
 */
export async function purgeMessages(messages: Message[]): Promise<PurgeOutcome> {
    const failures: (PurgeFailure | null)[] = new Array(messages.length).fill(null);
    let next = 0;
    async function worker(): Promise<void> {
        while (next < messages.length) {
            const index = next++;
            try {
                await purgeMessage(messages[index].uid);
            } catch (err) {
                failures[index] = { message: messages[index], ...describeFailure(err) };
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(PURGE_CONCURRENCY, messages.length) }, worker));
    return {
        deleted: messages.filter((_, index) => failures[index] === null),
        failed: failures.filter((failure): failure is PurgeFailure => failure !== null),
    };
}

/**
 * Permanently deletes everything in `folderUid`: one request for the whole folder, which is all or nothing. The server refuses it as a whole
 * when a message in it is under a legal hold (`409`) or when the caller may delete messages but not empty a folder (`403`, a delegate) - and
 * then this lists the folder and deletes message by message instead, so what may go does and each refusal is reported. Any other failure
 * (the server is down) rejects, and the caller says so.
 */
export async function purgeFolder(
    folderUid: string,
    paging: { pageSize: number; maxPages: number } = { pageSize: LIST_PAGE_SIZE, maxPages: MAX_LIST_PAGES },
): Promise<EmptyFolderOutcome> {
    try {
        await emptyFolder(folderUid);
        return { emptied: true, deleted: [], failed: [] };
    } catch (err) {
        if (!(err instanceof ApiRequestError) || (err.status !== 403 && err.status !== 409)) {
            throw err;
        }
    }
    const listed = await listAllPages((page) => listMessages(folderUid, { limit: paging.pageSize, page }), paging.pageSize, paging.maxPages);
    const outcome = await purgeMessages(listed.items);
    return { ...outcome, emptied: outcome.failed.length === 0 && !listed.truncated };
}

/** The line for one refusal, in the notification's details. */
function failureLine(failure: PurgeFailure): string {
    return `${displaySubject(failure.message.subject) || "(no subject)"}: ${failure.reason}`;
}

/**
 * Tells the reader what a delete of several messages came to: "3 messages permanently deleted" (no Undo - there is none), or "2 deleted, 1
 * could not be deleted" with the server's reasons.
 */
export function notifyPurged(outcome: PurgeOutcome): void {
    const { deleted, failed } = outcome;
    if (failed.length === 0) {
        notify({ kind: "success", title: `${messageCount(deleted.length)} permanently deleted` });
        return;
    }
    if (failed.some((failure) => failure.status === 401)) {
        notifySessionExpired();
        return;
    }
    const reasons = [...new Set(failed.map((failure) => failure.reason))];
    notify({
        kind: deleted.length > 0 ? "warning" : "error",
        title:
            deleted.length > 0
                ? `${deleted.length} deleted, ${failed.length} could not be deleted`
                : `Couldn't permanently delete ${failed.length === 1 ? "that message" : "those messages"}`,
        message: reasons.slice(0, 3).join(" ") + (reasons.length > 3 ? ` (and ${reasons.length - 3} more reasons)` : ""),
        details: failed.map(failureLine),
        sticky: true,
    });
}

/**
 * Tells the reader what emptying `folderName` came to. `count` is how many messages it held, when that was known: the whole-folder request
 * does not say. A folder that had to be deleted message by message reports as `notifyPurged()` does, plus a word when it was too big to be
 * done in one go.
 */
export function notifyFolderEmptied(folderName: string, outcome: EmptyFolderOutcome, count?: number): void {
    if (outcome.deleted.length === 0 && outcome.failed.length === 0 && outcome.emptied) {
        notify({
            kind: "success",
            title: count === undefined ? `${folderName} emptied` : `${messageCount(count)} permanently deleted`,
            message: count === undefined ? "Everything in it was permanently deleted." : `${folderName} is now empty.`,
        });
        return;
    }
    notifyPurged(outcome);
    if (!outcome.emptied && outcome.failed.length === 0) {
        notify({ kind: "info", title: `${folderName} is not empty yet`, message: "It holds more than could be deleted in one go. Empty it again to carry on." });
    }
}
