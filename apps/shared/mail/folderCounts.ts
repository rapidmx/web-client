///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useCallback, useEffect, useRef, useState } from "react";
import { Folder, FolderType, Mailbox, Message, listFolders } from "@rapidmx/react-shared/mail/mailApi.js";

/**
 * The folder badges' numbers, kept right without a reload.
 *
 * A folder's `unreadCount`/`totalCount` come from the server (`GET /mail/folders`, the server-published `Folder` update
 * event, and the poll), but waiting for a round trip to see a badge move after reading a message feels broken, so a change
 * made here is applied to the badge at once - **optimistically** - and then *reconciled*: every so often, and after every
 * change, the real counts are read back and replace whatever this page worked out. So the page can be wrong for a moment,
 * never for good.
 *
 * What the server sends (`@rapidmx/restapi`): `GET /mail/folders` returns each folder with a derived `unreadCount`/`totalCount`
 * (unread messages, all messages), and after any change to a folder's messages it publishes
 * `{ type: /^Folder/, action: "update", data: { uid, mailboxUid, unreadCount, totalCount } }` on the folder's push channel *and* its
 * mailbox's, so each is heard twice - the values are absolute and applying one again changes nothing. Nothing here fails without
 * that event, or for a write that publishes none (ActiveSync/MAPI, erasure jobs): the read-back after each change and the poll do
 * the same job a little later, and overlapping writes to one folder are unordered, so they always have the last word.
 */

export interface FolderCount {
    unread: number;
    total: number;
}

/** A change to one folder's counts. */
export interface CountDelta {
    folderUid: string;
    unread: number;
    total: number;
}

/** What one message change - a new message (`previous` absent), a deletion (`next` absent), a read/unread flip, a move - does to the folders' counts. */
export function countDeltas(previous: Message | null | undefined, next: Message | null | undefined): CountDelta[] {
    const byFolder = new Map<string, CountDelta>();
    function add(message: Message, sign: 1 | -1) {
        const entry = byFolder.get(message.folderUid) ?? { folderUid: message.folderUid, unread: 0, total: 0 };
        entry.total += sign;
        entry.unread += message.flags.read === true ? 0 : sign;
        byFolder.set(message.folderUid, entry);
    }
    if (previous) {
        add(previous, -1);
    }
    if (next) {
        add(next, 1);
    }
    return [...byFolder.values()].filter((delta) => delta.unread !== 0 || delta.total !== 0);
}

/** A folder's count as it should be shown: what this page last worked out or was told, else what the folder was listed with. */
export function countOfFolder(folder: Folder, counts: Record<string, FolderCount>): FolderCount {
    return counts[folder.uid] ?? { unread: folder.unreadCount, total: folder.totalCount };
}

/** What a folder's badge shows: how many unread, or (Drafts and Outbox, Outlook-style) how many messages are in it. */
export interface FolderBadge {
    kind: "unread" | "total";
    value: number;
}

/**
 * The badge a folder gets, if any. Inbox, Archive and the user's own folders show their unread count when it is above
 * zero; Drafts and Outbox show how many messages they hold (an unread count means nothing there); Sent Items, Deleted
 * Items and Junk Email show nothing.
 */
export function badgeFor(type: FolderType, count: FolderCount): FolderBadge | undefined {
    switch (type) {
        case "sent_items":
        case "deleted_items":
        case "junk":
            return undefined;
        case "drafts":
        case "outbox":
            return count.total > 0 ? { kind: "total", value: count.total } : undefined;
        default:
            return count.unread > 0 ? { kind: "unread", value: count.unread } : undefined;
    }
}

/** The badge's text for assistive technology: "3 unread", "2 messages". */
export function badgeLabel(badge: FolderBadge): string {
    return badge.kind === "unread" ? `${badge.value} unread` : `${badge.value} ${badge.value === 1 ? "message" : "messages"}`;
}

/** The unread messages in every mailbox's Inbox - what the tab title counts. */
export function inboxUnreadTotal(mailboxFolders: { folders: Folder[] }[], counts: Record<string, FolderCount>): number {
    return mailboxFolders.reduce(
        (total, entry) =>
            total + entry.folders.filter((folder) => folder.type === "inbox").reduce((sum, folder) => sum + countOfFolder(folder, counts).unread, 0),
        0,
    );
}

/** The unread messages behind the badges of `folders` that show an unread count (see `badgeFor()`: Inbox, Archive and the user's own
 * folders - not Drafts, Outbox, Sent Items, Deleted Items or Junk Email) - what a collapsed sidebar section shows on its heading. */
export function unreadBadgeTotal(folders: readonly Folder[], counts: Record<string, FolderCount>): number {
    return folders.reduce((total, folder) => {
        const badge = badgeFor(folder.type, countOfFolder(folder, counts));
        return badge?.kind === "unread" ? total + badge.value : total;
    }, 0);
}

/** How long after the last change of this page's own has finished a server-published count is trusted again: one published
 * about an earlier state of the folder could otherwise arrive late and put back what the change just took away. */
export const COUNT_QUIET_MS = 1_500;

/** How long after a change the counts are read back from the server. */
export const COUNT_REFRESH_DELAY_MS = 600;

/** How many message uids the "already counted this new message" memory holds. */
const SEEN_LIMIT = 500;

/** An optimistic change in flight: call exactly one of these once the server has answered. */
export interface CountTracker {
    /** The server accepted the change: keep what was applied, and read the real counts back. */
    settle(): void;
    /** The server refused it (or it failed): put the counts back as they were, and read the real ones back. */
    revert(): void;
}

export interface FolderCounts {
    /** The counts this page has worked out or been told since load, by folder uid - see `countOfFolder()`. */
    counts: Record<string, FolderCount>;
    /** Applies the effect of changing `previous` into `next` now, before the server has answered - see `CountTracker`. */
    track(previous: Message | null | undefined, next: Message | null | undefined): CountTracker;
    /** A new message arrived over the push connection: counts it (once per message) until the real counts are read back.
     * `false` when this one was already counted - a duplicate event. */
    noteCreated(message: Message): boolean;
    /** The server's `Folder` update event's `data`: the folder's real counts - when this page has nothing of its own in flight. */
    applyFolderEvent(data: unknown): void;
    /** Reads every mailbox's real counts back and shows them, after `delayMs` (at once for 0). A later call replaces one still waiting. */
    refresh(delayMs?: number): void;
}

/**
 * Holds the folder counts overlay for `MailShell`. `folders` is every folder the sidebar lists (the overlay starts from what
 * each was loaded with); `mailboxes` is whose folders to read back. The overlay starts again whenever `mailboxes` does.
 */
export function useFolderCounts(mailboxes: Mailbox[], folders: Folder[], onFoldersListed?: (folders: Folder[]) => void): FolderCounts {
    const [counts, setCounts] = useState<Record<string, FolderCount>>({});
    const latestRef = useRef({ mailboxes, folders, onFoldersListed });
    latestRef.current = { mailboxes, folders, onFoldersListed };
    // Bumped by every change of the overlay this page makes, so a read that started before one can tell it is out of date.
    const changesRef = useRef(0);
    const inFlightRef = useRef(0);
    const lastDoneRef = useRef(0);
    const runRef = useRef(0);
    // Assigned during every render, before anything can call it.
    const readBackRef = useRef<() => Promise<void>>(undefined as never);
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const stoppedRef = useRef(false);
    const seenRef = useRef<Set<string>>(new Set());

    const adjust = useCallback((deltas: CountDelta[]) => {
        const known = deltas.filter((delta) => latestRef.current.folders.some((folder) => folder.uid === delta.folderUid));
        if (known.length === 0) {
            return;
        }
        changesRef.current++;
        setCounts((previous) => {
            const next = { ...previous };
            for (const delta of known) {
                const folder = latestRef.current.folders.find((f) => f.uid === delta.folderUid)!;
                const base = next[delta.folderUid] ?? { unread: folder.unreadCount, total: folder.totalCount };
                next[delta.folderUid] = {
                    unread: Math.max(0, base.unread + delta.unread),
                    total: Math.max(0, base.total + delta.total),
                };
            }
            return next;
        });
    }, []);

    const refresh = useCallback((delayMs: number = COUNT_REFRESH_DELAY_MS) => {
        if (stoppedRef.current) {
            return;
        }
        clearTimeout(timerRef.current);
        if (delayMs <= 0) {
            timerRef.current = undefined;
            void readBackRef.current();
            return;
        }
        timerRef.current = setTimeout(() => void readBackRef.current(), delayMs);
    }, []);

    // Re-assigned on every render so it reads the latest mailboxes; `refresh` (stable) calls whichever is current.
    readBackRef.current = async () => {
        timerRef.current = undefined;
        const run = ++runRef.current;
        const startedAt = changesRef.current;
        const results = await Promise.all(latestRef.current.mailboxes.map((mailbox) => listFolders(mailbox.uid).catch(() => undefined)));
        if (stoppedRef.current || run !== runRef.current) {
            return;
        }
        // Whatever the counts' fate below, these are the mailboxes' folders as they are: a folder the sidebar does not have yet is filed now.
        for (const list of results) {
            if (list) {
                latestRef.current.onFoldersListed?.(list);
            }
        }
        if (inFlightRef.current > 0 || changesRef.current !== startedAt) {
            // A change of this page's own began or ended while that was being read, so it may predate it: read again.
            refresh();
            return;
        }
        const fresh: Record<string, FolderCount> = {};
        for (const list of results) {
            for (const folder of list ?? []) {
                fresh[folder.uid] = { unread: folder.unreadCount, total: folder.totalCount };
            }
        }
        setCounts((previous) => {
            const changed = Object.entries(fresh).some(
                ([uid, count]) => previous[uid]?.unread !== count.unread || previous[uid]?.total !== count.total,
            );
            return changed ? { ...previous, ...fresh } : previous;
        });
    };

    const track = useCallback(
        (previous: Message | null | undefined, next: Message | null | undefined): CountTracker => {
            const deltas = countDeltas(previous, next);
            inFlightRef.current++;
            adjust(deltas);
            let finished = false;
            /** Whether this call was the one that ended it (a tracker ends once). */
            function finish(): boolean {
                if (finished) {
                    return false;
                }
                finished = true;
                inFlightRef.current--;
                lastDoneRef.current = Date.now();
                changesRef.current++;
                return true;
            }
            return {
                settle() {
                    if (finish()) {
                        refresh();
                    }
                },
                revert() {
                    if (finish()) {
                        adjust(deltas.map((delta) => ({ folderUid: delta.folderUid, unread: -delta.unread, total: -delta.total })));
                        refresh();
                    }
                },
            };
        },
        [adjust, refresh],
    );

    const noteCreated = useCallback(
        (message: Message) => {
            const seen = seenRef.current;
            if (seen.has(message.uid)) {
                return false;
            }
            seen.add(message.uid);
            if (seen.size > SEEN_LIMIT) {
                seen.delete(seen.values().next().value!);
            }
            adjust(countDeltas(null, message));
            refresh();
            return true;
        },
        [adjust, refresh],
    );

    const applyFolderEvent = useCallback(
        (data: unknown) => {
            const event = data as { uid?: unknown; unreadCount?: unknown; totalCount?: unknown } | null | undefined;
            const uid = event?.uid;
            const folder = typeof uid === "string" ? latestRef.current.folders.find((f) => f.uid === uid) : undefined;
            if (!folder) {
                return;
            }
            if (inFlightRef.current > 0 || Date.now() - lastDoneRef.current < COUNT_QUIET_MS) {
                // Its number may be about a state older than this page's own change: let a fresh read settle it.
                refresh();
                return;
            }
            const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
            setCounts((previous) => {
                const current = previous[folder.uid] ?? { unread: folder.unreadCount, total: folder.totalCount };
                const unread = valid(event!.unreadCount) ? event!.unreadCount : current.unread;
                const total = valid(event!.totalCount) ? event!.totalCount : current.total;
                return unread === current.unread && total === current.total && previous[folder.uid] ? previous : { ...previous, [folder.uid]: { unread, total } };
            });
        },
        [refresh],
    );

    // A fresh load of the mailboxes is a fresh start: the folders come with counts of their own. (Keyed on the uids, not the array.)
    const mailboxKey = mailboxes.map((mailbox) => mailbox.uid).join("|");
    useEffect(() => {
        changesRef.current++;
        setCounts((previous) => (Object.keys(previous).length > 0 ? {} : previous));
    }, [mailboxKey]);

    useEffect(() => {
        stoppedRef.current = false;
        return () => {
            stoppedRef.current = true;
            clearTimeout(timerRef.current);
        };
    }, []);

    return { counts, track, noteCreated, applyFolderEvent, refresh };
}
