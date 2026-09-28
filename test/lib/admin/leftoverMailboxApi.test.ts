// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, createApiClient } from "../../../lib/util/api.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { eraseLeftoverMailbox, isErasureSettled, leftoverConflictOf, listLeftoverMailboxes } from "../../../lib/admin/leftoverMailboxApi.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("listLeftoverMailboxes", () => {
    it("fetches the first page with no query at all", async () => {
        const page = { items: [{ mailboxUid: "gone@example.com", folderCount: 11, messageCount: 4 }] };
        const fetchMock = mockFetch(() => jsonResponse(200, page));
        const result = await listLeftoverMailboxes();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/leftover", expect.anything());
        expect(result).toEqual(page);
    });

    it("forwards limit and the after cursor, encoded", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { items: [] }));
        await listLeftoverMailboxes({ limit: 20, after: "a+b@example.com" });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/leftover?limit=20&after=a%2Bb%40example.com", expect.anything());
    });
});

describe("eraseLeftoverMailbox", () => {
    it("posts the mailbox uid to the leftover erasure endpoint and answers the request", async () => {
        const request = { uid: "der1", mailboxUid: "gone@example.com", status: "approved", leftoverOnly: true };
        const fetchMock = mockFetch(() => jsonResponse(200, request));
        const result = await eraseLeftoverMailbox("gone@example.com");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/erasure-requests/leftover",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ mailboxUid: "gone@example.com" }) }),
        );
        expect(result).toEqual(request);
    });

    it("rejects with the server's own message when it refuses (a legal hold)", async () => {
        mockFetch(() => jsonResponse(409, { message: "This action is blocked by an active legal hold: m1." }));
        await expect(eraseLeftoverMailbox("gone@example.com")).rejects.toThrow("blocked by an active legal hold");
    });
});

describe("leftoverConflictOf", () => {
    const conflict = (body: unknown, status = 409) => new ApiRequestError("409", status, "api-011", body);

    it("recognises the data-remaining refusal, with the address", () => {
        expect(leftoverConflictOf(conflict({ reason: "mailbox-data-remaining", mailboxUid: "gone@example.com" }))).toEqual({
            reason: "mailbox-data-remaining",
            mailboxUid: "gone@example.com",
        });
    });

    it("recognises the erasing refusal and the request to wait for", () => {
        expect(
            leftoverConflictOf(conflict({ reason: "mailbox-data-erasing", mailboxUid: "gone@example.com", erasure: { uid: "der1", status: "in_progress" } })),
        ).toEqual({ reason: "mailbox-data-erasing", mailboxUid: "gone@example.com", erasure: { uid: "der1", status: "in_progress" } });
    });

    it("leaves the address out when the body does not name it as text", () => {
        expect(leftoverConflictOf(conflict({ reason: "mailbox-data-remaining", mailboxUid: 7 }))).toEqual({
            reason: "mailbox-data-remaining",
            mailboxUid: undefined,
        });
    });

    it.each([
        ["an erasing refusal that names no request", { reason: "mailbox-data-erasing" }],
        ["an erasing refusal whose request is malformed", { reason: "mailbox-data-erasing", erasure: { uid: 3, status: "approved" } }],
        ["an erasing refusal whose request has no status", { reason: "mailbox-data-erasing", erasure: { uid: "der1" } }],
        ["another reason", { reason: "mailbox-exists" }],
        ["no reason (an older server)", { message: "This address still has data from a deleted mailbox." }],
        ["no body", undefined],
    ])("does not recognise %s", (_label, body) => {
        expect(leftoverConflictOf(conflict(body))).toBeUndefined();
    });

    it("does not recognise a status other than 409, or an error that is not an API error", () => {
        expect(leftoverConflictOf(conflict({ reason: "mailbox-data-remaining" }, 400))).toBeUndefined();
        expect(leftoverConflictOf(new Error("boom"))).toBeUndefined();
        expect(leftoverConflictOf(undefined)).toBeUndefined();
    });
});

describe("isErasureSettled", () => {
    it.each([
        ["completed", true],
        ["denied", true],
        ["pending", false],
        ["approved", false],
        ["in_progress", false],
    ] as const)("%s -> %s", (status, settled) => {
        expect(isErasureSettled(status)).toBe(settled);
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, { items: [] }));

        await listLeftoverMailboxes({}, client);
        await eraseLeftoverMailbox("gone@example.com", client);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, { items: [] }));
        await listLeftoverMailboxes();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/leftover", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
