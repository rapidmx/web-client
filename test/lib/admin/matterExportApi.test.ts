// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import {
    createMatterExportRequest,
    getMatterExportRequest,
    listMatterExportRequests,
    matterExportRequestDownloadUrl,
} from "../../../lib/admin/matterExportApi.js";
import { configureApiBaseUrl, createApiClient } from "../../../lib/util/api.js";

const request = {
    uid: "mer1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    matterId: "m1",
    requestedByUserUid: "u1",
    status: "pending" as const,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("createMatterExportRequest", () => {
    it("posts the matterId", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, request));
        const result = await createMatterExportRequest("m1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/escrow/matter-export-requests",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ matterId: "m1" }) }),
        );
        expect(result).toEqual(request);
    });
});

describe("listMatterExportRequests", () => {
    it("fetches every request the caller holds a scope for", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [request]));
        const result = await listMatterExportRequests();
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/matter-export-requests", expect.anything());
        expect(result).toEqual([request]);
    });

    it("forwards limit/page/matterId as query params", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listMatterExportRequests({ limit: 50, page: 1, matterId: "m 1" });
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/matter-export-requests?limit=50&page=1&matterId=m+1", expect.anything());
    });
});

describe("getMatterExportRequest", () => {
    it("fetches the encoded uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, request));
        const result = await getMatterExportRequest("mer/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/matter-export-requests/mer%2F1", expect.anything());
        expect(result).toEqual(request);
    });
});

describe("matterExportRequestDownloadUrl", () => {
    it("builds the same-origin download URL for an encoded uid", () => {
        expect(matterExportRequestDownloadUrl("mer/1")).toBe("/api/escrow/matter-export-requests/mer%2F1/download");
    });

    it("prefixes the configured API base URL", () => {
        configureApiBaseUrl("https://mail.example.com");
        try {
            expect(matterExportRequestDownloadUrl("mer1")).toBe("https://mail.example.com/api/escrow/matter-export-requests/mer1/download");
        } finally {
            configureApiBaseUrl("");
        }
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, request));

        await createMatterExportRequest("m1", client);
        await listMatterExportRequests({}, client);
        await getMatterExportRequest("mer1", client);

        expect(fetchMock).toHaveBeenCalledTimes(3);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, [request]));
        await listMatterExportRequests();
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/matter-export-requests", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
