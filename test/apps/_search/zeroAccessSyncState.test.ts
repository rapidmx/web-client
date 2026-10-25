// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalIndexTransport } from "../../../apps/shared/search/localIndexTransport.js";
import {
    forgetAllZeroAccessSync,
    forgetZeroAccessSync,
    zeroAccessSyncEpoch,
    zeroAccessSyncStateKey,
} from "../../../apps/shared/search/zeroAccessSyncState.js";

afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
});

describe("zeroAccessSyncState", () => {
    it("forgets one mailbox's state, changing only its epoch", () => {
        localStorage.setItem(zeroAccessSyncStateKey("mb1"), "{}");
        localStorage.setItem(zeroAccessSyncStateKey("mb2"), "{}");
        const [mb1, mb2] = [zeroAccessSyncEpoch("mb1"), zeroAccessSyncEpoch("mb2")];

        forgetZeroAccessSync("mb1");

        expect(localStorage.getItem(zeroAccessSyncStateKey("mb1"))).toBeNull();
        expect(localStorage.getItem(zeroAccessSyncStateKey("mb2"))).toBe("{}");
        expect(zeroAccessSyncEpoch("mb1")).not.toBe(mb1);
        expect(zeroAccessSyncEpoch("mb2")).toBe(mb2);
    });

    it("forgets every mailbox's state, leaving other storage alone, and changes every epoch", () => {
        localStorage.setItem(zeroAccessSyncStateKey("mb1"), "{}");
        localStorage.setItem(zeroAccessSyncStateKey("mb2"), "{}");
        localStorage.setItem("unrelated", "kept");
        const epoch = zeroAccessSyncEpoch("mb3");

        forgetAllZeroAccessSync();

        expect(localStorage.length).toBe(1);
        expect(localStorage.getItem("unrelated")).toBe("kept");
        expect(zeroAccessSyncEpoch("mb3")).not.toBe(epoch);
    });

    it("works on without storage", () => {
        vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
            throw new Error("blocked");
        });
        localStorage.setItem(zeroAccessSyncStateKey("mb1"), "{}");
        const epoch = zeroAccessSyncEpoch("mb1");
        expect(() => forgetZeroAccessSync("mb1")).not.toThrow();
        expect(() => forgetAllZeroAccessSync()).not.toThrow();
        expect(zeroAccessSyncEpoch("mb1")).not.toBe(epoch);
    });

    it("is forgotten whenever the local index is destroyed, whatever the transport", async () => {
        const rpc = await import("../../../apps/shared/search/localIndexRpcClient.js");
        const transport = { destroy: vi.fn(async () => true), destroyAll: vi.fn(async () => true) } as unknown as LocalIndexTransport;
        rpc.setLocalIndexTransport(transport);
        try {
            localStorage.setItem(zeroAccessSyncStateKey("mb1"), "{}");
            localStorage.setItem(zeroAccessSyncStateKey("mb2"), "{}");
            await rpc.destroyLocalIndex("mb1");
            expect(localStorage.getItem(zeroAccessSyncStateKey("mb1"))).toBeNull();
            expect(localStorage.getItem(zeroAccessSyncStateKey("mb2"))).toBe("{}");
            await rpc.destroyAllLocalIndexes();
            expect(localStorage.getItem(zeroAccessSyncStateKey("mb2"))).toBeNull();
        } finally {
            rpc.setLocalIndexTransport(rpc.workerLocalIndexTransport);
        }
    });
});
