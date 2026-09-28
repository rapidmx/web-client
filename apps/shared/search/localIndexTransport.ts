///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The Tier 2 local index's transport contract - every operation `localIndexRpcClient.ts`'s public functions perform
 * against whatever actually stores and queries the index. Type-only: this module declares the shape, it never runs
 * anything itself.
 *
 * The browser/Electron path is backed by `workerLocalIndexTransport` (`localIndexRpcClient.ts`, exported from that
 * same file) - a Promise/RPC wrapper around a Worker running `@journeyapps/wa-sqlite` over OPFS. That module's own
 * doc comment covers the Worker/RPC mechanics this interface abstracts away (generations, cross-tab sign-out,
 * retried deletions, Worker-crash recovery); none of that is part of this contract - it is that transport's own
 * implementation detail, not something a second implementation needs to reproduce.
 *
 * A host app with no Worker/OPFS/WASM at all - `tauri-client`, backed instead by real SQLCipher-encrypted SQLite
 * via a Rust `rusqlite` `invoke()` command - implements this same shape and installs it once at startup via
 * `localIndexRpcClient.ts`'s `setLocalIndexTransport()`. Every call site already going through that file's exported
 * functions (`searchTier2.ts`, `LocalIndexLifecycle.tsx`, `localIndexBuilder.ts`, and the rest) then runs against
 * the native backend instead, unmodified - those exports are thin delegators to whichever transport is current.
 *
 * Method names mirror the Worker's own RPC method names (`localIndexWorker.ts`'s `LocalIndexRequest["method"]`),
 * not `localIndexRpcClient.ts`'s public function names - a second implementation has no reason to repeat that
 * file's "Local"-infixed naming (`indexLocalEntities`, `getLocalCoverage`, ...) for its own methods.
 *
 * Every method takes exactly the arguments its `localIndexRpcClient.ts` counterpart already resolves down to -
 * where that file's own export has a default parameter (`offset = 0`, `options = {}`, `timeoutMs = DESTROY_ALL_TIMEOUT_MS`),
 * this interface takes the resolved value as required, so an implementation never has to reproduce that default
 * itself.
 */
import type { ParsedSearchQuery } from "@rapidmx/react-shared/search/queryGrammar.js";
import type { Coverage, IndexEntitiesResult, InitParams, LocalSearchPage, WindowState } from "./localIndexWorker.js";
import type { LocalIndexEntity } from "./localIndexSchema.js";

/** `LocalIndexTransport.pruneEntities()`'s options - which folders' unseen rows may be pruned (see
 * `localIndexBuilder.ts`'s own "reliable" folders), and this pass's generation tag. */
export interface PruneLocalEntitiesOptions {
    folderUids?: string[];
    generation?: number;
}

/** `LocalIndexTransport.setBuilding()`'s completion summary - whether a build pass just finished, and how much of
 * the mailbox it covered (`Coverage.complete`/`coveredFrom`/`coveredUntil`'s own source). */
export interface SetLocalIndexBuildingCompletion {
    complete: boolean;
    coveredFrom?: string;
    coveredUntil?: string;
    generation?: number;
}

/** See this module's own doc comment. */
export interface LocalIndexTransport {
    /** A fresh, monotonic generation from this transport's own counter. */
    nextGeneration(): number;
    /** Opens (or reuses) this mailbox's index connection. */
    init(params: InitParams): Promise<void>;
    /** Indexes (inserts or updates) the given entities, applying byte-budget eviction as needed. */
    indexEntities(mailboxUid: string, entities: LocalIndexEntity[], generation?: number): Promise<IndexEntitiesResult>;
    /** Drops one indexed entity. */
    removeEntity(mailboxUid: string, entityUid: string): Promise<void>;
    /** Re-points one indexed entity at its new folder. */
    moveEntity(mailboxUid: string, entityUid: string, folderUid: string): Promise<void>;
    /** The indexed version marker (`Message.version` + folder) currently stored for each of the given entity uids. */
    indexedVersions(mailboxUid: string, entityUids: string[]): Promise<Record<string, string>>;
    /** Removes indexed rows outside `keepEntityUids` (and `since`/`options.folderUids`'s own scope). Returns how many rows were pruned. */
    pruneEntities(mailboxUid: string, keepEntityUids: string[], since: string | undefined, options: PruneLocalEntitiesOptions): Promise<number>;
    /** Runs a parsed query against the index, already scored and paginated. */
    search(mailboxUid: string, parsed: ParsedSearchQuery, limit: number, offset: number): Promise<LocalSearchPage>;
    /** How much of the mailbox the index currently covers. */
    coverage(mailboxUid: string): Promise<Coverage>;
    /** Sets this mailbox's window (time floor + byte budget), applying eviction immediately if it shrank. */
    setWindow(mailboxUid: string, timeFloorMonths: number, byteBudgetBytes: number, generation?: number): Promise<WindowState>;
    /** Flags whether a build pass is running, and - once it finishes - how much of the mailbox it covered. */
    setBuilding(mailboxUid: string, building: boolean, completion: SetLocalIndexBuildingCompletion): Promise<void>;
    /** Destroys one mailbox's index. Never rejects; resolves `false` (logging why) when it could not be removed. */
    destroy(mailboxUid: string): Promise<boolean>;
    /** Destroys every index this transport knows of, e.g. on sign-out. Never rejects; resolves `true` only if
     * everything was removed within `timeoutMs`. */
    destroyAll(timeoutMs: number): Promise<boolean>;
    /** Removes indexes for mailboxes outside `accessibleMailboxUids`. Never rejects. */
    pruneInaccessible(accessibleMailboxUids: Iterable<string>): Promise<void>;
    /** Retries any deletion an earlier session couldn't finish. Never rejects. */
    retryPendingDeletions(): Promise<void>;
}
