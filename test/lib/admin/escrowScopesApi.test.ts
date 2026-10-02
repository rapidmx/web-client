// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../testUtils.js";
import { createApiClient } from "../../../lib/util/api.js";
import {
    createEscrowScope,
    deleteEscrowScope,
    getEscrowScope,
    listEscrowScopes,
    resolveEscrowScopeHolder,
    updateEscrowScope,
} from "../../../lib/admin/escrowScopesApi.js";

const publicKey = {
    publicKey: "base64cert",
    type: "x509",
    fingerprint: "abc123",
    notBefore: 1735689600000,
    notAfter: 1767225600000,
};

const scope = {
    uid: "es1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    name: "Legal Hold Q1",
    description: "eDiscovery scope",
    publicKey,
    holderUserUids: ["u1", "u2"],
    requiredHolders: 2,
    notifySubjectOnAccess: false,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("listEscrowScopes", () => {
    it("fetches with default pagination", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [scope]));
        const result = await listEscrowScopes();
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/scopes?limit=25&page=0&sort=" + encodeURIComponent(JSON.stringify({ uid: "ASC" })), expect.anything());
        expect(result).toEqual([scope]);
    });

    it("forwards a custom page/limit", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listEscrowScopes({ page: 2, limit: 10 });
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/scopes?limit=10&page=2&sort=" + encodeURIComponent(JSON.stringify({ uid: "ASC" })), expect.anything());
    });
});

describe("getEscrowScope", () => {
    it("fetches the encoded uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, scope));
        const result = await getEscrowScope("es/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/scopes/es%2F1", expect.anything());
        expect(result).toEqual(scope);
    });
});

describe("createEscrowScope", () => {
    it("posts the input with a notifySubjectOnAccess default", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, scope));
        await createEscrowScope({
            name: "Legal Hold Q1",
            publicKey,
            holderUserUids: ["u1", "u2"],
            requiredHolders: 2,
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/escrow/scopes",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({
                    notifySubjectOnAccess: false,
                    name: "Legal Hold Q1",
                    publicKey,
                    holderUserUids: ["u1", "u2"],
                    requiredHolders: 2,
                }),
            }),
        );
    });

    it("forwards an explicit notifySubjectOnAccess instead of the default", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, scope));
        await createEscrowScope({
            name: "Legal Hold Q1",
            publicKey,
            holderUserUids: ["u1"],
            requiredHolders: 1,
            notifySubjectOnAccess: true,
        });
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.notifySubjectOnAccess).toBe(true);
    });
});

describe("updateEscrowScope", () => {
    it("PUTs the encoded uid with the input", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...scope, name: "Renamed" }));
        const result = await updateEscrowScope({ uid: "es1", version: 0, name: "Renamed" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/escrow/scopes/es1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "es1", version: 0, name: "Renamed" }),
            }),
        );
        expect(result.name).toBe("Renamed");
    });
});

describe("deleteEscrowScope", () => {
    it("DELETEs the encoded uid with the version query param", async () => {
        const fetchMock = mockFetch(() => emptyResponse(200));
        await deleteEscrowScope("es1", 3);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/escrow/scopes/es1?version=3",
            expect.objectContaining({ method: "DELETE" }),
        );
    });
});

describe("resolveEscrowScopeHolder", () => {
    it("asks the server who a typed address, username or uid is, encoding it", async () => {
        const person = { userUid: "u1", displayName: "Jean-Philippe", address: "jp@example.com" };
        const fetchMock = mockFetch(() => jsonResponse(200, person));
        expect(await resolveEscrowScopeHolder("jp@example.com")).toEqual(person);
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/scopes/resolve-holder?principal=jp%40example.com", expect.anything());
    });

    it("rejects with the server's own message when nobody is found", async () => {
        mockFetch(() => jsonResponse(404, { message: 'No user found for "nobody".' }));
        await expect(resolveEscrowScopeHolder("nobody")).rejects.toMatchObject({ status: 404, message: 'No user found for "nobody".' });
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, scope));

        await listEscrowScopes({}, client);
        await getEscrowScope("es1", client);
        await createEscrowScope({ name: "Legal Hold Q1", publicKey, holderUserUids: ["u1"], requiredHolders: 1 }, client);
        await updateEscrowScope({ uid: "es1", version: 0, name: "Renamed" }, client);
        await deleteEscrowScope("es1", 0, client);
        await resolveEscrowScopeHolder("jp@example.com", client);

        expect(fetchMock).toHaveBeenCalledTimes(6);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, scope));
        await getEscrowScope("es1");
        expect(fetchMock).toHaveBeenCalledWith("/api/escrow/scopes/es1", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
