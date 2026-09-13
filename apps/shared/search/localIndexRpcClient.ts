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
 * this module correlates the eventual matching response via a pending-request map - the same shape the
 * `__spike__` validation harness used during development, now the real thing.
 */
import type { ParsedSearchQuery } from "@rapidmx/react-shared/search/queryGrammar.js";
import type {
    Coverage,
    IndexEntitiesParams,
    InitParams,
    LocalIndexRequest,
    LocalIndexResponse,
    LocalSearchPage,
    RemoveEntityParams,
    SearchParams,
    SetBuildingParams,
    SetWindowParams,
} from "./localIndexWorker.js";
import type { LocalIndexEntity } from "./localIndexSchema.js";

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

/** Every mailboxUid `initLocalIndex()` has opened this session, not yet `destroyLocalIndex()`-ed - lets
 * `destroyAllLocalIndexes()` (called from `AppShell.tsx`'s sign-out, which has no mailboxUid of its own
 * to pass - see that call site's own comment) destroy every open index without needing one threaded
 * through. Mirrors `keySession.ts`'s own module-level `sessions` map in spirit - session-scoped,
 * intentionally never persisted. */
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
        getWorker().postMessage({ id, method, params } satisfies LocalIndexRequest);
    });
}

export async function initLocalIndex(params: InitParams): Promise<void> {
    await call("init", params);
    initializedMailboxes.add(params.mailboxUid);
}

export function indexLocalEntities(mailboxUid: string, entities: LocalIndexEntity[]): Promise<void> {
    return call("indexEntities", { mailboxUid, entities } satisfies IndexEntitiesParams);
}

export function removeLocalEntity(mailboxUid: string, entityUid: string): Promise<void> {
    return call("removeEntity", { mailboxUid, entityUid } satisfies RemoveEntityParams);
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

export function setLocalIndexBuilding(mailboxUid: string, building: boolean): Promise<void> {
    return call("setBuilding", { mailboxUid, building } satisfies SetBuildingParams);
}

/** Destroys one mailbox's local index (both the SQLite connection and its on-disk OPFS storage) - spec
 * §11 "MUST be destroyed on the same events that destroy private keys." Never throws: called from
 * lifecycle hooks (idle timeout, logout, the manual "destroy keys now" button) where a destroy failure
 * shouldn't block the key-destruction it's piggybacking on. */
export async function destroyLocalIndex(mailboxUid: string): Promise<void> {
    try {
        await call("destroy", mailboxUid);
    } catch {
        // Best-effort - see this function's own doc comment.
    } finally {
        initializedMailboxes.delete(mailboxUid);
    }
}

/** Destroys every mailbox's local index this session has opened - for a caller (`AppShell.tsx`'s
 * sign-out) that has no specific mailboxUid of its own, the same "clear everything" shape
 * `destroyUnlockedKeys()` itself offers when called with no argument. */
export async function destroyAllLocalIndexes(): Promise<void> {
    await Promise.all([...initializedMailboxes].map((mailboxUid) => destroyLocalIndex(mailboxUid)));
}
