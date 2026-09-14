// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The RPC client's own responsibilities: request/response correlation, the no-op rules for in-session
// mutations, and sign-out/sign-in cleanup reaching indexes this page load never opened. The Worker is a
// scripted fake; OPFS is a fake root directory.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RpcModule = typeof import("../../../apps/shared/search/localIndexRpcClient.js");

interface Posted {
    id: number;
    method: string;
    params?: unknown;
}

let posted: Posted[];
let respond: (message: Posted) => { ok: true; result: unknown } | { ok: false; error: string } | undefined;
let rootEntries: Set<string>;
let rpc: RpcModule;

class FakeWorker {
    static instances = 0;
    static latest: FakeWorker | undefined;
    #listener: ((event: { data: unknown }) => void) | undefined;
    constructor() {
        FakeWorker.instances += 1;
        FakeWorker.latest = this;
    }
    /** Delivers an arbitrary message, as if the Worker had posted it unprompted. */
    emit(data: unknown) {
        this.#listener?.({ data });
    }
    addEventListener(_type: string, listener: (event: { data: unknown }) => void) {
        this.#listener = listener;
    }
    postMessage(message: Posted) {
        posted.push(message);
        const reply = respond(message);
        if (reply) {
            queueMicrotask(() => this.#listener?.({ data: { id: message.id, ...reply } }));
        }
    }
}

beforeEach(async () => {
    posted = [];
    respond = () => ({ ok: true, result: undefined });
    rootEntries = new Set();
    FakeWorker.instances = 0;
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("navigator", {
        storage: {
            getDirectory: async () => ({
                async removeEntry(name: string) {
                    if (name.endsWith("busy")) {
                        throw Object.assign(new Error("busy"), { name: "NoModificationAllowedError" });
                    }
                    rootEntries.delete(name);
                },
                async *keys() {
                    yield* [...rootEntries];
                },
            }),
        },
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.resetModules();
    rpc = await import("../../../apps/shared/search/localIndexRpcClient.js");
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("localIndexRpcClient", () => {
    it("correlates responses by id and rejects with the Worker's error message", async () => {
        respond = (message) => (message.method === "coverage" ? { ok: false, error: "nope" } : { ok: true, result: { hits: [], hasMore: false } });
        await expect(rpc.searchLocal("mb1", { text: "x" }, 5)).resolves.toEqual({ hits: [], hasMore: false });
        await expect(rpc.getLocalCoverage("mb1")).rejects.toThrow("nope");
        expect(posted.map((p) => p.method)).toEqual(["search", "coverage"]);
        expect(FakeWorker.instances).toBe(1);
    });

    it("rejects instead of throwing synchronously when a Worker can't be created at all", async () => {
        vi.stubGlobal("Worker", undefined);
        await expect(rpc.initLocalIndex({ mailboxUid: "mb1", indexKey: new Uint8Array(32) })).rejects.toThrow();
    });

    it("removeLocalEntity/moveLocalEntity are no-ops (no Worker spawned) for a mailbox not indexed in this tab, and never reject", async () => {
        await rpc.removeLocalEntity("mb1", "m1");
        await rpc.moveLocalEntity("mb1", "m1", "archive");
        expect(FakeWorker.instances).toBe(0);

        await rpc.initLocalIndex({ mailboxUid: "mb1", indexKey: new Uint8Array(32) });
        respond = (message) => (message.method === "removeEntity" ? { ok: false, error: "boom" } : { ok: true, result: undefined });
        await expect(rpc.removeLocalEntity("mb1", "m1")).resolves.toBeUndefined();
        await rpc.moveLocalEntity("mb1", "m1", "archive");
        expect(posted.slice(1)).toEqual([
            { id: expect.any(Number), method: "removeEntity", params: { mailboxUid: "mb1", entityUid: "m1" } },
            { id: expect.any(Number), method: "moveEntity", params: { mailboxUid: "mb1", entityUid: "m1", folderUid: "archive" } },
        ]);
    });

    it("passes build bookkeeping calls straight through", async () => {
        respond = (message) => ({ ok: true, result: message.method === "indexedVersions" ? { m1: "1:f" } : message.method === "pruneEntities" ? 2 : { budgetReached: true } });
        await expect(rpc.getIndexedVersions("mb1", ["m1"])).resolves.toEqual({ m1: "1:f" });
        await expect(rpc.pruneLocalEntities("mb1", ["m1"], "2026-01-01")).resolves.toBe(2);
        await expect(rpc.indexLocalEntities("mb1", [])).resolves.toEqual({ budgetReached: true });
        await rpc.setLocalIndexWindow("mb1", 12, 100);
        await rpc.setLocalIndexBuilding("mb1", false, { complete: true, coveredFrom: "2025-01-01" });
        await rpc.setLocalIndexBuilding("mb1", true);
        expect(posted.slice(-2).map((p) => p.params)).toEqual([
            { mailboxUid: "mb1", building: false, complete: true, coveredFrom: "2025-01-01" },
            { mailboxUid: "mb1", building: true, complete: false },
        ]);
    });

    it("destroyLocalIndex resolves false and logs when the Worker couldn't remove the index", async () => {
        respond = () => ({ ok: false, error: "in use by another tab" });
        await expect(rpc.destroyLocalIndex("mb1")).resolves.toBe(false);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("in use by another tab"));
        respond = () => ({ ok: true, result: undefined });
        await expect(rpc.destroyLocalIndex("mb1")).resolves.toBe(true);
    });

    it("destroyAllLocalIndexes removes every index directory on the device without booting a Worker when none is running", async () => {
        rootEntries = new Set(["rapidmx-localsearch-never-opened", "rapidmx-localsearch-other-user", "unrelated"]);
        await expect(rpc.destroyAllLocalIndexes()).resolves.toBe(true);
        expect([...rootEntries]).toEqual(["unrelated"]);
        expect(FakeWorker.instances).toBe(0);
    });

    it("destroyAllLocalIndexes closes this tab's open indexes through the Worker first, and reports anything left behind", async () => {
        await rpc.initLocalIndex({ mailboxUid: "mb1", indexKey: new Uint8Array(32) });
        respond = (message) => (message.method === "destroyAll" ? { ok: true, result: { failed: [] } } : { ok: true, result: undefined });
        rootEntries = new Set(["rapidmx-localsearch-busy"]);
        await expect(rpc.destroyAllLocalIndexes()).resolves.toBe(false);
        expect(posted.map((p) => p.method)).toEqual(["init", "destroyAll"]);
        // In-session helpers are no-ops again afterwards.
        await rpc.removeLocalEntity("mb1", "m1");
        expect(posted).toHaveLength(2);
    });

    it("destroyAllLocalIndexes gives up after its timeout instead of blocking sign-out", async () => {
        await rpc.initLocalIndex({ mailboxUid: "mb1", indexKey: new Uint8Array(32) });
        respond = (message) => (message.method === "destroyAll" ? undefined : { ok: true, result: undefined }); // never answers
        vi.useFakeTimers();
        const result = rpc.destroyAllLocalIndexes(1_000);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(result).resolves.toBe(false);
    });

    it("destroyAllLocalIndexes counts a Worker-side failure as not fully destroyed", async () => {
        await rpc.initLocalIndex({ mailboxUid: "mb1", indexKey: new Uint8Array(32) });
        respond = (message) => (message.method === "destroyAll" ? { ok: false, error: "crashed" } : { ok: true, result: undefined });
        await expect(rpc.destroyAllLocalIndexes()).resolves.toBe(false);
    });

    it("pruneInaccessibleLocalIndexes keeps only the accessible mailboxes' indexes", async () => {
        rootEntries = new Set(["rapidmx-localsearch-mine", "rapidmx-localsearch-shared", "rapidmx-localsearch-previous-user"]);
        await rpc.pruneInaccessibleLocalIndexes(["mine", "shared"]);
        expect([...rootEntries].sort()).toEqual(["rapidmx-localsearch-mine", "rapidmx-localsearch-shared"]);
    });

    it("ignores a response whose id matches no pending request", async () => {
        await rpc.getLocalCoverage("mb1");
        expect(() => FakeWorker.latest!.emit({ id: 9999, ok: true, result: "stray" })).not.toThrow();
        await expect(rpc.getLocalCoverage("mb1")).resolves.toBeUndefined();
    });

    it("wraps a non-Error thrown by postMessage in an Error", async () => {
        const nonError: unknown = "DataCloneError";
        vi.stubGlobal(
            "Worker",
            class {
                addEventListener() {
                    return undefined;
                }
                postMessage() {
                    throw nonError;
                }
            },
        );
        await expect(rpc.getLocalCoverage("mb1")).rejects.toThrow("DataCloneError");
    });

    it("moveLocalEntity never rejects even when the Worker fails the move", async () => {
        await rpc.initLocalIndex({ mailboxUid: "mb1", indexKey: new Uint8Array(32) });
        respond = (message) => (message.method === "moveEntity" ? { ok: false, error: "boom" } : { ok: true, result: undefined });
        await expect(rpc.moveLocalEntity("mb1", "m1", "archive")).resolves.toBeUndefined();
    });

    it("destroyAllLocalIndexes and pruneInaccessibleLocalIndexes never reject when OPFS itself fails", async () => {
        vi.stubGlobal("navigator", {
            storage: {
                getDirectory: async () => {
                    throw new Error("SecurityError");
                },
            },
        });
        await expect(rpc.destroyAllLocalIndexes()).resolves.toBe(false);
        await expect(rpc.pruneInaccessibleLocalIndexes(["mine"])).resolves.toBeUndefined();
    });

    it("does nothing where OPFS isn't available", async () => {
        vi.stubGlobal("navigator", {});
        await expect(rpc.destroyAllLocalIndexes()).resolves.toBe(true);
        await expect(rpc.pruneInaccessibleLocalIndexes(["mine"])).resolves.toBeUndefined();
    });
});
