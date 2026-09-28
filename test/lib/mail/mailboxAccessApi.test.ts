// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import {
    getMyMailboxAccess,
    listMailboxAccess,
    lookupMailboxOwnerByEmail,
    removeMailboxAccess,
    resolveMailboxPrincipal,
    setMailboxAccess,
} from "../../../lib/mail/mailboxAccessApi.js";
import { createApiClient } from "../../../lib/util/api.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("getMyMailboxAccess", () => {
    it("fetches the caller's own access with the mailboxUid encoded", async () => {
        const access = { canRead: true, canCreate: true, canUpdate: false, canDelete: false, canManage: false };
        const fetchMock = mockFetch(() => jsonResponse(200, access));
        expect(await getMyMailboxAccess("mb/1")).toEqual(access);
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb%2F1/access/me", expect.anything());
    });
});

describe("listMailboxAccess", () => {
    it("fetches the mailbox's member list", async () => {
        const members = [{ userOrRoleId: "u1", role: "viewer" }];
        const fetchMock = mockFetch(() => jsonResponse(200, members));
        const result = await listMailboxAccess("mb1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb1/access", expect.anything());
        expect(result).toEqual(members);
    });

    it("encodes the mailboxUid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listMailboxAccess("mb/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb%2F1/access", expect.anything());
    });
});

describe("setMailboxAccess", () => {
    it("PUTs the role to the member's own path segment", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { userOrRoleId: "u1", role: "manager" }));
        const result = await setMailboxAccess("mb1", "u1", "manager");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/mb1/access/u1",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ role: "manager" }) }),
        );
        expect(result).toEqual({ userOrRoleId: "u1", role: "manager" });
    });

    it("encodes the userOrRoleId", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { userOrRoleId: "u/1", role: "viewer" }));
        await setMailboxAccess("mb1", "u/1", "viewer");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb1/access/u%2F1", expect.anything());
    });
});

describe("resolveMailboxPrincipal", () => {
    it("asks the server who a typed address, username or uid is, encoding both", async () => {
        const person = { userUid: "u1", displayName: "Jean-Philippe", address: "jp@example.com" };
        const fetchMock = mockFetch(() => jsonResponse(200, person));
        expect(await resolveMailboxPrincipal("mb/1", "jp@example.com")).toEqual(person);
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb%2F1/access/resolve?principal=jp%40example.com", expect.anything());
    });

    it("rejects with the server's own message when nobody is found", async () => {
        mockFetch(() => jsonResponse(404, { message: 'No user found for "nobody".' }));
        await expect(resolveMailboxPrincipal("mb1", "nobody")).rejects.toMatchObject({ status: 404, message: 'No user found for "nobody".' });
    });
});

describe("removeMailboxAccess", () => {
    it("DELETEs the member's own path segment", async () => {
        const fetchMock = mockFetch(() => jsonResponse(204, undefined));
        await removeMailboxAccess("mb1", "u1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb1/access/u1", expect.objectContaining({ method: "DELETE" }));
    });
});

describe("lookupMailboxOwnerByEmail", () => {
    it("fetches with the email query param and returns the match", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { userUid: "u1", displayName: "Jane Doe" }));
        const result = await lookupMailboxOwnerByEmail("jane@example.com");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/lookup-by-email?email=jane%40example.com", expect.anything());
        expect(result).toEqual({ userUid: "u1", displayName: "Jane Doe" });
    });

    it("returns null for no match", async () => {
        mockFetch(() => jsonResponse(200, null));
        const result = await lookupMailboxOwnerByEmail("nobody@example.com");
        expect(result).toBeNull();
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, { userOrRoleId: "u1", role: "viewer", userUid: "u1" }));

        await resolveMailboxPrincipal("mb1", "jp@example.com", client);
        await listMailboxAccess("mb1", client);
        await setMailboxAccess("mb1", "u1", "manager", client);
        await getMyMailboxAccess("mb1", client);
        await removeMailboxAccess("mb1", "u1", client);
        await lookupMailboxOwnerByEmail("jane@example.com", client);

        expect(fetchMock).toHaveBeenCalledTimes(6);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listMailboxAccess("mb1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb1/access", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
