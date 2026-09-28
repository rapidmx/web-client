// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../testUtils.js";
import {
    createMailSignature,
    deleteMailSignature,
    getMailSignature,
    listMailSignatures,
    updateMailSignature,
} from "../../../lib/mail/mailSignaturesApi.js";
import { createApiClient } from "../../../lib/util/api.js";

const signature = {
    uid: "sig1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    name: "Default",
    contentHtml: "<p>Best,<br>Jane</p>",
    isDefaultForNewMessages: true,
    isDefaultForReplyForward: false,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("listMailSignatures", () => {
    it("fetches with the mailboxUid filter and default pagination", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [signature]));
        const result = await listMailSignatures("mb1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mail-signatures?limit=25&page=0&mailboxUid=mb1", expect.anything());
        expect(result).toEqual([signature]);
    });

    it("forwards a custom page/limit alongside the mailboxUid filter", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listMailSignatures("mb1", { page: 2, limit: 100 });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mail-signatures?limit=100&page=2&mailboxUid=mb1", expect.anything());
    });
});

describe("getMailSignature", () => {
    it("fetches the encoded uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, signature));
        const result = await getMailSignature("sig/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mail-signatures/sig%2F1", expect.anything());
        expect(result).toEqual(signature);
    });
});

describe("createMailSignature", () => {
    it("posts the input with contentHtml/isDefaultForNewMessages/isDefaultForReplyForward defaults", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, signature));
        await createMailSignature({ mailboxUid: "mb1", name: "Default" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mail-signatures",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({
                    contentHtml: "",
                    isDefaultForNewMessages: false,
                    isDefaultForReplyForward: false,
                    mailboxUid: "mb1",
                    name: "Default",
                }),
            }),
        );
    });

    it("forwards explicit contentHtml/defaults instead of the defaults", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, signature));
        await createMailSignature({
            mailboxUid: "mb1",
            name: "Default",
            contentHtml: "<p>Hi</p>",
            isDefaultForNewMessages: true,
            isDefaultForReplyForward: true,
        });
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.contentHtml).toBe("<p>Hi</p>");
        expect(body.isDefaultForNewMessages).toBe(true);
        expect(body.isDefaultForReplyForward).toBe(true);
    });
});

describe("updateMailSignature", () => {
    it("PUTs the encoded uid with the input", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...signature, name: "Renamed" }));
        const result = await updateMailSignature({ uid: "sig1", version: 0, name: "Renamed" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mail-signatures/sig1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "sig1", version: 0, name: "Renamed" }),
            }),
        );
        expect(result.name).toBe("Renamed");
    });
});

describe("deleteMailSignature", () => {
    it("DELETEs the encoded uid with the version query param", async () => {
        const fetchMock = mockFetch(() => emptyResponse(200));
        await deleteMailSignature("sig1", 2);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mail-signatures/sig1?version=2",
            expect.objectContaining({ method: "DELETE" }),
        );
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, signature));

        await listMailSignatures("mb1", {}, client);
        await getMailSignature("sig1", client);
        await createMailSignature({ mailboxUid: "mb1", name: "Default" }, client);
        await updateMailSignature({ uid: "sig1", version: 0, name: "Renamed" }, client);
        await deleteMailSignature("sig1", 2, client);

        expect(fetchMock).toHaveBeenCalledTimes(5);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, signature));
        await getMailSignature("sig1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mail-signatures/sig1", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
