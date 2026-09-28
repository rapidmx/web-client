// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { createApiClient } from "../../../lib/util/api.js";
import { getAuditLogEntry, listAuditLogEntries, verifyAuditChain } from "../../../lib/admin/escrowAuditLogApi.js";

const entry = {
    uid: "eal1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    sequence: 0,
    hash: "abc123",
    action: "escrow_access_request.created" as const,
    holderUserUid: "u1",
    matterId: "m1",
    mailboxUid: "mb1",
    requestId: "ar1",
    occurredAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("listAuditLogEntries", () => {
    it("fetches with default pagination", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [entry]));
        const result = await listAuditLogEntries();
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/audit-log?limit=25&page=0", expect.anything());
        expect(result).toEqual([entry]);
    });

    it("forwards a custom page/limit", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listAuditLogEntries({ page: 2, limit: 10 });
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/audit-log?limit=10&page=2", expect.anything());
    });
});

describe("getAuditLogEntry", () => {
    it("fetches the encoded uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, entry));
        const result = await getAuditLogEntry("eal/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/audit-log/eal%2F1", expect.anything());
        expect(result).toEqual(entry);
    });
});

describe("verifyAuditChain", () => {
    it("GETs the verify sub-route", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { valid: true }));
        const result = await verifyAuditChain();
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/audit-log/verify", expect.anything());
        expect(result).toEqual({ valid: true });
    });

    it("surfaces a broken chain's sequence number", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { valid: false, brokenAtSequence: 4 }));
        const result = await verifyAuditChain();
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/audit-log/verify", expect.anything());
        expect(result).toEqual({ valid: false, brokenAtSequence: 4 });
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, entry));

        await listAuditLogEntries({}, client);
        await getAuditLogEntry("eal1", client);
        await verifyAuditChain(client);

        expect(fetchMock).toHaveBeenCalledTimes(3);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, entry));
        await getAuditLogEntry("eal1");
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/audit-log/eal1", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
