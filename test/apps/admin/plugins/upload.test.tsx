// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Installing a plugin from the .tgz `npm pack` produces: the Upload button and its file chooser, what is refused before it is
// sent, the answers the server can give, replacing an installed plugin, and how an uploaded plugin is shown in the list.
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import PluginsManager from "../../../../apps/shared/components/admin/settings/PluginsManager.js";
import PluginsPage from "../../../../apps/admin/plugins/index.js";
import { ReconfirmIdentityContext } from "../../../../apps/shared/components/admin/ActionAlert.js";
import { getNotificationsSnapshot } from "../../../../apps/shared/notifications/store.js";

const eas = {
    uid: "p-eas",
    version: 3,
    name: "@rapidmx/activesync",
    packageVersion: "1.0.0",
    enabled: true,
    settings: {},
    manifest: { apiVersion: 1, displayName: "Exchange ActiveSync", settings: [] },
    source: "registry",
};
const uploadedRow = {
    uid: "p-acme",
    version: 1,
    name: "@acme/x-plugin",
    packageVersion: "1.2.3",
    enabled: true,
    settings: {},
    manifest: { apiVersion: 1, displayName: "Acme X", settings: [] },
    source: "upload",
    uploadFilename: "acme-x-plugin-1.2.3.tgz",
    uploadedAt: "2026-09-30T10:00:00.000Z",
    uploadedByUserUid: "admin-1",
};
const instance = {
    instance: "pod-a",
    hash: "current",
    loaded: [],
    errors: [],
    safeMode: false,
    updatedAt: "2026-09-21T00:00:00.000Z",
};

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

function mockApi(options: { plugins?: unknown[]; updates?: unknown[]; extra?: Handler } = {}) {
    return mockFetch((url, init) => {
        const custom = options.extra?.(url, init);
        if (custom) return custom;
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        if (url === "/api/system/plugins/status") return jsonResponse(200, { hash: "current", instances: [instance] });
        if (url === "/api/system/plugins/updates") return jsonResponse(200, options.updates ?? []);
        if (url.startsWith("/api/system/plugins/plan?")) {
            const query = new URLSearchParams(url.split("?")[1]);
            return jsonResponse(200, { plugin: { name: query.get("name"), version: query.get("packageVersion") }, install: [], enable: [], conflicts: [] });
        }
        if (url === "/api/system/plugins" && (init?.method ?? "GET") === "GET") return jsonResponse(200, options.plugins ?? [eas]);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

const renderPage = () => render(<PluginsPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

const pack = (name = "acme-x-plugin-1.2.3.tgz") => new File(["gzip bytes"], name, { type: "application/gzip" });
const chooser = async (): Promise<HTMLInputElement> => {
    await screen.findByText("Exchange ActiveSync");
    return screen.getByLabelText("Plugin pack file");
};
const uploadCalls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.filter((call) => String(call[0]).startsWith("/api/system/plugins/upload"));

describe("the Upload button", () => {
    it("opens the file chooser, which takes only .tgz and gzip files", async () => {
        mockApi();
        const user = userEvent.setup();
        renderPage();
        const input = await chooser();
        expect(input).toHaveAttribute("type", "file");
        expect(input).toHaveAttribute("accept", ".tgz,.tar.gz,application/gzip,application/x-gzip");
        const open = vi.spyOn(input, "click");
        const button = screen.getByRole("button", { name: "Upload" });
        button.focus();
        await user.keyboard("{Enter}");
        expect(open).toHaveBeenCalledTimes(1);
        await user.click(button);
        expect(open).toHaveBeenCalledTimes(2);
    });

    it("refuses a file that isn't a .tgz or .gz without sending it, and says so", async () => {
        const fetchMock = mockApi();
        renderPage();
        const input = await chooser();
        fireEvent.change(input, { target: { files: [new File(["x"], "notes.zip")] } });
        expect(await screen.findByRole("alert")).toHaveTextContent("notes.zip isn't a plugin pack. Choose the .tgz file that npm pack produces.");
        expect(uploadCalls(fetchMock)).toHaveLength(0);
    });

    it("does nothing when the chooser is dismissed without a file", async () => {
        const fetchMock = mockApi();
        renderPage();
        const input = await chooser();
        fireEvent.change(input, { target: { files: [] } });
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(uploadCalls(fetchMock)).toHaveLength(0);
    });

    it("sends the raw file, then lists the plugin and says that the servers restart to load it", async () => {
        const fetchMock = mockApi({
            extra: (url, init) => (url.startsWith("/api/system/plugins/upload") && init?.method === "POST" ? jsonResponse(201, uploadedRow) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        const input = await chooser();
        const file = pack();
        await user.upload(input, file);

        expect(await screen.findByText("Acme X")).toBeInTheDocument();
        const [url, init] = uploadCalls(fetchMock)[0] as [string, RequestInit];
        expect(url).toBe("/api/system/plugins/upload?filename=acme-x-plugin-1.2.3.tgz");
        expect(init.body).toBe(file);
        expect(new Headers(init.headers).get("Content-Type")).toBe("application/gzip");
        const toast = getNotificationsSnapshot().visible.find((n) => n.title === "@acme/x-plugin@1.2.3 uploaded");
        expect(toast).toMatchObject({ kind: "success", message: "The servers restart one at a time to load it." });
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        // The same file can be chosen again.
        expect(input.value).toBe("");
    });

    it("is disabled and says Uploading while the file is on its way, and sends it once", async () => {
        let finish!: (response: Response) => void;
        const fetchMock = mockApi({
            extra: (url) => (url.startsWith("/api/system/plugins/upload") ? new Promise<Response>((resolve) => (finish = resolve)) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        const input = await chooser();
        await user.upload(input, pack());

        const busy = await screen.findByRole("button", { name: "Uploading…" });
        expect(busy).toBeDisabled();
        await user.click(busy);
        expect(uploadCalls(fetchMock)).toHaveLength(1);

        await act(async () => finish(jsonResponse(201, uploadedRow)));
        expect(await screen.findByRole("button", { name: "Upload" })).toBeEnabled();
    });
});

describe("what the server can answer", () => {
    const answer = (status: number, body: unknown): Handler => (url) => (url.startsWith("/api/system/plugins/upload") ? jsonResponse(status, body) : undefined);

    it("asks before replacing an installed plugin, and replaces it once confirmed", async () => {
        const replaced = { ...uploadedRow, uid: "p-eas", name: "@rapidmx/activesync", packageVersion: "1.0.1", manifest: eas.manifest };
        const fetchMock = mockApi({
            extra: (url) => {
                if (!url.startsWith("/api/system/plugins/upload")) return undefined;
                return url.includes("replace=true")
                    ? jsonResponse(200, replaced)
                    : jsonResponse(409, { message: "@rapidmx/activesync 1.0.0 is already installed from the registry." });
            },
        });
        const user = userEvent.setup();
        renderPage();
        const input = await chooser();
        await user.upload(input, pack("rapidmx-activesync-1.0.1.tgz"));

        const dialog = await screen.findByRole("dialog", { name: "Replace plugin?" });
        expect(within(dialog).getByText("Replace @rapidmx/activesync 1.0.0 with the uploaded pack?")).toBeInTheDocument();
        expect(within(dialog).getByText("@rapidmx/activesync 1.0.0 is already installed from the registry.")).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();

        await user.click(within(dialog).getByRole("button", { name: "Replace" }));
        await waitFor(() => expect(uploadCalls(fetchMock)).toHaveLength(2));
        expect(uploadCalls(fetchMock)[1][0]).toBe("/api/system/plugins/upload?filename=rapidmx-activesync-1.0.1.tgz&replace=true");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(await screen.findByText(/acme-x-plugin-1\.2\.3\.tgz/)).toBeInTheDocument();
        expect(getNotificationsSnapshot().visible.some((n) => n.title === "@rapidmx/activesync@1.0.1 uploaded")).toBe(true);
    });

    it("leaves the installed plugin alone when the replacement is cancelled", async () => {
        const fetchMock = mockApi({ extra: answer(409, { message: "Something is already installed as a different plugin." }) });
        const user = userEvent.setup();
        renderPage();
        await user.upload(await chooser(), pack());

        const dialog = await screen.findByRole("dialog", { name: "Replace plugin?" });
        // No installed plugin is named in the message, so the question stays general and the server's words explain it.
        expect(within(dialog).getByText("Replace the installed plugin with the uploaded pack?")).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(uploadCalls(fetchMock)).toHaveLength(1);
        // So does closing the dialog.
        await user.upload(screen.getByLabelText("Plugin pack file"), pack());
        await user.click(within(await screen.findByRole("dialog", { name: "Replace plugin?" })).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(uploadCalls(fetchMock)).toHaveLength(2);
    });

    it("shows any other 409, such as a missing required plugin, without offering to replace", async () => {
        mockApi({ extra: answer(409, { message: "@acme/x-plugin requires @acme/base-plugin, which isn't installed." }) });
        const user = userEvent.setup();
        renderPage();
        await user.upload(await chooser(), pack());
        expect(await screen.findByRole("alert")).toHaveTextContent("@acme/x-plugin requires @acme/base-plugin, which isn't installed.");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows why a replacement that was confirmed still failed, not asking again", async () => {
        mockApi({ extra: answer(409, { message: "@rapidmx/activesync 1.0.0 is already installed from the registry." }) });
        const user = userEvent.setup();
        renderPage();
        await user.upload(await chooser(), pack());
        await user.click(within(await screen.findByRole("dialog", { name: "Replace plugin?" })).getByRole("button", { name: "Replace" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("already installed from the registry.");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("sends an administrator whose identity wasn't confirmed recently to confirm it again", async () => {
        mockApi({ extra: answer(403, { code: "api-104", message: "Elevation required" }) });
        const reconfirm = vi.fn();
        const user = userEvent.setup();
        // Inside the admin shell, which provides its own way to confirm the identity again.
        render(
            <ReconfirmIdentityContext.Provider value={reconfirm}>
                <PluginsManager />
            </ReconfirmIdentityContext.Provider>,
        );
        await user.upload(await chooser(), pack());
        expect(await screen.findByRole("alert")).toHaveTextContent(/needs you to have recently confirmed your identity/);
        await user.click(screen.getByRole("button", { name: "Confirm identity again" }));
        expect(reconfirm).toHaveBeenCalledTimes(1);
    });

    it("shows the server's message when uploads are switched off", async () => {
        mockApi({ extra: answer(403, { message: "Plugin uploads are disabled on this server." }) });
        const user = userEvent.setup();
        renderPage();
        await user.upload(await chooser(), pack());
        expect(await screen.findByRole("alert")).toHaveTextContent("Plugin uploads are disabled on this server.");
    });

    it("says when the file is too large", async () => {
        mockApi({ extra: answer(413, { message: "Payload Too Large" }) });
        const user = userEvent.setup();
        renderPage();
        await user.upload(await chooser(), pack());
        expect(await screen.findByRole("alert")).toHaveTextContent("That file is too large for the server to accept.");
        expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled();
    });

    it("shows the reason an invalid pack was refused (400)", async () => {
        mockApi({ extra: answer(400, { message: "The pack has no plugin manifest." }) });
        const user = userEvent.setup();
        renderPage();
        await user.upload(await chooser(), pack());
        expect(await screen.findByRole("alert")).toHaveTextContent("The pack has no plugin manifest.");
    });

    it("falls back to a general message for a failure that isn't an API error", async () => {
        mockApi({
            extra: (url) => {
                if (url.startsWith("/api/system/plugins/upload")) throw new TypeError("network down");
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        await user.upload(await chooser(), pack());
        expect(await screen.findByRole("alert")).toHaveTextContent("Could not upload the plugin.");
    });
});

describe("an uploaded plugin in the list", () => {
    const bare = { ...uploadedRow, uid: "p-bare", name: "@acme/bare-plugin", manifest: { apiVersion: 1, displayName: "Acme Bare", settings: [] }, uploadFilename: undefined, uploadedAt: undefined };

    it("is marked Uploaded with its file name and date, and is never offered a registry update", async () => {
        mockApi({
            plugins: [eas, uploadedRow, bare],
            updates: [{ uid: "p-acme", name: "@acme/x-plugin", installedVersion: "1.2.3", latestVersion: "9.9.9", updateAvailable: true }],
        });
        renderPage();
        const row = (await screen.findByText("Acme X")).closest("tr") as HTMLElement;
        expect(within(row).getByText("Uploaded")).toBeInTheDocument();
        expect(row).toHaveTextContent(/acme-x-plugin-1\.2\.3\.tgz, /);
        expect(within(row).queryByText(/Update available/)).not.toBeInTheDocument();
        expect(within(row).queryByRole("button", { name: /^Upgrade/ })).not.toBeInTheDocument();
        expect(within(row).getByRole("button", { name: "Uninstall" })).toBeInTheDocument();
        // The registry plugin beside it carries no such mark, and a pack with no file name or date still says it was uploaded.
        const registryRow = screen.getByText("Exchange ActiveSync").closest("tr") as HTMLElement;
        expect(within(registryRow).queryByText("Uploaded")).not.toBeInTheDocument();
        expect(within((await screen.findByText("Acme Bare")).closest("tr") as HTMLElement).getByText("Uploaded")).toBeInTheDocument();
    });

    it("can be switched back to the registry's version, which is confirmed in a dialog first", async () => {
        const lookup = {
            package: { name: "@acme/x-plugin", latest: "2.0.0", versions: ["1.2.3", "2.0.0"] },
            selected: { name: "@acme/x-plugin", version: "2.0.0", peerDependencies: {}, manifest: { apiVersion: 1, displayName: "Acme X" } },
        };
        const fetchMock = mockApi({
            plugins: [uploadedRow],
            extra: (url, init) => {
                if (url.startsWith("/api/system/plugins/registry?")) return jsonResponse(200, lookup);
                if (url === "/api/system/plugins/p-acme" && init?.method === "PUT") return jsonResponse(200, { ...uploadedRow, packageVersion: "2.0.0", source: "registry" });
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        const row = (await screen.findByText("Acme X")).closest("tr") as HTMLElement;
        await user.click(within(row).getByRole("button", { name: "Install the registry version" }));

        const dialog = await screen.findByRole("dialog", { name: "Install the registry version of Acme X" });
        expect(await within(dialog).findByText(/was uploaded as acme-x-plugin-1\.2\.3\.tgz/)).toBeInTheDocument();
        const version = within(dialog).getByLabelText("Version");
        await waitFor(() => expect(version.value).toBe("2.0.0"));
        // The uploaded version isn't marked as the installed registry version, even when the registry has the same number.
        expect(within(dialog).getByRole("option", { name: "1.2.3" })).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Install" }));

        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        const put = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT")!;
        expect(JSON.parse(put[1].body as string)).toMatchObject({ version: 1, packageVersion: "2.0.0" });
        const updated = (await screen.findByText("Acme X")).closest("tr") as HTMLElement;
        expect(within(updated).queryByText("Uploaded")).not.toBeInTheDocument();
    });

    it("offers the registry version even when the registry names no latest one", async () => {
        const lookup = { package: { name: "@acme/x-plugin", versions: ["1.2.3"] }, selected: {} };
        mockApi({ plugins: [uploadedRow], extra: (url) => (url.startsWith("/api/system/plugins/registry?") ? jsonResponse(200, lookup) : undefined) });
        const user = userEvent.setup();
        renderPage();
        const row = (await screen.findByText("Acme X")).closest("tr") as HTMLElement;
        await user.click(within(row).getByRole("button", { name: "Install the registry version" }));
        const dialog = await screen.findByRole("dialog", { name: "Install the registry version of Acme X" });
        await within(dialog).findByLabelText("Version");
        expect(within(dialog).getByRole("button", { name: "Install" })).toBeEnabled();
    });
});
