// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import {
    fetchRecipientSuggestions,
    mergeRecipientSuggestions,
    RecipientSuggestion,
    RECIPIENT_SUGGESTION_MAX_QUERY_LENGTH,
    searchContactSuggestions,
    searchCorrespondents,
    searchDirectory,
} from "../../../lib/mail/directoryApi.js";
import { ApiRequestError, createApiClient } from "../../../lib/util/api.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

const alice: RecipientSuggestion = { displayName: "Alice Johnson", address: "alice@example.com", kind: "user" };
const aliceContact: RecipientSuggestion = { displayName: "Alice (home)", address: "ALICE@example.com", kind: "contact" };
const sales: RecipientSuggestion = { displayName: "Sales", address: "sales@example.com", kind: "list" };
const john: RecipientSuggestion = { displayName: "John Smith", address: "john.smith@gmail.com", kind: "correspondent" };

describe("searchDirectory", () => {
    it("sends the trimmed query and limit, and keeps only well-formed entries", async () => {
        const fetchMock = mockFetch(() =>
            jsonResponse(200, [alice, { address: "noname@example.com", kind: "shared" }, { displayName: "No address" }, null, { address: "" }]),
        );
        expect(await searchDirectory("  al ice ", { limit: 5 })).toEqual([alice, { displayName: "", address: "noname@example.com", kind: "shared" }]);
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/directory?q=al+ice&limit=5", expect.anything());
    });

    it("omits the limit when not given, passes the abort signal, and treats a non-array body as no entries", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { unexpected: true }));
        const controller = new AbortController();
        expect(await searchDirectory("al", { signal: controller.signal })).toEqual([]);
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/directory?q=al", expect.objectContaining({ signal: controller.signal }));
    });

    it("doesn't request a query shorter than two characters, and cuts a long one", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        expect(await searchDirectory(" a ")).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
        await searchDirectory("x".repeat(150));
        expect(fetchMock).toHaveBeenCalledWith(`/api/mail/directory?q=${"x".repeat(RECIPIENT_SUGGESTION_MAX_QUERY_LENGTH)}`, expect.anything());
    });

    it("rejects with the server's error", async () => {
        mockFetch(() => jsonResponse(403, { message: "Only users with a mailbox on this server can search its directory." }));
        await expect(searchDirectory("al")).rejects.toMatchObject({ status: 403 });
    });
});

describe("searchContactSuggestions", () => {
    it("sends the query, limit and mailboxUid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [aliceContact]));
        expect(await searchContactSuggestions("ali", { limit: 3, mailboxUid: "mb/1" })).toEqual([aliceContact]);
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/directory/contacts?q=ali&limit=3&mailboxUid=mb%2F1", expect.anything());
    });

    it("sends just the query by default", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await searchContactSuggestions("a&b");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/directory/contacts?q=a%26b", expect.anything());
    });
});

describe("searchCorrespondents", () => {
    it("sends the query, limit and mailboxUid to the correspondents endpoint", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [john]));
        expect(await searchCorrespondents("john", { limit: 4, mailboxUid: "mb1" })).toEqual([john]);
        expect(fetchMock.mock.calls[0][0]).toBe("/api/mail/directory/correspondents?q=john&limit=4&mailboxUid=mb1");
    });

    it("sends just the query by default, and nothing for one that is too short", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await searchCorrespondents("jo");
        expect(fetchMock.mock.calls[0][0]).toBe("/api/mail/directory/correspondents?q=jo");
        expect(await searchCorrespondents("j")).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe("mergeRecipientSuggestions", () => {
    it("puts the people the caller has corresponded with after the contacts and the directory, without repeating an address", () => {
        const repeat: RecipientSuggestion = { displayName: "Alice", address: "Alice@Example.com", kind: "correspondent" };
        expect(mergeRecipientSuggestions([aliceContact], [sales], 8, [repeat, john])).toEqual([aliceContact, sales, john]);
        // Without them, as before.
        expect(mergeRecipientSuggestions([aliceContact], [sales])).toEqual([aliceContact, sales]);
        // They take what room is left.
        expect(mergeRecipientSuggestions([aliceContact], [sales], 2, [john])).toEqual([aliceContact, sales]);
    });

    it("puts contacts first, drops repeated addresses case-insensitively and keeps the limit", () => {
        expect(mergeRecipientSuggestions([aliceContact], [alice, sales])).toEqual([aliceContact, sales]);
        expect(mergeRecipientSuggestions([aliceContact, { ...sales, address: " Sales@example.com " }], [alice, sales], 10)).toEqual([
            aliceContact,
            { ...sales, address: " Sales@example.com " },
        ]);
        expect(mergeRecipientSuggestions([aliceContact], [alice, sales], 1)).toEqual([aliceContact]);
    });
});

describe("fetchRecipientSuggestions and correspondents", () => {
    const answer = (url: string, correspondents: () => Response) =>
        url.startsWith("/api/mail/directory/correspondents")
            ? correspondents()
            : url.startsWith("/api/mail/directory/contacts")
              ? jsonResponse(200, [aliceContact])
              : jsonResponse(200, [sales]);

    it("adds the people the caller has corresponded with to the contacts and the directory", async () => {
        const fetchMock = mockFetch((url) => answer(url, () => jsonResponse(200, [john])));
        expect(await fetchRecipientSuggestions("john")).toEqual([aliceContact, sales, john]);
        expect(fetchMock.mock.calls.map(([url]) => String(url).split("?")[0]).sort()).toEqual([
            "/api/mail/directory",
            "/api/mail/directory/contacts",
            "/api/mail/directory/correspondents",
        ]);
    });

    it("carries on without them when the server has no such endpoint, or answers with an error", async () => {
        mockFetch((url) => answer(url, () => jsonResponse(404, { message: "Not found" })));
        expect(await fetchRecipientSuggestions("john")).toEqual([aliceContact, sales]);
        mockFetch((url) => answer(url, () => jsonResponse(500, { message: "boom" })));
        expect(await fetchRecipientSuggestions("john")).toEqual([aliceContact, sales]);
    });

    it("still rejects when the contacts and the directory both fail, however the correspondents fare", async () => {
        mockFetch((url) => (url.startsWith("/api/mail/directory/correspondents") ? jsonResponse(200, [john]) : jsonResponse(500, { message: "down" })));
        await expect(fetchRecipientSuggestions("john")).rejects.toMatchObject({ status: 500 });
    });

    it("rejects with the AbortError when only the correspondents request was aborted", async () => {
        const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
        mockFetch((url) => {
            if (url.startsWith("/api/mail/directory/correspondents")) throw abort;
            return url.startsWith("/api/mail/directory/contacts") ? jsonResponse(200, [aliceContact]) : jsonResponse(200, [sales]);
        });
        await expect(fetchRecipientSuggestions("john")).rejects.toBe(abort);
    });
});

describe("fetchRecipientSuggestions", () => {
    const route = (handlers: { contacts: () => Response | Promise<Response>; directory: () => Response | Promise<Response> }) =>
        mockFetch((url) => (url.startsWith("/api/mail/directory/contacts") ? handlers.contacts() : handlers.directory()));

    it("merges both sources with the default limit", async () => {
        const fetchMock = route({ contacts: () => jsonResponse(200, [aliceContact]), directory: () => jsonResponse(200, [alice, sales]) });
        expect(await fetchRecipientSuggestions("al", { mailboxUid: "mb1" })).toEqual([aliceContact, sales]);
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/directory/contacts?q=al&limit=8&mailboxUid=mb1", expect.anything());
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/directory?q=al&limit=8", expect.anything());
    });

    it("keeps one source's entries when the other fails", async () => {
        route({ contacts: () => jsonResponse(200, [aliceContact]), directory: () => jsonResponse(403, { message: "no" }) });
        expect(await fetchRecipientSuggestions("al", { limit: 2 })).toEqual([aliceContact]);
        route({ contacts: () => jsonResponse(500, { message: "down" }), directory: () => jsonResponse(200, [sales]) });
        expect(await fetchRecipientSuggestions("al")).toEqual([sales]);
    });

    it("rejects when both sources fail", async () => {
        route({ contacts: () => jsonResponse(429, { message: "slow down" }), directory: () => jsonResponse(403, { message: "no" }) });
        await expect(fetchRecipientSuggestions("al")).rejects.toMatchObject({ status: 429 });
        route({ contacts: () => Promise.reject("offline"), directory: () => Promise.reject("offline") });
        const error = await fetchRecipientSuggestions("al").catch((e) => e);
        expect(error).toBeInstanceOf(ApiRequestError);
    });

    it("rejects with the AbortError when aborted", async () => {
        const abort = () => Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
        route({ contacts: () => jsonResponse(200, [aliceContact]), directory: abort });
        await expect(fetchRecipientSuggestions("al")).rejects.toMatchObject({ name: "AbortError" });
        route({ contacts: abort, directory: () => jsonResponse(200, []) });
        await expect(fetchRecipientSuggestions("al")).rejects.toMatchObject({ name: "AbortError" });
    });

    it("makes no request for a short query", async () => {
        const fetchMock = route({ contacts: () => jsonResponse(200, []), directory: () => jsonResponse(200, []) });
        expect(await fetchRecipientSuggestions("a")).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, [alice]));

        await searchDirectory("alice", {}, client);
        await searchContactSuggestions("alice", {}, client);
        await fetchRecipientSuggestions("alice", {}, client);

        expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, [alice]));
        await searchDirectory("alice");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/directory?q=alice", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
