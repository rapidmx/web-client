// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import {
    approveErasureRequest,
    createErasureRequest,
    denyErasureRequest,
    getErasureRequest,
    listErasureRequests,
} from "../../../lib/mail/erasureRequestApi.js";
import { createApiClient } from "../../../lib/util/api.js";

const request = {
    uid: "der1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    requestedByUserUid: "u1",
    status: "pending" as const,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("createErasureRequest", () => {
    it("posts with no body, always the caller's own mailbox", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, request));
        const result = await createErasureRequest();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/erasure-requests", expect.objectContaining({ method: "POST" }));
        expect(result).toEqual(request);
    });
});

describe("listErasureRequests", () => {
    it("fetches every visible request", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [request]));
        const result = await listErasureRequests();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/erasure-requests", expect.anything());
        expect(result).toEqual([request]);
    });

    it("forwards limit/page as query params", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listErasureRequests({ limit: 10, page: 2 });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/erasure-requests?limit=10&page=2", expect.anything());
    });
});

describe("getErasureRequest", () => {
    it("fetches the encoded uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, request));
        const result = await getErasureRequest("der/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/erasure-requests/der%2F1", expect.anything());
        expect(result).toEqual(request);
    });
});

describe("approveErasureRequest", () => {
    it("posts to the encoded uid's approve action", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...request, status: "approved" }));
        const result = await approveErasureRequest("der/1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/erasure-requests/der%2F1/approve",
            expect.objectContaining({ method: "POST" }),
        );
        expect(result.status).toBe("approved");
    });
});

describe("denyErasureRequest", () => {
    it("posts the reason to the encoded uid's deny action", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...request, status: "denied", reason: "not verified" }));
        const result = await denyErasureRequest("der/1", "not verified");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/erasure-requests/der%2F1/deny",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "not verified" }) }),
        );
        expect(result.reason).toBe("not verified");
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, request));

        await createErasureRequest(client);
        await listErasureRequests({}, client);
        await getErasureRequest("der1", client);
        await approveErasureRequest("der1", client);
        await denyErasureRequest("der1", "not verified", client);

        expect(fetchMock).toHaveBeenCalledTimes(5);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, request));
        await getErasureRequest("der1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/erasure-requests/der1", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
