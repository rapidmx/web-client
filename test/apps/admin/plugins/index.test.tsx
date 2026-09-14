// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../../testUtils.js";
import PluginsPage from "../../../../apps/admin/plugins/index.js";

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

describe("PluginsPage", () => {
    it("shows an empty state", async () => {
        mockPlugins({ plugins: [], status: { hash: "h", instances: [] } });
        renderPage();
        expect(await screen.findByText("No plugins installed.")).toBeInTheDocument();
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
        expect(within(row).getByRole("checkbox", { name: "Enable Exchange ActiveSync" })).toBeChecked();

        const mapiRow = screen.getByText("MAPI over HTTP").closest("tr") as HTMLElement;
        expect(within(mapiRow).getByText("Disabled")).toBeInTheDocument();
        // No settings declared, so no Settings button.
        expect(within(mapiRow).queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    });

    it("shows unknown status when no server has reported, and still lists plugins when status can't load", async () => {
        mockPlugins({ plugins: [eas], extra: (url) => (url === "/api/system/plugins/status" ? jsonResponse(500, { message: "down" }) : undefined) });
        renderPage();
        expect(await screen.findByText("Unknown")).toBeInTheDocument();
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

    it("enables and disables a plugin", async () => {
        const fetchMock = mockPlugins({
            extra: (url, init) => (url === "/api/system/plugins/p-mapi" && init?.method === "PUT" ? jsonResponse(200, { ...mapi, enabled: true, version: 4 }) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("checkbox", { name: "Enable MAPI over HTTP" }));
        await waitFor(() => expect(screen.getByRole("checkbox", { name: "Enable MAPI over HTTP" })).toBeChecked());
        expect(requestBody(fetchMock, "/api/system/plugins/p-mapi", "PUT")).toEqual({ version: 3, enabled: true });
    });

    it("shows an error when toggling fails", async () => {
        mockPlugins({
            extra: (url, init) => (url === "/api/system/plugins/p-eas" && init?.method === "PUT" ? jsonResponse(409, { message: "Version conflict" }) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("checkbox", { name: "Enable Exchange ActiveSync" }));
        expect(await screen.findByText("Version conflict")).toBeInTheDocument();
    });

    it("adds a plugin after previewing it from the registry", async () => {
        const autodiscover = { ...mapi, uid: "p-ad", name: "@rapidmx/autodiscover", enabled: true, manifest: { apiVersion: 1, displayName: "Autodiscover", settings: [] } };
        const fetchMock = mockPlugins({
            extra: (url, init) => {
                if (url === "/api/system/plugins/registry/%40rapidmx%2Fautodiscover") {
                    return jsonResponse(200, {
                        package: { name: "@rapidmx/autodiscover", latest: "2.0.0", versions: ["2.0.0", "1.0.0"] },
                        selected: { name: "@rapidmx/autodiscover", version: "2.0.0", peerDependencies: {}, manifest: { apiVersion: 1, displayName: "Autodiscover", description: "Finds servers" } },
                    });
                }
                if (url === "/api/system/plugins" && init?.method === "POST") return jsonResponse(200, autodiscover);
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "+ Add plugin" }));
        const dialog = await screen.findByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: "Find" }));
        expect(within(dialog).getByText("Enter a package name.")).toBeInTheDocument();

        await user.type(within(dialog).getByLabelText("Package name"), "@rapidmx/autodiscover");
        await user.click(within(dialog).getByRole("button", { name: "Find" }));
        expect(await within(dialog).findByText("Finds servers")).toBeInTheDocument();
        expect(within(dialog).getByRole("option", { name: "2.0.0 (latest)" })).toBeInTheDocument();
        await user.selectOptions(within(dialog).getByLabelText("Version"), "1.0.0");
        await user.click(within(dialog).getByRole("button", { name: "Add plugin" }));

        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(requestBody(fetchMock, "/api/system/plugins", "POST")).toEqual({ name: "@rapidmx/autodiscover", packageVersion: "1.0.0" });
        expect(screen.getByText("Autodiscover")).toBeInTheDocument();
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
        await user.click(await screen.findByRole("button", { name: "+ Add plugin" }));
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
        expect(requestBody(fetchMock, "/api/system/plugins/p-eas", "PUT")).toEqual({ version: 3, packageVersion: "1.1.0" });
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
            "mail:eas:provision:password_enabled": true,
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
        await user.click(screen.getByRole("button", { name: "+ Add plugin" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
        await user.click(await screen.findByRole("button", { name: "+ Add plugin" }));
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
        await user.click(within(row).getByRole("button", { name: "Remove" }));
        const dialog = await screen.findByRole("dialog", { name: "Remove MAPI over HTTP?" });
        expect(within(dialog).getByText(/Data it stored stays in the database/)).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Remove" }));
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
        await user.click(within(row).getByRole("button", { name: "Remove" }));
        const dialog = await screen.findByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: "Remove" }));
        expect(await within(dialog).findByText("Not found")).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
});
