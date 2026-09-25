// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// No DOM needed - this only exercises searchTier2.ts's own orchestration (initializing the index,
// negating bm25 scores, degrading gracefully) with the Worker/RPC layer mocked out entirely. The Worker
// itself (localIndexWorker.ts, the real WASM/OPFS/FTS5 machinery) cannot run under Vitest at all - no
// environment here implements OPFS - so it's covered instead by localIndexBlockCipher.test.ts (the
// crypto, with real WebCrypto) and by manual browser verification, per this feature's own
// implementation plan.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedSearchQuery } from "@rapidmx/react-shared/search/queryGrammar.js";
import type { UnlockedKeys } from "@rapidmx/react-shared/crypto/keySession.js";
import { searchLocalIndex } from "../../../apps/shared/search/searchTier2.js";

const { initLocalIndex, searchLocal, getLocalCoverage } = vi.hoisted(() => ({
    initLocalIndex: vi.fn(),
    searchLocal: vi.fn(),
    getLocalCoverage: vi.fn(),
}));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => ({ initLocalIndex, searchLocal, getLocalCoverage }));

const { deriveLocalIndexKey } = vi.hoisted(() => ({ deriveLocalIndexKey: vi.fn() }));
vi.mock("../../../apps/shared/search/localIndexKey.js", () => ({ deriveLocalIndexKey }));

function parsedQuery(overrides: Partial<ParsedSearchQuery> = {}): ParsedSearchQuery {
    return { text: "budget", ...overrides };
}

const unlocked = { masterKey: new Uint8Array(32) } as UnlockedKeys;

// `clearMocks` only forgets calls: the `mockRejectedValue()` a test gave `initLocalIndex` would otherwise still be there for whichever test runs next.
beforeEach(() => {
    for (const mock of [initLocalIndex, searchLocal, getLocalCoverage, deriveLocalIndexKey]) {
        mock.mockReset();
    }
});

describe("searchTier2 (local index)", () => {
    it("returns no results and no coverage without unlocked keys, without touching the RPC client at all", async () => {
        const outcome = await searchLocalIndex("mb1", parsedQuery(), undefined);

        expect(outcome).toEqual({ results: [], hasMore: false });
        expect(initLocalIndex).not.toHaveBeenCalled();
    });

    it("derives the index key, initializes the connection, and returns negated-score, already-sourced results plus coverage/hasMore", async () => {
        deriveLocalIndexKey.mockResolvedValue(new Uint8Array(32).fill(7));
        searchLocal.mockResolvedValue({ hits: [{ entityUid: "m1", score: -3.2, snippet: "…the budget…" }], hasMore: true });
        getLocalCoverage.mockResolvedValue({ indexedFrom: "2025-06-01T00:00:00.000Z", indexedCount: 12, building: false });

        const outcome = await searchLocalIndex("mb1", parsedQuery(), unlocked, 25, 25);

        expect(deriveLocalIndexKey).toHaveBeenCalledWith(unlocked.masterKey, "mb1");
        expect(initLocalIndex).toHaveBeenCalledWith({ mailboxUid: "mb1", indexKey: expect.any(Uint8Array) });
        expect(searchLocal).toHaveBeenCalledWith("mb1", expect.objectContaining({ text: "budget" }), 25, 25);
        // Negated: SQLite's bm25() is "more negative is better," the opposite of every other tier's own
        // score convention - see searchTier2.ts's own doc comment on why this negates exactly once, here.
        expect(outcome.results).toEqual([
            { entityType: "message", entityUid: "m1", score: 3.2, snippet: "…the budget…", source: "local", metadataOnly: false },
        ]);
        expect(outcome.coverage).toEqual({ indexedFrom: "2025-06-01T00:00:00.000Z", indexedCount: 12, building: false });
        expect(outcome.hasMore).toBe(true);
    });

    it("degrades to no results (never rejects) when the local index throws for any reason", async () => {
        deriveLocalIndexKey.mockResolvedValue(new Uint8Array(32));
        initLocalIndex.mockRejectedValue(new Error("Worker is not defined"));

        await expect(searchLocalIndex("mb1", parsedQuery(), unlocked)).resolves.toEqual({ results: [], hasMore: false });
    });

    describe("timeout (a wedged Worker that never crashes and never answers)", () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it("degrades to no results once the timeout elapses, instead of hanging forever", async () => {
            vi.useFakeTimers();
            deriveLocalIndexKey.mockResolvedValue(new Uint8Array(32));
            initLocalIndex.mockResolvedValue(undefined);
            // Never resolve - the stand-in for a wedged Worker that posts no response at all.
            searchLocal.mockReturnValue(new Promise(() => undefined));
            getLocalCoverage.mockReturnValue(new Promise(() => undefined));

            const outcome = searchLocalIndex("mb1", parsedQuery(), unlocked, 25, 0, 1_000);
            await vi.advanceTimersByTimeAsync(1_000);

            await expect(outcome).resolves.toEqual({ results: [], hasMore: false });
        });

        it("still returns the real results when they arrive comfortably inside the timeout", async () => {
            vi.useFakeTimers();
            deriveLocalIndexKey.mockResolvedValue(new Uint8Array(32));
            initLocalIndex.mockResolvedValue(undefined);
            searchLocal.mockResolvedValue({ hits: [{ entityUid: "m1", score: -1, snippet: "hi" }], hasMore: false });
            getLocalCoverage.mockResolvedValue({ indexedFrom: "2025-06-01T00:00:00.000Z", indexedCount: 1, building: false });

            const outcome = await searchLocalIndex("mb1", parsedQuery(), unlocked, 25, 0, 1_000);

            expect(outcome.results).toHaveLength(1);
        });
    });
});
