// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// setLocalIndexTransport()'s own contract, not the Worker mechanics again (localIndexRpcClient.test.ts already
// covers those in full, unmodified, against the default transport): every function localIndexRpcClient.ts exports
// is a thin delegator to whichever LocalIndexTransport is current, a swap actually redirects every one of them to
// the new implementation, and a plain test double satisfies the interface with no Worker/BroadcastChannel/OPFS
// globals in scope at all.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
    Coverage,
    IndexEntitiesResult,
    LocalSearchPage,
    WindowState,
} from "../../../apps/shared/search/localIndexWorker.js";
import type { LocalIndexTransport } from "../../../apps/shared/search/localIndexTransport.js";

type RpcModule = typeof import("../../../apps/shared/search/localIndexRpcClient.js");

let rpc: RpcModule;

beforeEach(async () => {
    // A fresh module instance per test - `setLocalIndexTransport()` is module-level state, and the default
    // (workerLocalIndexTransport) must be what every *other* test file's fresh import still gets.
    vi.resetModules();
    rpc = await import("../../../apps/shared/search/localIndexRpcClient.js");
});

/** A minimal transport double: every method records the arguments it was called with and returns a fixed,
 * recognizable value distinct from anything the real Worker transport would produce - so a call that actually
 * reached the Worker path (instead of this fake) fails loudly rather than coincidentally matching. */
function fakeTransport() {
    const calls: Record<string, unknown[]> = {};
    const record = <A extends unknown[], R>(name: string, result: R) => {
        return (...args: A): Promise<R> => {
            calls[name] = args;
            return Promise.resolve(result);
        };
    };
    const coverage: Coverage = { indexedCount: 3, building: false };
    const page: LocalSearchPage = { hits: [{ entityUid: "m1", score: -1, snippet: "s" }], hasMore: false };
    const windowState: WindowState = { evictedBefore: "2025-01-01T00:00:00.000Z" };
    const indexResult: IndexEntitiesResult = { budgetReached: false };
    const transport: LocalIndexTransport = {
        nextGeneration: () => {
            calls.nextGeneration = [];
            return 99;
        },
        init: record("init", undefined),
        indexEntities: record("indexEntities", indexResult),
        removeEntity: record("removeEntity", undefined),
        moveEntity: record("moveEntity", undefined),
        indexedVersions: record("indexedVersions", { m1: "1:f" }),
        pruneEntities: record("pruneEntities", 7),
        search: record("search", page),
        coverage: record("coverage", coverage),
        setWindow: record("setWindow", windowState),
        setBuilding: record("setBuilding", undefined),
        destroy: record("destroy", true),
        destroyAll: record("destroyAll", true),
        pruneInaccessible: record("pruneInaccessible", undefined),
        retryPendingDeletions: record("retryPendingDeletions", undefined),
    };
    return { transport, calls };
}

describe("localIndexRpcClient's swappable transport", () => {
    it("exports workerLocalIndexTransport implementing every LocalIndexTransport method", () => {
        const methods: (keyof LocalIndexTransport)[] = [
            "nextGeneration",
            "init",
            "indexEntities",
            "removeEntity",
            "moveEntity",
            "indexedVersions",
            "pruneEntities",
            "search",
            "coverage",
            "setWindow",
            "setBuilding",
            "destroy",
            "destroyAll",
            "pruneInaccessible",
            "retryPendingDeletions",
        ];
        for (const method of methods) {
            expect(typeof rpc.workerLocalIndexTransport[method]).toBe("function");
        }
    });

    it("defaults to the Worker transport - an untouched export really does try to reach a Worker", async () => {
        // No `Worker` global exists in this (node) environment - the default transport's attempt to construct
        // one therefore rejects, proving this call went to the real Worker-backed implementation and not some
        // no-op default.
        await expect(rpc.getLocalCoverage("mb1")).rejects.toThrow();
    });

    it("setLocalIndexTransport() redirects every exported function to the new transport", async () => {
        const { transport, calls } = fakeTransport();
        rpc.setLocalIndexTransport(transport);

        expect(rpc.nextLocalIndexGeneration()).toBe(99);

        await expect(rpc.initLocalIndex({ mailboxUid: "mb1", indexKey: new Uint8Array(32) })).resolves.toBeUndefined();
        expect(calls.init).toEqual([{ mailboxUid: "mb1", indexKey: expect.any(Uint8Array) }]);

        await expect(rpc.indexLocalEntities("mb1", [], 5)).resolves.toEqual({ budgetReached: false });
        expect(calls.indexEntities).toEqual(["mb1", [], 5]);

        await expect(rpc.removeLocalEntity("mb1", "m1")).resolves.toBeUndefined();
        expect(calls.removeEntity).toEqual(["mb1", "m1"]);

        await expect(rpc.moveLocalEntity("mb1", "m1", "archive")).resolves.toBeUndefined();
        expect(calls.moveEntity).toEqual(["mb1", "m1", "archive"]);

        await expect(rpc.getIndexedVersions("mb1", ["m1"])).resolves.toEqual({ m1: "1:f" });
        expect(calls.indexedVersions).toEqual(["mb1", ["m1"]]);

        await expect(rpc.pruneLocalEntities("mb1", ["m1"], "2026-01-01")).resolves.toBe(7);
        // The wrapper's own default (`options = {}`) is resolved before the transport ever sees it - a fake
        // transport is never asked to invent that default itself.
        expect(calls.pruneEntities).toEqual(["mb1", ["m1"], "2026-01-01", {}]);

        await expect(rpc.searchLocal("mb1", { text: "x" }, 10)).resolves.toEqual({ hits: [{ entityUid: "m1", score: -1, snippet: "s" }], hasMore: false });
        expect(calls.search).toEqual(["mb1", { text: "x" }, 10, 0]);

        await expect(rpc.getLocalCoverage("mb1")).resolves.toEqual({ indexedCount: 3, building: false });
        expect(calls.coverage).toEqual(["mb1"]);

        await expect(rpc.setLocalIndexWindow("mb1", 12, 100)).resolves.toEqual({ evictedBefore: "2025-01-01T00:00:00.000Z" });
        expect(calls.setWindow).toEqual(["mb1", 12, 100, undefined]);

        await expect(rpc.setLocalIndexBuilding("mb1", true)).resolves.toBeUndefined();
        expect(calls.setBuilding).toEqual(["mb1", true, { complete: false }]);

        await expect(rpc.destroyLocalIndex("mb1")).resolves.toBe(true);
        expect(calls.destroy).toEqual(["mb1"]);

        await expect(rpc.destroyAllLocalIndexes()).resolves.toBe(true);
        expect(calls.destroyAll).toEqual([rpc.DESTROY_ALL_TIMEOUT_MS]);

        await expect(rpc.pruneInaccessibleLocalIndexes(["mb1"])).resolves.toBeUndefined();
        expect(calls.pruneInaccessible).toEqual([["mb1"]]);

        await expect(rpc.retryPendingLocalIndexDeletions()).resolves.toBeUndefined();
        expect(calls.retryPendingDeletions).toEqual([]);

        // None of the above ever touched the real Worker transport's own bookkeeping.
        expect(typeof calls.nextGeneration).not.toBe("undefined");
    });

    it("a later setLocalIndexTransport() call replaces the previous transport outright, not merges with it", async () => {
        const first = fakeTransport();
        const second = fakeTransport();
        rpc.setLocalIndexTransport(first.transport);
        rpc.setLocalIndexTransport(second.transport);

        await rpc.getLocalCoverage("mb1");

        expect(first.calls.coverage).toBeUndefined();
        expect(second.calls.coverage).toEqual(["mb1"]);
    });

    it("swapping the transport never touches workerLocalIndexTransport itself - it stays available to switch back to", async () => {
        const { transport } = fakeTransport();
        rpc.setLocalIndexTransport(transport);
        rpc.setLocalIndexTransport(rpc.workerLocalIndexTransport);

        // Back on the Worker transport, in this (node) environment with no `Worker` global - the same proof
        // of "really is the Worker path" as the defaulting test above.
        await expect(rpc.getLocalCoverage("mb1")).rejects.toThrow();
    });
});
