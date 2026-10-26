// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// A lock that lands while the local index key is being derived (WebCrypto's HKDF awaits): the derive still returns the real key, because
// WebCrypto copied the master key before the lock zeroed it, and the mailbox isn't open yet, so the index client's own lock watcher has
// nothing to destroy. Whatever opens the index next must notice the keys are gone and open nothing (spec §11 destroy-on-lock).
// Everything here is real - the key session, the lifecycle, the builder, Tier 2 search, the index client and the HKDF derive - except the
// mail API and the storage transport, which records what is open.
import React from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Folder } from "../../../lib/mail/mailApi.js";
import { destroyUnlockedKeys, getUnlockedKeys, installSharedSession, sharedUnlockGeneration } from "../../../lib/crypto/keySession.js";
import type { LocalIndexTransport } from "../../../apps/shared/search/localIndexTransport.js";
import { setLocalIndexTransport } from "../../../apps/shared/search/localIndexRpcClient.js";
import { searchLocalIndex } from "../../../apps/shared/search/searchTier2.js";
import { parseSearchQuery } from "../../../lib/search/queryGrammar.js";
import LocalIndexLifecycle from "../../../apps/shared/search/LocalIndexLifecycle.js";

vi.mock("../../../lib/mail/mailApi.js", () => ({
    listMessages: vi.fn(async () => []),
    listFolders: vi.fn(async () => []),
    getMessageRawContent: vi.fn(),
}));
vi.mock("../../../lib/crypto/keyvaultApi.js", () => ({ getKeyVault: vi.fn(async () => Promise.reject(new Error("no vault"))) }));
vi.mock("../../../apps/shared/search/zeroAccessIndexSync.js", () => ({
    importClientSegments: vi.fn(async () => 0),
    uploadClientDocuments: vi.fn(async () => 0),
    rememberZeroAccessMetadata: vi.fn(),
    syncZeroAccessIndex: vi.fn(async () => ({})),
}));

const folders = [{ uid: "inbox", type: "inbox" }] as Folder[];

/** Which mailboxes' indexes the transport holds open, with the key each was opened with. */
let open: Map<string, Uint8Array>;
let inits: string[];

function recordingTransport(): LocalIndexTransport {
    let generation = 0;
    return {
        nextGeneration: () => ++generation,
        init: async ({ mailboxUid, indexKey }) => {
            inits.push(mailboxUid);
            open.set(mailboxUid, indexKey);
        },
        indexEntities: async () => ({ budgetReached: false }),
        removeEntity: async () => undefined,
        moveEntity: async () => undefined,
        indexedVersions: async () => ({}),
        pruneEntities: async () => 0,
        search: async () => ({ hits: [], hasMore: false }),
        coverage: async () => ({}) as never,
        setWindow: async () => ({}),
        setBuilding: async () => undefined,
        destroy: async (mailboxUid) => open.delete(mailboxUid) || true,
        destroyAll: async () => {
            open.clear();
            return true;
        },
        pruneInaccessible: async () => undefined,
        retryPendingDeletions: async () => undefined,
    };
}

/** Locks `mailboxUid` the first time its index key's HKDF has computed its bits but not yet handed them back. */
function lockDuringNextDerive(mailboxUid: string): { fired: () => boolean } {
    let fired = false;
    const subtle = globalThis.crypto.subtle;
    const realDeriveBits = subtle.deriveBits.bind(subtle);
    vi.spyOn(subtle, "deriveBits").mockImplementation(async (...args: Parameters<SubtleCrypto["deriveBits"]>) => {
        const bits = await realDeriveBits(...args);
        if (!fired) {
            fired = true;
            destroyUnlockedKeys(mailboxUid);
        }
        return bits;
    });
    return { fired: () => fired };
}

function unlock(mailboxUid: string) {
    installSharedSession(mailboxUid, { masterKey: globalThis.crypto.getRandomValues(new Uint8Array(32)) }, sharedUnlockGeneration(mailboxUid));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(() => {
    open = new Map();
    inits = [];
    setLocalIndexTransport(recordingTransport());
});

afterEach(() => {
    vi.restoreAllMocks();
    destroyUnlockedKeys();
});

describe("a lock during the local index key's derive", () => {
    it("leaves no index open from the lifecycle's build", async () => {
        unlock("mb-build");
        const lock = lockDuringNextDerive("mb-build");
        const { unmount } = render(<LocalIndexLifecycle mailboxUid="mb-build" folders={folders} />);
        await vi.waitFor(() => expect(lock.fired()).toBe(true));
        await settle();
        expect(getUnlockedKeys("mb-build")).toBeUndefined();
        expect(open.has("mb-build")).toBe(false);
        expect(inits).not.toContain("mb-build");
        unmount();
    });

    it("leaves no index open from a Tier 2 search, which degrades to no local results", async () => {
        // The index client's lock watcher is already subscribed here (an earlier open), so only the late lock-count read lets it through.
        unlock("mb-other");
        await searchLocalIndex("mb-other", parseSearchQuery("hello"), getUnlockedKeys("mb-other"));
        unlock("mb-search");
        const unlocked = getUnlockedKeys("mb-search");
        const lock = lockDuringNextDerive("mb-search");
        const outcome = await searchLocalIndex("mb-search", parseSearchQuery("hello"), unlocked);
        await settle();
        expect(lock.fired()).toBe(true);
        expect(outcome).toEqual({ results: [], hasMore: false });
        expect(open.has("mb-search")).toBe(false);
        expect(inits).not.toContain("mb-search");
    });
});
