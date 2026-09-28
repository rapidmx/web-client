// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import {
    createExportRequest,
    exportRequestDownloadUrl,
    getExportRequest,
    listExportRequests,
} from "../../../lib/mail/dataExportApi.js";
import { configureApiBaseUrl, createApiClient } from "../../../lib/util/api.js";

const request = {
    uid: "der1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    requestedByUserUid: "u1",
    format: "json" as const,
    status: "pending" as const,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("createExportRequest", () => {
    it("posts the format, own mailbox implied", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, request));
        const result = await createExportRequest({ format: "json" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/data-export-requests",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ format: "json" }) }),
        );
        expect(result).toEqual(request);
    });

    it("forwards an explicit mailboxUid, only meaningful for a trusted caller", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...request, mailboxUid: "mb2" }));
        await createExportRequest({ format: "mbox", mailboxUid: "mb2" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/data-export-requests",
            expect.objectContaining({ body: JSON.stringify({ format: "mbox", mailboxUid: "mb2" }) }),
        );
    });
});

describe("listExportRequests", () => {
    it("fetches every visible request", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [request]));
        const result = await listExportRequests();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/data-export-requests", expect.anything());
        expect(result).toEqual([request]);
    });

    it("forwards only the page when limit is omitted", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listExportRequests({ page: 3 });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/data-export-requests?page=3", expect.anything());
    });
});

describe("getExportRequest", () => {
    it("fetches the encoded uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, request));
        const result = await getExportRequest("der/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/data-export-requests/der%2F1", expect.anything());
        expect(result).toEqual(request);
    });
});

describe("exportRequestDownloadUrl", () => {
    it("builds the same-origin download URL for an encoded uid", () => {
        expect(exportRequestDownloadUrl("der/1")).toBe("/api/mail/data-export-requests/der%2F1/download");
    });

    it("prefixes the configured API base URL", () => {
        configureApiBaseUrl("https://mail.example.com");
        try {
            expect(exportRequestDownloadUrl("der1")).toBe("https://mail.example.com/api/mail/data-export-requests/der1/download");
        } finally {
            configureApiBaseUrl("");
        }
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, request));

        await createExportRequest({ format: "json" }, client);
        await listExportRequests({}, client);
        await getExportRequest("der1", client);

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
        await listExportRequests();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/data-export-requests", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
