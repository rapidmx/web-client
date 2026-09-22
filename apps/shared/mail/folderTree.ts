///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { Folder } from "@rapidmx/react-shared/mail/mailApi.js";
import type { MailboxFolders } from "../components/mail/layout/MailShell.js";

/**
 * The sidebar's order of a mailbox's well-known folders; anything else (`user`) follows, alphabetically. Also the order push channels are asked
 * for (`pushChannelsFor()`), so when the server's channel cap bites it is the folders lowest in this list that go without live updates.
 */
export const FOLDER_ORDER = ["inbox", "drafts", "outbox", "sent_items", "deleted_items", "junk", "archive"];

/**
 * A mailbox's `calendar`/`contacts`/`tasks`/`notes` folders back their own dedicated apps (see `CalendarShell`/`ContactsShell`/`TasksShell`), not
 * Mail - `listFolders()` returns every well-known folder for the mailbox regardless of which app owns it, so Mail's own folder tree filters down
 * to just the mail ones itself, or those other apps' folders leak into its sidebar.
 */
export const MAIL_FOLDER_TYPES = new Set([...FOLDER_ORDER, "user"]);

/** The well-known folders the server creates lazily around a first send: what the sidebar shows a placeholder for while a message is on its way. */
export const SEND_FOLDER_TYPES = ["outbox", "sent_items"] as const;

export function isMailFolder(folder: { type: string }): boolean {
    return MAIL_FOLDER_TYPES.has(folder.type);
}

function sortKey(type: string): number {
    const index = FOLDER_ORDER.indexOf(type);
    return index === -1 ? FOLDER_ORDER.length : index;
}

/** Well-known folders in `FOLDER_ORDER`, then the rest by name. A new array; the input is left alone. */
export function sortFolders(folders: Folder[]): Folder[] {
    return [...folders].sort((a, b) => sortKey(a.type) - sortKey(b.type) || a.name.localeCompare(b.name));
}

/** What a sidebar row is: a folder that exists, or (`placeholder`) one that is expected to but has not arrived yet. */
export type FolderRow = { kind: "folder"; folder: Folder } | { kind: "placeholder"; type: string };

/**
 * The rows of one mailbox's sidebar section, in order: every folder that exists, and - while `sending` messages are on their way and the
 * server has not made the folder yet - a placeholder for each of the Outbox and Sent Items that is missing. The one place a folder that has not
 * arrived is drawn, so it can never appear twice: the moment the real folder is in `folders` its placeholder is not built.
 */
export function folderRows(folders: Folder[], sending: number): FolderRow[] {
    const rows: FolderRow[] = sortFolders(folders).map((folder) => ({ kind: "folder", folder }));
    if (sending > 0) {
        for (const type of SEND_FOLDER_TYPES) {
            if (!folders.some((folder) => folder.type === type)) {
                rows.push({ kind: "placeholder", type });
            }
        }
        rows.sort((a, b) => sortKey(rowType(a)) - sortKey(rowType(b)));
    }
    return rows;
}

function rowType(row: FolderRow): string {
    return row.kind === "folder" ? row.folder.type : row.type;
}

/** What a folder can be changed to by an event or a refetch: everything about it except the counts, which the counts overlay owns. */
export type FolderChange = Partial<Pick<Folder, "name" | "type" | "parentFolderUid" | "color">> & { uid: string; mailboxUid?: string };

const CHANGEABLE = ["name", "type", "parentFolderUid", "color"] as const;

/**
 * Files `folder` in the tree: added under its mailbox when unknown (a type Mail does not list is ignored), else its name, type, parent and
 * colour brought up to date (a folder that became a type Mail does not list leaves the tree). Returns `entries` itself - the same array - when
 * nothing changed, because everything on screen that depends on the tree starts over when it is a new one.
 */
export function upsertFolder(entries: MailboxFolders[], folder: Folder | FolderChange): MailboxFolders[] {
    let changed = false;
    const next = entries.map((entry) => {
        const existing = entry.folders.find((f) => f.uid === folder.uid);
        if (!existing) {
            // Only a whole folder can be added: an update for one that is not known has nothing to add it with (the refetch it causes will).
            if (entry.mailbox.uid !== folder.mailboxUid || !isFullFolder(folder) || !isMailFolder(folder)) {
                return entry;
            }
            // A well-known folder is one per mailbox - the server treats the oldest as the real one - so a second of the same type (made by a client that did
            // not know it existed) is not a second row: the older of the two is the one shown.
            const sameType = folder.type === "user" ? undefined : entry.folders.find((f) => f.type === folder.type);
            if (sameType) {
                if (!isOlder(folder, sameType)) {
                    return entry;
                }
                changed = true;
                return { ...entry, folders: entry.folders.map((f) => (f === sameType ? folder : f)) };
            }
            changed = true;
            return { ...entry, folders: [...entry.folders, folder] };
        }
        const patch: Partial<Folder> = {};
        for (const key of CHANGEABLE) {
            if (key in folder && folder[key] !== undefined && folder[key] !== existing[key]) {
                (patch as Record<string, unknown>)[key] = folder[key];
            }
        }
        if (Object.keys(patch).length === 0) {
            return entry;
        }
        changed = true;
        const updated = { ...existing, ...patch };
        return { ...entry, folders: isMailFolder(updated) ? entry.folders.map((f) => (f === existing ? updated : f)) : entry.folders.filter((f) => f !== existing) };
    });
    return changed ? next : entries;
}

function isFullFolder(folder: Folder | FolderChange): folder is Folder {
    return typeof folder.name === "string" && typeof folder.type === "string";
}

/** Whether `a` was created before `b`: only when both say when. */
function isOlder(a: Folder, b: Folder): boolean {
    // (A folder from the network may lack the date: `Date.parse(undefined)` is NaN, which is "cannot tell".)
    const first = Date.parse(a.dateCreated);
    const second = Date.parse(b.dateCreated);
    return Number.isFinite(first) && Number.isFinite(second) && first < second;
}

/** Takes a deleted folder out of the tree. The same array when it was not in it. */
export function removeFolder(entries: MailboxFolders[], folderUid: string): MailboxFolders[] {
    if (!entries.some((entry) => entry.folders.some((folder) => folder.uid === folderUid))) {
        return entries;
    }
    return entries.map((entry) => (entry.folders.some((folder) => folder.uid === folderUid) ? { ...entry, folders: entry.folders.filter((folder) => folder.uid !== folderUid) } : entry));
}

/**
 * Brings one mailbox's part of the tree up to date with a listing the server just gave (`listFolders()`): folders it has that the tree lacks
 * are added, changed names and types are taken. Nothing is removed - a listing that began before a folder was created here would take it out
 * again, and deletions arrive as events - and the counts are not touched (see `useFolderCounts()`). The same array when there is nothing to do.
 */
export function reconcileFolders(entries: MailboxFolders[], listed: Folder[]): MailboxFolders[] {
    return listed.reduce((tree, folder) => upsertFolder(tree, folder), entries);
}

/** Every folder uid in the tree. */
export function knownFolderUids(entries: MailboxFolders[]): Set<string> {
    return new Set(entries.flatMap((entry) => entry.folders.map((folder) => folder.uid)));
}
