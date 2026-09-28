// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { createApiClient } from "../../../lib/util/api.js";
import { getMailboxPolicy, updateMailboxPolicy } from "../../../lib/admin/mailboxPolicyApi.js";

const policy = {
    defaultQuotaBytes: 1_000_000_000,
    autoProvisionEnabled: true,
    autoProvisionQuotaBytes: 500_000_000,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("getMailboxPolicy", () => {
    it("fetches the deployment-wide policy", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, policy));
        const result = await getMailboxPolicy();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/mailbox-policy", expect.anything());
        expect(result).toEqual(policy);
    });

    it("passes through a `defaults` block when the server includes one", async () => {
        const withDefaults = { ...policy, defaults: { ...policy } };
        mockFetch(() => jsonResponse(200, withDefaults));
        const result = await getMailboxPolicy();
        expect(result).toEqual(withDefaults);
    });

    it("rejects with the server's own message on failure", async () => {
        mockFetch(() => jsonResponse(500, { message: "boom" }));
        await expect(getMailboxPolicy()).rejects.toMatchObject({ status: 500, message: "boom" });
    });
});

describe("updateMailboxPolicy", () => {
    it("PUTs only the supplied fields as a partial patch", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...policy, autoProvisionEnabled: false }));
        const result = await updateMailboxPolicy({ autoProvisionEnabled: false });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system/mailbox-policy",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ autoProvisionEnabled: false }) }),
        );
        expect(result.autoProvisionEnabled).toBe(false);
    });

    it("forwards multiple patched fields at once", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, policy));
        await updateMailboxPolicy({ defaultQuotaBytes: 2_000_000_000, autoProvisionQuotaBytes: 1_000_000_000 });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system/mailbox-policy",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ defaultQuotaBytes: 2_000_000_000, autoProvisionQuotaBytes: 1_000_000_000 }),
            }),
        );
    });

    it("rejects with the server's own message when a non-admin caller is refused", async () => {
        mockFetch(() => jsonResponse(403, { message: "Forbidden.", code: "api-103" }));
        await expect(updateMailboxPolicy({ autoProvisionEnabled: false })).rejects.toMatchObject({
            status: 403,
            code: "api-103",
        });
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, policy));

        await getMailboxPolicy(client);
        await updateMailboxPolicy({ autoProvisionEnabled: false }, client);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, policy));
        await getMailboxPolicy();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/mailbox-policy", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
