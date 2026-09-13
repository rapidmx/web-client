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
 * One SQLite connection per mailbox, opened on `init` and kept for the Worker's lifetime (or until
 * `destroy`). `entity_uid` is this module's identifier for a message (the only entity type Tier 2 covers
 * today - see the doc comment on `searchTier3.ts`'s identical scope decision, which this mirrors).
 *
 * Real index/search/lifecycle RPC methods are all implemented below; `selfTest` stays alongside them as
 * an internal diagnostic (proves the encrypted round trip end to end: write through `EncryptingVFS`,
 * close the connection, reopen, read back) rather than being removed once the real surface existed.
 */
import SQLiteESMFactory from "@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs";
import * as SQLite from "@journeyapps/wa-sqlite";
import type { ParsedSearchQuery } from "@rapidmx/react-shared/search/queryGrammar.js";
import { EncryptingVFS } from "./localIndexVFS.js";
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
    method: "init" | "indexEntities" | "removeEntity" | "search" | "coverage" | "setWindow" | "setBuilding" | "destroy" | "selfTest" | "ping";
    params?: unknown;
}

export type LocalIndexResponse =
    | { id: number; ok: true; result: unknown }
    | { id: number; ok: false; error: string };

export interface InitParams {
    mailboxUid: string;
    /** The mailbox's already-derived local-index key (`localIndexKey.ts`'s `deriveLocalIndexKey()`) -
     * this Worker never touches the master key itself, only this one purpose-derived value, matching
     * every other MK-derived-key boundary already established elsewhere in this codebase. */
    indexKey: Uint8Array;
}

export interface IndexEntitiesParams {
    mailboxUid: string;
    entities: LocalIndexEntity[];
}

export interface RemoveEntityParams {
    mailboxUid: string;
    entityUid: string;
}

export interface SearchParams {
    mailboxUid: string;
    parsed: ParsedSearchQuery;
    limit: number;
}

export interface LocalSearchHit {
    entityUid: string;
    /** Raw `bm25()` score - more negative is a better match, per SQLite's own convention. Normalized by
     * `searchTier2.ts` (main thread) via `searchScoring.ts`'s shared `normalizeServerScores()`, the same
     * way every other tier's raw score is, before merging (spec §7). */
    score: number;
    snippet?: string;
}

export interface Coverage {
    /** Oldest `date_for_sort` currently covered, or `undefined` for an empty index. */
    indexedFrom?: string;
    indexedCount: number;
    building: boolean;
}

export interface SetWindowParams {
    mailboxUid: string;
    timeFloorMonths: number;
    byteBudgetBytes: number;
}

export interface SetBuildingParams {
    mailboxUid: string;
    building: boolean;
}

interface OpenConnection {
    sqlite3: SQLiteAPI;
    db: number;
    vfs: EncryptingVFS;
}

/** Keyed by `mailboxUid` - a Worker instance is per-tab, not per-mailbox, so this stays a map even
 * though only one mailbox is ever unlocked in this app's UI at a time today. */
const connections = new Map<string, OpenConnection>();

/** The OPFS directory name (and `EncryptingVFS` name) a mailbox's index lives under - scoped per
 * mailbox so two mailboxes' indexes never collide and `destroy(mailboxUid)` (added in the next pass) can
 * remove exactly one without touching the others. */
function poolNameFor(mailboxUid: string): string {
    return `rapidmx-localsearch-${mailboxUid}`;
}

async function openConnection({ mailboxUid, indexKey }: InitParams): Promise<OpenConnection> {
    const module = await SQLiteESMFactory();
    const sqlite3 = SQLite.Factory(module);
    const vfs = await EncryptingVFS.create(poolNameFor(mailboxUid), module, indexKey);
    sqlite3.vfs_register(vfs, true);
    const db = await sqlite3.open_v2("index.db");
    // No WAL, no rollback journal - see localIndexVFS.ts's own doc comment on why this index's lack of
    // a durability requirement makes that an acceptable, deliberate simplification here.
    await sqlite3.exec(db, "PRAGMA journal_mode=OFF; PRAGMA page_size=4096;");
    await sqlite3.exec(db, CREATE_SCHEMA_SQL);
    const connection = { sqlite3, db, vfs };

    const storedVersion = await readMeta(connection, "schema_version");
    if (storedVersion !== String(SCHEMA_VERSION)) {
        // §11 "Invalidation... discarded and rebuilt... on schema version change" - drop every table's
        // rows (the DDL itself is `CREATE ... IF NOT EXISTS`, already current) and start fresh, rather
        // than attempting to migrate content built under an incompatible schema.
        await sqlite3.exec(connection.db, "DELETE FROM entities; DELETE FROM entities_fts;");
        await writeMeta(connection, "schema_version", String(SCHEMA_VERSION));
    }
    return connection;
}

async function readMeta(connection: OpenConnection, key: string): Promise<string | undefined> {
    let value: string | undefined;
    for await (const stmt of connection.sqlite3.statements(connection.db, "SELECT value FROM meta WHERE key = ?")) {
        connection.sqlite3.bind_collection(stmt, [key]);
        if ((await connection.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
            value = connection.sqlite3.column(stmt, 0) as string;
        }
    }
    return value;
}

async function writeMeta(connection: OpenConnection, key: string, value: string): Promise<void> {
    for await (const stmt of connection.sqlite3.statements(connection.db, "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")) {
        connection.sqlite3.bind_collection(stmt, [key, value]);
        await connection.sqlite3.step(stmt);
    }
}

async function init(params: InitParams): Promise<void> {
    if (connections.has(params.mailboxUid)) {
        return;
    }
    connections.set(params.mailboxUid, await openConnection(params));
}

function requireConnection(mailboxUid: string): OpenConnection {
    const connection = connections.get(mailboxUid);
    if (!connection) {
        throw new Error(`localIndexWorker: init() was never called for mailbox ${mailboxUid}`);
    }
    return connection;
}

/** Tears down a mailbox's connection completely: the SQLite connection itself (`sqlite3.close(db)`) AND
 * the underlying `EncryptingVFS`/`AccessHandlePoolVFS` instance (`vfs.close()`) - two separate lifecycles
 * (see `EncryptingVFS.close()`'s own doc comment on why skipping the second one breaks re-`init()`ing the
 * same mailbox). Removes the entry from `connections` either way. */
async function closeConnection(mailboxUid: string): Promise<void> {
    const connection = connections.get(mailboxUid);
    if (!connection) {
        return;
    }
    connections.delete(mailboxUid);
    await connection.sqlite3.close(connection.db);
    await connection.vfs.close();
}

async function sumBytes(connection: OpenConnection): Promise<number> {
    let total = 0;
    for await (const stmt of connection.sqlite3.statements(connection.db, "SELECT COALESCE(SUM(byte_size), 0) FROM entities")) {
        if ((await connection.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
            total = connection.sqlite3.column(stmt, 0) as number;
        }
    }
    return total;
}

async function oldestDateForSort(connection: OpenConnection): Promise<string | undefined> {
    let oldest: string | undefined;
    for await (const stmt of connection.sqlite3.statements(connection.db, "SELECT MIN(date_for_sort) FROM entities")) {
        if ((await connection.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
            oldest = (connection.sqlite3.column(stmt, 0) as string | null) ?? undefined;
        }
    }
    return oldest;
}

async function entityCount(connection: OpenConnection): Promise<number> {
    let count = 0;
    for await (const stmt of connection.sqlite3.statements(connection.db, "SELECT COUNT(*) FROM entities")) {
        if ((await connection.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
            count = connection.sqlite3.column(stmt, 0) as number;
        }
    }
    return count;
}

/** Deletes the single oldest entity (by `date_for_sort`) and returns whether one existed to delete -
 * `entities_ad` (see `localIndexSchema.ts`) keeps `entities_fts` in sync automatically. One row per call
 * (not a batch `DELETE ... LIMIT`, which SQLite's default build doesn't compile in) so
 * `#applyEviction()`'s own loop can re-check the byte total after each deletion rather than
 * over-evicting. */
async function deleteOldestEntity(connection: OpenConnection): Promise<boolean> {
    let deleted = false;
    for await (const stmt of connection.sqlite3.statements(
        connection.db,
        "DELETE FROM entities WHERE rowid = (SELECT rowid FROM entities ORDER BY date_for_sort ASC LIMIT 1)",
    )) {
        await connection.sqlite3.step(stmt);
        deleted = connection.sqlite3.changes(connection.db) > 0;
    }
    return deleted;
}

/** Oldest-first eviction against the configured byte budget (spec §11 "Eviction... MUST NOT block
 * search" - this runs to completion as part of `indexEntities()`, which is already off the UI thread by
 * virtue of running in this Worker, so there's no separate scheduling concern here). A no-op when no
 * budget has been configured yet (`setWindow()` was never called) - nothing to enforce. */
async function applyEviction(connection: OpenConnection): Promise<void> {
    const byteBudgetRaw = await readMeta(connection, "byte_budget");
    const byteBudget = byteBudgetRaw ? Number(byteBudgetRaw) : undefined;
    if (!byteBudget) {
        return;
    }
    for (;;) {
        const total = await sumBytes(connection);
        if (total <= byteBudget) {
            return;
        }
        const deletedOne = await deleteOldestEntity(connection);
        if (!deletedOne) {
            return;
        }
    }
}

async function indexEntities({ mailboxUid, entities }: IndexEntitiesParams): Promise<void> {
    const connection = requireConnection(mailboxUid);
    for (const entity of entities) {
        for await (const stmt of connection.sqlite3.statements(connection.db, UPSERT_ENTITY_SQL)) {
            connection.sqlite3.bind_collection(stmt, entityBindValues(entity));
            await connection.sqlite3.step(stmt);
        }
    }
    await applyEviction(connection);
}

async function removeEntity({ mailboxUid, entityUid }: RemoveEntityParams): Promise<void> {
    const connection = requireConnection(mailboxUid);
    for await (const stmt of connection.sqlite3.statements(connection.db, "DELETE FROM entities WHERE entity_uid = ?")) {
        connection.sqlite3.bind_collection(stmt, [entityUid]);
        await connection.sqlite3.step(stmt);
    }
}

async function search({ mailboxUid, parsed, limit }: SearchParams): Promise<LocalSearchHit[]> {
    const connection = requireConnection(mailboxUid);
    const { where, params } = buildSearchPredicates(parsed, mailboxUid);
    const matchExpr = buildMatchExpression(parsed);
    const hits: LocalSearchHit[] = [];

    // A malformed MATCH string is a real, reachable case (FTS5's query syntax rejects some inputs
    // `queryGrammar.ts` otherwise leaves untouched for the *server's* more lenient `websearch_to_tsquery`
    // to handle) - fails soft to "this tier found nothing," matching how every other tier already
    // degrades on its own per-candidate/per-provider failures, rather than breaking the whole search.
    try {
        const sql = matchExpr
            ? `SELECT e.entity_uid, bm25(entities_fts, ${BM25_WEIGHTS_SQL}) AS rank,
                      snippet(entities_fts, 2, '', '', '…', 24) AS snip
               FROM entities_fts f JOIN entities e ON e.rowid = f.rowid
               WHERE entities_fts MATCH ? AND ${where}
               ORDER BY rank LIMIT ?`
            : `SELECT e.entity_uid, 0 AS rank, NULL AS snip FROM entities e WHERE ${where}
               ORDER BY e.date_for_sort DESC LIMIT ?`;
        const bindings = matchExpr ? [matchExpr, ...params, limit] : [...params, limit];
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
    } catch {
        return [];
    }
    return hits;
}

async function coverage(mailboxUid: string): Promise<Coverage> {
    const connection = requireConnection(mailboxUid);
    return {
        indexedFrom: await oldestDateForSort(connection),
        indexedCount: await entityCount(connection),
        building: (await readMeta(connection, "building")) === "1",
    };
}

async function setWindow({ mailboxUid, timeFloorMonths, byteBudgetBytes }: SetWindowParams): Promise<void> {
    const connection = requireConnection(mailboxUid);
    await writeMeta(connection, "time_floor_months", String(timeFloorMonths));
    await writeMeta(connection, "byte_budget", String(byteBudgetBytes));
    // A lowered budget must shrink the window immediately, not just gate future inserts (spec §11 "the
    // client MUST reduce the window rather than fail writes when the budget is reached").
    await applyEviction(connection);
}

async function setBuilding(mailboxUid: string, building: boolean): Promise<void> {
    const connection = requireConnection(mailboxUid);
    await writeMeta(connection, "building", building ? "1" : "0");
}

/** Closes the connection (if open) and deletes the mailbox's entire OPFS directory - the spec's "MUST be
 * destroyed on the same events that destroy private keys" (§11), and also the discard side of
 * "discarded and rebuilt" on corruption/schema-version invalidation. Goes around SQLite/the VFS entirely
 * for the deletion itself (there's no VFS-level "delete everything" primitive) - safe only because the
 * connection is already closed at this point, so nothing else holds these files open. */
async function destroy(mailboxUid: string): Promise<void> {
    await closeConnection(mailboxUid);
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(poolNameFor(mailboxUid), { recursive: true }).catch(() => undefined);
}

/**
 * Proves the full encrypted round trip, not just a single write-then-read within one open connection
 * (which could pass even if encryption/decryption were silently no-ops): writes a row, **closes the
 * SQLite connection and drops it from `connections`**, then re-`init()`s the same mailbox from scratch -
 * a real close/reopen through `EncryptingVFS`, `AccessHandlePoolVFS`, and OPFS, not merely reading back
 * from an in-memory cache - and confirms the row (and a `bm25()`-ranked `MATCH` query against it) both
 * still work after that reopen.
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

self.addEventListener("message", (event: MessageEvent<LocalIndexRequest>) => {
    const { id, method, params } = event.data;
    void (async () => {
        try {
            let result: unknown;
            switch (method) {
                case "ping":
                    result = "pong";
                    break;
                case "init":
                    await init(params as InitParams);
                    result = undefined;
                    break;
                case "indexEntities":
                    await indexEntities(params as IndexEntitiesParams);
                    result = undefined;
                    break;
                case "removeEntity":
                    await removeEntity(params as RemoveEntityParams);
                    result = undefined;
                    break;
                case "search":
                    result = await search(params as SearchParams);
                    break;
                case "coverage":
                    result = await coverage(params as string);
                    break;
                case "setWindow":
                    await setWindow(params as SetWindowParams);
                    result = undefined;
                    break;
                case "setBuilding": {
                    const { mailboxUid, building } = params as SetBuildingParams;
                    await setBuilding(mailboxUid, building);
                    result = undefined;
                    break;
                }
                case "destroy":
                    await destroy(params as string);
                    result = undefined;
                    break;
                case "selfTest":
                    result = await selfTest(params as InitParams);
                    break;
                default:
                    throw new Error(`Unknown localIndexWorker method: ${method satisfies never}`);
            }
            const response: LocalIndexResponse = { id, ok: true, result };
            self.postMessage(response);
        } catch (err) {
            const response: LocalIndexResponse = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
            self.postMessage(response);
        }
    })();
});
