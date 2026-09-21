///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ConversationSummary } from "@rapidmx/react-shared/mail/conversationsApi.js";
import type { Message } from "@rapidmx/react-shared/mail/mailApi.js";

/**
 * A short-lived, in-memory copy of a folder's listing, so that switching to a folder that was shown a moment ago (or coming back
 * to Mail from another app) shows its rows on the very frame of the click and revalidates behind them (stale-while-revalidate),
 * instead of replacing the list with a loading state and waiting for the network. It is the client-side router's answer to
 * "folder navigation takes seconds": the list of the folder being switched to is usually already known.
 *
 * Only a plain folder's listing is kept - a search's, an aggregate ("All Mailboxes") view's and a load-more page's rows are not -
 * and what is kept is exactly what was on screen, including the rows "load more" added, the selection and the scroll position,
 * so returning to a folder puts the reader where they left it. A snapshot only makes the first paint fast; the listing is always
 * fetched again and folded in (`mergeFirstPage()`), so nothing shown from here is ever taken as current.
 */
export interface ListSnapshot {
    messages: Message[];
    conversations: ConversationSummary[];
    hasMore: boolean;
    /** The message that was selected (the reading pane's), if it is still in `messages` when the snapshot is shown. */
    selectedUid: string | null;
    /** The list's `scrollTop`, saved when the listing was left. */
    scrollTop: number;
    /** When it was last written. */
    at: number;
}

/** How long a snapshot may be shown after it was last written. Longer than that the folder is shown as loading, as before. */
export const LIST_SNAPSHOT_TTL_MS = 5 * 60_000;

/** How many folders are remembered; the least recently written is dropped first. */
export const LIST_SNAPSHOT_MAX = 16;

const snapshots = new Map<string, ListSnapshot>();

/** Everything that makes one listing different from another: which folder, as messages or conversations, and how it is
 * filtered and sorted. */
export function listSnapshotKey(parts: {
    mailboxUid: string | undefined;
    folderUid: string | undefined;
    conversations: boolean;
    filter: string;
    labels: string;
    sort: string;
}): string {
    return [parts.mailboxUid, parts.folderUid, parts.conversations ? "conversations" : "messages", parts.filter, parts.labels, parts.sort].join("|");
}

/** The snapshot for `key`, or `undefined` when there is none or it is older than `LIST_SNAPSHOT_TTL_MS`. */
export function readListSnapshot(key: string, now: number = Date.now()): ListSnapshot | undefined {
    const snapshot = snapshots.get(key);
    if (!snapshot) {
        return undefined;
    }
    if (now - snapshot.at > LIST_SNAPSHOT_TTL_MS) {
        snapshots.delete(key);
        return undefined;
    }
    return snapshot;
}

/** Remembers a listing as it is on screen (keeping the scroll position saved for it, if any). */
export function writeListSnapshot(key: string, listing: Omit<ListSnapshot, "scrollTop" | "at">, now: number = Date.now()): void {
    const previous = snapshots.get(key);
    // Re-inserted so that the Map's order is least-recently-written first.
    snapshots.delete(key);
    snapshots.set(key, { ...listing, scrollTop: previous?.scrollTop ?? 0, at: now });
    while (snapshots.size > LIST_SNAPSHOT_MAX) {
        snapshots.delete(snapshots.keys().next().value as string);
    }
}

/** Records how far `key`'s list was scrolled when it was left. A no-op for a listing that was never remembered. */
export function saveListScroll(key: string, scrollTop: number): void {
    const snapshot = snapshots.get(key);
    if (snapshot) {
        snapshot.scrollTop = scrollTop;
    }
}

/** Forgets every snapshot (sign-out, and tests). */
export function clearListSnapshots(): void {
    snapshots.clear();
}
