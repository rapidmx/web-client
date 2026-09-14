///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The Tier 2 local index's on-disk naming and bulk-removal helpers, shared by the Worker
 * (`localIndexWorker.ts`) and the main thread (`localIndexRpcClient.ts`). Deliberately free of any
 * wa-sqlite import so the main thread can use it without pulling the WASM build into its own bundle.
 *
 * Every mailbox's index lives in its own top-level OPFS directory named `rapidmx-localsearch-<mailboxUid>`
 * (`AccessHandlePoolVFS` creates it from the VFS name). Enumerating that prefix is how sign-out destroys
 * *every* index on this device - including ones for mailboxes this page load never opened, which the
 * RPC client's own session-scoped bookkeeping can't know about - and how a sign-in prunes indexes left
 * behind for mailboxes the current user can no longer access.
 */

export const LOCAL_INDEX_POOL_PREFIX = "rapidmx-localsearch-";

/** The OPFS directory name (and `EncryptingVFS` name) a mailbox's index lives under. */
export function poolNameFor(mailboxUid: string): string {
    return `${LOCAL_INDEX_POOL_PREFIX}${mailboxUid}`;
}

/** Inverse of `poolNameFor()`; `undefined` for any OPFS entry that isn't a local index directory. */
export function mailboxUidFromPoolName(name: string): string | undefined {
    return name.startsWith(LOCAL_INDEX_POOL_PREFIX) && name.length > LOCAL_INDEX_POOL_PREFIX.length
        ? name.slice(LOCAL_INDEX_POOL_PREFIX.length)
        : undefined;
}

/** `navigator.storage.getDirectory()`, or `undefined` where OPFS isn't available at all (older browsers,
 * jsdom/node) - there is nothing on disk to remove in that case. */
async function getOpfsRoot(): Promise<FileSystemDirectoryHandle | undefined> {
    const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
    if (!storage?.getDirectory) {
        return undefined;
    }
    return storage.getDirectory();
}

function isNotFound(err: unknown): boolean {
    return (err as { name?: string } | undefined)?.name === "NotFoundError";
}

/** Removes one mailbox's index directory. Resolves quietly when it doesn't exist; rejects for any other
 * failure (most commonly `NoModificationAllowedError` - another tab still holds its access handles). */
export async function removeLocalIndexDirectory(mailboxUid: string): Promise<void> {
    const root = await getOpfsRoot();
    if (!root) {
        return;
    }
    try {
        await root.removeEntry(poolNameFor(mailboxUid), { recursive: true });
    } catch (err) {
        if (!isNotFound(err)) {
            throw err;
        }
    }
}

export interface LocalIndexRemovalResult {
    removed: string[];
    /** Mailbox uids whose directory could not be removed (e.g. still open in another tab). */
    failed: string[];
}

/** Removes every local index directory on this origin except those whose mailbox uid is in `keep`. */
export async function removeLocalIndexDirectories(keep: ReadonlySet<string> = new Set()): Promise<LocalIndexRemovalResult> {
    const result: LocalIndexRemovalResult = { removed: [], failed: [] };
    const root = await getOpfsRoot();
    if (!root) {
        return result;
    }
    const mailboxUids: string[] = [];
    // `keys()` is part of the OPFS spec and every browser that has `getDirectory()` at all, but isn't in
    // this TypeScript version's DOM lib yet.
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
        const mailboxUid = mailboxUidFromPoolName(name);
        if (mailboxUid && !keep.has(mailboxUid)) {
            mailboxUids.push(mailboxUid);
        }
    }
    for (const mailboxUid of mailboxUids) {
        try {
            await removeLocalIndexDirectory(mailboxUid);
            result.removed.push(mailboxUid);
        } catch {
            result.failed.push(mailboxUid);
        }
    }
    return result;
}
