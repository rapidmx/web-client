// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The Plugins page's pre-release preference, the actions that apply to several plugins at once (Upgrade, Disable,
// Uninstall on the ticked ones, and Upgrade all), and the bar across the top that shows a change is still under way.
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../../testUtils.js";
import PluginsPage from "../../../../apps/admin/plugins/index.js";
import { getNotificationsSnapshot, resetNotifications } from "../../../../apps/shared/notifications/store.js";

const PLUGINS = "/api/system/plugins";
const PRERELEASE_KEY = "rapidmx:plugins-allow-prerelease";

const plugin = (short: string, displayName: string, overrides: Record<string, unknown> = {}, requires?: Record<string, string>) => ({
    uid: `p-${short}`,
    version: 3,
    name: `@rapidmx/${short}`,
    packageVersion: "1.0.0",
    enabled: true,
    settings: {},
    manifest: { apiVersion: 1, displayName, settings: [], ...(requires ? { requires } : {}) },
    ...overrides,
});

// In the order the server lists them (by name). Autodiscover requires the two that come either side of it.
const eas = plugin("activesync", "Exchange ActiveSync");
const autodiscover = plugin("autodiscover", "Autodiscover", {}, { "@rapidmx/activesync": "^1.0.0", "@rapidmx/mapi": "^1.0.0" });
const booking = plugin("booking", "Booking pages", { enabled: false });
const mapi = plugin("mapi", "MAPI over HTTP");

const update = (row: { uid: string; name: string }, latestVersion: string) => ({
    uid: row.uid,
    name: row.name,
    installedVersion: "1.0.0",
    latestVersion,
    updateAvailable: true,
    allowed: true,
});

const instance = { instance: "pod-a", hash: "current", loaded: [], errors: [], safeMode: false, updatedAt: "2026-09-26T00:00:00.000Z" };

type Handler = (url: string, init: RequestInit) => Response | Promise<Response> | undefined;

interface Options {
    plugins?: any[];
    /** What `GET /updates` answers with, or a function giving the response for each request. */
    updates?: unknown[] | ((url: string) => Response | Promise<Response>);
    status?: unknown;
    /** Held back until it resolves: every change (`PUT`, `DELETE`) waits for it. */
    gate?: Promise<void>;
    extra?: Handler;
}

function mockApi(options: Options = {}) {
    const plugins = options.plugins ?? [eas, autodiscover, booking, mapi];
    return mockFetch((url, init) => {
        const custom = options.extra?.(url, init);
        if (custom) return custom;
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        if (url === `${PLUGINS}/status`) return jsonResponse(200, options.status ?? { hash: "current", instances: [instance] });
        if (url === `${PLUGINS}/namespaces`) return jsonResponse(200, [{ name: "@rapidmx" }]);
        if (url.startsWith(`${PLUGINS}/updates`)) {
            return typeof options.updates === "function" ? options.updates(url) : jsonResponse(200, options.updates ?? []);
        }
        if (url.startsWith(`${PLUGINS}/plan?`)) {
            const query = new URLSearchParams(url.split("?")[1]);
            return jsonResponse(200, { plugin: { name: query.get("name"), version: query.get("packageVersion") }, install: [], enable: [], conflicts: [] });
        }
        if (url === PLUGINS && (init?.method ?? "GET") === "GET") return jsonResponse(200, plugins);
        const row = plugins.find((candidate) => url === `${PLUGINS}/${candidate.uid}`);
        if (row && init?.method === "PUT") {
            const body = JSON.parse(init.body as string);
            const changed = {
                ...row,
                ...(body.packageVersion ? { packageVersion: body.packageVersion } : {}),
                ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
                version: row.version + 1,
            };
            return (options.gate ?? Promise.resolve()).then(() => jsonResponse(200, changed));
        }
        if (row && init?.method === "DELETE") return (options.gate ?? Promise.resolve()).then(() => emptyResponse(204));
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

/** Every change made, in order, as `<METHOD> <uid>`. */
const writes = (fetchMock: ReturnType<typeof vi.fn>): string[] =>
    fetchMock.mock.calls
        .filter(([url, init]) => init?.method && init.method !== "GET" && !String(url).endsWith("/api/auth/refresh"))
        .map(([url, init]) => `${init.method} ${String(url).split("/").pop()}`);

const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, uid: string): any =>
    JSON.parse(fetchMock.mock.calls.find(([url, init]) => url === `${PLUGINS}/${uid}` && init?.method === "PUT")![1].body);

const calledWith = (fetchMock: ReturnType<typeof vi.fn>, url: string): boolean => fetchMock.mock.calls.some(([called]) => called === url);

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
};

const notifications = () => getNotificationsSnapshot().history.map((entry) => `${entry.kind}: ${entry.title}`);

afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    resetNotifications();
});

const renderPage = () => render(<PluginsPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

const rowOf = async (displayName: string) => (await screen.findByText(displayName)).closest("tr") as HTMLElement;

const select = async (user: ReturnType<typeof userEvent.setup>, ...displayNames: string[]) => {
    for (const displayName of displayNames) {
        await user.click(within(await rowOf(displayName)).getByRole("checkbox", { name: `Select ${displayName}` }));
    }
};

const toolbar = () => screen.getByRole("toolbar", { name: "Actions for several plugins" });
const bulkButton = (name: string) => within(toolbar()).getByRole("button", { name });

describe("the pre-release preference", () => {
    it("offers updates to pre-releases once allowed, and remembers the choice in this browser", async () => {
        const fetchMock = mockApi({
            updates: (url) => jsonResponse(200, url.endsWith("prerelease=true") ? [update(eas, "1.0.0-beta.2")] : []),
        });
        const user = userEvent.setup();
        const first = renderPage();
        const checkbox = await screen.findByRole("checkbox", { name: /Allow pre-release versions/ });
        expect(checkbox).not.toBeChecked();
        expect(calledWith(fetchMock, `${PLUGINS}/updates`)).toBe(true);
        const easRow = await rowOf("Exchange ActiveSync");
        expect(within(easRow).queryByText(/Update available/)).not.toBeInTheDocument();

        await user.click(checkbox);
        expect(await within(easRow).findByText("Update available: 1.0.0-beta.2")).toBeInTheDocument();
        expect(calledWith(fetchMock, `${PLUGINS}/updates?prerelease=true`)).toBe(true);
        expect(localStorage.getItem(PRERELEASE_KEY)).toBe("true");

        // A fresh page starts with it on, and asks for pre-releases from the start.
        first.unmount();
        fetchMock.mockClear();
        renderPage();
        expect(await screen.findByRole("checkbox", { name: /Allow pre-release versions/ })).toBeChecked();
        await waitFor(() => expect(calledWith(fetchMock, `${PLUGINS}/updates?prerelease=true`)).toBe(true));
        expect(calledWith(fetchMock, `${PLUGINS}/updates`)).toBe(false);

        await user.click(screen.getByRole("checkbox", { name: /Allow pre-release versions/ }));
        await waitFor(() => expect(within(screen.getByText("Exchange ActiveSync").closest("tr") as HTMLElement).queryByText(/Update available/)).not.toBeInTheDocument());
        expect(localStorage.getItem(PRERELEASE_KEY)).toBeNull();
    });

    it("ignores an update check that finishes after a newer one, whether it succeeded or failed", async () => {
        const checks: { url: string; answer: (response: Response) => void }[] = [];
        mockApi({ updates: (url) => new Promise<Response>((answer) => checks.push({ url, answer })) });
        const user = userEvent.setup();
        renderPage();
        await waitFor(() => expect(checks).toHaveLength(1));
        const easRow = await rowOf("Exchange ActiveSync");
        const mapiRow = await rowOf("MAPI over HTTP");

        // The check that was under way when the box was ticked finishes last, and is out of date by then.
        await user.click(screen.getByRole("checkbox", { name: /Allow pre-release versions/ }));
        await waitFor(() => expect(checks).toHaveLength(2));
        checks[1].answer(jsonResponse(200, [update(eas, "2.0.0-beta.1")]));
        expect(await within(easRow).findByText("Update available: 2.0.0-beta.1")).toBeInTheDocument();
        checks[0].answer(jsonResponse(200, [update(mapi, "9.9.9")]));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(within(mapiRow).queryByText(/Update available/)).not.toBeInTheDocument();
        expect(within(easRow).getByText("Update available: 2.0.0-beta.1")).toBeInTheDocument();

        // And an older check that fails after a newer one succeeded doesn't take the newer one's updates away.
        await user.click(screen.getByRole("checkbox", { name: /Allow pre-release versions/ }));
        await waitFor(() => expect(checks).toHaveLength(3));
        await user.click(screen.getByRole("checkbox", { name: /Allow pre-release versions/ }));
        await waitFor(() => expect(checks).toHaveLength(4));
        checks[3].answer(jsonResponse(200, [update(eas, "2.0.0")]));
        expect(await within(easRow).findByText("Update available: 2.0.0")).toBeInTheDocument();
        checks[2].answer(jsonResponse(500, { message: "registry offline" }));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(within(easRow).getByText("Update available: 2.0.0")).toBeInTheDocument();
    });

    it("looks a plugin's versions and the plugins to find up with pre-releases, and installs the newest of an uninstalled one", async () => {
        localStorage.setItem(PRERELEASE_KEY, "true");
        const gone = { uid: "u-gone", name: "@rapidmx/gone-plugin", displayName: "Gone", state: "done", steps: [] };
        const fetchMock = mockApi({
            plugins: [eas],
            status: { hash: "current", instances: [instance], purges: [gone] },
            extra: (url, init) => {
                if (url.startsWith(`${PLUGINS}/registry?`)) {
                    const name = new URLSearchParams(url.split("?")[1]).get("name");
                    return jsonResponse(200, {
                        package: { name, latest: "1.0.0-beta.3", versions: ["1.0.0-beta.3", "1.0.0"] },
                        selected: { name, version: "1.0.0-beta.3", peerDependencies: {}, manifest: { apiVersion: 1, displayName: "Found" } },
                    });
                }
                if (url.startsWith(`${PLUGINS}/search`)) return jsonResponse(200, []);
                if (url === PLUGINS && init.method === "POST") {
                    return jsonResponse(200, { plugin: plugin("gone-plugin", "Gone", { packageVersion: "1.0.0-beta.3" }), dependencies: [] });
                }
                if (url.startsWith(`${PLUGINS}/plan?name=%40rapidmx%2Fgone-plugin`) && !url.includes("packageVersion")) {
                    return jsonResponse(200, { plugin: { name: "@rapidmx/gone-plugin", version: "1.0.0-beta.3" }, install: [], enable: [], conflicts: [] });
                }
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();

        // The version list of an installed plugin.
        await user.click(within(await rowOf("Exchange ActiveSync")).getByRole("button", { name: "Change version" }));
        expect(await screen.findByRole("option", { name: "1.0.0-beta.3 (latest)" })).toBeInTheDocument();
        expect(calledWith(fetchMock, `${PLUGINS}/registry?name=%40rapidmx%2Factivesync&prerelease=true`)).toBe(true);
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        // Adding by name.
        await user.click(screen.getByRole("button", { name: "Add by name" }));
        await user.type(screen.getByLabelText("Package name"), "@rapidmx/found-plugin");
        await user.click(screen.getByRole("button", { name: "Find" }));
        await screen.findByRole("option", { name: "1.0.0-beta.3 (latest)" });
        expect(calledWith(fetchMock, `${PLUGINS}/registry?name=%40rapidmx%2Ffound-plugin&prerelease=true`)).toBe(true);
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        // Searching, and what was found doesn't outlive the setting.
        await user.click(screen.getByRole("button", { name: "Search" }));
        await screen.findByText("No plugins found.");
        expect(calledWith(fetchMock, `${PLUGINS}/search?prerelease=true`)).toBe(true);
        await user.click(screen.getByRole("checkbox", { name: /Allow pre-release versions/ }));
        expect(screen.queryByText("No plugins found.")).not.toBeInTheDocument();

        // Installing again a plugin that was uninstalled: the newest, pre-releases included while allowed.
        await user.click(screen.getByRole("checkbox", { name: /Allow pre-release versions/ }));
        await user.click(await screen.findByRole("button", { name: "Install Gone" }));
        await waitFor(() => expect(calledWith(fetchMock, `${PLUGINS}/plan?name=%40rapidmx%2Fgone-plugin&prerelease=true`)).toBe(true));
        await waitFor(() => expect(JSON.parse(fetchMock.mock.calls.find(([url, init]) => init?.method === "POST" && !String(url).endsWith("/api/auth/refresh"))![1].body)).toMatchObject({ name: "@rapidmx/gone-plugin", packageVersion: "1.0.0-beta.3" }));
    });

    it("is off when this browser won't say, and a choice it can't keep still applies", async () => {
        const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        const fetchMock = mockApi();
        const user = userEvent.setup();
        renderPage();
        const checkbox = await screen.findByRole("checkbox", { name: /Allow pre-release versions/ });
        expect(checkbox).not.toBeChecked();
        await user.click(checkbox);
        expect(checkbox).toBeChecked();
        await waitFor(() => expect(calledWith(fetchMock, `${PLUGINS}/updates?prerelease=true`)).toBe(true));
        getItem.mockRestore();
        setItem.mockRestore();
    });
});

describe("selecting plugins", () => {
    it("ticks every plugin at once, shows a partial selection, and only enables an action that has something to do", async () => {
        mockApi({ updates: [update(eas, "1.1.0")] });
        const user = userEvent.setup();
        renderPage();
        await rowOf("Exchange ActiveSync");
        const all = screen.getByRole<HTMLInputElement>("checkbox", { name: "Select all plugins" });
        expect(within(toolbar()).getByText("Select all")).toBeInTheDocument();
        // Nothing ticked: Upgrade all is there, the rest have nothing to work on.
        expect(bulkButton("Upgrade selected plugins")).toBeDisabled();
        expect(bulkButton("Disable selected plugins")).toBeDisabled();
        expect(bulkButton("Uninstall selected plugins")).toBeDisabled();
        expect(bulkButton("Upgrade all plugins")).toBeEnabled();

        // One that is disabled and has no update: only Uninstall applies.
        await select(user, "Booking pages");
        expect(all.indeterminate).toBe(true);
        expect(within(toolbar()).getByText("1 selected")).toBeInTheDocument();
        expect(bulkButton("Upgrade selected plugins")).toBeDisabled();
        expect(bulkButton("Disable selected plugins")).toBeDisabled();
        expect(bulkButton("Uninstall selected plugins")).toHaveTextContent("Uninstall (1)");

        await user.click(all);
        expect(all.indeterminate).toBe(false);
        expect(all).toBeChecked();
        expect(within(toolbar()).getByText("4 selected")).toBeInTheDocument();
        // Every plugin ticked, the counts are of the ones each action applies to.
        expect(bulkButton("Upgrade selected plugins")).toHaveTextContent("Upgrade (1)");
        expect(bulkButton("Disable selected plugins")).toHaveTextContent("Disable (3)");
        expect(bulkButton("Uninstall selected plugins")).toHaveTextContent("Uninstall (4)");

        await user.click(all);
        expect(within(toolbar()).getByText("Select all")).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: "Select Booking pages" })).not.toBeChecked();

        // A plugin's own box ticks it and unticks it again.
        await select(user, "Booking pages");
        expect(screen.getByRole("checkbox", { name: "Select Booking pages" })).toBeChecked();
        await select(user, "Booking pages");
        expect(screen.getByRole("checkbox", { name: "Select Booking pages" })).not.toBeChecked();
        expect(within(toolbar()).getByText("Select all")).toBeInTheDocument();
    });

    it("has no toolbar when nothing is installed", async () => {
        mockApi({ plugins: [] });
        renderPage();
        await screen.findByText("No plugins installed.");
        expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    });
});

describe("upgrading the selected plugins", () => {
    it("upgrades each to its newest version, the plugins others require first, and says how far it has got", async () => {
        const gate = deferred();
        const fetchMock = mockApi({
            gate: gate.promise,
            updates: [update(eas, "1.1.0"), update(autodiscover, "1.0.1"), update(mapi, "1.2.0")],
        });
        const user = userEvent.setup();
        renderPage();
        await select(user, "Autodiscover", "MAPI over HTTP", "Exchange ActiveSync");
        expect(bulkButton("Upgrade selected plugins")).toHaveTextContent("Upgrade (3)");
        await user.click(bulkButton("Upgrade selected plugins"));

        // Held on the first: the whole page is busy, and the bar and the note say so.
        expect(await screen.findByRole("progressbar", { name: "Working on plugins" })).toBeInTheDocument();
        expect(await within(toolbar()).findByText(/Upgrading Exchange ActiveSync \(1 of 3\)/)).toBeInTheDocument();
        expect(bulkButton("Upgrade selected plugins")).toBeDisabled();
        expect(bulkButton("Upgrade all plugins")).toBeDisabled();
        expect(screen.getByRole("checkbox", { name: "Select all plugins" })).toBeDisabled();
        expect(within(await rowOf("Booking pages")).getByRole("button", { name: "Enable Booking pages" })).toBeDisabled();
        gate.resolve();

        await waitFor(() => expect(notifications()).toEqual(["success: 3 plugins upgraded"]));
        // Autodiscover needs the other two at their new versions, so it comes last although it is listed second.
        expect(writes(fetchMock)).toEqual(["PUT p-activesync", "PUT p-mapi", "PUT p-autodiscover"]);
        expect(bodyOf(fetchMock, "p-mapi")).toMatchObject({ packageVersion: "1.2.0", version: 3, expectedPlan: { install: [], enable: [] } });
        expect(bodyOf(fetchMock, "p-autodiscover")).toMatchObject({ packageVersion: "1.0.1" });
        expect(screen.queryByRole("progressbar", { name: "Working on plugins" })).not.toBeInTheDocument();
        expect(within(toolbar()).getByText("Select all")).toBeInTheDocument();
        expect(within(await rowOf("MAPI over HTTP")).getByText("1.2.0")).toBeInTheDocument();
        expect(screen.queryByText(/couldn't be upgraded/)).not.toBeInTheDocument();
    });

    it("looks for updates once when it is done, not after every plugin it upgraded", async () => {
        const fetchMock = mockApi({ updates: [update(eas, "1.1.0"), update(autodiscover, "1.0.1"), update(mapi, "1.2.0")] });
        const user = userEvent.setup();
        renderPage();
        await select(user, "Autodiscover", "MAPI over HTTP", "Exchange ActiveSync");
        await user.click(bulkButton("Upgrade selected plugins"));

        await waitFor(() => expect(notifications()).toEqual(["success: 3 plugins upgraded"]));
        // Once as the page opened, once at the end - not three more in between.
        await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith(`${PLUGINS}/updates`))).toHaveLength(2));
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith(`${PLUGINS}/updates`))).toHaveLength(2);
    });

    it("leaves a plugin that would also install or enable others for the administrator to review, and one that conflicts", async () => {
        const fetchMock = mockApi({
            updates: [update(eas, "2.0.0"), update(mapi, "2.0.0"), update(booking, "2.0.0")],
            extra: (url) => {
                if (url.startsWith(`${PLUGINS}/plan?name=%40rapidmx%2Factivesync`)) {
                    return jsonResponse(200, {
                        plugin: { name: "@rapidmx/activesync", version: "2.0.0" },
                        install: [{ name: "@rapidmx/extra", version: "1.0.0", manifest: { apiVersion: 1, displayName: "Extra" } }],
                        enable: [],
                        conflicts: [],
                    });
                }
                if (url.startsWith(`${PLUGINS}/plan?name=%40rapidmx%2Fmapi`)) {
                    return jsonResponse(200, { plugin: { name: "@rapidmx/mapi", version: "2.0.0" }, install: [], enable: [], conflicts: ["Needs Autodiscover 2."] });
                }
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        await select(user, "Exchange ActiveSync", "MAPI over HTTP", "Booking pages");
        await user.click(bulkButton("Upgrade selected plugins"));

        // The disabled one is changed as it always is, without a preview; the other two are left as they were.
        await waitFor(() => expect(notifications()).toEqual(["success: 1 plugin upgraded"]));
        expect(writes(fetchMock)).toEqual(["PUT p-booking"]);
        const alert = await screen.findByText("2 plugins couldn't be upgraded:");
        const reasons = within(alert.closest("div") as HTMLElement);
        expect(reasons.getByText(/Exchange ActiveSync: Exchange ActiveSync 2\.0\.0 also needs other plugins installed or enabled, so it wasn't changed\. Change it on its own to review them\./)).toBeInTheDocument();
        expect(reasons.getByText(/MAPI over HTTP: MAPI over HTTP 2\.0\.0 can't be installed\. Needs Autodiscover 2\./)).toBeInTheDocument();
        // What failed stays ticked, to try again.
        expect(within(toolbar()).getByText("2 selected")).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: "Select Booking pages" })).not.toBeChecked();
    });
});

describe("Upgrade all", () => {
    it("upgrades every plugin with an update whatever is ticked, after checking the registry again", async () => {
        let checks = 0;
        const fetchMock = mockApi({
            updates: () => {
                checks++;
                // The first check (as the page opens) found nothing; by the second, one is out.
                return jsonResponse(200, checks === 1 ? [] : [update(eas, "1.1.0"), { ...update(mapi, "1.2.0"), updateAvailable: false }, { uid: "p-booking", updateAvailable: true }]);
            },
        });
        const user = userEvent.setup();
        renderPage();
        await select(user, "MAPI over HTTP");
        await waitFor(() => expect(checks).toBe(1));
        await user.click(bulkButton("Upgrade all plugins"));

        await waitFor(() => expect(notifications()).toEqual(["success: 1 plugin upgraded"]));
        expect(checks).toBeGreaterThanOrEqual(2);
        expect(writes(fetchMock)).toEqual(["PUT p-activesync"]);
        expect(bodyOf(fetchMock, "p-activesync")).toMatchObject({ packageVersion: "1.1.0" });
    });

    it("says so when everything is up to date, and when some plugins couldn't be checked", async () => {
        let answer: unknown[] = [];
        const fetchMock = mockApi({ updates: () => jsonResponse(200, answer) });
        const user = userEvent.setup();
        renderPage();
        await rowOf("Exchange ActiveSync");
        await user.click(bulkButton("Upgrade all plugins"));
        await waitFor(() => expect(notifications()).toEqual(["info: All plugins are up to date"]));

        answer = [{ uid: "p-mapi", name: "@rapidmx/mapi", installedVersion: "1.0.0", updateAvailable: false, allowed: true, error: "registry offline" }];
        await user.click(bulkButton("Upgrade all plugins"));
        await waitFor(() => expect(notifications()).toContain("warning: No updates found"));
        expect(writes(fetchMock)).toEqual([]);
    });

    it("says so when the registry can't be checked", async () => {
        let checks = 0;
        const fetchMock = mockApi({ updates: () => (++checks === 1 ? jsonResponse(200, []) : jsonResponse(500, { message: "down" })) });
        const user = userEvent.setup();
        renderPage();
        await rowOf("Exchange ActiveSync");
        await waitFor(() => expect(checks).toBe(1));
        await user.click(bulkButton("Upgrade all plugins"));
        expect(await screen.findByText("Could not check for plugin updates.")).toBeInTheDocument();
        expect(writes(fetchMock)).toEqual([]);
        expect(notifications()).toEqual([]);
    });
});

describe("disabling the selected plugins", () => {
    it("disables the enabled ones, the plugins that require others first, leaving those already disabled", async () => {
        const fetchMock = mockApi();
        const user = userEvent.setup();
        renderPage();
        // Autodiscover requires MAPI, which isn't ticked, and Exchange ActiveSync, which is.
        await select(user, "Exchange ActiveSync", "Booking pages", "Autodiscover");
        expect(bulkButton("Disable selected plugins")).toHaveTextContent("Disable (2)");
        await user.click(bulkButton("Disable selected plugins"));

        await waitFor(() => expect(notifications()).toEqual(["success: 2 plugins disabled"]));
        expect(writes(fetchMock)).toEqual(["PUT p-autodiscover", "PUT p-activesync"]);
        expect(bodyOf(fetchMock, "p-autodiscover")).toEqual({ version: 3, enabled: false });
        expect((await rowOf("Autodiscover")).textContent).toContain("Disabled");
    });

    it("keeps going after the server refuses one, and leaves it ticked with the reason", async () => {
        mockApi({
            extra: (url, init) =>
                url === `${PLUGINS}/p-autodiscover` && init.method === "PUT"
                    ? jsonResponse(409, { message: "Something requires Autodiscover, so it can't be disabled." })
                    : undefined,
        });
        const user = userEvent.setup();
        renderPage();
        await select(user, "Exchange ActiveSync", "Autodiscover");
        await user.click(bulkButton("Disable selected plugins"));

        expect(await screen.findByText("1 plugin couldn't be disabled:")).toBeInTheDocument();
        expect(screen.getByText("Autodiscover: Something requires Autodiscover, so it can't be disabled.")).toBeInTheDocument();
        expect(notifications()).toEqual(["success: 1 plugin disabled"]);
        expect(within(toolbar()).getByText("1 selected")).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: "Select Autodiscover" })).toBeChecked();

        // The next action clears what was said about the last.
        await user.click(bulkButton("Disable selected plugins"));
        await waitFor(() => expect(screen.getAllByText("1 plugin couldn't be disabled:")).toHaveLength(1));
    });

    it("stops at the first plugin the server refuses for want of a recently confirmed identity (api-104), as no other will get past it", async () => {
        const fetchMock = mockApi({
            extra: (url, init) => (init.method === "PUT" ? jsonResponse(403, { code: "api-104", message: "This operation requires elevation." }) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        await select(user, "Exchange ActiveSync", "MAPI over HTTP");
        await user.click(bulkButton("Disable selected plugins"));

        expect(await screen.findByText("2 plugins couldn't be disabled:")).toBeInTheDocument();
        expect(screen.getByText(/MAPI over HTTP: This needs you to have recently confirmed your identity/)).toBeInTheDocument();
        expect(screen.getByText("Exchange ActiveSync: Not attempted.")).toBeInTheDocument();
        expect(writes(fetchMock)).toHaveLength(1);
    });

    it("says nothing was disabled when the server refuses every one", async () => {
        mockApi({ extra: (url, init) => (init.method === "PUT" ? jsonResponse(500, { message: "Boom" }) : undefined) });
        const user = userEvent.setup();
        renderPage();
        await select(user, "MAPI over HTTP");
        await user.click(bulkButton("Disable selected plugins"));
        expect(await screen.findByText("MAPI over HTTP: Boom")).toBeInTheDocument();
        expect(notifications()).toEqual([]);
    });
});

describe("uninstalling the selected plugins", () => {
    it("asks first, naming them and saying their data stays, and does nothing on Cancel", async () => {
        const fetchMock = mockApi();
        const user = userEvent.setup();
        renderPage();
        await select(user, "Exchange ActiveSync", "Autodiscover");
        await user.click(bulkButton("Uninstall selected plugins"));

        const dialog = await screen.findByRole("dialog", { name: "Uninstall 2 plugins?" });
        expect(within(dialog).getByText("The servers stop running these plugins after they restart:")).toBeInTheDocument();
        expect(within(dialog).getByText("Exchange ActiveSync")).toBeInTheDocument();
        expect(within(dialog).getByText("Autodiscover")).toBeInTheDocument();
        expect(within(dialog).getByText(/Data they stored stays in the database, and adding a plugin again brings it back/)).toBeInTheDocument();
        // Their data is kept unless the box is ticked.
        expect(within(dialog).getByRole("checkbox", { name: "Also delete all data these plugins stored" })).not.toBeChecked();
        expect(within(dialog).queryByLabelText(/to confirm/)).not.toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(writes(fetchMock)).toEqual([]);
        expect(within(toolbar()).getByText("2 selected")).toBeInTheDocument();
    });

    it("uninstalls them once confirmed, the plugins that require others first, and follows the rollout", async () => {
        const fetchMock = mockApi();
        const user = userEvent.setup();
        renderPage();
        await select(user, "Exchange ActiveSync", "Autodiscover");
        await user.click(bulkButton("Uninstall selected plugins"));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Uninstall 2 plugins" }));

        await waitFor(() => expect(notifications()).toEqual(["success: 2 plugins uninstalled"]));
        expect(writes(fetchMock)).toEqual(["DELETE p-autodiscover", "DELETE p-activesync"]);
        // Nothing is sent that would delete the data.
        expect(fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")![1].body).toBeUndefined();
        expect(screen.queryByText("Exchange ActiveSync")).not.toBeInTheDocument();
        expect(screen.queryByText("Autodiscover")).not.toBeInTheDocument();
        expect(screen.getByText("MAPI over HTTP")).toBeInTheDocument();
        // The servers were asked how they're doing again after the change.
        expect(fetchMock.mock.calls.filter(([url]) => url === `${PLUGINS}/status`).length).toBeGreaterThan(1);
    });

    const scheduledPurge = (url: string, init: RequestInit) => {
        const row = [eas, autodiscover, booking, mapi].find((candidate) => url === `${PLUGINS}/${candidate.uid}`);
        return row && init.method === "DELETE"
            ? jsonResponse(200, {
                  purgeScheduled: true,
                  purge: { uid: `u-${row.uid}`, name: row.name, displayName: row.manifest.displayName, state: "pending", steps: [] },
              })
            : undefined;
    };

    it("offers to delete their data too, danger-styled and behind a typed word, saying what is deleted", async () => {
        const fetchMock = mockApi({
            extra: scheduledPurge,
            // What the servers report once asked: the deletions just scheduled (hidden while a plugin is still installed).
            status: {
                hash: "current",
                instances: [instance],
                purges: [eas, autodiscover].map((row) => ({ uid: `u-${row.uid}`, name: row.name, displayName: row.manifest.displayName, state: "pending", steps: [] })),
            },
        });
        const user = userEvent.setup();
        renderPage();
        await select(user, "Exchange ActiveSync", "Autodiscover");
        await user.click(bulkButton("Uninstall selected plugins"));
        const dialog = await screen.findByRole("dialog", { name: "Uninstall 2 plugins?" });

        const checkbox = within(dialog).getByRole("checkbox", { name: "Also delete all data these plugins stored" });
        expect(checkbox).toHaveAccessibleDescription(/What is deleted, for each plugin:/);
        expect(checkbox).toHaveAccessibleDescription(/This can.t be undone\./);
        await user.click(checkbox);
        expect(within(dialog).getByText(/all the data they stored is deleted/)).toBeInTheDocument();
        const confirm = within(dialog).getByRole("button", { name: "Uninstall 2 plugins and delete data" });
        expect(confirm).toBeDisabled();
        expect(confirm).toHaveClass("!bg-danger");

        // Enter does nothing until the word matches, however it's cased.
        const typed = within(dialog).getByLabelText(/Type delete to confirm/);
        await user.type(typed, "dele{Enter}");
        fireEvent.submit(typed.closest("form") as HTMLFormElement);
        expect(writes(fetchMock)).toEqual([]);
        await user.type(typed, "TE");
        expect(confirm).toBeEnabled();
        await user.click(confirm);

        await waitFor(() => expect(writes(fetchMock)).toEqual(["DELETE p-autodiscover", "DELETE p-activesync"]));
        expect(JSON.parse(fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")![1].body)).toEqual({ purgeData: true });
        await waitFor(() => expect(notifications()).toEqual(["success: 2 plugins uninstalled"]));
        expect(getNotificationsSnapshot().history[0].message).toMatch(/Their data is deleted once every server has stopped running them/);
        // Each deletion is listed at once, waiting for the servers.
        expect(await screen.findAllByText("Uninstalled - data will be deleted after servers restart")).toHaveLength(2);
    });

    it("words the data deletion for a single plugin, and submits with Enter once the word is typed", async () => {
        const fetchMock = mockApi({ extra: scheduledPurge });
        const user = userEvent.setup();
        renderPage();
        await select(user, "MAPI over HTTP");
        await user.click(bulkButton("Uninstall selected plugins"));
        const dialog = await screen.findByRole("dialog", { name: "Uninstall 1 plugin?" });
        await user.click(within(dialog).getByRole("checkbox", { name: "Also delete all data this plugin stored" }));
        expect(within(dialog).getByText("Once every server has stopped running it, all the data it stored is deleted.")).toBeInTheDocument();
        await user.type(within(dialog).getByLabelText(/Type delete to confirm/), "delete{Enter}");
        await waitFor(() => expect(writes(fetchMock)).toEqual(["DELETE p-mapi"]));
        expect(JSON.parse(fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")![1].body)).toEqual({ purgeData: true });
    });

    it("stops at the first plugin the server won't delete data for until the administrator confirms their identity", async () => {
        const fetchMock = mockApi({
            extra: (url, init) => (init.method === "DELETE" ? jsonResponse(403, { code: "api-104", message: "Elevation required" }) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        await select(user, "Exchange ActiveSync", "Autodiscover", "MAPI over HTTP");
        await user.click(bulkButton("Uninstall selected plugins"));
        const dialog = await screen.findByRole("dialog");
        await user.click(within(dialog).getByRole("checkbox", { name: /Also delete all data/ }));
        await user.type(within(dialog).getByLabelText(/Type delete to confirm/), "delete");
        await user.click(within(dialog).getByRole("button", { name: /and delete data/ }));

        expect(await screen.findByText("3 plugins couldn't be uninstalled:")).toBeInTheDocument();
        expect(screen.getByText(/Autodiscover: Deleting data needs you to have recently confirmed your identity/)).toBeInTheDocument();
        expect(screen.getAllByText(/: Not attempted\./)).toHaveLength(2);
        // Only the first was asked; all three stay ticked and installed.
        expect(writes(fetchMock)).toEqual(["DELETE p-autodiscover"]);
        expect(within(toolbar()).getByText("3 selected")).toBeInTheDocument();
        expect(notifications()).toEqual([]);
    });

    it("words a single plugin's confirmation for one, and reports what the server refused", async () => {
        const fetchMock = mockApi({
            extra: (url, init) => (url === `${PLUGINS}/p-mapi` && init.method === "DELETE" ? jsonResponse(409, { message: "Autodiscover requires MAPI over HTTP." }) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        await select(user, "MAPI over HTTP");
        await user.click(bulkButton("Uninstall selected plugins"));
        const dialog = await screen.findByRole("dialog", { name: "Uninstall 1 plugin?" });
        expect(within(dialog).getByText("The servers stop running this plugin after they restart:")).toBeInTheDocument();
        expect(within(dialog).getByText(/Data it stored stays in the database, and adding the plugin again brings it back/)).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Uninstall 1 plugin" }));

        expect(await screen.findByText("MAPI over HTTP: Autodiscover requires MAPI over HTTP.")).toBeInTheDocument();
        expect(notifications()).toEqual([]);
        expect(screen.getByText("MAPI over HTTP")).toBeInTheDocument();
        // Nothing changed, so nothing is being rolled out: the servers weren't asked again.
        expect(fetchMock.mock.calls.filter(([url]) => url === `${PLUGINS}/status`)).toHaveLength(1);
    });
});

describe("the progress bar", () => {
    it("runs across the top while a single plugin is being upgraded, and goes when it's done", async () => {
        const gate = deferred();
        mockApi({ gate: gate.promise, updates: [update(eas, "1.1.0")] });
        const user = userEvent.setup();
        renderPage();
        expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
        await user.click(await screen.findByRole("button", { name: "Upgrade Exchange ActiveSync to 1.1.0" }));

        const bar = await screen.findByRole("progressbar", { name: "Working on plugins" });
        // Fixed to the top of the window, above the dialogs, and moving on its own.
        expect(bar).toHaveClass("fixed", "top-0", "inset-x-0");
        expect(bar.firstElementChild).toHaveClass("rr-progress-indeterminate");
        gate.resolve();
        await waitFor(() => expect(screen.queryByRole("progressbar", { name: "Working on plugins" })).not.toBeInTheDocument());
    });

    it("shows while the servers are still applying a change, until they have", async () => {
        mockApi({ status: { hash: "wanted", instances: [{ ...instance, hash: "old" }] } });
        renderPage();
        expect(await screen.findByRole("progressbar", { name: "Applying plugin changes" })).toBeInTheDocument();
    });

    it("shows while a plugin is being enabled, disabled or planned, and not for a page at rest", async () => {
        const gate = deferred();
        mockApi({ gate: gate.promise });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Disable Exchange ActiveSync" }));
        await screen.findByRole("progressbar", { name: "Working on plugins" });
        gate.resolve();
        await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument());
    });
});
