///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Main-thread Promise-based RPC wrapper around `localIndexWorker.ts`. One Worker per tab (spawned
 * lazily, on first use, not at module load - a page that never touches search shouldn't pay for booting
 * the WASM module at all), shared across every mailbox `init()`-ed this session - the Worker itself keeps
 * a per-mailbox connection map (see that file's own doc comment).
 *
 * `postMessage` has no native request/response pairing, so every call generates its own numeric `id` and
 * this module correlates the eventual matching response via a pending-request map.
 */
import type { ParsedSearchQuery } from "@rapidmx/react-shared/search/queryGrammar.js";
import type {
    Coverage,
    IndexEntitiesParams,
    IndexEntitiesResult,
    IndexedVersionsParams,
    InitParams,
    LocalIndexRequest,
    LocalIndexResponse,
    LocalSearchPage,
    MoveEntityParams,
    PruneEntitiesParams,
    RemoveEntityParams,
    SearchParams,
    SetBuildingParams,
    SetWindowParams,
} from "./localIndexWorker.js";
import type { LocalIndexEntity } from "./localIndexSchema.js";
import { removeLocalIndexDirectories } from "./localIndexStorage.js";

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

/** Every mailboxUid `initLocalIndex()` has opened this session, not yet `destroyLocalIndex()`-ed. Gates
 * the in-session mutation helpers (`removeLocalEntity()`/`moveLocalEntity()`) so a delete/move in a
 * mailbox this tab never indexed doesn't spin up the Worker just to no-op. */
const initializedMailboxes = new Set<string>();

function getWorker(): Worker {
    if (!worker) {
        worker = new Worker(new URL("./localIndexWorker.ts", import.meta.url), { type: "module" });
        worker.addEventListener("message", (event: MessageEvent<LocalIndexResponse>) => {
            const entry = pending.get(event.data.id);
            if (!entry) {
                return;
            }
            pending.delete(event.data.id);
            if (event.data.ok) {
                entry.resolve(event.data.result);
            } else {
                entry.reject(new Error(event.data.error));
            }
        });
    }
    return worker;
}

function call<T>(method: LocalIndexRequest["method"], params?: unknown): Promise<T> {
    const id = nextRequestId++;
    return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        try {
            getWorker().postMessage({ id, method, params } satisfies LocalIndexRequest);
        } catch (err) {
            pending.delete(id);
            reject(err instanceof Error ? err : new Error(String(err)));
        }
    });
}

export async function initLocalIndex(params: InitParams): Promise<void> {
    await call("init", params);
    initializedMailboxes.add(params.mailboxUid);
}

export function indexLocalEntities(mailboxUid: string, entities: LocalIndexEntity[]): Promise<IndexEntitiesResult> {
    return call("indexEntities", { mailboxUid, entities } satisfies IndexEntitiesParams);
}

/** Drops one message from this session's local index (a delete). A no-op for a mailbox not indexed in
 * this tab - a later build pass prunes it instead. Never rejects: best-effort housekeeping. */
export async function removeLocalEntity(mailboxUid: string, entityUid: string): Promise<void> {
    if (!initializedMailboxes.has(mailboxUid)) {
        return;
    }
    await call("removeEntity", { mailboxUid, entityUid } satisfies RemoveEntityParams).catch(() => undefined);
}

/** Re-points one indexed message at its new folder (archive, cancel-scheduled-send) so `folder:`-scoped
 * local searches stay correct. Same no-op/never-rejects rules as `removeLocalEntity()`. */
export async function moveLocalEntity(mailboxUid: string, entityUid: string, folderUid: string): Promise<void> {
    if (!initializedMailboxes.has(mailboxUid)) {
        return;
    }
    await call("moveEntity", { mailboxUid, entityUid, folderUid } satisfies MoveEntityParams).catch(() => undefined);
}

export function getIndexedVersions(mailboxUid: string, entityUids: string[]): Promise<Record<string, string>> {
    return call("indexedVersions", { mailboxUid, entityUids } satisfies IndexedVersionsParams);
}

export function pruneLocalEntities(mailboxUid: string, keepEntityUids: string[], since: string | undefined): Promise<number> {
    return call("pruneEntities", { mailboxUid, keepEntityUids, since } satisfies PruneEntitiesParams);
}

export function searchLocal(mailboxUid: string, parsed: ParsedSearchQuery, limit: number, offset = 0): Promise<LocalSearchPage> {
    return call("search", { mailboxUid, parsed, limit, offset } satisfies SearchParams);
}

export function getLocalCoverage(mailboxUid: string): Promise<Coverage> {
    return call("coverage", mailboxUid);
}

export function setLocalIndexWindow(mailboxUid: string, timeFloorMonths: number, byteBudgetBytes: number): Promise<void> {
    return call("setWindow", { mailboxUid, timeFloorMonths, byteBudgetBytes } satisfies SetWindowParams);
}

export function setLocalIndexBuilding(mailboxUid: string, building: boolean, completion: { complete: boolean; coveredFrom?: string } = { complete: false }): Promise<void> {
    return call("setBuilding", { mailboxUid, building, ...completion } satisfies SetBuildingParams);
}

/** Destroys one mailbox's local index (both the SQLite connection and its on-disk OPFS storage) - spec
 * §11 "MUST be destroyed on the same events that destroy private keys." Never rejects (it's called from
 * lifecycle hooks where a failure mustn't block key destruction) but resolves `false` - and logs why -
 * when the index could not be removed, e.g. because another tab still has it open. */
export async function destroyLocalIndex(mailboxUid: string): Promise<boolean> {
    try {
        await call("destroy", mailboxUid);
        return true;
    } catch (err) {
        console.warn(`Could not destroy the local search index for mailbox ${mailboxUid}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    } finally {
        initializedMailboxes.delete(mailboxUid);
    }
}

/** How long sign-out waits for local index destruction before navigating anyway. */
export const DESTROY_ALL_TIMEOUT_MS = 3_000;

/**
 * Destroys **every** local index on this device - not just the mailboxes this page load opened (sign-out
 * from Calendar, say, never opened any), by enumerating OPFS for the index directory prefix. Closes this
 * tab's own open connections through the Worker first (only if one was ever spawned - there's nothing to
 * close otherwise, and booting one just to delete files would be waste), then removes the directories.
 * Resolves `true` when everything was removed within `timeoutMs`; never rejects.
 */
export async function destroyAllLocalIndexes(timeoutMs = DESTROY_ALL_TIMEOUT_MS): Promise<boolean> {
    const work = (async () => {
        let ok = true;
        if (worker) {
            const { failed } = await call<{ failed: string[] }>("destroyAll").catch(() => ({ failed: ["(worker)"] }));
            ok = failed.length === 0;
        }
        initializedMailboxes.clear();
        const { failed } = await removeLocalIndexDirectories();
        return ok && failed.length === 0;
    })().catch(() => false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([work, timeout]);
    clearTimeout(timer);
    if (!result) {
        console.warn("Could not destroy every local search index before signing out.");
    }
    return result;
}

/** Removes local indexes for mailboxes outside `accessibleMailboxUids` - e.g. left behind by a different
 * user who signed in on this device without signing out. Never rejects. */
export async function pruneInaccessibleLocalIndexes(accessibleMailboxUids: Iterable<string>): Promise<void> {
    await removeLocalIndexDirectories(new Set(accessibleMailboxUids)).catch(() => undefined);
}
