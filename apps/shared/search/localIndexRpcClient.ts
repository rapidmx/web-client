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
 *
 * **Generations**: `nextLocalIndexGeneration()` hands out one monotonic counter shared by build passes and
 * destroys, so the Worker can reject a build call issued before the index was destroyed (see
 * `GenerationParams`).
 *
 * **Sign-out reaches every tab**: `destroyAllLocalIndexes()` broadcasts on a `BroadcastChannel`; any other
 * tab running a Worker closes its connections and refuses further `init`s.
 *
 * **Failed deletions are retried**: a destroy that couldn't remove a directory (another tab held it, the page
 * navigated away first) is recorded in `localStorage` and retried before this tab's first `init`.
 *
 * **A crashed Worker never leaves a caller hanging**: the `error` listener registered in `getWorker()` rejects
 * every pending request and drops the module-level `worker` reference so the next `call()` spawns a
 * replacement. `searchTier2.ts` additionally races its own calls against a timeout, since a Worker that's
 * merely stuck (not crashed) posts no `error` event at all.
 */
import type { ParsedSearchQuery } from "@rapidmx/react-shared/search/queryGrammar.js";
import type {
    Coverage,
    DestroyParams,
    GenerationParams,
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
    WindowState,
} from "./localIndexWorker.js";
import type { LocalIndexEntity } from "./localIndexSchema.js";
import { removeLocalIndexDirectories, removeLocalIndexDirectory } from "./localIndexStorage.js";

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

/** Every mailboxUid `initLocalIndex()` has opened this session, not yet `destroyLocalIndex()`-ed. Gates
 * the in-session mutation helpers (`removeLocalEntity()`/`moveLocalEntity()`) so a delete/move in a
 * mailbox this tab never indexed doesn't spin up the Worker just to no-op. */
const initializedMailboxes = new Set<string>();

let generationCounter = 0;

/** A fresh generation - see this module's doc comment. */
export function nextLocalIndexGeneration(): number {
    generationCounter += 1;
    return generationCounter;
}

/** Set once this tab (or another one) signed out - no index may be opened again in this page load. */
let signedOut = false;

export const SIGN_OUT_CHANNEL = "rapidmx-localsearch";
let channel: BroadcastChannel | undefined;

function getWorker(): Worker {
    if (!worker) {
        // Named by its compiled `.js` file, like every other relative import: tsc copies the literal into
        // `dist` unchanged, where only the `.js` file exists, and Vite maps it back to the `.ts` source.
        worker = new Worker(new URL("./localIndexWorker.js", import.meta.url), { type: "module" });
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
        // A Worker that crashes (an uncaught exception, the WASM module aborting) never posts a response to
        // its in-flight requests - without this, every pending call() promise would sit unresolved forever,
        // and searchTier2.ts's try/catch (which can only catch a *rejection*) couldn't rescue it. Reject
        // everything outstanding and drop the reference so the next call() spawns a fresh Worker instead of
        // continuing to postMessage into a dead one.
        worker.addEventListener("error", (event: ErrorEvent) => {
            const err = new Error(`Local search Worker crashed: ${event.message || "unknown error"}`);
            for (const entry of pending.values()) {
                entry.reject(err);
            }
            pending.clear();
            worker?.terminate();
            worker = undefined;
        });
        // Only a tab with a Worker has connections to close when another tab signs out.
        listenForSignOut();
    }
    return worker;
}

function getChannel(): BroadcastChannel | undefined {
    if (!channel && typeof BroadcastChannel !== "undefined") {
        channel = new BroadcastChannel(SIGN_OUT_CHANNEL);
    }
    return channel;
}

function listenForSignOut(): void {
    getChannel()?.addEventListener("message", (event: MessageEvent<{ type?: string }>) => {
        if (event.data?.type === "sign-out") {
            void closeEverythingInThisTab();
        }
    });
}

/** Another tab signed out: stop every build here and close this tab's connections (which also removes their
 * directories, now that nothing holds them open). Never rejects. */
async function closeEverythingInThisTab(): Promise<void> {
    signedOut = true;
    initializedMailboxes.clear();
    await call("destroyAll", { generation: nextLocalIndexGeneration() } satisfies GenerationParams).catch(() => undefined);
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

export const PENDING_DELETIONS_KEY = "rapidmx-localsearch-pending-deletions";
/** Stands for "every index on this device" in the pending-deletions list - recorded before a sign-out starts,
 * so a navigation that kills it midway still gets finished on the next load. */
const ALL_INDEXES = "*";

function readPendingDeletions(): string[] {
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(PENDING_DELETIONS_KEY) ?? "[]");
        return Array.isArray(parsed) ? parsed.filter((uid): uid is string => typeof uid === "string") : [];
    } catch {
        return [];
    }
}

function writePendingDeletions(uids: Iterable<string>): void {
    try {
        const list = [...new Set(uids)];
        if (list.length === 0) {
            localStorage.removeItem(PENDING_DELETIONS_KEY);
        } else {
            localStorage.setItem(PENDING_DELETIONS_KEY, JSON.stringify(list));
        }
    } catch {
        // Storage blocked - nothing to retry from, the same as before this existed.
    }
}

function updatePendingDeletions(update: (current: Set<string>) => void): void {
    const current = new Set(readPendingDeletions());
    update(current);
    writePendingDeletions(current);
}

let pendingRetry: Promise<void> | undefined;

/** Retries every deletion an earlier page load couldn't finish. Runs once per page load (memoized), before
 * this tab's first `init` - so it never races an index this tab itself opens. Never rejects. */
export function retryPendingLocalIndexDeletions(): Promise<void> {
    pendingRetry ??= (async () => {
        const uids = readPendingDeletions();
        if (uids.length === 0) {
            return;
        }
        const failed: string[] = [];
        if (uids.includes(ALL_INDEXES)) {
            const result = await removeLocalIndexDirectories().catch(() => ({ failed: [ALL_INDEXES] }));
            failed.push(...result.failed);
        } else {
            for (const uid of uids) {
                await removeLocalIndexDirectory(uid).catch(() => failed.push(uid));
            }
        }
        writePendingDeletions(failed);
    })();
    return pendingRetry;
}

export async function initLocalIndex(params: InitParams): Promise<void> {
    await retryPendingLocalIndexDeletions();
    if (signedOut) {
        throw new Error("Signed out - the local search index is unavailable in this tab.");
    }
    await call("init", params);
    initializedMailboxes.add(params.mailboxUid);
}

export function indexLocalEntities(mailboxUid: string, entities: LocalIndexEntity[], generation?: number): Promise<IndexEntitiesResult> {
    return call("indexEntities", { mailboxUid, entities, generation } satisfies IndexEntitiesParams);
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

export function pruneLocalEntities(
    mailboxUid: string,
    keepEntityUids: string[],
    since: string | undefined,
    options: { folderUids?: string[]; generation?: number } = {},
): Promise<number> {
    return call("pruneEntities", { mailboxUid, keepEntityUids, since, ...options } satisfies PruneEntitiesParams);
}

export function searchLocal(mailboxUid: string, parsed: ParsedSearchQuery, limit: number, offset = 0): Promise<LocalSearchPage> {
    return call("search", { mailboxUid, parsed, limit, offset } satisfies SearchParams);
}

export function getLocalCoverage(mailboxUid: string): Promise<Coverage> {
    return call("coverage", mailboxUid);
}

export function setLocalIndexWindow(mailboxUid: string, timeFloorMonths: number, byteBudgetBytes: number, generation?: number): Promise<WindowState> {
    return call("setWindow", { mailboxUid, timeFloorMonths, byteBudgetBytes, generation } satisfies SetWindowParams);
}

export function setLocalIndexBuilding(
    mailboxUid: string,
    building: boolean,
    completion: { complete: boolean; coveredFrom?: string; coveredUntil?: string; generation?: number } = { complete: false },
): Promise<void> {
    return call("setBuilding", { mailboxUid, building, ...completion } satisfies SetBuildingParams);
}

/** Destroys one mailbox's local index (both the SQLite connection and its on-disk OPFS storage) - spec
 * §11 "MUST be destroyed on the same events that destroy private keys." Never rejects (it's called from
 * lifecycle hooks where a failure mustn't block key destruction) but resolves `false` - and logs why -
 * when the index could not be removed, e.g. because another tab still has it open; the deletion is then
 * retried on the next page load. */
export async function destroyLocalIndex(mailboxUid: string): Promise<boolean> {
    updatePendingDeletions((current) => current.add(mailboxUid));
    try {
        await call("destroy", { mailboxUid, generation: nextLocalIndexGeneration() } satisfies DestroyParams);
        updatePendingDeletions((current) => current.delete(mailboxUid));
        return true;
    } catch (err) {
        // `call()` only ever rejects with an Error.
        console.warn(`Could not destroy the local search index for mailbox ${mailboxUid}: ${(err as Error).message}`);
        return false;
    } finally {
        initializedMailboxes.delete(mailboxUid);
    }
}

/** How long sign-out waits for local index destruction before navigating anyway. */
export const DESTROY_ALL_TIMEOUT_MS = 3_000;

/**
 * Destroys **every** local index on this device - not just the mailboxes this page load opened (sign-out
 * from Calendar, say, never opened any), by enumerating OPFS for the index directory prefix - and tells every
 * other tab to close its own connections. Closes this tab's own open connections through the Worker first
 * (only if one was ever spawned - there's nothing to close otherwise, and booting one just to delete files
 * would be waste), then removes the directories. Anything left behind is retried on the next load. Resolves
 * `true` when everything was removed within `timeoutMs`; never rejects.
 */
export async function destroyAllLocalIndexes(timeoutMs = DESTROY_ALL_TIMEOUT_MS): Promise<boolean> {
    signedOut = true;
    writePendingDeletions([ALL_INDEXES]);
    try {
        getChannel()?.postMessage({ type: "sign-out" });
    } catch {
        // A closed/unsupported channel only loses the cross-tab notification.
    }
    const work = (async () => {
        let ok = true;
        if (worker) {
            const { failed } = await call<{ failed: string[] }>("destroyAll", { generation: nextLocalIndexGeneration() } satisfies GenerationParams).catch(() => ({
                failed: ["(worker)"],
            }));
            ok = failed.length === 0;
        }
        initializedMailboxes.clear();
        const { failed } = await removeLocalIndexDirectories();
        writePendingDeletions(failed);
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
