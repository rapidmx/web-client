// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { candidates, search } from "../../../lib/search/searchApi.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("search", () => {
    it("fetches with just the query text when no other params are given", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { results: [] }));
        const result = await search("hello");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/search?q=hello", expect.anything());
        expect(result).toEqual({ results: [] });
    });

    it("forwards types/cursor/limit when provided", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { results: [], nextCursor: "c1" }));
        const result = await search("hello", { types: ["message", "contact"], cursor: "c0", limit: 10 });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/search?q=hello&types=message%2Ccontact&cursor=c0&limit=10",
            expect.anything(),
        );
        expect(result.nextCursor).toBe("c1");
    });

    it("omits types/cursor/limit that are not provided", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { results: [] }));
        await search("q");
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe("/api/mail/search?q=q");
    });

    it("forwards every structured operator-grammar filter param, matching BaseSearchRoute's own names", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { results: [] }));
        const before = new Date("2026-06-01T00:00:00.000Z");
        const after = new Date("2026-01-01T00:00:00.000Z");
        await search("budget", {
            from: "alice@example.com",
            to: "bob@example.com",
            cc: "carol@example.com",
            subject: "quarterly",
            hasAttachment: true,
            before,
            after,
            folderUid: "f1",
            flags: ["read", "flagged"],
            labels: ["l1", "l2"],
            mailboxUid: "mb2",
        });
        const [url] = fetchMock.mock.calls[0];
        const params = new URLSearchParams(url.split("?")[1]);
        expect(params.get("mailboxUid")).toBe("mb2");
        expect(params.get("from")).toBe("alice@example.com");
        expect(params.get("to")).toBe("bob@example.com");
        expect(params.get("cc")).toBe("carol@example.com");
        expect(params.get("subject")).toBe("quarterly");
        expect(params.get("hasAttachment")).toBe("true");
        expect(params.get("before")).toBe(before.toISOString());
        expect(params.get("after")).toBe(after.toISOString());
        expect(params.get("in")).toBe("f1");
        expect(params.get("is")).toBe("read,flagged");
        expect(params.get("label")).toBe("l1,l2");
    });

    it("sends hasAttachment: false explicitly rather than omitting it", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { results: [] }));
        await search("q", { hasAttachment: false });
        const [url] = fetchMock.mock.calls[0];
        expect(new URLSearchParams(url.split("?")[1]).get("hasAttachment")).toBe("false");
    });

    it("omits every structured filter param that is not provided", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { results: [] }));
        await search("q");
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe("/api/mail/search?q=q");
    });

    it("propagates metadataOnly/source fields from the response", async () => {
        mockFetch(() =>
            jsonResponse(200, {
                results: [{ entityType: "message", entityUid: "m1", score: 0.5, metadataOnly: true, source: "server" }],
            }),
        );
        const result = await search("q");
        expect(result.results[0].metadataOnly).toBe(true);
        expect(result.results[0].source).toBe("server");
    });
});

describe("candidates", () => {
    it("fetches with no params when none are given", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { candidates: [] }));
        const result = await candidates();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/search/candidates?", expect.anything());
        expect(result).toEqual({ candidates: [] });
    });

    it("forwards every param, matching BaseSearchRoute.candidates()'s own query names", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { candidates: [], nextCursor: "c1" }));
        const before = new Date("2026-06-01T00:00:00.000Z");
        const after = new Date("2026-01-01T00:00:00.000Z");
        const result = await candidates({
            types: ["message"],
            participants: ["alice@example.com", "bob@example.com"],
            before,
            after,
            folderUid: "f1",
            flags: ["read"],
            labels: ["l1"],
            cursor: "c0",
            limit: 25,
            mailboxUid: "mb2",
        });
        const [url] = fetchMock.mock.calls[0];
        const params = new URLSearchParams(url.split("?")[1]);
        expect(params.get("mailboxUid")).toBe("mb2");
        expect(params.get("types")).toBe("message");
        expect(params.get("participants")).toBe("alice@example.com,bob@example.com");
        expect(params.get("before")).toBe(before.toISOString());
        expect(params.get("after")).toBe(after.toISOString());
        expect(params.get("in")).toBe("f1");
        expect(params.get("is")).toBe("read");
        expect(params.get("label")).toBe("l1");
        expect(params.get("cursor")).toBe("c0");
        expect(params.get("limit")).toBe("25");
        expect(result.nextCursor).toBe("c1");
    });
});
