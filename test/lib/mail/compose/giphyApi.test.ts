// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import { createApiClient } from "../../../../lib/util/api.js";
import { searchGifs } from "../../../../lib/mail/compose/giphyApi.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("searchGifs", () => {
    it("sends the trimmed query as q", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await searchGifs("  cats  ");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/giphy/search?q=cats", expect.anything());
    });

    it("omits q entirely for an empty/whitespace-only query, returning the trending feed", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await searchGifs("   ");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/giphy/search?", expect.anything());
    });

    it("resolves with the parsed GIF list", async () => {
        const gifs = [{ id: "1", previewUrl: "p", url: "u", title: "t" }];
        mockFetch(() => jsonResponse(200, gifs));
        await expect(searchGifs("cats")).resolves.toEqual(gifs);
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, []));

        await searchGifs("cats", client);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await searchGifs("cats");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/giphy/search?q=cats", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
