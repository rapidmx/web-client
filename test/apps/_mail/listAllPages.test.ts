///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it, vi } from "vitest";
import { LIST_PAGE_SIZE, MAX_LIST_PAGES, listAllPages } from "../../../apps/shared/mail/listAllPages.js";

describe("listAllPages", () => {
    it("stops at the first short page", async () => {
        const fetchPage = vi.fn(async (page: number) => (page < 2 ? [page * 10, page * 10 + 1] : [99]));
        expect(await listAllPages(fetchPage, 2, 10)).toEqual({ items: [0, 1, 10, 11, 99], truncated: false });
        expect(fetchPage.mock.calls.map(([page]) => page)).toEqual([0, 1, 2]);
    });

    it("stops after an empty page when the total is an exact multiple of the page size", async () => {
        const fetchPage = vi.fn(async (page: number) => (page === 0 ? ["a", "b"] : []));
        expect(await listAllPages(fetchPage, 2, 10)).toEqual({ items: ["a", "b"], truncated: false });
        expect(fetchPage).toHaveBeenCalledTimes(2);
    });

    it("gives up after maxPages when every page is full, reporting the result as truncated", async () => {
        const fetchPage = vi.fn(async () => [1, 2]);
        expect(await listAllPages(fetchPage, 2, 3)).toEqual({ items: [1, 2, 1, 2, 1, 2], truncated: true });
        expect(fetchPage).toHaveBeenCalledTimes(3);
    });

    it("defaults to the server's 500-item page size", async () => {
        const fetchPage = vi.fn(async () => []);
        await listAllPages(fetchPage);
        expect(LIST_PAGE_SIZE).toBe(500);
        expect(MAX_LIST_PAGES).toBeGreaterThan(1);
        expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it("propagates a failed page", async () => {
        await expect(listAllPages(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    });
});
