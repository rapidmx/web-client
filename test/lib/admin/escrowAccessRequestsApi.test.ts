// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { createApiClient } from "../../../lib/util/api.js";
import {
    approveAccessRequest,
    createAccessRequest,
    denyAccessRequest,
    getAccessRequest,
    getAccessRequestMaterial,
    listAccessRequests,
} from "../../../lib/admin/escrowAccessRequestsApi.js";

const request = {
    uid: "ar1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    matterId: "m1",
    mailboxUid: "mb1",
    requestedByUserUid: "u1",
    approvals: [{ holderUserUid: "u1", approvedAt: "2026-01-01T00:00:00.000Z" }],
    requiredHoldersAtCreation: 2,
    status: "pending" as const,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("listAccessRequests", () => {
    it("fetches with default pagination", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [request]));
        const result = await listAccessRequests();
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/access-requests?limit=25&page=0", expect.anything());
        expect(result).toEqual([request]);
    });

    it("forwards a custom page/limit", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listAccessRequests({ page: 2, limit: 10 });
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/access-requests?limit=10&page=2", expect.anything());
    });

    it("narrows to one matterId when given", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listAccessRequests({ matterId: "m/1" });
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/access-requests?limit=25&page=0&matterId=m%2F1", expect.anything());
    });
});

describe("getAccessRequest", () => {
    it("fetches the encoded uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, request));
        const result = await getAccessRequest("ar/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/access-requests/ar%2F1", expect.anything());
        expect(result).toEqual(request);
    });
});

describe("createAccessRequest", () => {
    it("posts matterId/mailboxUid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, request));
        await createAccessRequest({ matterId: "m1", mailboxUid: "mb1" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/escrow/access-requests",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ matterId: "m1", mailboxUid: "mb1" }),
            }),
        );
    });
});

describe("approveAccessRequest", () => {
    it("POSTs to the approve sub-route with the encoded uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...request, status: "approved" }));
        const result = await approveAccessRequest("ar/1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/escrow/access-requests/ar%2F1/approve",
            expect.objectContaining({ method: "POST" }),
        );
        expect(result.status).toBe("approved");
    });
});

describe("denyAccessRequest", () => {
    it("POSTs to the deny sub-route with the encoded uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...request, status: "denied" }));
        const result = await denyAccessRequest("ar/1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/escrow/access-requests/ar%2F1/deny",
            expect.objectContaining({ method: "POST" }),
        );
        expect(result.status).toBe("denied");
    });
});

describe("getAccessRequestMaterial", () => {
    it("GETs the material sub-route with the encoded uid", async () => {
        const material = {
            masterKeyWraps: [
                {
                    method: "escrow" as const,
                    escrowScopeId: "es1",
                    ciphertext: "cipher",
                    nonce: "nonce",
                    salt: "salt",
                    kdf: "argon2id:m=65536,t=3,p=4",
                    schemeVersion: 1,
                    createdAt: 1735689600000,
                },
            ],
        };
        const fetchMock = mockFetch(() => jsonResponse(200, material));
        const result = await getAccessRequestMaterial("ar/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/access-requests/ar%2F1/material", expect.anything());
        expect(result).toEqual(material);
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, request));

        await listAccessRequests({}, client);
        await getAccessRequest("ar1", client);
        await createAccessRequest({ matterId: "m1", mailboxUid: "mb1" }, client);
        await approveAccessRequest("ar1", client);
        await denyAccessRequest("ar1", client);
        await getAccessRequestMaterial("ar1", client);

        expect(fetchMock).toHaveBeenCalledTimes(6);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, request));
        await getAccessRequest("ar1");
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/access-requests/ar1", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
