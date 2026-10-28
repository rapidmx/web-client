// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../testUtils.js";
import { createApiClient } from "../../../lib/util/api.js";
import {
    createDnsProvider,
    deleteDnsProvider,
    getDnsControllerState,
    getDnsProvider,
    listDnsProviderOperations,
    listDnsProviders,
    listDnsProviderTypes,
    takeoverDnsRecords,
    takeoverDnsHosts,
    listDnsHostPublications,
    testDnsProvider,
    updateDnsProvider,
} from "../../../lib/admin/dnsProvidersApi.js";

const provider = {
    uid: "cloudflare-ab12cd34",
    name: "Cloudflare",
    type: "cloudflare",
    zones: ["example.com"],
    options: { zoneIds: ["0123456789abcdef0123456789abcdef"] },
    credentials: { apiToken: { secret: true } },
    enabled: true,
    allowTakeover: false,
    domainCount: 1,
    version: 4,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("dnsProvidersApi", () => {
    it("lists the configs, the types and the controller's state", async () => {
        const fetchMock = mockFetch((url) => jsonResponse(200, url.endsWith("/controller") ? { handshake: null, lastReport: null, lastStandbyReport: null } : []));
        await listDnsProviders();
        await listDnsProviderTypes();
        await getDnsControllerState();
        expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
            "/api/system/dns-providers",
            "/api/system/dns-providers/types",
            "/api/system/dns-providers/controller",
        ]);
    });

    it("reads one config and its operations by uid", async () => {
        const fetchMock = mockFetch((url) => jsonResponse(200, url.endsWith("/operations") ? [] : provider));
        expect(await getDnsProvider("cloudflare-ab12cd34")).toEqual(provider);
        await listDnsProviderOperations("cloudflare-ab12cd34");
        expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
            "/api/system/dns-providers/cloudflare-ab12cd34",
            "/api/system/dns-providers/cloudflare-ab12cd34/operations",
        ]);
    });

    it("creates, updates, tests and deletes a config", async () => {
        const fetchMock = mockFetch((_url, init) => (init.method === "DELETE" ? emptyResponse(204) : jsonResponse(200, provider)));
        const input = { name: "Cloudflare", type: "cloudflare" as const, zones: ["example.com"], credentials: { apiToken: "token" } };
        await createDnsProvider(input);
        await updateDnsProvider("cloudflare-ab12cd34", { name: "Main", credentials: { apiToken: null }, version: 4 });
        await testDnsProvider("cloudflare-ab12cd34");
        await deleteDnsProvider("cloudflare-ab12cd34");
        expect(fetchMock.mock.calls.map((call) => [call[0], call[1].method, call[1].body])).toEqual([
            ["/api/system/dns-providers", "POST", JSON.stringify(input)],
            ["/api/system/dns-providers/cloudflare-ab12cd34", "PUT", JSON.stringify({ name: "Main", credentials: { apiToken: null }, version: 4 })],
            ["/api/system/dns-providers/cloudflare-ab12cd34/test", "POST", undefined],
            ["/api/system/dns-providers/cloudflare-ab12cd34", "DELETE", undefined],
        ]);
    });

    it("queues a takeover of a domain's records, all of them or the types asked for", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "op1" }));
        await takeoverDnsRecords("cloudflare-ab12cd34", "example.com");
        await takeoverDnsRecords("cloudflare-ab12cd34", "example.com", ["mx", "dmarc"]);
        expect(fetchMock.mock.calls.map((call) => [call[0], call[1].method, call[1].body])).toEqual([
            ["/api/system/dns-providers/cloudflare-ab12cd34/takeover", "POST", JSON.stringify({ domainUid: "example.com" })],
            ["/api/system/dns-providers/cloudflare-ab12cd34/takeover", "POST", JSON.stringify({ domainUid: "example.com", records: ["mx", "dmarc"] })],
        ]);
    });

    it("queues a takeover of the deployment's hosts, all of them or the names asked for", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "op1" }));
        await takeoverDnsHosts("cloudflare-ab12cd34");
        await takeoverDnsHosts("cloudflare-ab12cd34", ["mail.example.com", "auth.example.com"]);
        expect(fetchMock.mock.calls.map((call) => [call[0], call[1].method, call[1].body])).toEqual([
            ["/api/system/dns-providers/cloudflare-ab12cd34/takeover", "POST", JSON.stringify({ hosts: true })],
            ["/api/system/dns-providers/cloudflare-ab12cd34/takeover", "POST", JSON.stringify({ hosts: true, records: ["mail.example.com", "auth.example.com"] })],
        ]);
    });

    it("lists how the deployment's hosts are published", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [{ recordName: "mail.example.com" }]));
        expect(await listDnsHostPublications()).toEqual([{ recordName: "mail.example.com" }]);
        expect(fetchMock.mock.calls[0][0]).toBe("/api/system/dns-providers/hosts");
    });

    it("escapes a uid in the path", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, provider));
        await getDnsProvider("a/b");
        expect(fetchMock.mock.calls[0][0]).toBe("/api/system/dns-providers/a%2Fb");
    });

    it("goes through an explicit client when given one", async () => {
        const client = createApiClient({ baseUrl: "https://mail.example.com", getAccessToken: async () => "tok" });
        const fetchMock = mockFetch((_url, init) => (init.method === "DELETE" ? emptyResponse(204) : jsonResponse(200, [])));
        await listDnsProviders(client);
        await listDnsProviderTypes(client);
        await getDnsControllerState(client);
        await getDnsProvider("p", client);
        await listDnsProviderOperations("p", client);
        await createDnsProvider({ name: "n", type: "route53", zones: ["example.com"] }, client);
        await updateDnsProvider("p", { enabled: false }, client);
        await testDnsProvider("p", client);
        await takeoverDnsRecords("p", "example.com", ["mx"], client);
        await takeoverDnsHosts("p", undefined, client);
        await listDnsHostPublications(client);
        await deleteDnsProvider("p", client);
        expect(fetchMock.mock.calls.every((call) => String(call[0]).startsWith("https://mail.example.com/api/system/dns-providers"))).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(12);
    });
});
