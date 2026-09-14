// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    mailboxUidFromPoolName,
    poolNameFor,
    removeLocalIndexDirectories,
    removeLocalIndexDirectory,
} from "../../../apps/shared/search/localIndexStorage.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("localIndexStorage", () => {
    it("maps mailbox uids to pool names and back, ignoring unrelated or bare-prefix entries", () => {
        expect(mailboxUidFromPoolName(poolNameFor("mb1"))).toBe("mb1");
        expect(mailboxUidFromPoolName("rapidmx-localsearch-")).toBeUndefined();
        expect(mailboxUidFromPoolName("unrelated")).toBeUndefined();
    });

    it("has nothing to remove where there is no navigator at all", async () => {
        vi.stubGlobal("navigator", undefined);
        await expect(removeLocalIndexDirectory("mb1")).resolves.toBeUndefined();
        await expect(removeLocalIndexDirectories()).resolves.toEqual({ removed: [], failed: [] });
    });
});
