// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../testUtils.js";
import {
    addPlugin,
    expectedPlanOf,
    getPluginStatus,
    getPluginUpdates,
    listPluginNamespaces,
    searchPlugins,
    listPlugins,
    lookupPluginPackage,
    planPluginChange,
    removePlugin,
    retryPluginPurge,
    updatePlugin,
    uploadPlugin,
} from "../../../lib/admin/pluginsApi.js";
import { createApiClient } from "../../../lib/util/api.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("pluginsApi", () => {
    it("lists plugins and reads their status", async () => {
        const fetchMock = mockFetch((url) => jsonResponse(200, url.endsWith("/status") ? { hash: "h", instances: [] } : []));
        expect(await listPlugins()).toEqual([]);
        expect(await getPluginStatus()).toEqual({ hash: "h", instances: [] });
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins", expect.anything());
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/status", expect.anything());
    });

    it("looks a package up by a name in the query string, optionally at a version", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        await lookupPluginPackage("@rapidmx/activesync");
        await lookupPluginPackage("@rapidmx/activesync", "1.0.0-beta.1");
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/registry?name=%40rapidmx%2Factivesync", expect.anything());
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/registry?name=%40rapidmx%2Factivesync&packageVersion=1.0.0-beta.1", expect.anything());
    });

    it("adds, updates and removes a plugin", async () => {
        const fetchMock = mockFetch((_url, init) => (init?.method === "DELETE" ? emptyResponse(204) : jsonResponse(200, { uid: "p1" })));
        await addPlugin("@rapidmx/mapi", "1.0.0");
        await updatePlugin("p1", { version: 2, enabled: false, settings: { "mail:x": null } });
        await removePlugin("p1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system/plugins",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "@rapidmx/mapi", packageVersion: "1.0.0" }) }),
        );
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system/plugins/p1",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ version: 2, enabled: false, settings: { "mail:x": null } }) }),
        );
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/p1", expect.objectContaining({ method: "DELETE" }));
    });

    it("removes a plugin without a body unless its data is to be deleted, and reports what happened", async () => {
        const fetchMock = mockFetch((_url, init) => (init?.body ? jsonResponse(200, { purgeScheduled: true, purge: { uid: "u1", name: "@rapidmx/mapi", state: "pending", steps: [] } }) : emptyResponse(204)));
        // An older server answers with nothing at all: no data deletion was scheduled.
        expect(await removePlugin("p1")).toEqual({ purgeScheduled: false });
        expect(await removePlugin("p1", { purgeData: false })).toEqual({ purgeScheduled: false });
        expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit).body === undefined)).toBe(true);

        expect(await removePlugin("p1", { purgeData: true })).toEqual({ purgeScheduled: true, purge: expect.objectContaining({ state: "pending" }) });
        expect(fetchMock).toHaveBeenLastCalledWith(
            "/api/system/plugins/p1",
            expect.objectContaining({ method: "DELETE", body: JSON.stringify({ purgeData: true }) }),
        );
    });

    it("retries a failed data deletion by its uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "u/1", name: "@rapidmx/mapi", state: "pending", steps: [] }));
        expect(await retryPluginPurge("u/1")).toEqual(expect.objectContaining({ state: "pending" }));
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/purges/u%2F1/retry", expect.objectContaining({ method: "POST" }));
    });

    it("sends the confirmed plan with an add or update", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "p1" }));
        const expectedPlan = expectedPlanOf({
            install: [{ name: "@rapidmx/mapi", version: "1.0.0", integrity: "sha512-x", manifest: { apiVersion: 1, displayName: "MAPI" } }],
            enable: ["@rapidmx/activesync"],
        });
        expect(expectedPlan).toEqual({ install: [{ name: "@rapidmx/mapi", version: "1.0.0" }], enable: ["@rapidmx/activesync"] });
        expect(expectedPlanOf({ plugin: { version: "2.0.0" }, install: [], enable: [] })).toEqual({ version: "2.0.0", install: [], enable: [] });
        await addPlugin("@rapidmx/autodiscover-plugin", "2.0.0", expectedPlan);
        await updatePlugin("p1", { version: 2, enabled: true, expectedPlan: { install: [], enable: [] } });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system/plugins",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ name: "@rapidmx/autodiscover-plugin", packageVersion: "2.0.0", expectedPlan }),
            }),
        );
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system/plugins/p1",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ version: 2, enabled: true, expectedPlan: { install: [], enable: [] } }) }),
        );
    });

    it("plans a change, optionally at a version", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { install: [], enable: [], conflicts: [] }));
        expect(await planPluginChange("@rapidmx/autodiscover-plugin")).toEqual({ install: [], enable: [], conflicts: [] });
        await planPluginChange("@rapidmx/autodiscover-plugin", "1.0.0-beta.1");
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/plan?name=%40rapidmx%2Fautodiscover-plugin", expect.anything());
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/plan?name=%40rapidmx%2Fautodiscover-plugin&packageVersion=1.0.0-beta.1", expect.anything());
    });

    it("lists namespaces, searches for plugins in all or one namespace, and checks for updates", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listPluginNamespaces();
        await searchPlugins();
        await searchPlugins("@my-company");
        await getPluginUpdates();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/namespaces", expect.anything());
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/search", expect.anything());
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/search?namespace=%40my-company", expect.anything());
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/updates", expect.anything());
    });

    it("asks for prerelease versions only when told to", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await getPluginUpdates({ prerelease: true });
        await getPluginUpdates({ prerelease: false });
        await searchPlugins(undefined, { prerelease: true });
        await searchPlugins("@my-company", { prerelease: true });
        await lookupPluginPackage("@rapidmx/activesync", undefined, { prerelease: true });
        await lookupPluginPackage("@rapidmx/activesync", "1.0.0-beta.1", { prerelease: true });
        await planPluginChange("@rapidmx/autodiscover-plugin", undefined, { prerelease: true });
        await planPluginChange("@rapidmx/autodiscover-plugin", "1.0.0", { prerelease: false });
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/updates?prerelease=true", expect.anything());
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/updates", expect.anything());
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/search?prerelease=true", expect.anything());
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/search?namespace=%40my-company&prerelease=true", expect.anything());
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/registry?name=%40rapidmx%2Factivesync&prerelease=true", expect.anything());
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system/plugins/registry?name=%40rapidmx%2Factivesync&packageVersion=1.0.0-beta.1&prerelease=true",
            expect.anything(),
        );
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/plan?name=%40rapidmx%2Fautodiscover-plugin&prerelease=true", expect.anything());
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/plan?name=%40rapidmx%2Fautodiscover-plugin&packageVersion=1.0.0", expect.anything());
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "p1" }));

        await listPlugins(client);
        await getPluginStatus(client);
        await listPluginNamespaces(client);
        await searchPlugins(undefined, {}, client);
        await getPluginUpdates({}, client);
        await lookupPluginPackage("@rapidmx/mapi", undefined, {}, client);
        await planPluginChange("@rapidmx/mapi", undefined, {}, client);
        await addPlugin("@rapidmx/mapi", "1.0.0", undefined, client);
        await updatePlugin("p1", { version: 1 }, client);
        await removePlugin("p1", {}, client);
        await retryPluginPurge("u1", client);

        expect(fetchMock).toHaveBeenCalledTimes(11);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listPlugins();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});

describe("uploadPlugin", () => {
    const row = { uid: "p1", name: "@acme/x-plugin", packageVersion: "1.2.3", source: "upload", uploadFilename: "acme-x-plugin-1.2.3.tgz" };

    it("posts the file's raw bytes as application/gzip with its name in the query string", async () => {
        const file = new File(["gz"], "acme x&plugin-1.2.3.tgz");
        const fetchMock = mockFetch(() => jsonResponse(201, row));
        expect(await uploadPlugin(file)).toEqual(row);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system/plugins/upload?filename=acme+x%26plugin-1.2.3.tgz",
            expect.objectContaining({ method: "POST", body: file, credentials: "include" }),
        );
        expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get("Content-Type")).toBe("application/gzip");
    });

    it("adds replace=true only when asked to replace", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, row));
        await uploadPlugin(new File(["gz"], "a.tgz"), { replace: true });
        await uploadPlugin(new File(["gz"], "a.tgz"), { replace: false });
        expect(fetchMock.mock.calls[0][0]).toBe("/api/system/plugins/upload?filename=a.tgz&replace=true");
        expect(fetchMock.mock.calls[1][0]).toBe("/api/system/plugins/upload?filename=a.tgz");
    });

    it("throws an ApiRequestError carrying the server's status, code and message", async () => {
        mockFetch(() => jsonResponse(409, { message: "@acme/x-plugin 1.0.0 is already installed from the registry." }));
        await expect(uploadPlugin(new File(["gz"], "a.tgz"))).rejects.toMatchObject({
            name: "ApiRequestError",
            status: 409,
            message: "@acme/x-plugin 1.0.0 is already installed from the registry.",
        });
        mockFetch(() => jsonResponse(403, { code: "api-104", message: "Elevation required" }));
        await expect(uploadPlugin(new File(["gz"], "a.tgz"))).rejects.toMatchObject({ status: 403, code: "api-104" });
    });

    it("falls back to its own message when the server gave none", async () => {
        mockFetch(() => emptyResponse(413));
        await expect(uploadPlugin(new File(["gz"], "a.tgz"))).rejects.toMatchObject({ status: 413, message: "Could not upload the plugin." });
    });

    it("goes through an explicit client's origin and token", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(201, row));
        const file = new File(["gz"], "a.tgz");
        await uploadPlugin(file, {}, client);
        expect(fetchMock.mock.calls[0][0]).toBe("https://account-a.example.com/api/system/plugins/upload?filename=a.tgz");
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(init.body).toBe(file);
        expect((init.headers as Headers).get("Authorization")).toBe("jwt tok-a");
        expect((init.headers as Headers).get("Content-Type")).toBe("application/gzip");
    });
});
