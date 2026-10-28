// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { createApiClient } from "../../../lib/util/api.js";
import { getIntegrations, isSecretMask, isUnreadableSecret, updateIntegrationSection } from "../../../lib/admin/integrationsApi.js";

const view = {
    giphy: { values: { enabled: true, apiKey: { secret: true } }, defaults: { enabled: true, apiKey: null }, source: { enabled: "deployment", apiKey: "admin" } },
    version: 2,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("getIntegrations", () => {
    it("reads every section's values, defaults and sources", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, view));
        expect(await getIntegrations()).toEqual(view);
        expect(fetchMock).toHaveBeenCalledWith("/api/system/integrations", expect.anything());
    });

    it("goes through an explicit client when given one", async () => {
        const client = createApiClient({ baseUrl: "https://mail.example.com", getAccessToken: async () => "tok" });
        const fetchMock = mockFetch(() => jsonResponse(200, view));
        await getIntegrations(client);
        expect(fetchMock.mock.calls[0][0]).toBe("https://mail.example.com/api/system/integrations");
    });
});

describe("updateIntegrationSection", () => {
    it("PUTs the patch to the section's own route and answers the new view", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, view));
        const result = await updateIntegrationSection("giphy", { apiKey: "key-1", version: 2 });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system/integrations/giphy",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ apiKey: "key-1", version: 2 }) }),
        );
        expect(result).toEqual(view);
    });

    it("rejects with the server's message", async () => {
        mockFetch(() => jsonResponse(409, { message: "The integrations were changed by someone else.", code: "api-005" }));
        await expect(updateIntegrationSection("stun", { urls: null })).rejects.toMatchObject({ status: 409 });
    });
});

describe("isSecretMask", () => {
    it("is true only for exactly the mask", () => {
        expect(isSecretMask({ secret: true })).toBe(true);
        expect(isSecretMask({ secret: true, extra: 1 })).toBe(false);
        expect(isSecretMask({ secret: false })).toBe(false);
        expect(isSecretMask(null)).toBe(false);
        expect(isSecretMask("secret")).toBe(false);
    });

    it("is still true for a mask the server marks unreadable, which is a secret that is set", () => {
        expect(isSecretMask({ secret: true, unreadable: true })).toBe(true);
        expect(isSecretMask({ secret: true, unreadable: false })).toBe(true);
        expect(isSecretMask({ secret: true, unreadable: "yes" })).toBe(false);
    });
});

describe("isUnreadableSecret", () => {
    it("is true only for a set secret the server says it can't read", () => {
        expect(isUnreadableSecret({ secret: true, unreadable: true })).toBe(true);
        expect(isUnreadableSecret({ secret: true })).toBe(false);
        expect(isUnreadableSecret({ secret: true, unreadable: false })).toBe(false);
        expect(isUnreadableSecret({ unreadable: true })).toBe(false);
        expect(isUnreadableSecret(null)).toBe(false);
    });
});
