// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Runs the real Worker module against the real wa-sqlite Asyncify build (real FTS5, bm25(), pragmas) and
// the real EncryptingVFS (real WebCrypto) - only the two browser-only pieces are substituted: OPFS
// (`AccessHandlePoolVFS` becomes wa-sqlite's own MemoryVFS over a shared in-memory "directory" map, so
// files survive a close/reopen like OPFS does) and the `self`/`navigator` Worker globals.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalIndexEntity } from "../../../apps/shared/search/localIndexSchema.js";

type WorkerModule = typeof import("../../../apps/shared/search/localIndexWorker.js");

const { opfs, poolCreations } = vi.hoisted(() => ({
    /** OPFS root: directory name -> (file path -> MemoryVFS file record). */
    opfs: new Map<string, Map<string, { data: ArrayBuffer; size: number }>>(),
    poolCreations: [] as string[],
}));

vi.mock("@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs", async (importOriginal) => {
    const actual = await importOriginal<{ default: (options?: object) => Promise<unknown> }>();
    const require = createRequire(import.meta.url);
    const wasmBinary = readFileSync(require.resolve("@journeyapps/wa-sqlite/dist/wa-sqlite-async.wasm"));
    return { default: () => actual.default({ wasmBinary }) };
});

vi.mock("@journeyapps/wa-sqlite/src/examples/AccessHandlePoolVFS.js", async () => {
    const { MemoryVFS } = await import("@journeyapps/wa-sqlite/src/examples/MemoryVFS.js");
    class FakeAccessHandlePoolVFS extends MemoryVFS {
        static async create(name: string, module: unknown) {
            poolCreations.push(name);
            const vfs = new FakeAccessHandlePoolVFS(name, module);
            if (!opfs.has(name)) {
                opfs.set(name, new Map());
            }
            (vfs as unknown as { mapNameToFile: unknown }).mapNameToFile = opfs.get(name);
            return vfs;
        }
    }
    return { AccessHandlePoolVFS: FakeAccessHandlePoolVFS };
});

// Pass-through wrapper over the real wa-sqlite API with optional per-test fault injection - lets the tests
// below reach the Worker's defensive failure paths (a failing close, a non-Error throw, a SQLite error
// code, an unexpectedly empty/NULL result) that a healthy real database never produces on its own.
interface SqliteHooks {
    /** Called before `open_v2`/`exec`/`statements` - may throw to fail that call. */
    onOpen?: () => void;
    onExec?: (sql: string) => void;
    onStatements?: (sql: string) => void;
    /** Called after a real `close` - may throw to make that close reject. */
    onClose?: () => void;
    /** Replaces whatever a real `open_v2`/`exec` threw. */
    mapError?: (err: unknown) => unknown;
    /** Statements whose SQL matches report a NULL column value / no rows at all. */
    nullColumnFor?: RegExp;
    noRowsFor?: RegExp;
}

const { sqliteHooks } = vi.hoisted(() => {
    const hooks: SqliteHooks = {};
    return { sqliteHooks: hooks };
});

/** A thrown value that deliberately isn't an `Error`, for the Worker's `String(err)` fallbacks. */
const NON_ERROR = (message: string): unknown => message;

vi.mock("@journeyapps/wa-sqlite", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@journeyapps/wa-sqlite")>();
    const withMappedError = async <T>(run: () => Promise<T>): Promise<T> => {
        try {
            return await run();
        } catch (err) {
            throw sqliteHooks.mapError ? sqliteHooks.mapError(err) : err;
        }
    };
    return {
        ...actual,
        Factory(module: unknown) {
            const api = actual.Factory(module);
            const sqlByStatement = new Map<number, string>();
            return {
                ...api,
                open_v2: (...args: Parameters<typeof api.open_v2>) =>
                    withMappedError(async () => {
                        sqliteHooks.onOpen?.();
                        return api.open_v2(...args);
                    }),
                exec: (db: number, sql: string) =>
                    withMappedError(async () => {
                        sqliteHooks.onExec?.(sql);
                        return api.exec(db, sql);
                    }),
                close: async (db: number) => {
                    const result = await api.close(db);
                    sqliteHooks.onClose?.();
                    return result;
                },
                async *statements(db: number, sql: string) {
                    sqliteHooks.onStatements?.(sql);
                    for await (const stmt of api.statements(db, sql)) {
                        sqlByStatement.set(stmt, sql);
                        yield stmt;
                    }
                },
                step: async (stmt: number) =>
                    sqliteHooks.noRowsFor?.test(sqlByStatement.get(stmt) ?? "") ? actual.SQLITE_DONE : api.step(stmt),
                column: (stmt: number, i: number) =>
                    sqliteHooks.nullColumnFor?.test(sqlByStatement.get(stmt) ?? "") ? null : api.column(stmt, i),
            };
        },
    };
});

/** Makes only the next `close` reject (after really closing). */
function failNextClose() {
    sqliteHooks.onClose = () => {
        sqliteHooks.onClose = undefined;
        throw new Error("close failed");
    };
}

const busyDirectories = new Set<string>();
const opfsRoot = {
    async removeEntry(name: string) {
        if (!opfs.has(name)) {
            throw Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });
        }
        if (busyDirectories.has(name)) {
            throw Object.assign(new Error(`${name} is in use`), { name: "NoModificationAllowedError" });
        }
        opfs.delete(name);
    },
    async *keys() {
        yield* [...opfs.keys()];
    },
};

const KEY = new Uint8Array(32).fill(1);
const OTHER_KEY = new Uint8Array(32).fill(2);

function entity(uid: string, overrides: Partial<LocalIndexEntity> = {}): LocalIndexEntity {
    return {
        entityType: "message",
        entityUid: uid,
        mailboxUid: "mb1",
        folderUid: "inbox",
        dateForSort: "2026-06-01T00:00:00.000Z",
        participants: "alice@example.com",
        flags: ",read,",
        hasAttachments: false,
        subject: `Budget review ${uid}`,
        body: "Quarterly budget numbers",
        byteSize: 600,
        entityVersion: `1:inbox`,
        ...overrides,
    };
}

let worker: WorkerModule;
let postMessage: ReturnType<typeof vi.fn>;
let messageListener: ((event: { data: unknown }) => void) | undefined;

async function loadWorker(): Promise<WorkerModule> {
    vi.resetModules();
    return import("../../../apps/shared/search/localIndexWorker.js");
}

function call<T>(method: Parameters<WorkerModule["handleRequest"]>[0], params?: unknown): Promise<T> {
    return worker.handleRequest(method, params) as Promise<T>;
}

beforeEach(async () => {
    opfs.clear();
    busyDirectories.clear();
    for (const key of Object.keys(sqliteHooks)) {
        delete sqliteHooks[key as keyof typeof sqliteHooks];
    }
    poolCreations.length = 0;
    postMessage = vi.fn();
    vi.stubGlobal("self", {
        addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => (messageListener = listener),
        postMessage,
    });
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => opfsRoot } });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    worker = await loadWorker();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("localIndexWorker", () => {
    it("answers postMessage requests through the registered message listener", async () => {
        messageListener!({ data: { id: 7, method: "ping" } });
        messageListener!({ data: { id: 8, method: "coverage", params: "never-initialized" } });
        await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
        expect(postMessage).toHaveBeenCalledWith({ id: 7, ok: true, result: "pong" });
        expect(postMessage).toHaveBeenCalledWith({ id: 8, ok: false, error: expect.stringContaining("init() was never called") });
    });

    describe("runExclusive", () => {
        it("runs one mailbox's tasks strictly in order, even when an earlier one is slower or fails", async () => {
            const events: string[] = [];
            const slow = worker.runExclusive("mb1", async () => {
                events.push("slow:start");
                await new Promise((resolve) => setTimeout(resolve, 20));
                events.push("slow:end");
                throw new Error("boom");
            });
            const fast = worker.runExclusive("mb1", async () => {
                events.push("fast");
                return 42;
            });
            await expect(slow).rejects.toThrow("boom");
            await expect(fast).resolves.toBe(42);
            expect(events).toEqual(["slow:start", "slow:end", "fast"]);
        });
    });

    it("serializes concurrent requests: two racing inits open exactly one pool, and interleaved index/search/coverage all succeed", async () => {
        await Promise.all([
            call("init", { mailboxUid: "mb1", indexKey: KEY }),
            call("init", { mailboxUid: "mb1", indexKey: KEY }),
            call("indexEntities", { mailboxUid: "mb1", entities: [entity("m1"), entity("m2")] }),
            call("search", { mailboxUid: "mb1", parsed: { text: "budget" }, limit: 10 }),
            call("coverage", "mb1"),
        ]);
        expect(poolCreations).toEqual(["rapidmx-localsearch-mb1"]);
        const page = await call<{ hits: { entityUid: string }[] }>("search", { mailboxUid: "mb1", parsed: { text: "budget" }, limit: 10 });
        expect(page.hits.map((h) => h.entityUid).sort()).toEqual(["m1", "m2"]);
    });

    it("orders ties by entity_uid so OFFSET pages never overlap or skip rows", async () => {
        await call("init", { mailboxUid: "mb1", indexKey: KEY });
        const uids = ["m5", "m3", "m1", "m4", "m2", "m6"];
        await call("indexEntities", { mailboxUid: "mb1", entities: uids.map((uid) => entity(uid)) });

        const seen: string[] = [];
        for (const offset of [0, 2, 4]) {
            const page = await call<{ hits: { entityUid: string }[]; hasMore: boolean }>("search", {
                mailboxUid: "mb1",
                parsed: { text: "" },
                limit: 2,
                offset,
            });
            seen.push(...page.hits.map((h) => h.entityUid));
            expect(page.hasMore).toBe(offset < 4);
        }
        expect(seen).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);

        const ranked = await call<{ hits: { entityUid: string }[] }>("search", { mailboxUid: "mb1", parsed: { text: "budget" }, limit: 3, offset: 3 });
        expect(ranked.hits.map((h) => h.entityUid)).toEqual(["m4", "m5", "m6"]);
    });

    it("reports indexed versions, moves and removes entities in place", async () => {
        await call("init", { mailboxUid: "mb1", indexKey: KEY });
        await call("indexEntities", { mailboxUid: "mb1", entities: [entity("m1"), entity("m2", { entityVersion: "4:inbox" })] });

        await expect(call("indexedVersions", { mailboxUid: "mb1", entityUids: ["m1", "m2", "missing"] })).resolves.toEqual({
            m1: "1:inbox",
            m2: "4:inbox",
        });
        await expect(call("indexedVersions", { mailboxUid: "mb1", entityUids: [] })).resolves.toEqual({});

        await call("moveEntity", { mailboxUid: "mb1", entityUid: "m1", folderUid: "archive" });
        const inArchive = await call<{ hits: { entityUid: string }[] }>("search", {
            mailboxUid: "mb1",
            parsed: { text: "budget", folderUid: "archive" },
            limit: 10,
        });
        expect(inArchive.hits.map((h) => h.entityUid)).toEqual(["m1"]);
        // A move clears the version so the next build re-validates the row.
        await expect(call("indexedVersions", { mailboxUid: "mb1", entityUids: ["m1"] })).resolves.toEqual({});

        await call("removeEntity", { mailboxUid: "mb1", entityUid: "m2" });
        await expect(call("coverage", "mb1")).resolves.toMatchObject({ indexedCount: 1 });
    });

    it("prunes rows a complete pass didn't see, only within the pass's time floor", async () => {
        await call("init", { mailboxUid: "mb1", indexKey: KEY });
        await call("indexEntities", {
            mailboxUid: "mb1",
            entities: [
                entity("kept", { dateForSort: "2026-06-01T00:00:00.000Z" }),
                entity("deleted", { dateForSort: "2026-05-01T00:00:00.000Z" }),
                entity("old", { dateForSort: "2024-01-01T00:00:00.000Z" }),
            ],
        });
        await expect(call("pruneEntities", { mailboxUid: "mb1", keepEntityUids: ["kept"], since: "2025-09-01T00:00:00.000Z" })).resolves.toBe(1);
        await expect(call("indexedVersions", { mailboxUid: "mb1", entityUids: ["kept", "deleted", "old"] })).resolves.toEqual({
            kept: "1:inbox",
            old: "1:inbox",
        });
        await expect(call("pruneEntities", { mailboxUid: "mb1", keepEntityUids: ["kept"] })).resolves.toBe(1);
        await expect(call("pruneEntities", { mailboxUid: "mb1", keepEntityUids: ["kept"] })).resolves.toBe(0);
    });

    it("only reports a coverage guarantee for a finished, complete pass - and never older than that pass's time floor", async () => {
        await call("init", { mailboxUid: "mb1", indexKey: KEY });
        await call("indexEntities", { mailboxUid: "mb1", entities: [entity("m1", { dateForSort: "2025-01-01T00:00:00.000Z" })] });

        await call("setBuilding", { mailboxUid: "mb1", building: true });
        await expect(call("coverage", "mb1")).resolves.toMatchObject({ building: true, complete: false, indexedFrom: "2025-01-01T00:00:00.000Z" });

        await call("setBuilding", { mailboxUid: "mb1", building: false, complete: false });
        await expect(call("coverage", "mb1")).resolves.toMatchObject({ building: false, complete: false });

        await call("setBuilding", { mailboxUid: "mb1", building: false, complete: true, coveredFrom: "2025-09-01T00:00:00.000Z" });
        await expect(call("coverage", "mb1")).resolves.toMatchObject({ building: false, complete: true, indexedFrom: "2025-09-01T00:00:00.000Z" });

        await call("setBuilding", { mailboxUid: "mb1", building: false, complete: true, coveredFrom: "2024-01-01T00:00:00.000Z" });
        await expect(call("coverage", "mb1")).resolves.toMatchObject({ complete: true, indexedFrom: "2025-01-01T00:00:00.000Z" });
    });

    it("enforces the byte budget against the real database size, evicting oldest-first in bulk and vacuuming freed pages", async () => {
        await call("init", { mailboxUid: "mb1", indexKey: KEY });
        const body = "lorem ipsum dolor sit amet ".repeat(400); // ~10 KB per row
        const entities = Array.from({ length: 60 }, (_, i) =>
            entity(`m${String(i).padStart(2, "0")}`, {
                dateForSort: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
                body,
                byteSize: body.length + 512,
            }),
        );
        await expect(call("indexEntities", { mailboxUid: "mb1", entities })).resolves.toEqual({ budgetReached: false });
        const before = await call<{ indexedCount: number; fileBytes: number }>("coverage", "mb1");
        expect(before.indexedCount).toBe(60);

        const budget = 250_000;
        await call("setWindow", { mailboxUid: "mb1", timeFloorMonths: 12, byteBudgetBytes: budget });
        const after = await call<{ indexedCount: number; fileBytes: number; indexedFrom: string }>("coverage", "mb1");
        expect(after.indexedCount).toBeGreaterThan(0);
        expect(after.indexedCount).toBeLessThan(60);
        // incremental_vacuum actually shrank the file, and it now fits the budget.
        expect(after.fileBytes).toBeLessThan(before.fileBytes);
        expect(after.fileBytes).toBeLessThanOrEqual(budget);
        // Oldest rows went first: whatever survived is a contiguous newest range.
        const survivors = await call<Record<string, string>>("indexedVersions", { mailboxUid: "mb1", entityUids: entities.map((e) => e.entityUid) });
        const expected = entities.slice(60 - after.indexedCount).map((e) => e.entityUid);
        expect(Object.keys(survivors).sort()).toEqual(expected);
        expect(after.indexedFrom).toBe(entities[60 - after.indexedCount].dateForSort);

        // Inserting past the budget again reports that it had to evict.
        const newer = Array.from({ length: 10 }, (_, i) =>
            entity(`new${i}`, { dateForSort: new Date(Date.UTC(2026, 6, 1 + i)).toISOString(), body, byteSize: body.length + 512 }),
        );
        await expect(call("indexEntities", { mailboxUid: "mb1", entities: newer })).resolves.toEqual({ budgetReached: true });
    });

    it("discards and rebuilds an index that fails to decrypt at open time (e.g. a different key)", async () => {
        await call("init", { mailboxUid: "mb1", indexKey: KEY });
        await call("indexEntities", { mailboxUid: "mb1", entities: [entity("m1")] });

        worker = await loadWorker(); // a fresh Worker (new tab/session) over the same on-disk index
        await call("init", { mailboxUid: "mb1", indexKey: OTHER_KEY });
        await expect(call("coverage", "mb1")).resolves.toMatchObject({ indexedCount: 0 });
        await call("indexEntities", { mailboxUid: "mb1", entities: [entity("m2")] });
        await expect(call("coverage", "mb1")).resolves.toMatchObject({ indexedCount: 1 });
    });

    it("discards an index built under an older schema version and recreates the whole file", async () => {
        // Hand-build a v1-shaped database through the real EncryptingVFS, the way an older client would have.
        const [{ default: factory }, SQLite, { EncryptingVFS }] = await Promise.all([
            import("@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs"),
            import("@journeyapps/wa-sqlite"),
            import("../../../apps/shared/search/localIndexVFS.js"),
        ]);
        const module = await factory();
        const sqlite3 = SQLite.Factory(module);
        const vfs = await EncryptingVFS.create("rapidmx-localsearch-mb1", module, KEY);
        sqlite3.vfs_register(vfs, true);
        const db = await sqlite3.open_v2("index.db");
        await sqlite3.exec(
            db,
            "PRAGMA journal_mode=OFF; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema_version', '1'); CREATE TABLE entities (rowid INTEGER PRIMARY KEY, entity_uid TEXT);",
        );
        await sqlite3.close(db);
        await vfs.close();

        // Closing the outdated database before discarding it failing too must not block the rebuild.
        failNextClose();
        await call("init", { mailboxUid: "mb1", indexKey: KEY });
        await call("indexEntities", { mailboxUid: "mb1", entities: [entity("m1")] });
        await expect(call("indexedVersions", { mailboxUid: "mb1", entityUids: ["m1"] })).resolves.toEqual({ m1: "1:inbox" });
    });

    it("detects corruption mid-session, fails that one call instead of hanging, and reopens an empty usable index", async () => {
        await call("init", { mailboxUid: "mb1", indexKey: KEY });
        await call("indexEntities", { mailboxUid: "mb1", entities: [entity("m1")] });

        // Flip bytes inside the first encrypted block on "disk".
        const file = opfs.get("rapidmx-localsearch-mb1")!.get("/index.db")!;
        new Uint8Array(file.data).fill(0xff, 20, 60);

        await expect(call("search", { mailboxUid: "mb1", parsed: { text: "budget" }, limit: 10 })).rejects.toThrow();
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("corrupted"));
        await expect(call("coverage", "mb1")).resolves.toMatchObject({ indexedCount: 0 });
        await call("indexEntities", { mailboxUid: "mb1", entities: [entity("m2")] });
        await expect(call("coverage", "mb1")).resolves.toMatchObject({ indexedCount: 1 });
    });

    it("still fails soft (no hits, no rebuild) for an ordinary malformed MATCH expression", async () => {
        await call("init", { mailboxUid: "mb1", indexKey: KEY });
        await call("indexEntities", { mailboxUid: "mb1", entities: [entity("m1")] });
        await expect(call("search", { mailboxUid: "mb1", parsed: { text: '"unterminated' }, limit: 10 })).resolves.toEqual({ hits: [], hasMore: false });
        await expect(call("coverage", "mb1")).resolves.toMatchObject({ indexedCount: 1 });
    });

    it("refuses to open an index another tab holds (Web Locks), with a logged reason, and releases its own lock on destroy", async () => {
        const held = new Set<string>();
        const locks = {
            request: vi.fn(async (name: string, _options: object, callback: (lock: object | null) => Promise<void> | undefined) => {
                if (held.has(name)) {
                    return callback(null);
                }
                held.add(name);
                await callback({ name });
                held.delete(name);
            }),
        };
        vi.stubGlobal("navigator", { storage: { getDirectory: async () => opfsRoot }, locks });

        await call("init", { mailboxUid: "mb1", indexKey: KEY });
        const otherTab = await loadWorker();
        await expect(otherTab.handleRequest("init", { mailboxUid: "mb1", indexKey: KEY })).rejects.toThrow("already open in another tab");
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("already open in another tab"));

        await call("destroy", "mb1");
        await vi.waitFor(() => expect(held.size).toBe(0));
        await expect(otherTab.handleRequest("init", { mailboxUid: "mb1", indexKey: KEY })).resolves.toBeUndefined();
    });

    it("destroy removes the mailbox's directory and surfaces a failure to remove it", async () => {
        await call("init", { mailboxUid: "mb1", indexKey: KEY });
        await call("destroy", "mb1");
        expect(opfs.has("rapidmx-localsearch-mb1")).toBe(false);
        await expect(call("coverage", "mb1")).rejects.toThrow("init() was never called");
        // Already gone: not an error.
        await expect(call("destroy", "mb1")).resolves.toBeUndefined();

        opfs.set("rapidmx-localsearch-mb2", new Map());
        busyDirectories.add("rapidmx-localsearch-mb2");
        await expect(call("destroy", "mb2")).rejects.toThrow("in use");
    });

    it("destroyAll closes open connections and removes every index directory, including ones never opened here", async () => {
        await call("init", { mailboxUid: "mb1", indexKey: KEY });
        opfs.set("rapidmx-localsearch-someone-elses", new Map());
        opfs.set("rapidmx-localsearch-busy", new Map());
        opfs.set("unrelated-app-data", new Map());
        busyDirectories.add("rapidmx-localsearch-busy");

        await expect(call("destroyAll")).resolves.toEqual({ failed: ["busy"] });
        expect([...opfs.keys()].sort()).toEqual(["rapidmx-localsearch-busy", "unrelated-app-data"]);
        await expect(call("coverage", "mb1")).rejects.toThrow("init() was never called");
    });

    it("selfTest round-trips a row through a real close and reopen", async () => {
        await expect(call("selfTest", { mailboxUid: "mb1", indexKey: KEY })).resolves.toEqual({ matchedAfterReopen: ["spike-1"] });
    });

    it("rejects an unknown method", async () => {
        await expect(call("bogus" as never)).rejects.toThrow("Unknown localIndexWorker method: bogus");
    });

    it("opens an index without Web Locks where navigator itself is unavailable", async () => {
        vi.stubGlobal("navigator", undefined);
        await call("init", { mailboxUid: "mb1", indexKey: KEY });
        await call("indexEntities", { mailboxUid: "mb1", entities: [entity("m1")] });
        await expect(call("coverage", "mb1")).resolves.toMatchObject({ indexedCount: 1 });
    });

    describe("failure handling", () => {
        async function withHeldLocks() {
            const held = new Set<string>();
            vi.stubGlobal("navigator", {
                storage: { getDirectory: async () => opfsRoot },
                locks: {
                    request: async (name: string, _options: object, callback: (lock: object | null) => Promise<void> | undefined) => {
                        held.add(name);
                        await callback({ name });
                        held.delete(name);
                    },
                },
            });
            return held;
        }

        it("surfaces a non-corruption open failure (logging a non-Error reason) and releases the Web Lock", async () => {
            const held = await withHeldLocks();
            sqliteHooks.onOpen = () => {
                throw NON_ERROR("sqlite unavailable");
            };

            await expect(call("init", { mailboxUid: "mb1", indexKey: KEY })).rejects.toBe("sqlite unavailable");
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("sqlite unavailable"));
            await vi.waitFor(() => expect(held.size).toBe(0));

            sqliteHooks.onOpen = undefined;
            await expect(call("init", { mailboxUid: "mb1", indexKey: KEY })).resolves.toBeUndefined();
        });

        it("closes a half-opened database when setting its journal mode fails, even if that close fails too", async () => {
            sqliteHooks.onExec = (sql) => {
                if (sql.includes("journal_mode=OFF")) {
                    throw new Error("pragma failed");
                }
            };
            failNextClose();

            await expect(call("init", { mailboxUid: "mb1", indexKey: KEY })).rejects.toThrow("pragma failed");

            sqliteHooks.onExec = undefined;
            await expect(call("init", { mailboxUid: "mb1", indexKey: KEY })).resolves.toBeUndefined();
        });

        it("rebuilds when a wrong-key open fails with a non-Error value", async () => {
            await call("init", { mailboxUid: "mb1", indexKey: KEY });
            await call("indexEntities", { mailboxUid: "mb1", entities: [entity("m1")] });

            worker = await loadWorker();
            sqliteHooks.mapError = () => "opaque failure";
            await call("init", { mailboxUid: "mb1", indexKey: OTHER_KEY });
            sqliteHooks.mapError = undefined;

            await expect(call("coverage", "mb1")).resolves.toMatchObject({ indexedCount: 0 });
        });

        it("treats a SQLite corruption error code during the schema check as corruption, even if closing fails", async () => {
            const SQLite = await import("@journeyapps/wa-sqlite");
            await call("init", { mailboxUid: "mb1", indexKey: KEY });
            await call("indexEntities", { mailboxUid: "mb1", entities: [entity("m1")] });

            worker = await loadWorker();
            sqliteHooks.onStatements = (sql) => {
                if (sql.includes("sqlite_master")) {
                    sqliteHooks.onStatements = undefined;
                    throw Object.assign(new Error("header check failed"), { code: SQLite.SQLITE_NOTADB });
                }
            };
            failNextClose();
            await call("init", { mailboxUid: "mb1", indexKey: KEY });

            await expect(call("coverage", "mb1")).resolves.toMatchObject({ indexedCount: 0 });
        });

        it("rebuilds after a mid-session SQLITE_CORRUPT error code, even if closing the corrupted connection fails", async () => {
            const SQLite = await import("@journeyapps/wa-sqlite");
            await call("init", { mailboxUid: "mb1", indexKey: KEY });
            await call("indexEntities", { mailboxUid: "mb1", entities: [entity("m1")] });

            sqliteHooks.onStatements = (sql) => {
                if (sql.includes("MATCH")) {
                    sqliteHooks.onStatements = undefined;
                    throw Object.assign(new Error("database disk image problem"), { code: SQLite.SQLITE_CORRUPT });
                }
            };
            failNextClose();

            await expect(call("search", { mailboxUid: "mb1", parsed: { text: "budget" }, limit: 10 })).rejects.toThrow("database disk image problem");
            await expect(call("coverage", "mb1")).resolves.toMatchObject({ indexedCount: 0 });
        });

        it("leaves the mailbox uninitialized when rebuilding a corrupted index fails", async () => {
            await call("init", { mailboxUid: "mb1", indexKey: KEY });
            await call("indexEntities", { mailboxUid: "mb1", entities: [entity("m1")] });
            new Uint8Array(opfs.get("rapidmx-localsearch-mb1")!.get("/index.db")!.data).fill(0xff, 20, 60);
            busyDirectories.add("rapidmx-localsearch-mb1");

            await expect(call("search", { mailboxUid: "mb1", parsed: { text: "budget" }, limit: 10 })).rejects.toThrow();
            await expect(call("coverage", "mb1")).rejects.toThrow("init() was never called");
        });

        it("fails search soft for a non-Error throw, and rethrows other operations' ordinary failures without rebuilding", async () => {
            await call("init", { mailboxUid: "mb1", indexKey: KEY });
            await call("indexEntities", { mailboxUid: "mb1", entities: [entity("m1")] });

            sqliteHooks.onStatements = (sql) => {
                if (sql.includes("MATCH")) throw NON_ERROR("not an Error");
                if (sql.startsWith("DELETE FROM entities WHERE entity_uid")) throw new Error("disk full");
                if (sql.startsWith("UPDATE entities SET folder_uid")) throw NON_ERROR("move failed");
            };

            await expect(call("search", { mailboxUid: "mb1", parsed: { text: "budget" }, limit: 10 })).resolves.toEqual({ hits: [], hasMore: false });
            await expect(call("removeEntity", { mailboxUid: "mb1", entityUid: "m1" })).rejects.toThrow("disk full");
            messageListener!({ data: { id: 9, method: "moveEntity", params: { mailboxUid: "mb1", entityUid: "m1", folderUid: "archive" } } });
            await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ id: 9, ok: false, error: "move failed" }));

            sqliteHooks.onStatements = undefined;
            await expect(call("coverage", "mb1")).resolves.toMatchObject({ indexedCount: 1 });
        });

        it("reports a mailbox whose connection fails to close in destroyAll", async () => {
            await call("init", { mailboxUid: "mb1", indexKey: KEY });
            failNextClose();
            await expect(call("destroyAll")).resolves.toEqual({ failed: ["mb1"] });
        });
    });

    describe("byte budget edge cases", () => {
        async function seed() {
            await call("init", { mailboxUid: "mb1", indexKey: KEY });
            const body = "lorem ipsum dolor sit amet ".repeat(400);
            await call("indexEntities", {
                mailboxUid: "mb1",
                entities: Array.from({ length: 10 }, (_, i) => entity(`m${i}`, { dateForSort: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), body })),
            });
        }

        it("evicts nothing (and skips vacuuming) when the database already fits the budget", async () => {
            await seed();
            await call("setWindow", { mailboxUid: "mb1", timeFloorMonths: 12, byteBudgetBytes: 1_000_000_000 });
            await expect(call("indexEntities", { mailboxUid: "mb1", entities: [entity("extra")] })).resolves.toEqual({ budgetReached: false });
            await expect(call("coverage", "mb1")).resolves.toMatchObject({ indexedCount: 11 });
        });

        it("treats missing size pragmas and a missing row count as zero", async () => {
            await seed();
            sqliteHooks.nullColumnFor = /^PRAGMA (page_count|freelist_count|page_size)|^SELECT COUNT\(\*\) FROM entities/;
            await call("setWindow", { mailboxUid: "mb1", timeFloorMonths: 12, byteBudgetBytes: 1 });
            await expect(call("coverage", "mb1")).resolves.toMatchObject({ indexedCount: 0, fileBytes: 0 });
            sqliteHooks.nullColumnFor = undefined;
            await expect(call("coverage", "mb1")).resolves.toMatchObject({ indexedCount: 10 });
        });

        it("stops evicting when there is no row weight to size a cutoff from", async () => {
            await seed();
            sqliteHooks.nullColumnFor = /COALESCE\(SUM\(byte_size\)/;
            await call("setWindow", { mailboxUid: "mb1", timeFloorMonths: 12, byteBudgetBytes: 1 });
            sqliteHooks.nullColumnFor = undefined;
            await expect(call("coverage", "mb1")).resolves.toMatchObject({ indexedCount: 10 });
        });

        it("stops evicting when no rows come back to pick a cutoff from", async () => {
            await seed();
            sqliteHooks.noRowsFor = /^SELECT date_for_sort, rowid, byte_size/;
            await call("setWindow", { mailboxUid: "mb1", timeFloorMonths: 12, byteBudgetBytes: 1 });
            sqliteHooks.noRowsFor = undefined;
            await expect(call("coverage", "mb1")).resolves.toMatchObject({ indexedCount: 10 });
        });
    });
});
