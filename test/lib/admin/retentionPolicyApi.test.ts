// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { createApiClient } from "../../../lib/util/api.js";
import { getRetentionPolicy, updateRetentionPolicy } from "../../../lib/admin/retentionPolicyApi.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("getRetentionPolicy", () => {
    it("fetches the singleton policy", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { messageRetentionDays: 90, auditLogRetentionDays: 2190 }));
        const result = await getRetentionPolicy();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/retention-policy", expect.anything());
        expect(result).toEqual({ messageRetentionDays: 90, auditLogRetentionDays: 2190 });
    });

    it("returns an empty object when nothing has been configured yet", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        const result = await getRetentionPolicy();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/retention-policy", expect.anything());
        expect(result).toEqual({});
    });
});

describe("updateRetentionPolicy", () => {
    it("PUTs only the supplied fields", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { messageRetentionDays: 90 }));
        const result = await updateRetentionPolicy({ messageRetentionDays: 90 });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system/retention-policy",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ messageRetentionDays: 90 }) }),
        );
        expect(result).toEqual({ messageRetentionDays: 90 });
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, { messageRetentionDays: 90, auditLogRetentionDays: 2190 }));

        await getRetentionPolicy(client);
        await updateRetentionPolicy({ messageRetentionDays: 90 }, client);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        await getRetentionPolicy();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/retention-policy", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
