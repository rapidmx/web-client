// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { getImportRequest, listImportRequests, uploadMailboxImport } from "../../../lib/mail/mailboxImportApi.js";
import { configureApiBaseUrl, createApiClient } from "../../../lib/util/api.js";

const request = {
    uid: "mir1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    requestedByUserUid: "u1",
    targetFolderUid: "f1",
    format: "mbox" as const,
    sourceBlobKey: "mailbox-imports/abc",
    status: "pending" as const,
};

afterEach(() => {
    vi.unstubAllGlobals();
    configureApiBaseUrl("");
});

describe("uploadMailboxImport", () => {
    it("posts the file's raw bytes with query-string metadata and its own content-type, not JSON", async () => {
        const file = new File(["From x\n"], "archive.mbox");
        const fetchMock = mockFetch(() => jsonResponse(200, request));

        const result = await uploadMailboxImport(file, { format: "mbox", targetFolderUid: "f1" });

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailbox-import-requests?format=mbox&targetFolderUid=f1",
            expect.objectContaining({ method: "POST", body: file, credentials: "include" }),
        );
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get("Content-Type")).toBe("application/mbox");
        expect(result).toEqual(request);
    });

    it("targets the configured API base URL", async () => {
        configureApiBaseUrl("https://mail.example.com");
        const fetchMock = mockFetch(() => jsonResponse(200, request));
        await uploadMailboxImport(new File(["From x\n"], "archive.mbox"), { format: "mbox", targetFolderUid: "f1" });
        expect(fetchMock.mock.calls[0][0]).toBe("https://mail.example.com/api/mail/mailbox-import-requests?format=mbox&targetFolderUid=f1");
    });

    it("uses application/vnd.ms-outlook for a pst upload", async () => {
        const file = new File(["..."], "archive.pst");
        const fetchMock = mockFetch(() => jsonResponse(200, { ...request, format: "pst" }));

        await uploadMailboxImport(file, { format: "pst", targetFolderUid: "f1" });

        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get("Content-Type")).toBe("application/vnd.ms-outlook");
    });

    it("forwards an explicit mailboxUid, only meaningful for a trusted caller", async () => {
        const file = new File(["..."], "archive.mbox");
        const fetchMock = mockFetch(() => jsonResponse(200, request));

        await uploadMailboxImport(file, { format: "mbox", targetFolderUid: "f1", mailboxUid: "mb2" });

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailbox-import-requests?format=mbox&targetFolderUid=f1&mailboxUid=mb2",
            expect.anything(),
        );
    });

    it("throws ApiRequestError using the body's message field on a non-ok response", async () => {
        const file = new File(["..."], "archive.mbox");
        mockFetch(() => jsonResponse(400, { message: "targetFolderUid is required.", code: "api-101" }));

        await expect(uploadMailboxImport(file, { format: "mbox", targetFolderUid: "f1" })).rejects.toMatchObject({
            name: "ApiRequestError",
            message: "targetFolderUid is required.",
            status: 400,
            code: "api-101",
        });
    });

    it("falls back to the body's error field when message is absent", async () => {
        const file = new File(["..."], "archive.mbox");
        mockFetch(() => jsonResponse(400, { error: "targetFolderUid is required." }));

        await expect(uploadMailboxImport(file, { format: "mbox", targetFolderUid: "f1" })).rejects.toMatchObject({
            message: "targetFolderUid is required.",
        });
    });

    it("treats an unparseable JSON body as no body", async () => {
        const file = new File(["..."], "archive.mbox");
        mockFetch(() => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }));

        const result = await uploadMailboxImport(file, { format: "mbox", targetFolderUid: "f1" });

        expect(result).toBeUndefined();
    });

    it("returns undefined for a non-JSON success response body", async () => {
        const file = new File(["..."], "archive.mbox");
        mockFetch(() => new Response("", { status: 200, headers: { "content-type": "text/plain" } }));

        const result = await uploadMailboxImport(file, { format: "mbox", targetFolderUid: "f1" });

        expect(result).toBeUndefined();
    });

    it("falls back to a generic message when there is no body and no statusText", async () => {
        mockFetch(() => new Response(null, { status: 500, statusText: "" }));
        await expect(uploadMailboxImport(new File(["..."], "archive.mbox"), { format: "mbox", targetFolderUid: "f1" })).rejects.toMatchObject({
            message: "Upload failed.",
        });
    });

    it("falls back to statusText when the error response has no JSON body", async () => {
        const file = new File(["..."], "archive.mbox");
        mockFetch(() => new Response(null, { status: 500, statusText: "Server Error" }));

        await expect(uploadMailboxImport(file, { format: "mbox", targetFolderUid: "f1" })).rejects.toMatchObject({
            message: "Server Error",
            status: 500,
        });
    });
});

describe("listImportRequests", () => {
    it("fetches every visible request", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [request]));
        const result = await listImportRequests();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailbox-import-requests", expect.anything());
        expect(result).toEqual([request]);
    });

    it("forwards limit/page as query params", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listImportRequests({ limit: 500, page: 0 });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailbox-import-requests?limit=500&page=0", expect.anything());
    });
});

describe("getImportRequest", () => {
    it("fetches the encoded uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, request));
        const result = await getImportRequest("mir/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailbox-import-requests/mir%2F1", expect.anything());
        expect(result).toEqual(request);
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, request));

        await listImportRequests({}, client);
        await getImportRequest("mir1", client);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, [request]));
        await listImportRequests();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailbox-import-requests", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});

describe("uploadMailboxImport with a client", () => {
    it("goes through an explicit client, to that account's origin with its token, when given one", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, request));
        const client = createApiClient({ baseUrl: "https://a.example.com", getAccessToken: async () => "tok" });
        await uploadMailboxImport(new File(["From x\n"], "a.mbox"), { format: "mbox", targetFolderUid: "f1" }, client);
        expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/a\.example\.com\/api\//);
        expect(((fetchMock.mock.calls[0][1] as RequestInit).headers as Headers).get("Authorization")).toBe("jwt tok");
    });
});
