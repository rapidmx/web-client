// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { createApiClient } from "../../../lib/util/api.js";
import { listAuditLog } from "../../../lib/admin/auditLogApi.js";

const entry = {
    uid: "al1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    actorUserUid: "u1",
    action: "domain.create",
    targetType: "Domain",
    targetUid: "example.com",
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("listAuditLog", () => {
    it("fetches with default pagination and no filters", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [entry]));
        const result = await listAuditLog();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/audit-log?limit=25&page=0&sort=" + encodeURIComponent(JSON.stringify({ dateCreated: "DESC", uid: "ASC" })), expect.anything());
        expect(result).toEqual([entry]);
    });

    it("forwards a custom page/limit", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listAuditLog({}, { page: 2, limit: 10 });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/audit-log?limit=10&page=2&sort=" + encodeURIComponent(JSON.stringify({ dateCreated: "DESC", uid: "ASC" })), expect.anything());
    });

    it("forwards every provided filter", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listAuditLog({ mailboxUid: "mb1", actorUserUid: "u1", action: "domain.create", targetType: "Domain" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/audit-log?limit=25&page=0&mailboxUid=mb1&actorUserUid=u1&action=domain.create&targetType=Domain&sort=" + encodeURIComponent(JSON.stringify({ dateCreated: "DESC", uid: "ASC" })),
            expect.anything(),
        );
    });

    it("omits filters that are not provided", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listAuditLog({ mailboxUid: "mb1" });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/audit-log?limit=25&page=0&mailboxUid=mb1&sort=" + encodeURIComponent(JSON.stringify({ dateCreated: "DESC", uid: "ASC" })), expect.anything());
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, [entry]));

        await listAuditLog({}, {}, client);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, [entry]));
        await listAuditLog();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/audit-log?limit=25&page=0&sort=" + encodeURIComponent(JSON.stringify({ dateCreated: "DESC", uid: "ASC" })), expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
