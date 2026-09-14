///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The Tier 2 local search index's Worker entry point (`specs/search.md` §13) - runs a WASM SQLite build
 * (`@journeyapps/wa-sqlite`) over `EncryptingVFS` (`localIndexVFS.ts`), an OPFS-backed, AES-256-GCM
 * page-encrypting VFS. Must live in a Worker: OPFS synchronous access handles (what the inner
 * `AccessHandlePoolVFS` - the "SAH Pool VFS" the spec names - uses) are only available off the UI
 * thread, which also satisfies the spec's "indexing MUST NOT run on the UI thread" requirement for free.
 *
 * Boots the **Asyncify** build (`dist/wa-sqlite-async.mjs`), not the plain synchronous one - required
 * because `EncryptingVFS`'s `jRead`/`jWrite` are genuinely async (WebCrypto has no synchronous form) -
 * see that file's own doc comment for why this doesn't conflict with `AccessHandlePoolVFS` itself being
 * synchronous underneath it.
 *
 * **Every operation on a mailbox's connection runs through that mailbox's own serial queue**
 * (`runExclusive()`). An Asyncify module is not re-entrant: starting a second `sqlite3.*` call while
 * another is suspended inside an async VFS method corrupts the unwinding state. `postMessage` requests
 * arrive concurrently (e.g. `searchTier2.ts` issues `search` and `coverage` together, while a build pass
 * is mid-`indexEntities`), so without the queue they interleaved inside the same module. It also closes
 * an `init` race where two concurrent `init`s both saw no connection and created two VFS instances over
 * one OPFS pool. Each mailbox gets its own module instance, so separate mailboxes don't need to share
 * one queue.
 *
 * One SQLite connection per mailbox, opened on `init` and kept for the Worker's lifetime (or until
 * `destroy`). A Web Lock per mailbox (`navigator.locks`) ensures only one tab holds a given index open;
 * a second tab's `init` fails with a logged reason and Tier 2 simply contributes nothing there.
 *
 * `entity_uid` is this module's identifier for a message (the only entity type Tier 2 covers today).
 */
import SQLiteESMFactory from "@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs";
import * as SQLite from "@journeyapps/wa-sqlite";
import type { ParsedSearchQuery } from "@rapidmx/react-shared/search/queryGrammar.js";
import { EncryptingVFS } from "./localIndexVFS.js";
import { listLocalIndexMailboxUids, poolNameFor, removeLocalIndexDirectory } from "./localIndexStorage.js";
import {
    BM25_WEIGHTS_SQL,
    CREATE_SCHEMA_SQL,
    SCHEMA_VERSION,
    UPSERT_ENTITY_SQL,
    LocalIndexEntity,
    buildMatchExpression,
    buildSearchPredicates,
    entityBindValues,
} from "./localIndexSchema.js";

/** One request sent from the main thread. `id` correlates the eventual response - `postMessage` has no
 * native request/response pairing, so every RPC call carries its own id (see `localIndexRpcClient.ts`,
 * the main-thread counterpart that generates/awaits these). */
export interface LocalIndexRequest {
    id: number;
    method:
        | "init"
        | "indexEntities"
        | "removeEntity"
        | "moveEntity"
        | "indexedVersions"
        | "pruneEntities"
        | "search"
        | "coverage"
        | "setWindow"
        | "setBuilding"
        | "destroy"
        | "destroyAll"
        | "selfTest"
        | "ping";
    params?: unknown;
}

export type LocalIndexResponse =
    | { id: number; ok: true; result: unknown }
    | { id: number; ok: false; error: string };

/**
 * Carried by every call a build pass makes (`init`, `setWindow`, `setBuilding`, `indexEntities`,
 * `pruneEntities`). Generations come from one monotonic counter on the main thread
 * (`localIndexRpcClient.ts`), shared with `destroy`/`destroyAll`: a call whose generation is older than the
 * last destroy of its mailbox is rejected (`StaleGenerationError`), so a build started before a lock/sign-out
 * can't recreate the index with its captured keys or write into a rebuild that started after it. Calls
 * without a generation (search, coverage, in-session moves) are never rejected.
 */
export interface GenerationParams {
    generation?: number;
}

export interface InitParams extends GenerationParams {
    mailboxUid: string;
    /** The mailbox's already-derived local-index key (`localIndexKey.ts`'s `deriveLocalIndexKey()`) -
     * this Worker never touches the master key itself, only this one purpose-derived value, matching
     * every other MK-derived-key boundary already established elsewhere in this codebase. */
    indexKey: Uint8Array;
}

export interface IndexEntitiesParams extends GenerationParams {
    mailboxUid: string;
    entities: LocalIndexEntity[];
}

export interface IndexEntitiesResult {
    /** `true` when this call's eviction pass had to delete anything to get back under the byte budget. */
    budgetReached: boolean;
    /** The eviction watermark after this call - see `WindowState.evictedBefore`. */
    evictedBefore?: string;
}

export interface WindowState {
    /** Set once the byte budget has forced an eviction: messages dated strictly before this were evicted (or
     * would be, on insert), so a build pass neither re-fetches them nor walks past them. Cleared by
     * `setWindow` once the index has comfortably shrunk back under budget (or the budget was raised). */
    evictedBefore?: string;
}

export interface DestroyParams extends GenerationParams {
    mailboxUid: string;
}

export interface RemoveEntityParams {
    mailboxUid: string;
    entityUid: string;
}

export interface MoveEntityParams {
    mailboxUid: string;
    entityUid: string;
    folderUid: string;
}

export interface IndexedVersionsParams {
    mailboxUid: string;
    entityUids: string[];
}

export interface PruneEntitiesParams extends GenerationParams {
    mailboxUid: string;
    /** Every entity uid a build pass saw on the server. */
    keepEntityUids: string[];
    /** Only rows at or after this `date_for_sort` are candidates (the walk's own time floor - anything
     * older was never re-listed, so its absence proves nothing). `undefined` means no floor. */
    since?: string;
    /** Only rows currently filed in one of these folders are candidates - folders whose listing was reliable
     * for the whole walk. `undefined` means every folder. */
    folderUids?: string[];
}

export interface SearchParams {
    mailboxUid: string;
    parsed: ParsedSearchQuery;
    limit: number;
    /** How many matches to skip before returning `limit` more - §8's composite pagination cursor's own
     * "the local index position consumed so far" component, threaded straight through to SQL `OFFSET`.
     * Defaults to `0` for a first page. */
    offset?: number;
}

export interface LocalSearchHit {
    entityUid: string;
    /** Raw `bm25()` score - more negative is a better match, per SQLite's own convention. Normalized by
     * `searchTier2.ts` (main thread) before merging (spec §7). */
    score: number;
    snippet?: string;
}

export interface LocalSearchPage {
    hits: LocalSearchHit[];
    /** `true` when at least one more match exists beyond this page - detected by fetching `limit + 1`
     * rows and trimming the extra one, rather than a separate `COUNT(*)` query. */
    hasMore: boolean;
}

export interface Coverage {
    /** The oldest date the index is known to cover. While `complete`, every indexable message at least
     * this recent is present; otherwise it is only the oldest row that happens to be present. `undefined`
     * for an empty index. */
    indexedFrom?: string;
    indexedCount: number;
    building: boolean;
    /** `true` only once a build pass *in this connection's lifetime* has walked every mail folder all the
     * way back to its time floor with no errors and no budget cut-off - reset whenever the index is opened,
     * so a completion persisted by an earlier session never counts. Callers MUST NOT treat `indexedFrom` as
     * a coverage guarantee (e.g. to narrow Tier 3) unless this is `true` and `building` is `false`. */
    complete: boolean;
    /** Only set while `complete`: the guarantee ends here. Nothing indexes mail that arrives after a pass
     * started, so everything dated after this (ISO) is NOT covered and must still be searched elsewhere. */
    indexedUntil?: string;
}

export interface SetWindowParams extends GenerationParams {
    mailboxUid: string;
    timeFloorMonths: number;
    byteBudgetBytes: number;
}

export interface SetBuildingParams extends GenerationParams {
    mailboxUid: string;
    building: boolean;
    /** Only meaningful with `building: false` - whether the pass that just ended walked everything. */
    complete?: boolean;
    /** Only meaningful with `complete: true` - the pass's time floor (ISO), or `undefined` for none. */
    coveredFrom?: string;
    /** Only meaningful with `complete: true` - when the pass started (ISO, minus a clock-skew margin). */
    coveredUntil?: string;
}

interface OpenConnection {
    sqlite3: SQLiteAPI;
    db: number;
    vfs: EncryptingVFS;
    /** Kept so a corrupted index can be reopened empty without another round trip to the main thread. */
    params: InitParams;
    releaseLock?: () => void;
}

/** Keyed by `mailboxUid` - a Worker instance is per-tab, not per-mailbox. */
const connections = new Map<string, OpenConnection>();

/** Per-mailbox promise chains - see this module's doc comment. Each value never rejects. */
const queues = new Map<string, Promise<void>>();

/** Runs `task` after every previously queued task for `mailboxUid` has settled. Exported for tests. */
export function runExclusive<T>(mailboxUid: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(mailboxUid) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
        () => undefined,
        () => undefined,
    );
    queues.set(mailboxUid, tail);
    void tail.then(() => {
        if (queues.get(mailboxUid) === tail) {
            queues.delete(mailboxUid);
        }
    });
    return result;
}

/** Generation of the most recent `destroy` per mailbox, and of the most recent `destroyAll`. */
const destroyedGenerations = new Map<string, number>();
let destroyedAllGeneration = 0;

/** Rejects a build-pass call issued before its mailbox's index was last destroyed. */
export class StaleGenerationError extends Error {
    constructor(mailboxUid: string) {
        super(`Local search index for mailbox ${mailboxUid} was destroyed after this build started.`);
        this.name = "StaleGenerationError";
    }
}

function assertCurrentGeneration(mailboxUid: string, generation: number | undefined): void {
    if (generation === undefined) {
        return;
    }
    if (generation < Math.max(destroyedGenerations.get(mailboxUid) ?? 0, destroyedAllGeneration)) {
        throw new StaleGenerationError(mailboxUid);
    }
}

function recordDestroyGeneration(mailboxUid: string | undefined, generation: number | undefined): void {
    if (generation === undefined) {
        return;
    }
    if (mailboxUid === undefined) {
        destroyedAllGeneration = Math.max(destroyedAllGeneration, generation);
    } else {
        destroyedGenerations.set(mailboxUid, Math.max(destroyedGenerations.get(mailboxUid) ?? 0, generation));
    }
}

/** Thrown by `init` when another tab already holds this mailbox's index open. */
export class LocalIndexBusyError extends Error {
    constructor(mailboxUid: string) {
        super(`Local search index for mailbox ${mailboxUid} is already open in another tab.`);
        this.name = "LocalIndexBusyError";
    }
}

/**
 * Takes an exclusive, non-waiting Web Lock for one mailbox's index and holds it until the returned release
 * function is called. `undefined` when the Web Locks API isn't available - `AccessHandlePoolVFS`'s own
 * exclusive sync access handles still stop a second tab from opening the pool, just with a less specific
 * error.
 */
async function acquireIndexLock(mailboxUid: string): Promise<(() => void) | undefined> {
    const locks = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks) {
        return undefined;
    }
    return new Promise<() => void>((resolve, reject) => {
        locks
            .request(`${poolNameFor(mailboxUid)}:lock`, { ifAvailable: true }, (lock) => {
                if (!lock) {
                    reject(new LocalIndexBusyError(mailboxUid));
                    return undefined;
                }
                return new Promise<void>((release) => resolve(release));
            })
            .catch(reject);
    });
}

/** Wraps a failure to even open the database because its pages don't decrypt/authenticate. */
class LocalIndexCorruptedError extends Error {
    constructor(cause: unknown) {
        super(`Local search index is corrupted: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.name = "LocalIndexCorruptedError";
    }
}

/** SQLite's own exact messages for `SQLITE_CORRUPT`/`SQLITE_NOTADB`, for an error that lost its code. Anchored
 * on both ends: an FTS5 error echoes the user's query text back (e.g. `no such column: malformed`), and a
 * loose substring match on that used to wipe the whole index. */
const CORRUPTION_MESSAGE = /^(database disk image is malformed|file is not a database)$/i;

/** A real corruption signal (discard and rebuild) versus an ordinary error (e.g. a malformed MATCH). */
function isCorruptionError(err: unknown, connection: OpenConnection | undefined): boolean {
    if (err instanceof LocalIndexCorruptedError || connection?.vfs.corruptionDetected) {
        return true;
    }
    const code = (err as { code?: number } | undefined)?.code;
    if (code === SQLite.SQLITE_CORRUPT || code === SQLite.SQLITE_NOTADB) {
        return true;
    }
    return err instanceof Error && CORRUPTION_MESSAGE.test(err.message);
}

async function openRawConnection(params: InitParams): Promise<OpenConnection> {
    const { mailboxUid, indexKey } = params;
    const module = await SQLiteESMFactory();
    const sqlite3 = SQLite.Factory(module);
    const vfs = await EncryptingVFS.create(poolNameFor(mailboxUid), module, indexKey);
    sqlite3.vfs_register(vfs, true);
    let db: number | undefined;
    try {
        db = await sqlite3.open_v2("index.db");
        // No WAL, no rollback journal - see localIndexVFS.ts's own doc comment on why this index's lack of
        // a durability requirement makes that an acceptable, deliberate simplification here.
        await sqlite3.exec(db, "PRAGMA journal_mode=OFF;");
    } catch (err) {
        // Opening reads the header page, so a wrong key or a corrupted first block fails right here.
        if (db !== undefined) {
            await sqlite3.close(db).catch(() => undefined);
        }
        await vfs.close();
        throw vfs.corruptionDetected ? new LocalIndexCorruptedError(err) : err;
    }
    return { sqlite3, db, vfs, params };
}

async function closeRawConnection(connection: OpenConnection): Promise<void> {
    try {
        await connection.sqlite3.close(connection.db);
    } finally {
        await connection.vfs.close();
    }
}

async function queryValue<T>(connection: OpenConnection, sql: string, bindings: (string | number)[] = []): Promise<T | undefined> {
    let value: T | undefined;
    for await (const stmt of connection.sqlite3.statements(connection.db, sql)) {
        if (bindings.length > 0) {
            connection.sqlite3.bind_collection(stmt, bindings);
        }
        if ((await connection.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
            value = (connection.sqlite3.column(stmt, 0) as T | null) ?? undefined;
        }
    }
    return value;
}

/** Creates the schema on a brand-new database, or validates an existing one. Resolves `false` when an
 * existing database was built under a different `SCHEMA_VERSION` and must be discarded (§11
 * "Invalidation... on schema version change"). */
async function initializeSchema(connection: OpenConnection): Promise<boolean> {
    const hasMeta = await queryValue<number>(connection, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'meta'");
    if (hasMeta) {
        return (await readMeta(connection, "schema_version")) === String(SCHEMA_VERSION);
    }
    // Both pragmas only take effect before the first table exists, which is why a schema-version bump
    // recreates the whole file rather than just clearing rows.
    await connection.sqlite3.exec(connection.db, "PRAGMA page_size=4096; PRAGMA auto_vacuum=INCREMENTAL;");
    await connection.sqlite3.exec(connection.db, CREATE_SCHEMA_SQL);
    await writeMeta(connection, "schema_version", String(SCHEMA_VERSION));
    return true;
}

/** Opens a just-discarded (empty) index and creates its schema - closing the connection again if the schema
 * step fails, so its OPFS access handles aren't leaked for the rest of the Worker's life. */
async function openFreshConnection(params: InitParams): Promise<OpenConnection> {
    const connection = await openRawConnection(params);
    try {
        await initializeSchema(connection);
    } catch (err) {
        await closeRawConnection(connection).catch(() => undefined);
        throw err;
    }
    return connection;
}

async function openConnection(params: InitParams): Promise<OpenConnection> {
    const releaseLock = await acquireIndexLock(params.mailboxUid);
    try {
        let connection: OpenConnection | undefined;
        let usable: boolean;
        try {
            connection = await openRawConnection(params);
            usable = await initializeSchema(connection);
        } catch (err) {
            if (connection) {
                await closeRawConnection(connection).catch(() => undefined);
            }
            if (!isCorruptionError(err, connection)) {
                throw err;
            }
            connection = undefined;
            usable = false;
        }
        if (!usable || !connection) {
            // Corrupted (GCM auth failure, "malformed"/"not a database") or an old schema version: discard
            // the whole database and start empty - the builder repopulates it (§11 "discarded and rebuilt").
            if (connection) {
                await closeRawConnection(connection).catch(() => undefined);
            }
            await removeLocalIndexDirectory(params.mailboxUid);
            connection = await openFreshConnection(params);
        }
        connection.releaseLock = releaseLock;
        return connection;
    } catch (err) {
        releaseLock?.();
        throw err;
    }
}

async function readMeta(connection: OpenConnection, key: string): Promise<string | undefined> {
    return queryValue<string>(connection, "SELECT value FROM meta WHERE key = ?", [key]);
}

async function writeMeta(connection: OpenConnection, key: string, value: string): Promise<void> {
    for await (const stmt of connection.sqlite3.statements(connection.db, "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")) {
        connection.sqlite3.bind_collection(stmt, [key, value]);
        await connection.sqlite3.step(stmt);
    }
}

async function init(params: InitParams): Promise<void> {
    assertCurrentGeneration(params.mailboxUid, params.generation);
    if (connections.has(params.mailboxUid)) {
        return;
    }
    try {
        const connection = await openConnection(params);
        try {
            // A completion (or an in-progress flag) persisted by an earlier session proves nothing about mail
            // that arrived since - only a pass that finishes while this connection is open may narrow Tier 3.
            await clearBuildState(connection);
        } catch (err) {
            await closeRawConnection(connection).catch(() => undefined);
            connection.releaseLock?.();
            throw err;
        }
        connections.set(params.mailboxUid, connection);
    } catch (err) {
        // Tier 2 degrades to "contributes nothing" in this tab - say why, once per attempt, rather than
        // leaving a silently empty local tier.
        console.warn(`localIndexWorker: local search unavailable for mailbox ${params.mailboxUid}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
    }
}

function requireConnection(mailboxUid: string): OpenConnection {
    const connection = connections.get(mailboxUid);
    if (!connection) {
        throw new Error(`localIndexWorker: init() was never called for mailbox ${mailboxUid}`);
    }
    return connection;
}

/** Tears down a mailbox's connection completely: the SQLite connection, the underlying VFS's pooled
 * access handles (see `EncryptingVFS.close()`), and the cross-tab Web Lock. */
async function closeConnection(mailboxUid: string): Promise<void> {
    const connection = connections.get(mailboxUid);
    if (!connection) {
        return;
    }
    connections.delete(mailboxUid);
    try {
        await closeRawConnection(connection);
    } finally {
        connection.releaseLock?.();
    }
}

/**
 * Runs `operation` against a mailbox's open connection. If it fails because the index is corrupted, the
 * index is destroyed and reopened empty (same key, same lock) so the next build pass repopulates it, and
 * the original error is rethrown - the caller's own degradation (e.g. `search()` returning no hits) still
 * applies to this one call.
 */
async function withConnection<T>(mailboxUid: string, operation: (connection: OpenConnection) => Promise<T>): Promise<T> {
    const connection = requireConnection(mailboxUid);
    try {
        return await operation(connection);
    } catch (err) {
        if (isCorruptionError(err, connection) && connections.get(mailboxUid) === connection) {
            await resetCorruptedConnection(mailboxUid, connection);
        }
        throw err;
    }
}

/** `withConnection()` for a build-pass call - rejected first if the call's generation is stale. */
async function withCurrentConnection<T>(params: GenerationParams & { mailboxUid: string }, operation: (connection: OpenConnection) => Promise<T>): Promise<T> {
    assertCurrentGeneration(params.mailboxUid, params.generation);
    return withConnection(params.mailboxUid, operation);
}

/** Discards a corrupted index and reopens it empty under the same key and Web Lock. If reopening fails,
 * the mailbox is left uninitialized (lock released) - the next `init()` tries again from scratch. */
async function resetCorruptedConnection(mailboxUid: string, connection: OpenConnection): Promise<void> {
    console.warn(`localIndexWorker: local search index for mailbox ${mailboxUid} is corrupted; discarding and rebuilding.`);
    connections.delete(mailboxUid);
    await closeRawConnection(connection).catch(() => undefined);
    try {
        await removeLocalIndexDirectory(mailboxUid);
        const fresh = await openFreshConnection(connection.params);
        fresh.releaseLock = connection.releaseLock;
        connections.set(mailboxUid, fresh);
    } catch {
        connection.releaseLock?.();
    }
}

/** Bytes actually used by live pages - `page_count` minus free pages, times `page_size`. Counts the FTS5
 * shadow tables and indexes too, unlike summing a per-row estimate. */
async function usedBytes(connection: OpenConnection): Promise<number> {
    const pageCount = (await queryValue<number>(connection, "PRAGMA page_count")) ?? 0;
    const freelist = (await queryValue<number>(connection, "PRAGMA freelist_count")) ?? 0;
    const pageSize = (await queryValue<number>(connection, "PRAGMA page_size")) ?? 4096;
    return (pageCount - freelist) * pageSize;
}

/** Physical database size (what OPFS actually stores) - exported via `coverage()` for diagnostics/tests. */
async function fileBytes(connection: OpenConnection): Promise<number> {
    const pageCount = (await queryValue<number>(connection, "PRAGMA page_count")) ?? 0;
    const pageSize = (await queryValue<number>(connection, "PRAGMA page_size")) ?? 4096;
    return pageCount * pageSize;
}

/** Maximum bulk-eviction rounds per call - each round deletes a whole date range sized from the measured
 * overshoot, so more than a couple only happens when the per-row weights badly underestimate real size. */
const MAX_EVICTION_ROUNDS = 8;

/**
 * Oldest-first eviction against the configured byte budget (spec §11). Measures the real database size,
 * then deletes a contiguous oldest date range in one statement, sized by walking rows oldest-first with a
 * running total of their `byte_size` weights scaled to the measured size - rather than the previous
 * delete-one-row-then-re-SUM loop, which was O(n²). `incremental_vacuum` then returns freed pages to the
 * filesystem. A no-op when no budget has been configured yet. Resolves whether anything was evicted.
 */
async function applyEviction(connection: OpenConnection): Promise<boolean> {
    const byteBudgetRaw = await readMeta(connection, "byte_budget");
    const byteBudget = byteBudgetRaw ? Number(byteBudgetRaw) : undefined;
    if (!byteBudget) {
        return false;
    }
    // The newest cutoff actually deleted up to; `undefined` while nothing has been evicted.
    let watermark: string | undefined;
    for (let round = 0; round < MAX_EVICTION_ROUNDS; round++) {
        const used = await usedBytes(connection);
        if (used <= byteBudget) {
            break;
        }
        const totalWeight = (await queryValue<number>(connection, "SELECT COALESCE(SUM(byte_size), 0) FROM entities")) ?? 0;
        if (totalWeight <= 0) {
            break;
        }
        const overshootWeight = ((used - byteBudget) / used) * totalWeight;
        let running = 0;
        let cutoffRowid: number | undefined;
        let cutoffDate: string | undefined;
        for await (const stmt of connection.sqlite3.statements(
            connection.db,
            "SELECT date_for_sort, rowid, byte_size FROM entities ORDER BY date_for_sort ASC, rowid ASC",
        )) {
            while ((await connection.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
                cutoffDate = connection.sqlite3.column(stmt, 0) as string;
                cutoffRowid = connection.sqlite3.column(stmt, 1) as number;
                running += connection.sqlite3.column(stmt, 2) as number;
                if (running >= overshootWeight) {
                    break;
                }
            }
        }
        if (cutoffDate === undefined || cutoffRowid === undefined) {
            break;
        }
        for await (const stmt of connection.sqlite3.statements(
            connection.db,
            "DELETE FROM entities WHERE date_for_sort < ? OR (date_for_sort = ? AND rowid <= ?)",
        )) {
            connection.sqlite3.bind_collection(stmt, [cutoffDate, cutoffDate, cutoffRowid]);
            await connection.sqlite3.step(stmt);
        }
        // The cutoff row was just read, so this always deleted at least that row.
        watermark = cutoffDate;
    }
    if (watermark !== undefined) {
        // Rows at exactly `watermark` may be partly evicted (the rowid tiebreaker), so only strictly older
        // messages are treated as out of the window. Never moves backwards while at budget.
        const previous = await readMeta(connection, "evicted_before");
        if (!previous || watermark > previous) {
            await writeMeta(connection, "evicted_before", watermark);
        }
        await connection.sqlite3.exec(connection.db, "PRAGMA incremental_vacuum;");
    }
    return watermark !== undefined;
}

async function indexEntities(connection: OpenConnection, entities: LocalIndexEntity[]): Promise<IndexEntitiesResult> {
    for (const entity of entities) {
        for await (const stmt of connection.sqlite3.statements(connection.db, UPSERT_ENTITY_SQL)) {
            connection.sqlite3.bind_collection(stmt, entityBindValues(entity));
            await connection.sqlite3.step(stmt);
        }
    }
    const budgetReached = await applyEviction(connection);
    return { budgetReached, ...(await readWindowState(connection)) };
}

async function removeEntity(connection: OpenConnection, entityUid: string): Promise<void> {
    for await (const stmt of connection.sqlite3.statements(connection.db, "DELETE FROM entities WHERE entity_uid = ?")) {
        connection.sqlite3.bind_collection(stmt, [entityUid]);
        await connection.sqlite3.step(stmt);
    }
}

/** Re-points an indexed message at a new folder in place (archive, cancel-scheduled-send). Clears
 * `entity_version` so the next build pass re-validates the row against the server. */
async function moveEntity(connection: OpenConnection, entityUid: string, folderUid: string): Promise<void> {
    for await (const stmt of connection.sqlite3.statements(connection.db, "UPDATE entities SET folder_uid = ?, entity_version = NULL WHERE entity_uid = ?")) {
        connection.sqlite3.bind_collection(stmt, [folderUid, entityUid]);
        await connection.sqlite3.step(stmt);
    }
}

/** `entity_version` for whichever of `entityUids` are already indexed - one batched query per builder page,
 * so a rebuild can skip re-fetching/decrypting unchanged messages. */
async function indexedVersions(connection: OpenConnection, entityUids: string[]): Promise<Record<string, string>> {
    const versions: Record<string, string> = {};
    if (entityUids.length === 0) {
        return versions;
    }
    const placeholders = entityUids.map(() => "?").join(", ");
    for await (const stmt of connection.sqlite3.statements(
        connection.db,
        `SELECT entity_uid, entity_version FROM entities WHERE entity_uid IN (${placeholders})`,
    )) {
        connection.sqlite3.bind_collection(stmt, entityUids);
        while ((await connection.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
            const version = connection.sqlite3.column(stmt, 1) as string | null;
            if (version !== null) {
                versions[connection.sqlite3.column(stmt, 0) as string] = version;
            }
        }
    }
    return versions;
}

/** Deletes rows a complete build pass didn't see (deleted, or moved out of every mail folder, on any
 * client) within the pass's own time floor. Resolves how many rows were removed. */
async function pruneEntities(connection: OpenConnection, { keepEntityUids, since, folderUids }: PruneEntitiesParams): Promise<number> {
    const keep = new Set(keepEntityUids);
    const folders = folderUids ? new Set(folderUids) : undefined;
    const stale: string[] = [];
    for await (const stmt of connection.sqlite3.statements(
        connection.db,
        since ? "SELECT entity_uid, folder_uid FROM entities WHERE date_for_sort >= ?" : "SELECT entity_uid, folder_uid FROM entities",
    )) {
        if (since) {
            connection.sqlite3.bind_collection(stmt, [since]);
        }
        while ((await connection.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
            const uid = connection.sqlite3.column(stmt, 0) as string;
            const folderUid = connection.sqlite3.column(stmt, 1) as string;
            if (!keep.has(uid) && (!folders || folders.has(folderUid))) {
                stale.push(uid);
            }
        }
    }
    for (const uid of stale) {
        await removeEntity(connection, uid);
    }
    if (stale.length > 0) {
        await connection.sqlite3.exec(connection.db, "PRAGMA incremental_vacuum;");
    }
    return stale.length;
}

async function search(connection: OpenConnection, { mailboxUid, parsed, limit, offset = 0 }: SearchParams): Promise<LocalSearchPage> {
    const { where, params } = buildSearchPredicates(parsed, mailboxUid);
    const matchExpr = buildMatchExpression(parsed);
    const hits: LocalSearchHit[] = [];

    // A malformed MATCH string is a real, reachable case (FTS5's query syntax rejects some inputs the
    // server's more lenient parser accepts) - fails soft to "this tier found nothing". Corruption is the
    // one failure rethrown, so `withConnection()` can discard and rebuild the index.
    try {
        // Fetches one extra row beyond `limit` so `hasMore` can be determined without a COUNT(*). The
        // `entity_uid` tiebreaker makes the ordering total, so OFFSET pages never overlap or skip rows
        // that share a rank/date.
        const fetchLimit = limit + 1;
        const sql = matchExpr
            ? `SELECT e.entity_uid, bm25(entities_fts, ${BM25_WEIGHTS_SQL}) AS rank,
                      snippet(entities_fts, 2, '', '', '…', 24) AS snip
               FROM entities_fts f JOIN entities e ON e.rowid = f.rowid
               WHERE entities_fts MATCH ? AND ${where}
               ORDER BY rank, e.entity_uid LIMIT ? OFFSET ?`
            : `SELECT e.entity_uid, 0 AS rank, NULL AS snip FROM entities e WHERE ${where}
               ORDER BY e.date_for_sort DESC, e.entity_uid LIMIT ? OFFSET ?`;
        const bindings = matchExpr ? [matchExpr, ...params, fetchLimit, offset] : [...params, fetchLimit, offset];
        for await (const stmt of connection.sqlite3.statements(connection.db, sql)) {
            connection.sqlite3.bind_collection(stmt, bindings);
            while ((await connection.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
                hits.push({
                    entityUid: connection.sqlite3.column(stmt, 0) as string,
                    score: connection.sqlite3.column(stmt, 1) as number,
                    snippet: (connection.sqlite3.column(stmt, 2) as string | null) ?? undefined,
                });
            }
        }
    } catch (err) {
        if (isCorruptionError(err, connection)) {
            throw err;
        }
        return { hits: [], hasMore: false };
    }
    const hasMore = hits.length > limit;
    if (hasMore) {
        hits.length = limit;
    }
    return { hits, hasMore };
}

async function coverage(connection: OpenConnection): Promise<Coverage & { fileBytes: number }> {
    const oldest = await queryValue<string>(connection, "SELECT MIN(date_for_sort) FROM entities");
    const complete = (await readMeta(connection, "build_complete")) === "1";
    const coveredFrom = await readMeta(connection, "covered_from");
    // A complete pass walked every folder back to its time floor, but a folder's last page can reach
    // further back than another folder's did - so the guaranteed frontier is the later of the two.
    const indexedFrom = complete && oldest && coveredFrom && coveredFrom > oldest ? coveredFrom : oldest;
    const coveredUntil = await readMeta(connection, "covered_until");
    return {
        indexedFrom,
        indexedCount: (await queryValue<number>(connection, "SELECT COUNT(*) FROM entities")) ?? 0,
        building: (await readMeta(connection, "building")) === "1",
        complete,
        indexedUntil: complete && coveredUntil ? coveredUntil : undefined,
        fileBytes: await fileBytes(connection),
    };
}

/** Below this fraction of the budget, the eviction watermark is dropped so older mail can come back in -
 * the gap between it and 1.0 keeps a pass from evicting and re-fetching the same boundary every time. */
const WATERMARK_RESET_FRACTION = 0.9;

async function readWindowState(connection: OpenConnection): Promise<WindowState> {
    return { evictedBefore: (await readMeta(connection, "evicted_before")) || undefined };
}

async function setWindow(connection: OpenConnection, { timeFloorMonths, byteBudgetBytes }: SetWindowParams): Promise<WindowState> {
    await writeMeta(connection, "time_floor_months", String(timeFloorMonths));
    await writeMeta(connection, "byte_budget", String(byteBudgetBytes));
    // A lowered budget must shrink the window immediately, not just gate future inserts (spec §11 "the
    // client MUST reduce the window rather than fail writes when the budget is reached").
    const evicted = await applyEviction(connection);
    if (!evicted && (!byteBudgetBytes || (await usedBytes(connection)) <= byteBudgetBytes * WATERMARK_RESET_FRACTION)) {
        await writeMeta(connection, "evicted_before", "");
    }
    return readWindowState(connection);
}

async function setBuilding(connection: OpenConnection, { building, complete, coveredFrom, coveredUntil }: SetBuildingParams): Promise<void> {
    const done = !building && !!complete;
    await writeMeta(connection, "building", building ? "1" : "0");
    // Starting a pass invalidates the previous pass's completeness until this one finishes.
    await writeMeta(connection, "build_complete", done ? "1" : "0");
    await writeMeta(connection, "covered_from", done && coveredFrom ? coveredFrom : "");
    await writeMeta(connection, "covered_until", done && coveredUntil ? coveredUntil : "");
}

async function clearBuildState(connection: OpenConnection): Promise<void> {
    await setBuilding(connection, { mailboxUid: connection.params.mailboxUid, building: false, complete: false });
}

/** Closes the connection (if open) and deletes the mailbox's entire OPFS directory - the spec's "MUST be
 * destroyed on the same events that destroy private keys" (§11). Rejects if the directory couldn't be
 * removed (e.g. another tab still has it open), so the caller can report it. */
async function destroy(mailboxUid: string): Promise<void> {
    await closeConnection(mailboxUid);
    await removeLocalIndexDirectory(mailboxUid);
}

/** Destroys every local index on this origin, including ones this Worker never opened. Each mailbox's close
 * and directory removal runs inside that mailbox's own queue, so an `init` already queued can't recreate a
 * directory after it was removed (a stale build's queued `init` is rejected by its generation instead). */
async function destroyAll(): Promise<{ failed: string[] }> {
    const mailboxUids = new Set([...connections.keys(), ...(await listLocalIndexMailboxUids())]);
    const failed: string[] = [];
    await Promise.all(
        [...mailboxUids].map((mailboxUid) => runExclusive(mailboxUid, () => destroy(mailboxUid)).catch(() => failed.push(mailboxUid))),
    );
    return { failed: failed.sort() };
}

/**
 * Proves the full encrypted round trip, not just a single write-then-read within one open connection:
 * writes a row, closes the connection, re-`init()`s the same mailbox from scratch, and confirms the row
 * (and a `bm25()`-ranked `MATCH` query against it) both still work after that reopen.
 */
async function selfTest(params: InitParams): Promise<{ matchedAfterReopen: string[] }> {
    await init(params);
    const before = requireConnection(params.mailboxUid);
    await before.sqlite3.exec(before.db, "DELETE FROM entities");
    for await (const stmt of before.sqlite3.statements(
        before.db,
        "INSERT INTO entities (entity_type, entity_uid, mailbox_uid, date_for_sort, subject, body) VALUES (?, ?, ?, ?, ?, ?)",
    )) {
        before.sqlite3.bind_collection(stmt, [
            "message",
            "spike-1",
            params.mailboxUid,
            new Date().toISOString(),
            "Quarterly budget review",
            "This round-trips through EncryptingVFS: written before a close, read back after a reopen.",
        ]);
        await before.sqlite3.step(stmt);
    }
    await closeConnection(params.mailboxUid);

    await init(params);
    const after = requireConnection(params.mailboxUid);
    const matchedAfterReopen: string[] = [];
    for await (const stmt of after.sqlite3.statements(
        after.db,
        `SELECT e.entity_uid FROM entities_fts f JOIN entities e ON e.rowid = f.rowid
         WHERE entities_fts MATCH 'budget' ORDER BY bm25(entities_fts, ${BM25_WEIGHTS_SQL})`,
    )) {
        while ((await after.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
            matchedAfterReopen.push(after.sqlite3.column(stmt, 0) as string);
        }
    }
    return { matchedAfterReopen };
}

/** Routes one request to its handler, inside the owning mailbox's serial queue. Exported for tests. */
export async function handleRequest(method: LocalIndexRequest["method"], params: unknown): Promise<unknown> {
    switch (method) {
        case "ping":
            return "pong";
        case "init": {
            const p = params as InitParams;
            return runExclusive(p.mailboxUid, () => init(p));
        }
        case "indexEntities": {
            const p = params as IndexEntitiesParams;
            return runExclusive(p.mailboxUid, () => withCurrentConnection(p, (c) => indexEntities(c, p.entities)));
        }
        case "removeEntity": {
            const p = params as RemoveEntityParams;
            return runExclusive(p.mailboxUid, () => withConnection(p.mailboxUid, (c) => removeEntity(c, p.entityUid)));
        }
        case "moveEntity": {
            const p = params as MoveEntityParams;
            return runExclusive(p.mailboxUid, () => withConnection(p.mailboxUid, (c) => moveEntity(c, p.entityUid, p.folderUid)));
        }
        case "indexedVersions": {
            const p = params as IndexedVersionsParams;
            return runExclusive(p.mailboxUid, () => withConnection(p.mailboxUid, (c) => indexedVersions(c, p.entityUids)));
        }
        case "pruneEntities": {
            const p = params as PruneEntitiesParams;
            return runExclusive(p.mailboxUid, () => withCurrentConnection(p, (c) => pruneEntities(c, p)));
        }
        case "search": {
            const p = params as SearchParams;
            return runExclusive(p.mailboxUid, () => withConnection(p.mailboxUid, (c) => search(c, p)));
        }
        case "coverage": {
            const mailboxUid = params as string;
            return runExclusive(mailboxUid, () => withConnection(mailboxUid, (c) => coverage(c)));
        }
        case "setWindow": {
            const p = params as SetWindowParams;
            return runExclusive(p.mailboxUid, () => withCurrentConnection(p, (c) => setWindow(c, p)));
        }
        case "setBuilding": {
            const p = params as SetBuildingParams;
            return runExclusive(p.mailboxUid, () => withCurrentConnection(p, (c) => setBuilding(c, p)));
        }
        case "destroy": {
            const p = params as DestroyParams;
            // Recorded synchronously, before queueing - any build call issued earlier but still queued behind
            // this one is rejected once it runs.
            recordDestroyGeneration(p.mailboxUid, p.generation);
            return runExclusive(p.mailboxUid, () => destroy(p.mailboxUid));
        }
        case "destroyAll": {
            recordDestroyGeneration(undefined, (params as GenerationParams | undefined)?.generation);
            return destroyAll();
        }
        case "selfTest": {
            const p = params as InitParams;
            return runExclusive(p.mailboxUid, () => selfTest(p));
        }
        default:
            throw new Error(`Unknown localIndexWorker method: ${method satisfies never}`);
    }
}

self.addEventListener("message", (event: MessageEvent<LocalIndexRequest>) => {
    const { id, method, params } = event.data;
    handleRequest(method, params).then(
        (result) => self.postMessage({ id, ok: true, result } satisfies LocalIndexResponse),
        (err: unknown) => self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies LocalIndexResponse),
    );
});
