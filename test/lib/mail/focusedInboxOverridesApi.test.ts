// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../testUtils.js";
import {
    createFocusedInboxOverride,
    deleteFocusedInboxOverride,
    listFocusedInboxOverrides,
    updateFocusedInboxOverride,
} from "../../../lib/mail/focusedInboxOverridesApi.js";
import { createApiClient } from "../../../lib/util/api.js";

const override = {
    uid: "fio1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    senderAddress: "newsletter@example.com",
    classifyAs: "other" as const,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("listFocusedInboxOverrides", () => {
    it("fetches with the mailboxUid filter and default pagination", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [override]));
        const result = await listFocusedInboxOverrides("mb1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/focused-inbox-overrides?limit=25&page=0&mailboxUid=mb1",
            expect.anything(),
        );
        expect(result).toEqual([override]);
    });

    it("forwards a custom page/limit", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listFocusedInboxOverrides("mb1", { page: 2, limit: 10 });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/focused-inbox-overrides?limit=10&page=2&mailboxUid=mb1",
            expect.anything(),
        );
    });
});

describe("createFocusedInboxOverride", () => {
    it("posts the input", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, override));
        const result = await createFocusedInboxOverride({
            mailboxUid: "mb1",
            senderAddress: "newsletter@example.com",
            classifyAs: "other",
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/focused-inbox-overrides",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ mailboxUid: "mb1", senderAddress: "newsletter@example.com", classifyAs: "other" }),
            }),
        );
        expect(result).toEqual(override);
    });
});

describe("updateFocusedInboxOverride", () => {
    it("PUTs the encoded uid with the input", async () => {
        const updated = { ...override, classifyAs: "focused" as const };
        const fetchMock = mockFetch(() => jsonResponse(200, updated));
        const result = await updateFocusedInboxOverride({ uid: "fio1", version: 0, classifyAs: "focused" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/focused-inbox-overrides/fio1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "fio1", version: 0, classifyAs: "focused" }),
            }),
        );
        expect(result).toEqual(updated);
    });
});

describe("deleteFocusedInboxOverride", () => {
    it("DELETEs the encoded uid with the version query param", async () => {
        const fetchMock = mockFetch(() => emptyResponse(200));
        await deleteFocusedInboxOverride("fio1", 2);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/focused-inbox-overrides/fio1?version=2",
            expect.objectContaining({ method: "DELETE" }),
        );
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, override));

        await listFocusedInboxOverrides("mb1", {}, client);
        await createFocusedInboxOverride({ mailboxUid: "mb1", senderAddress: "newsletter@example.com", classifyAs: "other" }, client);
        await updateFocusedInboxOverride({ uid: "fio1", version: 0, classifyAs: "focused" }, client);
        await deleteFocusedInboxOverride("fio1", 2, client);

        expect(fetchMock).toHaveBeenCalledTimes(4);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, [override]));
        await listFocusedInboxOverrides("mb1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/focused-inbox-overrides?limit=25&page=0&mailboxUid=mb1", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
