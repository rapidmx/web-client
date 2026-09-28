// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { createApiClient } from "../../../lib/util/api.js";
import { searchMatter } from "../../../lib/admin/matterSearchApi.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("searchMatter", () => {
    it("fetches against escrow/matter-search with the matterId and query text", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { mb1: { results: [] } }));
        const result = await searchMatter("m1", "budget");
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/matter-search?q=budget&matterId=m1", expect.anything());
        expect(result).toEqual({ mb1: { results: [] } });
    });

    it("forwards structured operator-grammar filters, reusing search/searchApi.ts's own param grammar", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        await searchMatter("m1", "", { subject: "quarterly", hasAttachment: true, folderUid: "f1" });
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe("/api/escrow/matter-search?q=&subject=quarterly&hasAttachment=true&in=f1&matterId=m1");
    });

    it("returns results keyed by mailboxUid, one page per custodian", async () => {
        mockFetch(() => jsonResponse(200, { mb1: { results: [{ entityType: "message", entityUid: "msg1", score: 1 }] }, mb2: { results: [] } }));
        const result = await searchMatter("m1", "budget");
        expect(Object.keys(result)).toEqual(["mb1", "mb2"]);
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, {}));

        await searchMatter("m1", "budget", {}, client);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        await searchMatter("m1", "budget");
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/matter-search?q=budget&matterId=m1", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
