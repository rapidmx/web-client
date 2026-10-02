// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../testUtils.js";
import { createApiClient } from "../../../lib/util/api.js";
import { createLabel, deleteLabel, getLabel, listLabels, updateLabel } from "../../../lib/mail/labelsApi.js";

const label = {
    uid: "l1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    name: "Important",
    color: "#e11d48",
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("listLabels", () => {
    it("fetches with the mailboxUid filter and default pagination", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [label]));
        const result = await listLabels("mb1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/labels?limit=200&page=0&mailboxUid=mb1", expect.anything());
        expect(result).toEqual([label]);
    });

    it("forwards a custom page/limit alongside the mailboxUid filter", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listLabels("mb1", { page: 2, limit: 100 });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/labels?limit=100&page=2&mailboxUid=mb1", expect.anything());
    });
});

describe("getLabel", () => {
    it("fetches the encoded uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, label));
        const result = await getLabel("l/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/labels/l%2F1", expect.anything());
        expect(result).toEqual(label);
    });
});

describe("createLabel", () => {
    it("posts the input as-is", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, label));
        await createLabel({ mailboxUid: "mb1", name: "Important", color: "#e11d48" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/labels",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ mailboxUid: "mb1", name: "Important", color: "#e11d48" }),
            }),
        );
    });
});

describe("updateLabel", () => {
    it("PUTs the encoded uid with the input", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...label, name: "Renamed" }));
        const result = await updateLabel({ uid: "l1", version: 0, name: "Renamed" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/labels/l1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "l1", version: 0, name: "Renamed" }),
            }),
        );
        expect(result.name).toBe("Renamed");
    });
});

describe("deleteLabel", () => {
    it("DELETEs the encoded uid with the version query param", async () => {
        const fetchMock = mockFetch(() => emptyResponse(200));
        await deleteLabel("l1", 2);
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/labels/l1?version=2", expect.objectContaining({ method: "DELETE" }));
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, label));

        await listLabels("mb1", {}, client);
        await getLabel("l1", client);
        await createLabel({ mailboxUid: "mb1", name: "Important" }, client);
        await updateLabel({ uid: "l1", version: 0, name: "Renamed" }, client);
        await deleteLabel("l1", 2, client);

        expect(fetchMock).toHaveBeenCalledTimes(5);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, label));
        await getLabel("l1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/labels/l1", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
