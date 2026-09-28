///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Backs Tasks' "Flagged email" smart-list (an Outlook To-Do concept: flagged *Messages*, not Tasks,
 * surfaced into the Tasks app).
 *
 * The server now does the filtering: `listMessages({ filter: "flagged" })` is an indexed database predicate on
 * the denormalized `Message.flagged` mirror (`flags` itself is one JSON column, which is why this used to read
 * every message in the mailbox and filter in the browser). What is still client-side is the fan-out: a message
 * list is folder-scoped, and "every flagged message in this mailbox" spans every mail folder, so this still
 * makes one paged call per folder and merges the results. The client-side `flags.flagged` check below is kept
 * as a cheap guard for a row written before the mirror existed, not as the filter.
 */
import { Folder, Message, listFolders, listMessages } from "./mailApi.js";
import { ApiClient } from "../util/api.js";

/** Folder types that actually hold `Message` records — mirrors `MailShell.tsx`'s own `MAIL_FOLDER_TYPES`
 * allowlist (kept as a separate local copy rather than a shared export, since the two call sites have no
 * other coupling and this list is small/stable). */
const MAIL_FOLDER_TYPES = new Set(["inbox", "drafts", "outbox", "sent_items", "junk", "deleted_items", "archive", "user"]);

/** The server's own per-request `limit` cap - a page shorter than this is the folder's last one. */
const PAGE_SIZE = 500;

/** Hard cap on pages read per folder (50,000 messages) - guards against paging forever should a server
 * ignore `page` and keep returning full pages. */
export const FLAGGED_MAX_PAGES_PER_FOLDER = 100;

/** How many folders are paged through at once, bounding the request burst on a mailbox with many folders. */
export const FLAGGED_FOLDER_CONCURRENCY = 4;

/** Every flagged message in one folder, paging through `listMessages()` until a short page. Only flagged
 * messages are kept (a large folder's unflagged pages are dropped as they arrive). Stops early at
 * `FLAGGED_MAX_PAGES_PER_FOLDER`, or when a full page brings no message not already seen (a server
 * ignoring `page` and returning the same page again). */
async function listFlaggedInFolder(folderUid: string, seen: Set<string>, client?: ApiClient): Promise<Message[]> {
    const flagged: Message[] = [];
    const seenInFolder = new Set<string>();
    for (let page = 0; page < FLAGGED_MAX_PAGES_PER_FOLDER; page += 1) {
        const batch = await listMessages(folderUid, { limit: PAGE_SIZE, page, filter: "flagged" }, client);
        let fresh = 0;
        for (const message of batch) {
            if (seenInFolder.has(message.uid)) {
                continue;
            }
            seenInFolder.add(message.uid);
            fresh += 1;
            // Deduplicated across folders too: a message moved mid-listing can appear in two folders' pages.
            if (message.flags.flagged && !seen.has(message.uid)) {
                seen.add(message.uid);
                flagged.push(message);
            }
        }
        if (batch.length < PAGE_SIZE || fresh === 0) {
            break;
        }
    }
    return flagged;
}

/** Lists every flagged message across all of a mailbox's mail folders (not just Inbox), newest first, each
 * message at most once. `client`, when given, is threaded through to every underlying `listFolders()`/
 * `listMessages()` call (see `useApiClient()`'s own doc comment) - omitted, this behaves exactly as before. */
export async function listFlaggedMessages(mailboxUid: string, client?: ApiClient): Promise<Message[]> {
    const folders: Folder[] = await listFolders(mailboxUid, client);
    const mailFolders = folders.filter((f) => MAIL_FOLDER_TYPES.has(f.type));
    const seen = new Set<string>();
    const perFolder: Message[][] = [];
    let next = 0;
    async function worker(): Promise<void> {
        while (next < mailFolders.length) {
            const index = next++;
            perFolder[index] = await listFlaggedInFolder(mailFolders[index].uid, seen, client);
        }
    }
    await Promise.all(Array.from({ length: Math.min(FLAGGED_FOLDER_CONCURRENCY, mailFolders.length) }, () => worker()));
    return perFolder.flat().sort((a, b) => new Date(b.receivedDate).getTime() - new Date(a.receivedDate).getTime());
}
