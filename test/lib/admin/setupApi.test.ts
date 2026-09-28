// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { createApiClient } from "../../../lib/util/api.js";
import { completeSetup, getSetupStatus, reopenSetup, saveSetupStep } from "../../../lib/admin/setupApi.js";
import { getMailboxPolicy, updateMailboxPolicy } from "../../../lib/admin/mailboxPolicyApi.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("setupApi", () => {
    it("reads, saves progress, completes and reopens setup", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { required: true }));
        expect(await getSetupStatus()).toEqual({ required: true });
        await saveSetupStep("domain");
        await completeSetup();
        await reopenSetup();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/setup", expect.anything());
        expect(fetchMock).toHaveBeenCalledWith("/api/system/setup", expect.objectContaining({ method: "PUT", body: JSON.stringify({ currentStep: "domain" }) }));
        expect(fetchMock).toHaveBeenCalledWith("/api/system/setup/complete", expect.objectContaining({ method: "POST" }));
        expect(fetchMock).toHaveBeenCalledWith("/api/system/setup/reopen", expect.objectContaining({ method: "POST" }));
    });
});

describe("mailboxPolicyApi", () => {
    it("reads and patches the mailbox policy", async () => {
        const policy = { defaultQuotaBytes: 1, autoProvisionEnabled: false, autoProvisionQuotaBytes: 2 };
        const fetchMock = mockFetch(() => jsonResponse(200, policy));
        expect(await getMailboxPolicy()).toEqual(policy);
        await updateMailboxPolicy({ autoProvisionEnabled: true });
        expect(fetchMock).toHaveBeenCalledWith("/api/system/mailbox-policy", expect.anything());
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system/mailbox-policy",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ autoProvisionEnabled: true }) }),
        );
    });
});

describe("with an explicit ApiClient", () => {
    it("every setupApi function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, { required: true }));

        await getSetupStatus(client);
        await saveSetupStep("domain", client);
        await completeSetup(client);
        await reopenSetup(client);

        expect(fetchMock).toHaveBeenCalledTimes(4);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, { required: true }));
        await getSetupStatus();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/setup", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
