// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { blockedSendersOf, reportMessage, safeSendersOf } from "../../../lib/mail/mailApi.js";
import {
    MAX_SENDER_ENTRY_LENGTH,
    addBlockedSender,
    addSafeSender,
    checkSenderEntry,
    normalizeSenderEntry,
    removeBlockedSender,
    removeSafeSender,
    senderDomainOf,
    senderEntryMatches,
    senderListEntryFor,
} from "../../../lib/mail/senderListsApi.js";
import { createApiClient } from "../../../lib/util/api.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("normalizeSenderEntry", () => {
    it.each([
        ["Ann@Example.COM", "ann@example.com"],
        ["  ann@example.com  ", "ann@example.com"],
        ["example.com", "@example.com"],
        ["@Example.com", "@example.com"],
        ["  Mail.Example.co.uk ", "@mail.example.co.uk"],
        ["xn--bcher-kva.example", "@xn--bcher-kva.example"],
        ["a-b.example", "@a-b.example"],
    ])("makes %j the entry %j", (typed, entry) => {
        expect(normalizeSenderEntry(typed)).toBe(entry);
    });

    it.each([
        "",
        "   ",
        "localhost",
        "@",
        "-bad.example",
        "bad-.example",
        "a..example",
        "exa mple.com",
        "Ann <ann@example.com>",
        "ann@example.com, bob@example.com",
        "a b@example.com",
        "a@@example.com",
        "@ann@example.com",
        "ann@",
        "@example.com@",
        "ann\u0001@example.com",
        "bücher.example",
    ])("refuses %j", (typed) => {
        expect(normalizeSenderEntry(typed)).toBeUndefined();
    });

    it("refuses an entry over the length limit and accepts one at it", () => {
        const local = "a".repeat(MAX_SENDER_ENTRY_LENGTH - "@x.com".length);
        expect(normalizeSenderEntry(`${local}@x.com`)).toBe(`${local}@x.com`);
        expect(normalizeSenderEntry(`${local}a@x.com`)).toBeUndefined();
        const label = "a".repeat(60);
        expect(normalizeSenderEntry(`${label}.${label}.${label}.${label}.${label}.com`)).toBeUndefined();
    });
});

describe("checkSenderEntry", () => {
    it("returns the canonical entry and whether it is an address or a domain", () => {
        expect(checkSenderEntry(" Ann@Example.com ")).toEqual({ ok: true, entry: "ann@example.com", kind: "address" });
        expect(checkSenderEntry("Example.com")).toEqual({ ok: true, entry: "@example.com", kind: "domain" });
    });

    it.each([
        ["", /Type an email address/],
        ["   ", /Type an email address/],
        ["a".repeat(MAX_SENDER_ENTRY_LENGTH + 1), /longer than 254/],
        ["Ann <ann@example.com>", /without a name or angle brackets/],
        ["ann@example.com bob@example.com", /one address or domain at a time/],
        ["ann@example.com,bob@example.com", /one address or domain at a time/],
        ["bücher.example", /punycode/],
        ["@bücher.example", /punycode/],
        ["localhost", /not a domain/],
        ["@", /not a domain/],
        ["a@@example.com", /not an email address/],
        ["ann@", /not an email address/],
    ])("explains why %j is refused", (typed, message) => {
        const result = checkSenderEntry(typed);
        expect(result.ok).toBe(false);
        expect(result.ok ? "" : result.message).toMatch(message);
    });
});

describe("senderDomainOf, senderEntryMatches and senderListEntryFor", () => {
    it("takes the domain after the last @, lowercased", () => {
        expect(senderDomainOf("Ann@Example.COM")).toBe("example.com");
        expect(senderDomainOf("a@b@x.com")).toBe("x.com");
    });

    it("has no domain for an address without one", () => {
        expect(senderDomainOf("ann")).toBeUndefined();
        expect(senderDomainOf("ann@")).toBeUndefined();
    });

    it("matches an address entry exactly and a domain entry to the exact domain only", () => {
        expect(senderEntryMatches("ann@x.com", " ANN@x.com ")).toBe(true);
        expect(senderEntryMatches("ann@x.com", "joann@x.com")).toBe(false);
        expect(senderEntryMatches("@x.com", "anyone@X.com")).toBe(true);
        expect(senderEntryMatches("@x.com", "anyone@mail.x.com")).toBe(false);
        expect(senderEntryMatches("@x.com", "nodomain")).toBe(false);
    });

    it("finds the entry of a list that names an address, whatever the list holds", () => {
        expect(senderListEntryFor(["bob@y.com", "@x.com"], "ann@x.com")).toBe("@x.com");
        expect(senderListEntryFor(["ann@x.com", "@x.com"], "ann@x.com")).toBe("ann@x.com");
        expect(senderListEntryFor(["bob@y.com"], "ann@x.com")).toBeUndefined();
        expect(senderListEntryFor(null, "ann@x.com")).toBeUndefined();
        expect(senderListEntryFor(undefined, "ann@x.com")).toBeUndefined();
    });
});

describe("the sender list calls", () => {
    const change = { entry: "ann@x.com", changed: true, blockedSenders: ["ann@x.com"], safeSenders: [] };

    it("POSTs the entry to the encoded mailbox's blocked-senders and answers both lists", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, change));
        await expect(addBlockedSender("mb/1", "ann@x.com")).resolves.toEqual(change);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/mb%2F1/blocked-senders",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ entry: "ann@x.com" }) }),
        );
    });

    it("POSTs the entry to safe-senders", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, change));
        await addSafeSender("mb1", "@x.com");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/mb1/safe-senders",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ entry: "@x.com" }) }),
        );
    });

    it("DELETEs with the entry URL-encoded as one path segment, its @ included", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, change));
        await removeBlockedSender("mb1", "@x.com");
        await removeSafeSender("mb1", "a/b+c@x.com");
        expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/mail/mailboxes/mb1/blocked-senders/%40x.com", expect.objectContaining({ method: "DELETE" }));
        expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/mail/mailboxes/mb1/safe-senders/a%2Fb%2Bc%40x.com", expect.objectContaining({ method: "DELETE" }));
    });

    it("rejects with the server's refusal", async () => {
        mockFetch(() => jsonResponse(403, { message: "Only the mailbox's owner can change its blocked and safe senders." }));
        await expect(addBlockedSender("mb1", "ann@x.com")).rejects.toMatchObject({ status: 403, message: expect.stringContaining("owner") });
    });
});

describe("blockedSendersOf and safeSendersOf", () => {
    it("read the lists, and none for a mailbox that says none", () => {
        expect(blockedSendersOf({ blockedSenders: ["a@x.com"] })).toEqual(["a@x.com"]);
        expect(safeSendersOf({ safeSenders: ["@x.com"] })).toEqual(["@x.com"]);
        expect(blockedSendersOf({})).toEqual([]);
        expect(safeSendersOf({ safeSenders: undefined })).toEqual([]);
    });
});

describe("reportMessage", () => {
    const result = { uid: "m/1", kind: "junk", moved: true, folderUid: "f9", learned: true };

    it("POSTs the kind to the encoded message's report route and answers what the server did", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, result));
        await expect(reportMessage("m/1", "junk")).resolves.toEqual(result);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/m%2F1/report",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ kind: "junk" }) }),
        );
    });

    it("sends alwaysTrustSender only when it is set", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...result, kind: "not_junk", safeSender: "a@x.com" }));
        await reportMessage("m1", "not_junk", { alwaysTrustSender: true });
        await reportMessage("m1", "not_junk", { alwaysTrustSender: false });
        expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ kind: "not_junk", alwaysTrustSender: true });
        expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({ kind: "not_junk" });
    });

    it("rejects with the status of a refusal, a 404 being also what a server without the route answers", async () => {
        mockFetch(() => jsonResponse(404, { message: "Not found" }));
        await expect(reportMessage("m1", "phishing")).rejects.toMatchObject({ status: 404 });
    });
});

describe("with an explicit ApiClient", () => {
    const change = { entry: "ann@x.com", changed: true, blockedSenders: ["ann@x.com"], safeSenders: [] };

    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, change));

        await addBlockedSender("mb1", "ann@x.com", client);
        await removeBlockedSender("mb1", "ann@x.com", client);
        await addSafeSender("mb1", "ann@x.com", client);
        await removeSafeSender("mb1", "ann@x.com", client);

        expect(fetchMock).toHaveBeenCalledTimes(4);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, change));
        await addBlockedSender("mb1", "ann@x.com");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/mb1/blocked-senders",
            expect.objectContaining({ method: "POST" }),
        );
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
