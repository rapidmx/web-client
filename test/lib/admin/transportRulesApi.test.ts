// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../testUtils.js";
import { createApiClient } from "../../../lib/util/api.js";
import {
    createTransportRule,
    deleteTransportRule,
    getTransportRule,
    listTransportRules,
    updateTransportRule,
} from "../../../lib/admin/transportRulesApi.js";

const rule = {
    uid: "tr1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    name: "Flag external senders",
    enabled: true,
    sequence: 0,
    stopProcessingRules: false,
    conditions: {},
    actions: [],
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("listTransportRules", () => {
    it("fetches with default pagination", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [rule]));
        const result = await listTransportRules();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/transport-rules?limit=25&page=0&sort=" + encodeURIComponent(JSON.stringify({ sequence: "ASC", uid: "ASC" })), expect.anything());
        expect(result).toEqual([rule]);
    });

    it("forwards a custom page/limit", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listTransportRules({ page: 2, limit: 10 });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/transport-rules?limit=10&page=2&sort=" + encodeURIComponent(JSON.stringify({ sequence: "ASC", uid: "ASC" })), expect.anything());
    });
});

describe("getTransportRule", () => {
    it("fetches the encoded uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, rule));
        const result = await getTransportRule("tr/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/transport-rules/tr%2F1", expect.anything());
        expect(result).toEqual(rule);
    });
});

describe("createTransportRule", () => {
    it("posts the input with enabled/sequence/stopProcessingRules/conditions/actions defaults", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, rule));
        await createTransportRule({ name: "Flag external senders" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/transport-rules",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({
                    enabled: true,
                    sequence: 0,
                    stopProcessingRules: false,
                    conditions: {},
                    actions: [],
                    name: "Flag external senders",
                }),
            }),
        );
    });

    it("forwards explicit conditions/actions instead of the defaults", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, rule));
        await createTransportRule({
            name: "Flag external senders",
            enabled: false,
            sequence: 5,
            stopProcessingRules: true,
            conditions: { anyRecipientExternal: true },
            actions: [{ type: "reject" }],
        });
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.enabled).toBe(false);
        expect(body.sequence).toBe(5);
        expect(body.stopProcessingRules).toBe(true);
        expect(body.conditions).toEqual({ anyRecipientExternal: true });
        expect(body.actions).toEqual([{ type: "reject" }]);
    });
});

describe("updateTransportRule", () => {
    it("PUTs the encoded uid with the input", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...rule, name: "Renamed" }));
        const result = await updateTransportRule({ uid: "tr1", version: 0, name: "Renamed" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/transport-rules/tr1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "tr1", version: 0, name: "Renamed" }),
            }),
        );
        expect(result.name).toBe("Renamed");
    });
});

describe("deleteTransportRule", () => {
    it("DELETEs the encoded uid with the version query param", async () => {
        const fetchMock = mockFetch(() => emptyResponse(200));
        await deleteTransportRule("tr1", 3);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/transport-rules/tr1?version=3",
            expect.objectContaining({ method: "DELETE" }),
        );
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, rule));

        await listTransportRules({}, client);
        await getTransportRule("tr1", client);
        await createTransportRule({ name: "Flag external senders" }, client);
        await updateTransportRule({ uid: "tr1", version: 0, name: "Renamed" }, client);
        await deleteTransportRule("tr1", 0, client);

        expect(fetchMock).toHaveBeenCalledTimes(5);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, rule));
        await getTransportRule("tr1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/transport-rules/tr1", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
