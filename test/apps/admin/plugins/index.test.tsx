// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../../testUtils.js";
import PluginsPage from "../../../../apps/admin/plugins/index.js";
import PluginsManager from "../../../../apps/shared/components/admin/settings/PluginsManager.js";

const eas = {
    uid: "p-eas",
    version: 3,
    name: "@rapidmx/activesync",
    packageVersion: "1.0.0",
    enabled: true,
    settings: { "mail:eas:sync_window_size": 50 },
    manifest: {
        apiVersion: 1,
        displayName: "Exchange ActiveSync",
        description: "Phone sync",
        settings: [
            { key: "mail:eas:sync_window_size", label: "Sync batch size", type: "number", default: 100, min: 1, max: 512 },
            { key: "mail:eas:provision:password_enabled", label: "Require a device passcode", type: "boolean", default: true },
            { key: "mail:eas:mode", label: "Mode", type: "select", options: [{ value: "a", label: "Mode A" }] },
            { key: "mail:eas:note", label: "Note", type: "string", help: "Free text" },
        ],
    },
};
const mapi = {
    ...eas,
    uid: "p-mapi",
    name: "@rapidmx/mapi",
    enabled: false,
    settings: {},
    manifest: { apiVersion: 1, displayName: "MAPI over HTTP", settings: [] },
};

const instance = (overrides: Record<string, unknown> = {}) => ({
    instance: "pod-a",
    hash: "current",
    loaded: [{ name: "@rapidmx/activesync", version: "1.0.0" }],
    errors: [],
    safeMode: false,
    updatedAt: "2026-09-13T00:00:00.000Z",
    ...overrides,
});

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function mockPlugins(options: { plugins?: unknown[]; status?: unknown; extra?: Handler } = {}) {
    return mockFetch((url, init) => {
        const custom = options.extra?.(url, init);
        if (custom) return custom;
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        if (url === "/api/system/plugins/status") return jsonResponse(200, options.status ?? { hash: "current", instances: [instance()] });
        if (url.startsWith("/api/system/plugins/plan?")) {
            // By default a change needs nothing else.
            const query = new URLSearchParams(url.split("?")[1]);
            return jsonResponse(200, { plugin: { name: query.get("name"), version: query.get("packageVersion") }, install: [], enable: [], conflicts: [] });
        }
        if (url === "/api/system/plugins" && (init?.method ?? "GET") === "GET") return jsonResponse(200, options.plugins ?? [eas, mapi]);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

function requestBody(fetchMock: any, url: string, method: string): any {
    const call = fetchMock.mock.calls.find((c: any[]) => c[0] === url && (c[1] as RequestInit)?.method === method);
    return JSON.parse((call[1] as RequestInit).body as string);
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

const renderPage = () => render(<PluginsPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

/** The `expectedPlan` of a change to `version` that needs no other plugins. */
const noExtras = (version: string) => ({ version, install: [], enable: [] });

describe("PluginsPage", () => {
    it("shows an empty state", async () => {
        mockPlugins({ plugins: [], status: { hash: "h", instances: [] } });
        renderPage();
        expect(await screen.findByText("No plugins installed.")).toBeInTheDocument();
    });

    it("heads the Plugins page with its title and introduction", async () => {
        mockPlugins();
        renderPage();
        expect(await screen.findByRole("heading", { level: 1, name: "Plugins" })).toBeInTheDocument();
        expect(screen.getByText(/Plugins add protocols and features to every server/)).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 2, name: "Installed plugins" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 2, name: "Find plugins" })).toBeInTheDocument();
    });

    it("leaves out the page title and introduction when embedded in another page, keeping Add by name", async () => {
        mockPlugins();
        const user = userEvent.setup();
        render(<PluginsManager embedded />);
        expect(await screen.findByText("Exchange ActiveSync")).toBeInTheDocument();
        expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
        expect(screen.queryByText(/Plugins add protocols and features to every server/)).not.toBeInTheDocument();
        expect(screen.getByText(/only add ones you trust/)).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 3, name: "Installed plugins" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 3, name: "Find plugins" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Add by name" }));
        expect(await screen.findByRole("dialog", { name: "Add plugin" })).toBeInTheDocument();
    });

    it("lists plugins with their load status and errors", async () => {
        mockPlugins({
            status: {
                hash: "current",
                instances: [instance(), instance({ instance: "pod-b", loaded: [], errors: [{ name: "@rapidmx/activesync", message: "npm failed" }] })],
            },
        });
        renderPage();
        const row = (await screen.findByText("Exchange ActiveSync")).closest("tr") as HTMLElement;
        expect(within(row).getByText("@rapidmx/activesync")).toBeInTheDocument();
        expect(within(row).getByText("Phone sync")).toBeInTheDocument();
        expect(within(row).getByText("Loaded on 1 of 2 servers")).toBeInTheDocument();
        expect(within(row).getByText("pod-b: npm failed")).toBeInTheDocument();
        expect(within(row).getByText("Enabled")).toBeInTheDocument();
        expect(within(row).getByRole("button", { name: "Disable Exchange ActiveSync" })).toBeInTheDocument();
        expect(within(row).getByRole("button", { name: "Uninstall" })).toBeInTheDocument();

        const mapiRow = screen.getByText("MAPI over HTTP").closest("tr") as HTMLElement;
        // A disabled plugin shows its state once, with no per-server status.
        expect(within(mapiRow).getAllByText("Disabled")).toHaveLength(1);
        expect(within(mapiRow).queryByText(/Loaded on/)).not.toBeInTheDocument();
        expect(within(mapiRow).getByRole("button", { name: "Enable MAPI over HTTP" })).toBeInTheDocument();
        // No settings declared, so no Settings button.
        expect(within(mapiRow).queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    });

    it("shows unknown status when no server has reported, and still lists plugins when status can't load", async () => {
        mockPlugins({ plugins: [eas], extra: (url) => (url === "/api/system/plugins/status" ? jsonResponse(500, { message: "down" }) : undefined) });
        renderPage();
        expect(await screen.findByText("Server status unknown")).toBeInTheDocument();
    });

    it("shows a load error", async () => {
        mockPlugins({ extra: (url, init) => (url === "/api/system/plugins" && !init?.method ? jsonResponse(500, { message: "boom" }) : undefined) });
        renderPage();
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows rollout progress and polls until every server has applied the change, and warns about safe mode", async () => {
        let polls = 0;
        const fetchMock = mockPlugins({
            extra: (url) => {
                if (url !== "/api/system/plugins/status") return undefined;
                polls++;
                return jsonResponse(200, {
                    hash: "current",
                    instances: polls < 3 ? [instance(), instance({ instance: "pod-b", hash: "old", safeMode: true })] : [instance()],
                });
            },
        });
        renderPage();
        expect(await screen.findByRole("status")).toHaveTextContent("Applying changes: 1 of 2 servers updated.");
        expect(screen.getByText(/pod-b started without any plugins/)).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument(), { timeout: 15000 });
        expect(fetchMock.mock.calls.filter((c) => c[0] === "/api/system/plugins/status").length).toBeGreaterThanOrEqual(3);
    }, 20000);

    it("shows server-wide plugin errors, reported under the name \"*\", in the banner", async () => {
        mockPlugins({
            status: {
                hash: "current",
                instances: [
                    instance({ errors: [{ name: "*", message: "plugin set failed to install" }, { name: "@rapidmx/activesync", message: "row error" }] }),
                    instance({ instance: "pod-b", hash: "old", errors: [{ name: "*", message: "registry unreachable" }] }),
                ],
            },
        });
        renderPage();
        expect(await screen.findByText("pod-a: plugin set failed to install")).toBeInTheDocument();
        expect(screen.getByText("pod-b: registry unreachable")).toBeInTheDocument();
        expect(screen.getByText(/Plugins couldn.t be loaded/)).toBeInTheDocument();
        expect(screen.queryByText("pod-a: row error", { selector: "li" })).not.toBeInTheDocument();
    });

    it("keeps the last status when a refresh fails, and keeps polling the rollout", async () => {
        let polls = 0;
        mockPlugins({
            extra: (url) => {
                if (url !== "/api/system/plugins/status") return undefined;
                polls++;
                if (polls === 2) return jsonResponse(500, { message: "down" });
                return jsonResponse(200, { hash: "current", instances: polls < 3 ? [instance(), instance({ instance: "pod-b", hash: "old" })] : [instance()] });
            },
        });
        renderPage();
        expect(await screen.findByRole("status")).toHaveTextContent("Applying changes: 1 of 2 servers updated.");
        expect(await screen.findByText(/Couldn't refresh server status/, undefined, { timeout: 8000 })).toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveTextContent("Applying changes: 1 of 2 servers updated.");
        await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument(), { timeout: 8000 });
        expect(screen.queryByText(/Couldn't refresh server status/)).not.toBeInTheDocument();
    }, 20000);

    it("keeps polling for a while after a change is saved, before servers start applying it", async () => {
        let saved = false;
        let pollsAfterSave = 0;
        mockPlugins({
            extra: (url, init) => {
                if (url === "/api/system/plugins/p-eas" && init?.method === "PUT") {
                    saved = true;
                    return jsonResponse(200, { ...eas, enabled: false, version: 4 });
                }
                if (url !== "/api/system/plugins/status") return undefined;
                if (saved) pollsAfterSave++;
                // Servers only notice the change a while after it's saved.
                return jsonResponse(200, { hash: pollsAfterSave >= 2 ? "next" : "current", instances: [instance()] });
            },
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Disable Exchange ActiveSync" }));
        expect(await screen.findByRole("button", { name: "Enable Exchange ActiveSync" })).toBeInTheDocument();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(await screen.findByRole("status", undefined, { timeout: 8000 })).toHaveTextContent("Applying changes: 0 of 1 server updated.");
    }, 20000);

    it("stops polling a saved change's rollout once the watch period ends", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const fetchMock = mockPlugins({
            extra: (url, init) => (url === "/api/system/plugins/p-eas" && init?.method === "PUT" ? jsonResponse(200, { ...eas, enabled: false, version: 4 }) : undefined),
        });
        const statusCalls = () => fetchMock.mock.calls.filter((c) => c[0] === "/api/system/plugins/status").length;
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Disable Exchange ActiveSync" }));
        expect(await screen.findByRole("button", { name: "Enable Exchange ActiveSync" })).toBeInTheDocument();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 1000);
        });
        const afterWatch = statusCalls();
        // Polled every few seconds while watching...
        expect(afterWatch).toBeGreaterThan(10);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60 * 1000);
        });
        // ...and not at all once the watch period is over, since nothing is pending.
        expect(statusCalls()).toBe(afterWatch);
    });

    it("keeps retrying, less often each time, when status has never been read", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        let reads = 0;
        mockPlugins({
            extra: (url) => {
                if (url !== "/api/system/plugins/status") return undefined;
                reads++;
                return reads <= 2 ? jsonResponse(500, { message: "down" }) : jsonResponse(200, { hash: "current", instances: [instance()] });
            },
        });
        renderPage();
        expect(await screen.findByText("Server status unknown")).toBeInTheDocument();
        expect(reads).toBe(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5000);
        });
        expect(reads).toBe(2);
        // The next retry waits twice as long.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5000);
        });
        expect(reads).toBe(2);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5000);
        });
        expect(reads).toBe(3);
        expect(await screen.findByText("Loaded on 1 of 1 server")).toBeInTheDocument();
        // Once read, nothing more is retried while nothing is pending.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60 * 1000);
        });
        expect(reads).toBe(3);
    });

    it("doesn't start another status read while a slow one is still running", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        let reads = 0;
        mockPlugins({
            extra: ((url: string) => {
                if (url !== "/api/system/plugins/status") return undefined;
                reads++;
                // The first read shows a rollout under way; every later one hangs.
                return reads === 1 ? jsonResponse(200, { hash: "current", instances: [instance({ hash: "old" })] }) : new Promise<Response>(() => undefined);
            }) as Handler,
        });
        renderPage();
        expect(await screen.findByRole("status")).toHaveTextContent("Applying changes: 0 of 1 server updated.");
        await act(async () => {
            await vi.advanceTimersByTimeAsync(30 * 1000);
        });
        expect(reads).toBe(2);
    });

    it("enables and disables a plugin", async () => {
        const fetchMock = mockPlugins({
            extra: (url, init) => (url === "/api/system/plugins/p-mapi" && init?.method === "PUT" ? jsonResponse(200, { ...mapi, enabled: true, version: 4 }) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Enable MAPI over HTTP" }));
        expect(await screen.findByRole("button", { name: "Disable MAPI over HTTP" })).toBeInTheDocument();
        // Enabling is previewed like any change, and sends the plan it was confirmed against.
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/plan?name=%40rapidmx%2Fmapi&packageVersion=1.0.0", expect.anything());
        expect(requestBody(fetchMock, "/api/system/plugins/p-mapi", "PUT")).toEqual({ version: 3, enabled: true, expectedPlan: noExtras("1.0.0") });
    });

    it("shows an error when toggling fails, and disables without previewing", async () => {
        const fetchMock = mockPlugins({
            extra: (url, init) => (url === "/api/system/plugins/p-eas" && init?.method === "PUT" ? jsonResponse(409, { message: "Version conflict" }) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Disable Exchange ActiveSync" }));
        expect(await screen.findByText("Version conflict")).toBeInTheDocument();
        expect(requestBody(fetchMock, "/api/system/plugins/p-eas", "PUT")).toEqual({ version: 3, enabled: false });
        expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("/api/system/plugins/plan?"))).toBe(false);
    });

    it("adds a plugin after previewing it from the registry", async () => {
        const autodiscover = { ...mapi, uid: "p-ad", name: "@rapidmx/autodiscover", enabled: true, manifest: { apiVersion: 1, displayName: "Autodiscover", settings: [] } };
        const fetchMock = mockPlugins({
            extra: (url, init) => {
                if (url.startsWith("/api/system/plugins/registry/%40rapidmx%2Fautodiscover")) {
                    const version = url.endsWith("?packageVersion=1.0.0") ? "1.0.0" : "2.0.0";
                    return jsonResponse(200, {
                        package: { name: "@rapidmx/autodiscover", latest: "2.0.0", versions: ["2.0.0", "1.0.0"] },
                        selected: {
                            name: "@rapidmx/autodiscover",
                            version,
                            peerDependencies: {},
                            manifest: { apiVersion: 1, displayName: "Autodiscover", description: version === "1.0.0" ? "Finds old servers" : "Finds servers" },
                        },
                    });
                }
                if (url === "/api/system/plugins" && init?.method === "POST") return jsonResponse(200, { plugin: autodiscover, dependencies: [] });
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Add by name" }));
        const dialog = await screen.findByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: "Find" }));
        expect(within(dialog).getByText("Enter a package name.")).toBeInTheDocument();

        await user.type(within(dialog).getByLabelText("Package name"), "@rapidmx/autodiscover");
        await user.click(within(dialog).getByRole("button", { name: "Find" }));
        expect(await within(dialog).findByText("Finds servers")).toBeInTheDocument();
        // The package name is shown alongside the manifest's display name.
        expect(within(dialog).getByText("@rapidmx/autodiscover")).toBeInTheDocument();
        expect(within(dialog).getByRole("option", { name: "2.0.0 (latest)" })).toBeInTheDocument();
        await user.selectOptions(within(dialog).getByLabelText("Version"), "1.0.0");
        // The chosen version's manifest is looked up, not the latest one's.
        expect(await within(dialog).findByText("Finds old servers")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/registry/%40rapidmx%2Fautodiscover?packageVersion=1.0.0", expect.anything());
        await user.click(within(dialog).getByRole("button", { name: "Add plugin" }));

        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(requestBody(fetchMock, "/api/system/plugins", "POST")).toEqual({ name: "@rapidmx/autodiscover", packageVersion: "1.0.0", expectedPlan: noExtras("1.0.0") });
        expect(screen.getByText("Autodiscover")).toBeInTheDocument();
    });

    it("ignores a lookup that finishes after the name was changed, and disables Add while a version loads", async () => {
        let releaseSlow: () => void = () => undefined;
        let releaseVersion: () => void = () => undefined;
        const lookupOf = (name: string, displayName: string, version = "1.0.0") =>
            jsonResponse(200, {
                package: { name, latest: "1.0.0", versions: ["1.0.0", "0.9.0"] },
                selected: { name, version, peerDependencies: {}, manifest: { apiVersion: 1, displayName } },
            });
        mockPlugins({
            extra: ((url: string) => {
                if (url === "/api/system/plugins/registry/%40acme%2Fslow-plugin") {
                    return new Promise<Response>((resolve) => (releaseSlow = () => resolve(lookupOf("@acme/slow-plugin", "Slow"))));
                }
                if (url === "/api/system/plugins/registry/%40acme%2Ffast-plugin") return lookupOf("@acme/fast-plugin", "Fast");
                if (url === "/api/system/plugins/registry/%40acme%2Ffast-plugin?packageVersion=0.9.0") {
                    return new Promise<Response>((resolve) => (releaseVersion = () => resolve(lookupOf("@acme/fast-plugin", "Fast old", "0.9.0"))));
                }
                return undefined;
            }) as Handler,
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Add by name" }));
        const dialog = await screen.findByRole("dialog");
        await user.type(within(dialog).getByLabelText("Package name"), "@acme/slow-plugin");
        await user.click(within(dialog).getByRole("button", { name: "Find" }));

        await user.clear(within(dialog).getByLabelText("Package name"));
        await user.type(within(dialog).getByLabelText("Package name"), "@acme/fast-plugin");
        await user.click(within(dialog).getByRole("button", { name: "Find" }));
        expect(await within(dialog).findByText("Fast")).toBeInTheDocument();

        releaseSlow();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(within(dialog).queryByText("Slow")).not.toBeInTheDocument();
        expect(within(dialog).getByText("@acme/fast-plugin")).toBeInTheDocument();

        await user.selectOptions(within(dialog).getByLabelText("Version"), "0.9.0");
        expect(within(dialog).getByRole("button", { name: "Add plugin" })).toBeDisabled();
        releaseVersion();
        expect(await within(dialog).findByText("Fast old")).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Add plugin" })).toBeEnabled();
    });

    it("ignores a lookup that fails after the name was changed, and keeps the package shown when a version can't be read", async () => {
        let failSlow: () => void = () => undefined;
        const lookupOf = (name: string, displayName: string) =>
            jsonResponse(200, {
                package: { name, latest: "1.0.0", versions: ["1.0.0", "0.9.0"] },
                selected: { name, version: "1.0.0", peerDependencies: {}, manifest: { apiVersion: 1, displayName } },
            });
        mockPlugins({
            extra: ((url: string) => {
                if (url === "/api/system/plugins/registry/%40acme%2Fslow-plugin") {
                    return new Promise<Response>((_resolve, reject) => (failSlow = () => reject(new TypeError("offline"))));
                }
                if (url === "/api/system/plugins/registry/%40acme%2Ffast-plugin") return lookupOf("@acme/fast-plugin", "Fast");
                if (url === "/api/system/plugins/registry/%40acme%2Ffast-plugin?packageVersion=0.9.0") return jsonResponse(503, { message: "Version unavailable" });
                return undefined;
            }) as Handler,
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Add by name" }));
        const dialog = await screen.findByRole("dialog");
        await user.type(within(dialog).getByLabelText("Package name"), "@acme/slow-plugin");
        await user.click(within(dialog).getByRole("button", { name: "Find" }));

        await user.clear(within(dialog).getByLabelText("Package name"));
        await user.type(within(dialog).getByLabelText("Package name"), "@acme/fast-plugin");
        await user.click(within(dialog).getByRole("button", { name: "Find" }));
        expect(await within(dialog).findByText("Fast")).toBeInTheDocument();

        failSlow();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(within(dialog).queryByText("Could not look that package up.")).not.toBeInTheDocument();
        expect(within(dialog).getByText("Fast")).toBeInTheDocument();

        await user.selectOptions(within(dialog).getByLabelText("Version"), "0.9.0");
        expect(await within(dialog).findByText("Version unavailable")).toBeInTheDocument();
        expect(within(dialog).getByText("@acme/fast-plugin")).toBeInTheDocument();
        expect(within(dialog).getByLabelText("Version")).toHaveValue("0.9.0");
        expect(within(dialog).getByRole("button", { name: "Add plugin" })).toBeDisabled();
    });

    it("doesn't show an add that finished after the dialog was closed when it's opened again", async () => {
        let failAdd: () => void = () => undefined;
        mockPlugins({
            extra: ((url: string, init?: RequestInit) => {
                if (url === "/api/system/plugins/registry/%40acme%2Fx-plugin") {
                    return jsonResponse(200, {
                        package: { name: "@acme/x-plugin", latest: "1.0.0", versions: ["1.0.0"] },
                        selected: { name: "@acme/x-plugin", version: "1.0.0", peerDependencies: {}, manifest: { apiVersion: 1, displayName: "X" } },
                    });
                }
                if (url === "/api/system/plugins" && init?.method === "POST") {
                    return new Promise<Response>((resolve) => (failAdd = () => resolve(jsonResponse(502, { message: "Registry down" }))));
                }
                return undefined;
            }) as Handler,
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Add by name" }));
        let dialog = await screen.findByRole("dialog");
        await user.type(within(dialog).getByLabelText("Package name"), "@acme/x-plugin");
        await user.click(within(dialog).getByRole("button", { name: "Find" }));
        await user.click(await within(dialog).findByRole("button", { name: "Add plugin" }));
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

        await user.click(screen.getByRole("button", { name: "Add by name" }));
        dialog = await screen.findByRole("dialog");
        failAdd();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(within(dialog).queryByText("Registry down")).not.toBeInTheDocument();
        await user.type(within(dialog).getByLabelText("Package name"), "@acme/x-plugin");
        await user.click(within(dialog).getByRole("button", { name: "Find" }));
        expect(await within(dialog).findByRole("button", { name: "Add plugin" })).toBeEnabled();
    });

    it("adds a package whose manifest isn't shown under its package name, and explains a non-API failure", async () => {
        mockPlugins({
            extra: (url, init) => {
                if (url === "/api/system/plugins/registry/%40acme%2Fbare") {
                    return jsonResponse(200, { package: { name: "@acme/bare", versions: ["1.0.0"] }, selected: { name: "@acme/bare", version: "1.0.0", peerDependencies: {} } });
                }
                if (url === "/api/system/plugins" && init?.method === "POST") throw new TypeError("network down");
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Add by name" }));
        const dialog = await screen.findByRole("dialog");
        await user.type(within(dialog).getByLabelText("Package name"), "@acme/bare");
        await user.click(within(dialog).getByRole("button", { name: "Find" }));
        await user.click(await within(dialog).findByRole("button", { name: "Add plugin" }));
        expect(await within(dialog).findByText("Could not install @acme/bare.")).toBeInTheDocument();
    });

    it("explains why a package can't be added", async () => {
        mockPlugins({
            extra: (url, init) => {
                if (url === "/api/system/plugins/registry/left-pad") return jsonResponse(400, { message: "'left-pad' is not an allowed plugin package." });
                if (url === "/api/system/plugins/registry/%40rapidmx%2Fnot-plugin") {
                    return jsonResponse(200, {
                        package: { name: "@rapidmx/not-plugin", versions: ["1.0.0"] },
                        selected: { name: "@rapidmx/not-plugin", version: "1.0.0", peerDependencies: {}, manifest: "This package is not a RapidMX plugin." },
                    });
                }
                if (init?.method === "POST") return jsonResponse(502, { message: "Registry down" });
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Add by name" }));
        const dialog = await screen.findByRole("dialog");
        await user.type(within(dialog).getByLabelText("Package name"), "left-pad");
        await user.click(within(dialog).getByRole("button", { name: "Find" }));
        expect(await within(dialog).findByText("'left-pad' is not an allowed plugin package.")).toBeInTheDocument();

        await user.clear(within(dialog).getByLabelText("Package name"));
        await user.type(within(dialog).getByLabelText("Package name"), "@rapidmx/not-plugin");
        await user.click(within(dialog).getByRole("button", { name: "Find" }));
        expect(await within(dialog).findByText("This package is not a RapidMX plugin.")).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Add plugin" })).toBeDisabled();
    });

    it("changes a plugin's version", async () => {
        const fetchMock = mockPlugins({
            extra: (url, init) => {
                if (url === "/api/system/plugins/registry/%40rapidmx%2Factivesync") {
                    return jsonResponse(200, { package: { name: "@rapidmx/activesync", latest: "1.1.0", versions: ["1.1.0", "1.0.0"] }, selected: {} });
                }
                if (url === "/api/system/plugins/p-eas" && init?.method === "PUT") return jsonResponse(200, { ...eas, packageVersion: "1.1.0" });
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        const row = (await screen.findByText("Exchange ActiveSync")).closest("tr") as HTMLElement;
        await user.click(within(row).getByRole("button", { name: "Change version" }));
        const dialog = await screen.findByRole("dialog");
        const select = await within(dialog).findByLabelText("Version");
        expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
        expect(within(dialog).getByRole("option", { name: "1.0.0 (installed)" })).toBeInTheDocument();
        await user.selectOptions(select, "1.1.0");
        await user.click(within(dialog).getByRole("button", { name: "Save" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(requestBody(fetchMock, "/api/system/plugins/p-eas", "PUT")).toEqual({ version: 3, packageVersion: "1.1.0", expectedPlan: noExtras("1.1.0") });
        expect(within(row).getByText("1.1.0")).toBeInTheDocument();
    });

    it("edits settings rendered from the manifest", async () => {
        const fetchMock = mockPlugins({
            extra: (url, init) => (url === "/api/system/plugins/p-eas" && init?.method === "PUT" ? jsonResponse(200, eas) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        const row = (await screen.findByText("Exchange ActiveSync")).closest("tr") as HTMLElement;
        await user.click(within(row).getByRole("button", { name: "Settings" }));
        const dialog = await screen.findByRole("dialog");

        expect(within(dialog).getByLabelText("Sync batch size")).toHaveValue(50);
        expect(within(dialog).getByRole("checkbox", { name: "Require a device passcode" })).toBeChecked();
        expect(within(dialog).getByText("Free text")).toBeInTheDocument();

        await user.clear(within(dialog).getByLabelText("Sync batch size"));
        await user.type(within(dialog).getByLabelText("Sync batch size"), "64");
        await user.click(within(dialog).getByRole("checkbox", { name: "Require a device passcode" }));
        await user.selectOptions(within(dialog).getByLabelText("Mode"), "a");
        await user.type(within(dialog).getByLabelText("Note"), "hi");
        await user.click(within(dialog).getByRole("button", { name: "Save" }));

        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(requestBody(fetchMock, "/api/system/plugins/p-eas", "PUT")).toEqual({
            version: 3,
            settings: {
                "mail:eas:sync_window_size": 64,
                "mail:eas:provision:password_enabled": false,
                "mail:eas:mode": "a",
                "mail:eas:note": "hi",
            },
        });
    });

    it("sends every setting, since the server replaces them all, keeping unchanged ones as saved and saving a required select's first option", async () => {
        const plugin = {
            ...mapi,
            settings: { "x:note": "kept", "x:size": 7 },
            manifest: {
                apiVersion: 1,
                displayName: "MAPI over HTTP",
                settings: [
                    { key: "x:flag", label: "Flag", type: "boolean", default: true },
                    { key: "x:region", label: "Region", type: "select", required: true, options: [{ value: "eu", label: "EU" }, { value: "us", label: "US" }] },
                    { key: "x:note", label: "Note", type: "string" },
                    { key: "x:size", label: "Size", type: "number", default: 5 },
                ],
            },
        };
        const fetchMock = mockPlugins({
            plugins: [plugin],
            extra: (url, init) => (url === "/api/system/plugins/p-mapi" && init?.method === "PUT" ? jsonResponse(200, plugin) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        const row = (await screen.findByText("MAPI over HTTP")).closest("tr") as HTMLElement;
        await user.click(within(row).getByRole("button", { name: "Settings" }));
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByLabelText("Region")).toHaveValue("eu");
        await user.type(within(dialog).getByLabelText("Note"), "!");
        await user.click(within(dialog).getByRole("button", { name: "Save" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(requestBody(fetchMock, "/api/system/plugins/p-mapi", "PUT")).toEqual({
            version: 3,
            // An unchanged setting with no saved value stays unset, so it keeps following the plugin's default.
            settings: { "x:flag": null, "x:region": "eu", "x:note": "kept!", "x:size": 7 },
        });
    });

    it("clears emptied text and select settings, and leaves a required select without options alone", async () => {
        const plugin = {
            ...mapi,
            settings: { "x:note": "kept", "x:mode": "b" },
            manifest: {
                apiVersion: 1,
                displayName: "MAPI over HTTP",
                settings: [
                    { key: "x:empty", label: "Empty", type: "select", required: true },
                    { key: "x:loose", label: "Loose", type: "select" },
                    { key: "x:note", label: "Note", type: "string" },
                    { key: "x:mode", label: "Mode", type: "select", options: [{ value: "b", label: "B" }] },
                ],
            },
        };
        const fetchMock = mockPlugins({
            plugins: [plugin],
            extra: (url, init) => (url === "/api/system/plugins/p-mapi" && init?.method === "PUT" ? jsonResponse(200, plugin) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        const row = (await screen.findByText("MAPI over HTTP")).closest("tr") as HTMLElement;
        await user.click(within(row).getByRole("button", { name: "Settings" }));
        const dialog = await screen.findByRole("dialog");
        expect(within(within(dialog).getByLabelText("Empty")).queryAllByRole("option")).toHaveLength(0);
        expect(within(within(dialog).getByLabelText("Loose")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Default"]);
        await user.clear(within(dialog).getByLabelText("Note"));
        await user.selectOptions(within(dialog).getByLabelText("Mode"), "");
        await user.click(within(dialog).getByRole("button", { name: "Save" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(requestBody(fetchMock, "/api/system/plugins/p-mapi", "PUT")).toEqual({
            version: 3,
            settings: { "x:empty": null, "x:loose": null, "x:note": null, "x:mode": null },
        });
    });

    it("closes settings without saving when nothing changed", async () => {
        const fetchMock = mockPlugins();
        const user = userEvent.setup();
        renderPage();
        const row = (await screen.findByText("Exchange ActiveSync")).closest("tr") as HTMLElement;
        await user.click(within(row).getByRole("button", { name: "Settings" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "PUT")).toBe(false);
    });

    it("clears an emptied setting back to its default, and shows a save error", async () => {
        const fetchMock = mockPlugins({
            extra: (url, init) => (url === "/api/system/plugins/p-eas" && init?.method === "PUT" ? jsonResponse(400, { message: "'Mode' is required." }) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        const row = (await screen.findByText("Exchange ActiveSync")).closest("tr") as HTMLElement;
        await user.click(within(row).getByRole("button", { name: "Settings" }));
        const dialog = await screen.findByRole("dialog");
        await user.clear(within(dialog).getByLabelText("Sync batch size"));
        await user.click(within(dialog).getByRole("button", { name: "Save" }));
        expect(await within(dialog).findByText("'Mode' is required.")).toBeInTheDocument();
        expect(requestBody(fetchMock, "/api/system/plugins/p-eas", "PUT").settings).toEqual({
            "mail:eas:sync_window_size": null,
            "mail:eas:provision:password_enabled": null,
            "mail:eas:mode": null,
            "mail:eas:note": null,
        });
    });

    it("closes each dialog on Cancel", async () => {
        mockPlugins({
            extra: (url) =>
                url === "/api/system/plugins/registry/%40rapidmx%2Factivesync"
                    ? jsonResponse(200, { package: { name: "@rapidmx/activesync", versions: ["1.0.0"] }, selected: {} })
                    : undefined,
        });
        const user = userEvent.setup();
        renderPage();
        const row = (await screen.findByText("Exchange ActiveSync")).closest("tr") as HTMLElement;
        for (const button of ["Settings", "Change version"]) {
            await user.click(within(row).getByRole("button", { name: button }));
            await user.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Cancel" }));
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        }
        await user.click(screen.getByRole("button", { name: "Add by name" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("closes the settings dialog with its close button, Escape or a click outside it, without saving", async () => {
        const fetchMock = mockPlugins();
        const user = userEvent.setup();
        renderPage();
        const row = (await screen.findByText("Exchange ActiveSync")).closest("tr") as HTMLElement;
        const open = async () => {
            await user.click(within(row).getByRole("button", { name: "Settings" }));
            const dialog = await screen.findByRole("dialog", { name: "Exchange ActiveSync settings" });
            // Save and Cancel stay in the dialog, below every setting.
            expect(within(dialog).getByRole("button", { name: "Save" })).toBeInTheDocument();
            expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
            return dialog;
        };

        await user.click(within(await open()).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        await open();
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        // A press inside the dialog doesn't close it; one on the backdrop around it does.
        const dialog = await open();
        fireEvent.mouseDown(within(dialog).getByLabelText("Sync batch size"));
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        fireEvent.mouseDown(dialog.parentElement!);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "PUT")).toBe(false);
    });

    it("shows a checkbox setting's help beside it", async () => {
        const help = { ...eas, manifest: { ...eas.manifest, settings: [{ key: "x:flag", label: "Flag", type: "boolean", help: "Turns it on" }] } };
        mockPlugins({ plugins: [help] });
        const user = userEvent.setup();
        renderPage();
        const row = (await screen.findByText("Exchange ActiveSync")).closest("tr") as HTMLElement;
        await user.click(within(row).getByRole("button", { name: "Settings" }));
        const checkbox = within(await screen.findByRole("dialog")).getByRole("checkbox");
        expect(checkbox.closest("label")).toHaveTextContent("FlagTurns it on");
    });

    it("shows errors when adding, loading versions or changing version fails", async () => {
        let versionsFail = true;
        mockPlugins({
            extra: (url, init) => {
                if (url.startsWith("/api/system/plugins/registry/")) {
                    if (url.includes("activesync") && versionsFail) return jsonResponse(503, { message: "Registry offline" });
                    return jsonResponse(200, {
                        package: { name: "@rapidmx/x", latest: "2.0.0", versions: ["2.0.0", "1.0.0"] },
                        selected: { name: "@rapidmx/x", version: "2.0.0", peerDependencies: {}, manifest: { apiVersion: 1, displayName: "X" } },
                    });
                }
                if (init?.method === "POST") return jsonResponse(502, { message: "Registry down" });
                if (init?.method === "PUT") return jsonResponse(409, { message: "Changed elsewhere" });
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Add by name" }));
        let dialog = await screen.findByRole("dialog");
        await user.type(within(dialog).getByLabelText("Package name"), "@rapidmx/x");
        await user.click(within(dialog).getByRole("button", { name: "Find" }));
        await user.click(await within(dialog).findByRole("button", { name: "Add plugin" }));
        expect(await within(dialog).findByText("Registry down")).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

        const row = screen.getByText("Exchange ActiveSync").closest("tr") as HTMLElement;
        await user.click(within(row).getByRole("button", { name: "Change version" }));
        dialog = await screen.findByRole("dialog");
        expect(await within(dialog).findByText("Registry offline")).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Close" }));

        versionsFail = false;
        await user.click(within(row).getByRole("button", { name: "Change version" }));
        dialog = await screen.findByRole("dialog");
        await user.selectOptions(await within(dialog).findByLabelText("Version"), "2.0.0");
        await user.click(within(dialog).getByRole("button", { name: "Save" }));
        expect(await within(dialog).findByText("Changed elsewhere")).toBeInTheDocument();
    });

    it("removes a plugin after confirming", async () => {
        const fetchMock = mockPlugins({
            extra: (url, init) => (url === "/api/system/plugins/p-mapi" && init?.method === "DELETE" ? emptyResponse(204) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        const row = (await screen.findByText("MAPI over HTTP")).closest("tr") as HTMLElement;
        await user.click(within(row).getByRole("button", { name: "Uninstall" }));
        const dialog = await screen.findByRole("dialog", { name: "Uninstall MAPI over HTTP?" });
        expect(within(dialog).getByText(/Data it stored stays in the database/)).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Uninstall" }));
        await waitFor(() => expect(screen.queryByText("MAPI over HTTP")).not.toBeInTheDocument());
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/p-mapi", expect.objectContaining({ method: "DELETE" }));
    });

    it("keeps the confirmation open with an error when removing fails", async () => {
        mockPlugins({
            extra: (url, init) => (url === "/api/system/plugins/p-mapi" && init?.method === "DELETE" ? jsonResponse(404, { message: "Not found" }) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        const row = (await screen.findByText("MAPI over HTTP")).closest("tr") as HTMLElement;
        await user.click(within(row).getByRole("button", { name: "Uninstall" }));
        const dialog = await screen.findByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: "Uninstall" }));
        expect(await within(dialog).findByText("Not found")).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows when a newer version is available and upgrades to it", async () => {
        const fetchMock = mockPlugins({
            extra: (url, init) => {
                if (url === "/api/system/plugins/updates") {
                    return jsonResponse(200, [
                        { uid: "p-eas", name: "@rapidmx/activesync", installedVersion: "1.0.0", latestVersion: "1.3.0", updateAvailable: true },
                        { uid: "p-mapi", name: "@rapidmx/mapi", installedVersion: "1.0.0", updateAvailable: false, error: "offline" },
                    ]);
                }
                if (url === "/api/system/plugins/p-eas" && init?.method === "PUT") return jsonResponse(200, { ...eas, packageVersion: "1.3.0", version: 4 });
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        const row = (await screen.findByText("Exchange ActiveSync")).closest("tr") as HTMLElement;
        expect(await within(row).findByText("Update available: 1.3.0")).toBeInTheDocument();
        const mapiRow = screen.getByText("MAPI over HTTP").closest("tr") as HTMLElement;
        expect(within(mapiRow).queryByText(/Update available/)).not.toBeInTheDocument();

        await user.click(within(row).getByRole("button", { name: "Upgrade Exchange ActiveSync to 1.3.0" }));
        await waitFor(() => expect(within(row).getByText("1.3.0")).toBeInTheDocument());
        expect(requestBody(fetchMock, "/api/system/plugins/p-eas", "PUT")).toEqual({ version: 3, packageVersion: "1.3.0", expectedPlan: noExtras("1.3.0") });
    });

    it("shows an error when upgrading fails", async () => {
        mockPlugins({
            extra: (url, init) => {
                if (url === "/api/system/plugins/updates") {
                    return jsonResponse(200, [{ uid: "p-eas", name: "@rapidmx/activesync", installedVersion: "1.0.0", latestVersion: "2.0.0", updateAvailable: true }]);
                }
                if (url === "/api/system/plugins/p-eas" && init?.method === "PUT") return jsonResponse(400, { message: "Bad version" });
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Upgrade Exchange ActiveSync to 2.0.0" }));
        expect(await screen.findByText("Bad version")).toBeInTheDocument();
    });

    describe("plugin dependencies", () => {
        const autodiscover = {
            ...mapi,
            uid: "p-ad",
            name: "@rapidmx/autodiscover-plugin",
            enabled: true,
            manifest: { apiVersion: 1, displayName: "Autodiscover", settings: [], requires: { "@rapidmx/activesync": "^1.0.0", "@rapidmx/mapi": "^1.0.0" } },
        };
        const plan = (extra: Record<string, unknown>) =>
            jsonResponse(200, { plugin: { name: autodiscover.name, version: "1.0.0", manifest: autodiscover.manifest }, install: [], enable: [], conflicts: [], ...extra });

        it("shows what a plugin requires and what requires it", async () => {
            mockPlugins({ plugins: [eas, autodiscover, mapi] });
            renderPage();
            const row = (await screen.findByText("Autodiscover")).closest("tr") as HTMLElement;
            expect(within(row).getByText("Requires: Exchange ActiveSync, MAPI over HTTP")).toBeInTheDocument();
            const easRow = screen.getByText("Exchange ActiveSync").closest("tr") as HTMLElement;
            expect(within(easRow).getByText("Required by: Autodiscover")).toBeInTheDocument();
        });

        it("confirms the plugins an install also installs and enables, then shows them all", async () => {
            const newEas = { ...eas, uid: "p-eas2", name: "@rapidmx/activesync-plugin" };
            const fetchMock = mockPlugins({
                plugins: [mapi],
                extra: (url, init) => {
                    if (url === "/api/system/plugins/namespaces") return jsonResponse(200, []);
                    if (url.startsWith("/api/system/plugins/search")) {
                        return jsonResponse(200, [{ name: autodiscover.name, version: "1.0.0", allowed: true, updateAvailable: false }]);
                    }
                    if (url.startsWith("/api/system/plugins/plan?")) {
                        return plan({ install: [{ name: newEas.name, version: "1.2.0", manifest: newEas.manifest }], enable: ["@rapidmx/mapi"] });
                    }
                    if (url === "/api/system/plugins" && init?.method === "POST") {
                        return jsonResponse(200, { plugin: autodiscover, dependencies: [newEas, { ...mapi, enabled: true }] });
                    }
                    return undefined;
                },
            });
            const user = userEvent.setup();
            renderPage();
            const browser = within(await screen.findByRole("region", { name: "Find plugins" }));
            await user.click(browser.getByRole("button", { name: "Search" }));
            await user.click(await browser.findByRole("button", { name: `Install ${autodiscover.name}` }));

            const dialog = await screen.findByRole("dialog", { name: `${autodiscover.name} requires other plugins` });
            expect(within(dialog).getByText("Install Exchange ActiveSync 1.2.0")).toBeInTheDocument();
            expect(within(dialog).getByText("Enable MAPI over HTTP")).toBeInTheDocument();
            expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/plan?name=%40rapidmx%2Fautodiscover-plugin&packageVersion=1.0.0", expect.anything());
            expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "POST")).toBe(false);

            await user.click(within(dialog).getByRole("button", { name: "Continue" }));
            await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
            // What was confirmed is what the server is asked to do.
            expect(requestBody(fetchMock, "/api/system/plugins", "POST")).toEqual({
                name: autodiscover.name,
                packageVersion: "1.0.0",
                expectedPlan: { version: "1.0.0", install: [{ name: newEas.name, version: "1.2.0" }], enable: ["@rapidmx/mapi"] },
            });
            expect(screen.getByText("Autodiscover")).toBeInTheDocument();
            expect(screen.getByText("Exchange ActiveSync")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Disable MAPI over HTTP" })).toBeInTheDocument();
        });

        it("doesn't install when cancelled, and keeps the confirmation open when the install fails", async () => {
            const fetchMock = mockPlugins({
                extra: (url, init) => {
                    if (url.startsWith("/api/system/plugins/registry/")) {
                        return jsonResponse(200, {
                            package: { name: autodiscover.name, latest: "1.0.0", versions: ["1.0.0"] },
                            selected: { name: autodiscover.name, version: "1.0.0", peerDependencies: {}, manifest: autodiscover.manifest },
                        });
                    }
                    if (url.startsWith("/api/system/plugins/plan?")) return plan({ enable: ["@rapidmx/mapi"] });
                    if (url === "/api/system/plugins" && init?.method === "POST") return jsonResponse(409, { message: "Changed meanwhile" });
                    return undefined;
                },
            });
            const user = userEvent.setup();
            renderPage();
            for (const action of ["Cancel", "Continue"]) {
                await user.click(await screen.findByRole("button", { name: "Add by name" }));
                const add = await screen.findByRole("dialog", { name: "Add plugin" });
                await user.type(within(add).getByLabelText("Package name"), autodiscover.name);
                await user.click(within(add).getByRole("button", { name: "Find" }));
                await user.click(await within(add).findByRole("button", { name: "Add plugin" }));
                const confirm = await screen.findByRole("dialog", { name: "Autodiscover requires other plugins" });
                await user.click(within(confirm).getByRole("button", { name: action }));
                if (action === "Cancel") {
                    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
                    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "POST")).toBe(false);
                } else {
                    expect(await within(confirm).findByText("Changed meanwhile")).toBeInTheDocument();
                }
            }
        });

        it("explains a conflict instead of installing or upgrading", async () => {
            const fetchMock = mockPlugins({
                extra: (url) => {
                    if (url === "/api/system/plugins/updates") {
                        return jsonResponse(200, [{ uid: "p-eas", name: "@rapidmx/activesync", installedVersion: "1.0.0", latestVersion: "2.0.0", updateAvailable: true }]);
                    }
                    if (url === "/api/system/plugins/namespaces") return jsonResponse(200, []);
                    if (url.startsWith("/api/system/plugins/search")) {
                        return jsonResponse(200, [{ name: autodiscover.name, version: "1.0.0", allowed: true, updateAvailable: false }]);
                    }
                    if (url.startsWith("/api/system/plugins/plan?name=%40rapidmx%2Factivesync&")) {
                        return jsonResponse(200, {
                            plugin: { name: eas.name, version: "2.0.0" },
                            install: [],
                            enable: [],
                            conflicts: ["Autodiscover requires @rapidmx/activesync ^1.0.0, which 2.0.0 doesn't satisfy."],
                        });
                    }
                    if (url.startsWith("/api/system/plugins/plan?")) return plan({ conflicts: ["Autodiscover requires Exchange ActiveSync ^3.0.0, but 1.0.0 is installed."] });
                    return undefined;
                },
            });
            const user = userEvent.setup();
            renderPage();
            await user.click(await screen.findByRole("button", { name: "Upgrade Exchange ActiveSync to 2.0.0" }));
            expect(
                await screen.findByText("Exchange ActiveSync 2.0.0 can't be installed. Autodiscover requires @rapidmx/activesync ^1.0.0, which 2.0.0 doesn't satisfy."),
            ).toBeInTheDocument();

            const browser = within(screen.getByRole("region", { name: "Find plugins" }));
            await user.click(browser.getByRole("button", { name: "Search" }));
            await user.click(await browser.findByRole("button", { name: `Install ${autodiscover.name}` }));
            expect(await browser.findByText(/can't be installed\. Autodiscover requires Exchange ActiveSync \^3\.0\.0/)).toBeInTheDocument();
            expect(fetchMock.mock.calls.some((c) => ["POST", "PUT"].includes((c[1] as RequestInit)?.method ?? ""))).toBe(false);
        });

        it("reloads the list after a version change or enable that brought in other plugins, keeping the row busy while confirming", async () => {
            let listed: unknown[] = [eas, { ...autodiscover, enabled: false }, mapi];
            const fetchMock = mockPlugins({
                extra: (url, init) => {
                    if (url === "/api/system/plugins" && (init?.method ?? "GET") === "GET") return jsonResponse(200, listed);
                    if (url === "/api/system/plugins/registry/%40rapidmx%2Factivesync") {
                        return jsonResponse(200, { package: { name: "@rapidmx/activesync", versions: ["2.0.0", "1.0.0"] }, selected: {} });
                    }
                    if (url.startsWith("/api/system/plugins/plan?name=%40rapidmx%2Factivesync&")) {
                        return jsonResponse(200, { plugin: { name: eas.name, version: "2.0.0", manifest: eas.manifest }, install: [], enable: ["@rapidmx/mapi"], conflicts: [] });
                    }
                    if (url.startsWith("/api/system/plugins/plan?")) return plan({ enable: ["@rapidmx/activesync"] });
                    if (url === "/api/system/plugins/p-eas" && init?.method === "PUT") {
                        listed = [{ ...eas, packageVersion: "2.0.0", manifest: { ...eas.manifest, displayName: "EAS 2" } }, { ...autodiscover, enabled: false }, { ...mapi, enabled: true }];
                        return jsonResponse(200, { ...eas, packageVersion: "2.0.0" });
                    }
                    if (url === "/api/system/plugins/p-ad" && init?.method === "PUT") {
                        listed = [eas, autodiscover, { ...mapi, enabled: true }];
                        return jsonResponse(200, autodiscover);
                    }
                    return undefined;
                },
            });
            const user = userEvent.setup();
            renderPage();
            const easRow = (await screen.findByText("Exchange ActiveSync")).closest("tr") as HTMLElement;
            await user.click(within(easRow).getByRole("button", { name: "Change version" }));
            const dialog = await screen.findByRole("dialog");
            await user.selectOptions(await within(dialog).findByLabelText("Version"), "2.0.0");
            await user.click(within(dialog).getByRole("button", { name: "Save" }));
            const confirm = await screen.findByRole("dialog", { name: "Exchange ActiveSync requires other plugins" });
            expect(within(confirm).getByText("Enable MAPI over HTTP")).toBeInTheDocument();
            await user.click(within(confirm).getByRole("button", { name: "Continue" }));
            expect(await screen.findByText("EAS 2")).toBeInTheDocument();
            expect(requestBody(fetchMock, "/api/system/plugins/p-eas", "PUT")).toEqual({
                version: 3,
                packageVersion: "2.0.0",
                expectedPlan: { version: "2.0.0", install: [], enable: ["@rapidmx/mapi"] },
            });

            // Enabling also confirms the plugins it enables first, and the row stays busy until that's settled.
            await user.click(screen.getByRole("button", { name: "Enable Autodiscover" }));
            let confirmEnable = await screen.findByRole("dialog", { name: "Autodiscover requires other plugins" });
            expect(screen.getByRole("button", { name: "Enable Autodiscover" })).toBeDisabled();
            await user.click(within(confirmEnable).getByRole("button", { name: "Cancel" }));
            expect(screen.getByRole("button", { name: "Enable Autodiscover" })).toBeEnabled();
            expect(fetchMock.mock.calls.some((c) => c[0] === "/api/system/plugins/p-ad")).toBe(false);

            await user.click(screen.getByRole("button", { name: "Enable Autodiscover" }));
            confirmEnable = await screen.findByRole("dialog", { name: "Autodiscover requires other plugins" });
            await user.click(within(confirmEnable).getByRole("button", { name: "Continue" }));
            expect(await screen.findByRole("button", { name: "Disable Autodiscover" })).toBeInTheDocument();
            expect(requestBody(fetchMock, "/api/system/plugins/p-ad", "PUT")).toEqual({
                version: 3,
                enabled: true,
                expectedPlan: { version: "1.0.0", install: [], enable: ["@rapidmx/activesync"] },
            });
        });

        it("keeps a confirmed enable shown when re-reading the list afterwards fails, and says the list may be out of date", async () => {
            const { settings: _settings, ...bareManifest } = autodiscover.manifest;
            const bare = { ...autodiscover, enabled: false, manifest: bareManifest };
            let lists = 0;
            const fetchMock = mockPlugins({
                extra: (url, init) => {
                    if (url === "/api/system/plugins" && (init?.method ?? "GET") === "GET") {
                        lists++;
                        if (lists === 1) return jsonResponse(200, [eas, bare]);
                        return lists === 2 ? jsonResponse(500, { message: "down" }) : jsonResponse(200, [eas, { ...bare, enabled: true }, { ...mapi, enabled: true }]);
                    }
                    if (url.startsWith("/api/system/plugins/plan?")) return plan({ enable: ["@rapidmx/mapi"] });
                    if (url === "/api/system/plugins/p-ad" && init?.method === "PUT") return jsonResponse(200, { ...bare, enabled: true, version: 4 });
                    return undefined;
                },
            });
            const user = userEvent.setup();
            renderPage();
            const row = (await screen.findByText("Autodiscover")).closest("tr") as HTMLElement;
            // A manifest that declares no settings at all has no Settings button.
            expect(within(row).queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
            await user.click(within(row).getByRole("button", { name: "Enable Autodiscover" }));
            const confirm = await screen.findByRole("dialog", { name: "Autodiscover requires other plugins" });
            await user.click(within(confirm).getByRole("button", { name: "Continue" }));
            await waitFor(() => expect(fetchMock.mock.calls.filter((c) => c[0] === "/api/system/plugins" && !(c[1] as RequestInit)?.method)).toHaveLength(2));
            expect(await screen.findByRole("button", { name: "Disable Autodiscover" })).toBeInTheDocument();
            expect(screen.queryByText("down")).not.toBeInTheDocument();
            expect(await screen.findByText(/may be out of date/)).toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Retry" }));
            expect(await screen.findByRole("button", { name: "Disable MAPI over HTTP" })).toBeInTheDocument();
            expect(screen.queryByText(/may be out of date/)).not.toBeInTheDocument();
        });

        it("never enables without a preview when the change can't be planned, and offers a retry", async () => {
            let planStatus = 502;
            let putStatus = 200;
            const fetchMock = mockPlugins({
                plugins: [eas, { ...autodiscover, enabled: false }],
                extra: (url, init) => {
                    if (url.startsWith("/api/system/plugins/plan?") && planStatus !== 200) {
                        return jsonResponse(planStatus, { message: "Registry unreachable" });
                    }
                    if (url === "/api/system/plugins/p-ad" && init?.method === "PUT") {
                        if (putStatus !== 200) return jsonResponse(409, { message: "MAPI over HTTP isn't installed." });
                        return jsonResponse(200, { ...autodiscover, version: 4 });
                    }
                    return undefined;
                },
            });
            const puts = () => fetchMock.mock.calls.filter((c) => c[0] === "/api/system/plugins/p-ad" && (c[1] as RequestInit)?.method === "PUT");
            const user = userEvent.setup();
            renderPage();
            await user.click(await screen.findByRole("button", { name: "Enable Autodiscover" }));
            expect(await screen.findByText(/Registry unreachable/)).toBeInTheDocument();
            expect(puts()).toHaveLength(0);
            expect(screen.getByRole("button", { name: "Enable Autodiscover" })).toBeEnabled();

            // Still failing: the retry shows the error again, still without enabling.
            await user.click(screen.getByRole("button", { name: "Try again" }));
            expect(await screen.findByText(/Registry unreachable/)).toBeInTheDocument();
            expect(puts()).toHaveLength(0);

            // A server refusal after a successful preview is retryable too.
            planStatus = 200;
            putStatus = 409;
            await user.click(screen.getByRole("button", { name: "Try again" }));
            expect(await screen.findByText(/MAPI over HTTP isn't installed\./)).toBeInTheDocument();
            expect(requestBody(fetchMock, "/api/system/plugins/p-ad", "PUT")).toEqual({ version: 3, enabled: true, expectedPlan: noExtras("1.0.0") });

            putStatus = 200;
            await user.click(screen.getByRole("button", { name: "Try again" }));
            expect(await screen.findByRole("button", { name: "Disable Autodiscover" })).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
        });

        it("doesn't offer an enable retry for other failures", async () => {
            mockPlugins({
                extra: (url, init) => (url === "/api/system/plugins/p-eas" && init?.method === "PUT" ? jsonResponse(409, { message: "Version conflict" }) : undefined),
            });
            const user = userEvent.setup();
            renderPage();
            await user.click(await screen.findByRole("button", { name: "Disable Exchange ActiveSync" }));
            expect(await screen.findByText("Version conflict")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
        });

        it("changes a disabled plugin's version without previewing it", async () => {
            let putStatus = 200;
            const fetchMock = mockPlugins({
                extra: (url, init) => {
                    if (url === "/api/system/plugins/updates") {
                        return jsonResponse(200, [{ uid: "p-mapi", name: "@rapidmx/mapi", installedVersion: "1.0.0", latestVersion: "3.0.0", updateAvailable: true }]);
                    }
                    if (url === "/api/system/plugins/registry/%40rapidmx%2Fmapi") {
                        return jsonResponse(200, { package: { name: "@rapidmx/mapi", versions: ["3.0.0", "2.0.0", "1.0.0"] }, selected: {} });
                    }
                    if (url === "/api/system/plugins/p-mapi" && init?.method === "PUT") {
                        return putStatus === 200 ? jsonResponse(200, { ...mapi, packageVersion: "2.0.0", version: 4 }) : jsonResponse(409, { message: "Changed elsewhere" });
                    }
                    return undefined;
                },
            });
            const user = userEvent.setup();
            renderPage();
            const mapiRow = (await screen.findByText("MAPI over HTTP")).closest("tr") as HTMLElement;
            await user.click(within(mapiRow).getByRole("button", { name: "Change version" }));
            const dialog = await screen.findByRole("dialog");
            await user.selectOptions(await within(dialog).findByLabelText("Version"), "2.0.0");
            await user.click(within(dialog).getByRole("button", { name: "Save" }));
            await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
            expect(requestBody(fetchMock, "/api/system/plugins/p-mapi", "PUT")).toEqual({ version: 3, packageVersion: "2.0.0" });
            expect(within(mapiRow).getByText("2.0.0")).toBeInTheDocument();

            putStatus = 409;
            await user.click(await within(mapiRow).findByRole("button", { name: "Upgrade MAPI over HTTP to 3.0.0" }));
            expect(await screen.findByText("Changed elsewhere")).toBeInTheDocument();
            expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("/api/system/plugins/plan?"))).toBe(false);
        });

        it("keeps every plugin with an action under way busy at once", async () => {
            const release: Record<string, () => void> = {};
            mockPlugins({
                plugins: [eas, { ...autodiscover, enabled: false }],
                extra: ((url: string, init?: RequestInit) => {
                    if (url === "/api/system/plugins/updates") {
                        return jsonResponse(200, [{ uid: "p-eas", name: "@rapidmx/activesync", installedVersion: "1.0.0", latestVersion: "2.0.0", updateAvailable: true }]);
                    }
                    if (url.startsWith("/api/system/plugins/plan?name=%40rapidmx%2Factivesync&")) {
                        return new Promise<Response>((resolve) => {
                            release.eas = () => resolve(jsonResponse(200, { plugin: { name: eas.name, version: "2.0.0" }, install: [], enable: [], conflicts: [] }));
                        });
                    }
                    if (url.startsWith("/api/system/plugins/plan?")) {
                        return new Promise<Response>((resolve) => {
                            release.ad = () => resolve(plan({ enable: ["@rapidmx/mapi"] }));
                        });
                    }
                    if (url === "/api/system/plugins/p-eas" && init?.method === "PUT") return jsonResponse(200, { ...eas, packageVersion: "2.0.0", version: 4 });
                    return undefined;
                }) as Handler,
            });
            const user = userEvent.setup();
            renderPage();
            const upgradeEas = await screen.findByRole("button", { name: "Upgrade Exchange ActiveSync to 2.0.0" });
            await user.click(upgradeEas);
            await user.click(screen.getByRole("button", { name: "Enable Autodiscover" }));
            expect(upgradeEas).toBeDisabled();
            expect(screen.getByRole("button", { name: "Enable Autodiscover" })).toBeDisabled();

            release.ad();
            const confirm = await screen.findByRole("dialog", { name: "Autodiscover requires other plugins" });
            expect(upgradeEas).toBeDisabled();
            release.eas();
            const easRow = screen.getByText("Exchange ActiveSync").closest("tr") as HTMLElement;
            await waitFor(() => expect(within(easRow).getByText("2.0.0")).toBeInTheDocument());
            expect(screen.getByRole("button", { name: "Enable Autodiscover" })).toBeDisabled();
            await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
            expect(screen.getByRole("button", { name: "Enable Autodiscover" })).toBeEnabled();
        });

        it("refuses to enable a plugin whose requirements conflict", async () => {
            const fetchMock = mockPlugins({
                plugins: [eas, { ...autodiscover, enabled: false }],
                extra: (url) => (url.startsWith("/api/system/plugins/plan?") ? plan({ conflicts: ["MAPI over HTTP ^1.0.0 isn't available."] }) : undefined),
            });
            const user = userEvent.setup();
            renderPage();
            await user.click(await screen.findByRole("button", { name: "Enable Autodiscover" }));
            expect(await screen.findByText("Autodiscover 1.0.0 can't be installed. MAPI over HTTP ^1.0.0 isn't available.")).toBeInTheDocument();
            expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "PUT")).toBe(false);
            expect(screen.getByRole("button", { name: "Enable Autodiscover" })).toBeEnabled();
        });

        it("shows the server's refusal when the plan changed since it was confirmed", async () => {
            mockPlugins({
                plugins: [eas, { ...autodiscover, enabled: false }],
                extra: (url, init) => {
                    if (url.startsWith("/api/system/plugins/plan?")) return plan({ enable: ["@rapidmx/mapi"] });
                    if (url === "/api/system/plugins/p-ad" && init?.method === "PUT") {
                        return jsonResponse(409, { message: "The plugins this change needs have changed since it was previewed. Review the change again." });
                    }
                    return undefined;
                },
            });
            const user = userEvent.setup();
            renderPage();
            await user.click(await screen.findByRole("button", { name: "Enable Autodiscover" }));
            const confirm = await screen.findByRole("dialog", { name: "Autodiscover requires other plugins" });
            await user.click(within(confirm).getByRole("button", { name: "Continue" }));
            expect(await within(confirm).findByText(/have changed since it was previewed/)).toBeInTheDocument();
        });

        it("explains why a required plugin can't be disabled", async () => {
            mockPlugins({
                plugins: [eas, autodiscover],
                extra: (url, init) =>
                    url === "/api/system/plugins/p-eas" && init?.method === "PUT"
                        ? jsonResponse(409, { message: "Autodiscover requires Exchange ActiveSync, so it can't be disabled. Disable Autodiscover first." })
                        : undefined,
            });
            const user = userEvent.setup();
            renderPage();
            await user.click(await screen.findByRole("button", { name: "Disable Exchange ActiveSync" }));
            expect(await screen.findByText(/so it can't be disabled\. Disable Autodiscover first\./)).toBeInTheDocument();
        });
    });

    describe("finding plugins", () => {
        const results = [
            { name: "@acme/crm-plugin", version: "0.2.0", description: "CRM sync", allowed: true, updateAvailable: false },
            { name: "@other/thing-plugin", version: "3.0.0", allowed: false, updateAvailable: false },
            { name: "@rapidmx/activesync", version: "1.4.0", allowed: true, installedUid: "p-eas", installedVersion: "1.0.0", updateAvailable: true },
            { name: "@rapidmx/mapi", version: "1.0.0", allowed: true, installedUid: "p-mapi", installedVersion: "1.0.0", updateAvailable: false },
        ];

        it("lists namespaces, searches them, and shows each plugin's version and install state", async () => {
            const fetchMock = mockPlugins({
                extra: (url) => {
                    if (url === "/api/system/plugins/namespaces") return jsonResponse(200, [{ name: "@rapidmx" }, { name: "@acme", registry: "https://npm.acme.test" }]);
                    if (url.startsWith("/api/system/plugins/search")) return jsonResponse(200, results);
                    return undefined;
                },
            });
            const user = userEvent.setup();
            renderPage();
            const browser = within(await screen.findByRole("region", { name: "Find plugins" }));
            expect(await browser.findByRole("option", { name: "@acme" })).toBeInTheDocument();

            await user.click(browser.getByRole("button", { name: "Search" }));
            const crm = (await browser.findByText("@acme/crm-plugin")).closest("tr") as HTMLElement;
            expect(within(crm).getByText("0.2.0")).toBeInTheDocument();
            expect(within(crm).getByText("CRM sync")).toBeInTheDocument();
            expect(within(crm).getByText("Not installed")).toBeInTheDocument();
            expect(within(crm).getByRole("button", { name: "Install @acme/crm-plugin" })).toBeInTheDocument();

            const other = browser.getByText("@other/thing-plugin").closest("tr") as HTMLElement;
            expect(within(other).getByText("Not allowed on this server")).toBeInTheDocument();
            expect(within(other).queryByRole("button")).not.toBeInTheDocument();

            const easRow = browser.getByText("@rapidmx/activesync").closest("tr") as HTMLElement;
            expect(within(easRow).getByText("Installed 1.0.0 - update available")).toBeInTheDocument();
            const mapi = browser.getByText("@rapidmx/mapi").closest("tr") as HTMLElement;
            expect(within(mapi).getByText("Installed 1.0.0")).toBeInTheDocument();
            expect(within(mapi).queryByRole("button")).not.toBeInTheDocument();

            await user.selectOptions(browser.getByLabelText("Namespace"), "@acme");
            await user.click(browser.getByRole("button", { name: "Search" }));
            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/search?namespace=%40acme", expect.anything()));
            expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/search", expect.anything());
        });

        it("installs a found plugin at its latest version and upgrades an installed one", async () => {
            const fetchMock = mockPlugins({
                extra: (url, init) => {
                    if (url === "/api/system/plugins/namespaces") return jsonResponse(200, []);
                    if (url.startsWith("/api/system/plugins/search")) return jsonResponse(200, results);
                    if (url === "/api/system/plugins" && init?.method === "POST") {
                        return jsonResponse(200, {
                            plugin: { ...mapi, uid: "p-crm", name: "@acme/crm-plugin", packageVersion: "0.2.0", enabled: true, manifest: { apiVersion: 1, displayName: "CRM", settings: [] } },
                            dependencies: [],
                        });
                    }
                    if (url === "/api/system/plugins/p-eas" && init?.method === "PUT") return jsonResponse(200, { ...eas, packageVersion: "1.4.0", version: 4 });
                    return undefined;
                },
            });
            const user = userEvent.setup();
            renderPage();
            const browser = within(await screen.findByRole("region", { name: "Find plugins" }));
            await user.click(browser.getByRole("button", { name: "Search" }));

            await user.click(await browser.findByRole("button", { name: "Install @acme/crm-plugin" }));
            expect(await screen.findByText("CRM")).toBeInTheDocument();
            expect(requestBody(fetchMock, "/api/system/plugins", "POST")).toEqual({ name: "@acme/crm-plugin", packageVersion: "0.2.0", expectedPlan: noExtras("0.2.0") });
            const crm = browser.getByText("@acme/crm-plugin").closest("tr") as HTMLElement;
            expect(within(crm).getByText("Installed 0.2.0")).toBeInTheDocument();

            await user.click(browser.getByRole("button", { name: "Upgrade @rapidmx/activesync to 1.4.0" }));
            await waitFor(() => expect(requestBody(fetchMock, "/api/system/plugins/p-eas", "PUT")).toEqual({ version: 3, packageVersion: "1.4.0", expectedPlan: noExtras("1.4.0") }));
            const easRow = browser.getByText("@rapidmx/activesync").closest("tr") as HTMLElement;
            await waitFor(() => expect(within(easRow).getByText("Installed 1.4.0")).toBeInTheDocument());
        });

        it("doesn't install when what it takes can't be checked", async () => {
            const fetchMock = mockPlugins({
                extra: (url) => {
                    if (url === "/api/system/plugins/namespaces") return jsonResponse(200, []);
                    if (url.startsWith("/api/system/plugins/search")) return jsonResponse(200, [results[0]]);
                    if (url.startsWith("/api/system/plugins/plan?")) return jsonResponse(502, { message: "Registry unreachable" });
                    return undefined;
                },
            });
            const user = userEvent.setup();
            renderPage();
            const browser = within(await screen.findByRole("region", { name: "Find plugins" }));
            await user.click(browser.getByRole("button", { name: "Search" }));
            await user.click(await browser.findByRole("button", { name: "Install @acme/crm-plugin" }));
            expect(await browser.findByText("Registry unreachable")).toBeInTheDocument();
            expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "POST")).toBe(false);
        });

        it("shows no results, a search error, and an install error", async () => {
            let searchResponse: () => Response = () => jsonResponse(200, []);
            mockPlugins({
                extra: (url, init) => {
                    if (url === "/api/system/plugins/namespaces") return jsonResponse(500, {});
                    if (url.startsWith("/api/system/plugins/search")) return searchResponse();
                    if (url === "/api/system/plugins" && init?.method === "POST") return jsonResponse(400, { message: "Not a RapidMX plugin" });
                    return undefined;
                },
            });
            const user = userEvent.setup();
            renderPage();
            const browser = within(await screen.findByRole("region", { name: "Find plugins" }));
            await user.click(browser.getByRole("button", { name: "Search" }));
            expect(await browser.findByText("No plugins found.")).toBeInTheDocument();

            searchResponse = () => jsonResponse(502, { message: "Registry unreachable" });
            await user.click(browser.getByRole("button", { name: "Search" }));
            expect(await browser.findByText("Registry unreachable")).toBeInTheDocument();
            expect(browser.queryByText("No plugins found.")).not.toBeInTheDocument();

            searchResponse = () => jsonResponse(200, [results[0]]);
            await user.click(browser.getByRole("button", { name: "Search" }));
            await user.click(await browser.findByRole("button", { name: "Install @acme/crm-plugin" }));
            expect(await browser.findByText("Not a RapidMX plugin")).toBeInTheDocument();
        });
    });
});
