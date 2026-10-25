///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Where a zero-access sync pass (`zeroAccessIndexSync.ts`) remembers what it imported into a mailbox's local index - the segments it
 * holds, the live tail's last read - and the forgetting of it when that index is destroyed (`localIndexRpcClient.ts`'s
 * `destroyLocalIndex()`/`destroyAllLocalIndexes()`: a lock, sign-out; `pruneInaccessibleLocalIndexes()`; the Worker discarding a corrupted
 * index). Apart from both so neither imports the other.
 *
 * What was remembered describes an index that is gone, so it must not outlive it - a new index the build fills first (decrypted
 * end-to-end mail) would otherwise be taken for the old one, and the segments it never got skipped. A pass that started before the destroy
 * must not write it back either: each pass reads `zeroAccessSyncEpoch()` when it starts and saves nothing once it changed.
 */

const PREFIX = "rapidmx:za-index-sync:";

/** The localStorage key of `mailboxUid`'s sync state. */
export const zeroAccessSyncStateKey = (mailboxUid: string): string => `${PREFIX}${mailboxUid}`;

const epochs = new Map<string, number>();
let allEpoch = 0;

/** Changes whenever `mailboxUid`'s sync state is forgotten. */
export function zeroAccessSyncEpoch(mailboxUid: string): string {
    return `${allEpoch}:${epochs.get(mailboxUid) ?? 0}`;
}

/** Forgets what a pass remembered for `mailboxUid` (its local index is destroyed). */
export function forgetZeroAccessSync(mailboxUid: string): void {
    epochs.set(mailboxUid, (epochs.get(mailboxUid) ?? 0) + 1);
    try {
        localStorage.removeItem(zeroAccessSyncStateKey(mailboxUid));
    } catch {
        // Nothing to forget.
    }
}

/** Forgets what passes remembered for every mailbox (every local index is destroyed). */
export function forgetAllZeroAccessSync(): void {
    allEpoch++;
    try {
        storedMailboxUids().forEach((mailboxUid) => localStorage.removeItem(zeroAccessSyncStateKey(mailboxUid)));
    } catch {
        // Nothing to forget.
    }
}

/** Forgets what passes remembered for every mailbox not in `keep` (their local indexes are pruned). */
export function forgetZeroAccessSyncExcept(keep: ReadonlySet<string>): void {
    let stored: string[];
    try {
        stored = storedMailboxUids();
    } catch {
        return;
    }
    stored.filter((mailboxUid) => !keep.has(mailboxUid)).forEach(forgetZeroAccessSync);
}

/** The mailboxes some sync state is stored for. Throws when storage can't be read. */
function storedMailboxUids(): string[] {
    const uids: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(PREFIX)) {
            uids.push(key.slice(PREFIX.length));
        }
    }
    return uids;
}
