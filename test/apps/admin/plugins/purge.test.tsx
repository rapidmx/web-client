// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Uninstalling a plugin together with its data: the confirmation dialog (the checkbox, the typed name, the danger button,
// what it says will be deleted), the state of each deletion in the plugin list, retrying, and the notifications.
import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../../testUtils.js";
import PluginsPage from "../../../../apps/admin/plugins/index.js";
import { getNotificationsSnapshot } from "../../../../apps/shared/notifications/store.js";

const eas = {
    uid: "p-eas",
    version: 3,
    name: "@rapidmx/activesync",
    packageVersion: "1.0.0",
    enabled: true,
    settings: {},
    manifest: { apiVersion: 1, displayName: "Exchange ActiveSync", settings: [] },
};
const mapi = { ...eas, uid: "p-mapi", name: "@rapidmx/mapi", enabled: false, manifest: { apiVersion: 1, displayName: "MAPI over HTTP", settings: [] } };

const instance = (overrides: Record<string, unknown> = {}) => ({
    instance: "pod-a",
    hash: "current",
    loaded: [{ name: "@rapidmx/activesync", version: "1.0.0" }],
    errors: [],
    safeMode: false,
    updatedAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
});

const purgeOf = (overrides: Record<string, unknown> = {}) => ({
    uid: "u-mapi",
    name: "@rapidmx/mapi",
    displayName: "MAPI over HTTP",
    state: "pending",
    requestedBy: "admin-1",
    requestedAt: "2026-09-21T10:00:00.000Z",
    steps: [],
    ...overrides,
});

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

interface Options {
    plugins?: unknown[];
    /** The status body, or a function giving it for each read. */
    status?: unknown | (() => unknown);
    extra?: Handler;
}

function mockApi(options: Options = {}) {
    return mockFetch((url, init) => {
        const custom = options.extra?.(url, init);
        if (custom) return custom;
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        if (url === "/api/system/plugins/status") {
            const status = typeof options.status === "function" ? (options.status as () => unknown)() : options.status;
            return jsonResponse(200, status ?? { hash: "current", instances: [instance()] });
        }
        if (url === "/api/system/plugins/updates") return jsonResponse(200, []);
        if (url.startsWith("/api/system/plugins/plan?")) {
            const query = new URLSearchParams(url.split("?")[1]);
            return jsonResponse(200, { plugin: { name: query.get("name"), version: query.get("packageVersion") }, install: [], enable: [], conflicts: [] });
        }
        if (url === "/api/system/plugins" && (init?.method ?? "GET") === "GET") return jsonResponse(200, options.plugins ?? [eas, mapi]);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

const renderPage = () => render(<PluginsPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

const openUninstall = async (user: ReturnType<typeof userEvent.setup>, displayName: string = "MAPI over HTTP") => {
    const row = (await screen.findByText(displayName)).closest("tr") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Uninstall" }));
    return screen.findByRole("dialog", { name: `Uninstall ${displayName}?` });
};

const toasts = () => getNotificationsSnapshot().visible;

describe("the uninstall dialog", () => {
    it("offers to delete the data, unchecked, saying exactly what would be deleted and that it can't be undone", async () => {
        mockApi({ extra: (url, init) => (url === "/api/system/plugins/p-mapi" && init?.method === "DELETE" ? emptyResponse(204) : undefined) });
        const user = userEvent.setup();
        renderPage();
        const dialog = await openUninstall(user);

        const checkbox = within(dialog).getByRole("checkbox", { name: "Also delete all data this plugin stored" });
        expect(checkbox).not.toBeChecked();
        // The description is what the checkbox is described by, so a screen reader reads it with the checkbox.
        expect(checkbox).toHaveAccessibleDescription(/What is deleted:/);
        expect(checkbox).toHaveAccessibleDescription(/the database collections and tables the plugin.s features use/);
        expect(checkbox).toHaveAccessibleDescription(/saved settings/);
        expect(checkbox).toHaveAccessibleDescription(/its downloaded package and cached pages on the servers/);
        expect(checkbox).toHaveAccessibleDescription(/files it stored or data kept outside the database/);
        expect(checkbox).toHaveAccessibleDescription(/This can.t be undone\./);
        expect(within(dialog).getByText(/This can.t be undone\./)).toHaveClass("text-danger");
        // The plain uninstall keeps its wording and its primary button, and has no name to type.
        expect(within(dialog).getByText(/Data it stored stays in the database/)).toBeInTheDocument();
        expect(within(dialog).queryByLabelText(/to confirm/)).not.toBeInTheDocument();
        const confirm = within(dialog).getByRole("button", { name: "Uninstall" });
        expect(confirm).toBeEnabled();
        expect(confirm).not.toHaveClass("!bg-danger");
    });

    it("uninstalls as before when the box is left unchecked: no body is sent, nothing is announced", async () => {
        const fetchMock = mockApi({ extra: (url, init) => (url === "/api/system/plugins/p-mapi" && init?.method === "DELETE" ? emptyResponse(204) : undefined) });
        const user = userEvent.setup();
        renderPage();
        const dialog = await openUninstall(user);
        await user.click(within(dialog).getByRole("button", { name: "Uninstall" }));
        await waitFor(() => expect(screen.queryByText("MAPI over HTTP")).not.toBeInTheDocument());
        const call = fetchMock.mock.calls.find((c) => c[0] === "/api/system/plugins/p-mapi" && (c[1] as RequestInit).method === "DELETE")!;
        expect((call[1] as RequestInit).body).toBeUndefined();
        expect(toasts()).toEqual([]);
        expect(screen.queryByText(/Uninstalled - data will be deleted/)).not.toBeInTheDocument();
    });

    it("turns the button red and asks for the plugin's name once the box is checked, and back when it is unchecked", async () => {
        mockApi();
        const user = userEvent.setup();
        renderPage();
        const dialog = await openUninstall(user);
        await user.click(within(dialog).getByRole("checkbox", { name: "Also delete all data this plugin stored" }));

        const confirm = within(dialog).getByRole("button", { name: "Uninstall and delete data" });
        expect(confirm).toBeDisabled();
        expect(confirm).toHaveClass("!bg-danger", "!border-danger");
        expect(within(dialog).getByText(/all the data it stored is deleted/)).toBeInTheDocument();
        expect(within(dialog).queryByText(/Data it stored stays in the database/)).not.toBeInTheDocument();
        // When it happens, and how to stop it.
        expect(within(dialog).getByText(/Nothing is deleted while a server is still running the plugin/)).toBeInTheDocument();
        expect(within(dialog).getByText(/Adding the plugin again before then cancels the deletion/)).toBeInTheDocument();

        const name = within(dialog).getByLabelText("Type MAPI over HTTP to confirm");
        expect(name).toHaveAttribute("autocomplete", "off");
        await user.type(name, "MAPI");
        expect(confirm).toBeDisabled();
        await user.clear(name);
        await user.type(name, "  mapi over http ");
        expect(confirm).toBeEnabled();

        await user.click(within(dialog).getByRole("checkbox", { name: "Also delete all data this plugin stored" }));
        expect(within(dialog).queryByLabelText(/to confirm/)).not.toBeInTheDocument();
        const plain = within(dialog).getByRole("button", { name: "Uninstall" });
        expect(plain).toBeEnabled();
        expect(plain).not.toHaveClass("!bg-danger");
    });

    it("sends purgeData, then lists the plugin as uninstalled with its data to be deleted and says so", async () => {
        let deleted = false;
        const fetchMock = mockApi({
            // The status the servers report once the plugin is uninstalled includes its deletion.
            status: () => ({ hash: "current", instances: [instance()], purges: deleted ? [purgeOf({ serversRunning: 1, serversTotal: 2 })] : [] }),
            extra: (url, init) => {
                if (url === "/api/system/plugins/p-mapi" && init?.method === "DELETE") {
                    deleted = true;
                    return jsonResponse(200, { purgeScheduled: true, purge: purgeOf({ serversRunning: 1, serversTotal: 2 }) });
                }
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        const dialog = await openUninstall(user);
        await user.click(within(dialog).getByRole("checkbox", { name: "Also delete all data this plugin stored" }));
        await user.type(within(dialog).getByLabelText(/to confirm/), "MAPI over HTTP");
        await user.click(within(dialog).getByRole("button", { name: "Uninstall and delete data" }));

        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        const call = fetchMock.mock.calls.find((c) => c[0] === "/api/system/plugins/p-mapi" && (c[1] as RequestInit).method === "DELETE")!;
        expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ purgeData: true });

        const row = screen.getByText("Uninstalled - data will be deleted after servers restart").closest("tr") as HTMLElement;
        expect(within(row).getByText("MAPI over HTTP")).toBeInTheDocument();
        expect(within(row).getByText("@rapidmx/mapi")).toBeInTheDocument();
        expect(within(row).getByText("Uninstalled")).toBeInTheDocument();
        expect(within(row).getByText("1 of 2 servers still running it")).toBeInTheDocument();
        // Nothing to retry, but the plugin can be installed again.
        expect(within(row).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Install MAPI over HTTP"]);
        // The other plugin's row is untouched.
        expect(screen.getByRole("button", { name: "Disable Exchange ActiveSync" })).toBeInTheDocument();
        expect(toasts()).toEqual([expect.objectContaining({ kind: "info", title: "MAPI over HTTP uninstalled", message: expect.stringContaining("deleted once every server has stopped running it") })]);
    });

    it("submits with Enter from the name field once the name matches", async () => {
        const fetchMock = mockApi({
            extra: (url, init) => (url === "/api/system/plugins/p-mapi" && init?.method === "DELETE" ? jsonResponse(200, { purgeScheduled: true }) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        const dialog = await openUninstall(user);
        await user.click(within(dialog).getByRole("checkbox", { name: "Also delete all data this plugin stored" }));
        await user.type(within(dialog).getByLabelText(/to confirm/), "MAPI over HTTP{Enter}");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "DELETE")).toBe(true);
    });

    it("copes with a server that says a deletion is scheduled without describing it, and with no status to add it to", async () => {
        mockApi({
            status: () => {
                throw new Error("status unavailable");
            },
            extra: (url, init) => (url === "/api/system/plugins/p-mapi" && init?.method === "DELETE" ? jsonResponse(200, { purgeScheduled: true }) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        const dialog = await openUninstall(user);
        await user.click(within(dialog).getByRole("checkbox", { name: "Also delete all data this plugin stored" }));
        await user.type(within(dialog).getByLabelText(/to confirm/), "MAPI over HTTP");
        await user.click(within(dialog).getByRole("button", { name: "Uninstall and delete data" }));
        await waitFor(() => expect(screen.queryByText("MAPI over HTTP")).not.toBeInTheDocument());
        expect(toasts()[0]).toEqual(expect.objectContaining({ title: "MAPI over HTTP uninstalled" }));
    });

    it("lists the new deletion next to one that is already listed, replacing an older one for the same plugin", async () => {
        let deleted = false;
        mockApi({
            status: () => ({
                hash: "current",
                instances: [instance()],
                purges: [
                    purgeOf({ uid: "u-old", name: "@rapidmx/old", displayName: "Old plugin", state: "done", completedAt: "2026-09-01T10:00:00.000Z" }),
                    ...(deleted ? [purgeOf({ serversRunning: 1, serversTotal: 1 })] : []),
                ],
            }),
            extra: (url, init) => {
                if (url === "/api/system/plugins/p-mapi" && init?.method === "DELETE") {
                    deleted = true;
                    return jsonResponse(200, { purgeScheduled: true, purge: purgeOf({ serversRunning: 1, serversTotal: 1 }) });
                }
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        expect(await screen.findByText("Old plugin")).toBeInTheDocument();
        const dialog = await openUninstall(user);
        await user.click(within(dialog).getByRole("checkbox", { name: "Also delete all data this plugin stored" }));
        await user.type(within(dialog).getByLabelText(/to confirm/), "MAPI over HTTP");
        await user.click(within(dialog).getByRole("button", { name: "Uninstall and delete data" }));
        expect(await screen.findByText("Uninstalled - data will be deleted after servers restart")).toBeInTheDocument();
        expect(screen.getByText("Old plugin")).toBeInTheDocument();
        expect(screen.getAllByText("Uninstalled")).toHaveLength(2);
    });

    it("adds the deletion to a status that has no list of them yet, as an older server's has none", async () => {
        mockApi({
            status: { hash: "current", instances: [instance()] },
            extra: (url, init) => (url === "/api/system/plugins/p-mapi" && init?.method === "DELETE" ? jsonResponse(200, { purgeScheduled: true, purge: purgeOf() }) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        const dialog = await openUninstall(user);
        await user.click(within(dialog).getByRole("checkbox", { name: "Also delete all data this plugin stored" }));
        await user.type(within(dialog).getByLabelText(/to confirm/), "MAPI over HTTP");
        await user.click(within(dialog).getByRole("button", { name: "Uninstall and delete data" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(toasts()[0]).toEqual(expect.objectContaining({ title: "MAPI over HTTP uninstalled" }));
    });

    it("says why it needs the administrator to confirm their identity, and keeps the dialog", async () => {
        mockApi({
            extra: (url, init) =>
                url === "/api/system/plugins/p-mapi" && init?.method === "DELETE" ? jsonResponse(403, { code: "api-104", message: "Elevation required" }) : undefined,
        });
        const user = userEvent.setup();
        renderPage();
        const dialog = await openUninstall(user);
        await user.click(within(dialog).getByRole("checkbox", { name: "Also delete all data this plugin stored" }));
        await user.type(within(dialog).getByLabelText(/to confirm/), "MAPI over HTTP");
        await user.click(within(dialog).getByRole("button", { name: "Uninstall and delete data" }));

        expect(await within(dialog).findByText(/needs you to have recently confirmed your identity/)).toBeInTheDocument();
        expect(within(dialog).queryByText("Elevation required")).not.toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Uninstall and delete data" })).toBeEnabled();
        expect(screen.getByText("MAPI over HTTP", { selector: ".font-semibold" })).toBeInTheDocument();
    });

    it("shows any other failure as it was reported", async () => {
        mockApi({
            extra: (url, init) => (url === "/api/system/plugins/p-mapi" && init?.method === "DELETE" ? jsonResponse(409, { message: "Autodiscover requires MAPI over HTTP" }) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        const dialog = await openUninstall(user);
        await user.click(within(dialog).getByRole("button", { name: "Uninstall" }));
        expect(await within(dialog).findByRole("alert")).toHaveTextContent("Autodiscover requires MAPI over HTTP");
    });

    it("disables everything while the request is under way", async () => {
        let release: () => void = () => undefined;
        mockApi({
            extra: (url, init) =>
                url === "/api/system/plugins/p-mapi" && init?.method === "DELETE"
                    ? new Promise<Response>((resolve) => (release = () => resolve(emptyResponse(204))))
                    : undefined,
        });
        const user = userEvent.setup();
        renderPage();
        const dialog = await openUninstall(user);
        await user.click(within(dialog).getByRole("checkbox", { name: "Also delete all data this plugin stored" }));
        const name = within(dialog).getByLabelText(/to confirm/);
        await user.type(name, "MAPI over HTTP");
        await user.click(within(dialog).getByRole("button", { name: "Uninstall and delete data" }));

        await waitFor(() => expect(within(dialog).getByRole("checkbox")).toBeDisabled());
        expect(name).toBeDisabled();
        expect(within(dialog).getByRole("button", { name: "Uninstall and delete data" })).toBeDisabled();
        release();
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("keeps focus inside, reaches the checkbox and the name by keyboard, and closes with Escape", async () => {
        mockApi();
        const user = userEvent.setup();
        renderPage();
        const dialog = await openUninstall(user);
        await user.tab();
        const focused = document.activeElement as HTMLElement;
        expect(dialog).toContainElement(focused);
        await user.tab();
        await user.tab();
        await user.tab();
        await user.tab();
        expect(dialog).toContainElement(document.activeElement as HTMLElement);
        // Space toggles the checkbox, which reveals the name field in the tab order.
        within(dialog).getByRole("checkbox").focus();
        await user.keyboard(" ");
        expect(within(dialog).getByRole("checkbox")).toBeChecked();
        await user.tab();
        expect(within(dialog).getByLabelText(/to confirm/)).toHaveFocus();
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
});

describe("the list of uninstalled plugins", () => {
    const withPurges = (...purges: unknown[]) => ({ hash: "current", instances: [instance()], purges });

    it("says the data will be deleted after the servers restart, and how many still run the plugin", async () => {
        mockApi({ plugins: [eas], status: withPurges(purgeOf({ serversRunning: 1, serversTotal: 1 })) });
        renderPage();
        const row = (await screen.findByText("Uninstalled - data will be deleted after servers restart")).closest("tr") as HTMLElement;
        expect(within(row).getByText("1 of 1 server still running it")).toBeInTheDocument();
    });

    it("shows no count when no server runs it, and names a plugin by its package when the display name wasn't kept", async () => {
        mockApi({ plugins: [eas], status: withPurges(purgeOf({ serversRunning: 0, serversTotal: 2, displayName: undefined })) });
        renderPage();
        const row = (await screen.findByText("Uninstalled - data will be deleted after servers restart")).closest("tr") as HTMLElement;
        expect(within(row).queryByText(/still running it/)).not.toBeInTheDocument();
        expect(within(row).getAllByText("@rapidmx/mapi")).toHaveLength(2);
    });

    it("says the data is being deleted", async () => {
        mockApi({ plugins: [eas], status: withPurges(purgeOf({ state: "running" })) });
        renderPage();
        expect(await screen.findByText("Uninstalled - deleting its data now")).toBeInTheDocument();
    });

    it("says when the data was deleted", async () => {
        mockApi({ plugins: [eas], status: withPurges(purgeOf({ state: "done", completedAt: "2026-09-20T10:00:00.000Z" })) });
        renderPage();
        const date = new Date("2026-09-20T10:00:00.000Z").toLocaleDateString(undefined, { dateStyle: "medium" });
        expect(await screen.findByText(`Data deleted ${date}`)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    });

    it("says the data was deleted even when no date was recorded", async () => {
        mockApi({ plugins: [eas], status: withPurges(purgeOf({ state: "done" })) });
        renderPage();
        expect(await screen.findByText("Data deleted")).toBeInTheDocument();
    });

    it("says why the deletion failed, which steps did, and offers a retry", async () => {
        mockApi({
            plugins: [eas],
            status: withPurges(
                purgeOf({
                    state: "failed",
                    error: "2 of 4 steps failed. hook: the bucket is unreachable",
                    steps: [
                        { step: "hook", ok: false, error: "the bucket is unreachable" },
                        { step: "data:sql:notes", ok: true, count: 3 },
                        { step: "files", ok: false },
                    ],
                }),
            ),
        });
        renderPage();
        const row = (await screen.findByText("Data deletion failed: 2 of 4 steps failed. hook: the bucket is unreachable")).closest("tr") as HTMLElement;
        expect(within(row).getByText("hook: the bucket is unreachable")).toBeInTheDocument();
        expect(within(row).getByText("files: failed")).toBeInTheDocument();
        expect(within(row).queryByText(/data:sql:notes/)).not.toBeInTheDocument();
        expect(within(row).getByRole("button", { name: "Retry deleting the data of MAPI over HTTP" })).toBeEnabled();
    });

    it("works out the reason from the failed steps, or admits it wasn't recorded", async () => {
        mockApi({
            plugins: [eas],
            status: withPurges(
                purgeOf({ state: "failed", steps: [{ step: "hook", ok: false, error: "boom" }, { step: "files", ok: false }] }),
                purgeOf({ uid: "u-other", name: "@rapidmx/other", displayName: "Other", state: "failed", steps: [] }),
            ),
        });
        renderPage();
        expect(await screen.findByText("Data deletion failed: boom; files")).toBeInTheDocument();
        expect(screen.getByText("Data deletion failed: The reason wasn't recorded.")).toBeInTheDocument();
        // No failed step to list for the second.
        const other = screen.getByText("Other").closest("tr") as HTMLElement;
        expect(within(other).queryByRole("list")).not.toBeInTheDocument();
    });

    it("leaves a plugin that is installed alone, whatever the server lists about its old deletion", async () => {
        mockApi({ plugins: [eas, mapi], status: withPurges(purgeOf({ state: "failed", error: "boom" })) });
        renderPage();
        expect(await screen.findByText("MAPI over HTTP")).toBeInTheDocument();
        expect(screen.getAllByText("MAPI over HTTP")).toHaveLength(1);
        expect(screen.queryByText(/Data deletion failed/)).not.toBeInTheDocument();
        expect(screen.queryByText("Uninstalled")).not.toBeInTheDocument();
    });

    it("lists uninstalled plugins even when none is installed", async () => {
        mockApi({ plugins: [], status: withPurges(purgeOf()) });
        renderPage();
        expect(await screen.findByText("Uninstalled - data will be deleted after servers restart")).toBeInTheDocument();
        expect(screen.queryByText("No plugins installed.")).not.toBeInTheDocument();
    });

    it("still says there are none installed when there is nothing to list either", async () => {
        mockApi({ plugins: [], status: { hash: "current", instances: [instance()], purges: [] } });
        renderPage();
        expect(await screen.findByText("No plugins installed.")).toBeInTheDocument();
    });
});

describe("retrying a failed deletion", () => {
    const failed = (extra: Record<string, unknown> = {}) => ({ hash: "current", instances: [instance()], purges: [purgeOf({ state: "failed", error: "boom", steps: [{ step: "hook", ok: false, error: "boom" }], ...extra })] });

    it("asks the server to retry, and shows what the servers report next", async () => {
        let retried = false;
        const fetchMock = mockApi({
            plugins: [eas],
            status: () => (retried ? { hash: "current", instances: [instance()], purges: [purgeOf({ state: "running" })] } : failed()),
            extra: (url, init) => {
                if (url === "/api/system/plugins/purges/u-mapi/retry" && init?.method === "POST") {
                    retried = true;
                    return jsonResponse(200, purgeOf());
                }
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Retry deleting the data of MAPI over HTTP" }));
        expect(await screen.findByText("Uninstalled - deleting its data now")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/plugins/purges/u-mapi/retry", expect.objectContaining({ method: "POST" }));
        expect(screen.queryByText(/Data deletion failed/)).not.toBeInTheDocument();
    });

    it("keeps the button busy while the request is under way", async () => {
        let release: () => void = () => undefined;
        mockApi({
            plugins: [eas],
            status: failed(),
            extra: (url, init) =>
                url === "/api/system/plugins/purges/u-mapi/retry" && init?.method === "POST"
                    ? new Promise<Response>((resolve) => (release = () => resolve(jsonResponse(200, purgeOf()))))
                    : undefined,
        });
        const user = userEvent.setup();
        renderPage();
        const button = await screen.findByRole("button", { name: "Retry deleting the data of MAPI over HTTP" });
        await user.click(button);
        await waitFor(() => expect(button).toBeDisabled());
        release();
        await waitFor(() => expect(button).toBeEnabled());
    });

    it("shows why a retry was refused", async () => {
        mockApi({
            plugins: [eas],
            status: failed(),
            extra: (url) => (url.endsWith("/retry") ? jsonResponse(409, { message: "Only a data deletion that failed can be retried." }) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Retry deleting the data of MAPI over HTTP" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Only a data deletion that failed can be retried.");
    });

    it("asks for a recent identity confirmation when the server does", async () => {
        mockApi({
            plugins: [eas],
            status: failed(),
            extra: (url) => (url.endsWith("/retry") ? jsonResponse(403, { code: "api-104", message: "Elevation required" }) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Retry deleting the data of MAPI over HTTP" }));
        expect(await screen.findByRole("alert")).toHaveTextContent(/needs you to have recently confirmed your identity/);
    });

    it("says it couldn't retry when the request itself failed", async () => {
        mockApi({
            plugins: [eas],
            status: failed(),
            extra: (url) => {
                if (url.endsWith("/retry")) throw new TypeError("network down");
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Retry deleting the data of MAPI over HTTP" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Could not retry deleting MAPI over HTTP's data.");
    });
});

describe("following a deletion", () => {
    it("keeps reading the status while a deletion is waiting, then tells the administrator it was deleted", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        let reads = 0;
        mockApi({
            plugins: [eas],
            status: () => {
                reads++;
                return { hash: "current", instances: [instance()], purges: [purgeOf({ state: reads >= 3 ? "done" : reads === 2 ? "running" : "pending", completedAt: "2026-09-21T11:00:00.000Z" })] };
            },
        });
        renderPage();
        expect(await screen.findByText("Uninstalled - data will be deleted after servers restart")).toBeInTheDocument();
        // No notification for the deletion that was already under way when the page opened.
        expect(toasts()).toEqual([]);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5000);
        });
        expect(await screen.findByText("Uninstalled - deleting its data now")).toBeInTheDocument();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5000);
        });
        expect(await screen.findByText(/^Data deleted /)).toBeInTheDocument();
        expect(toasts()).toEqual([expect.objectContaining({ kind: "success", title: "MAPI over HTTP's data was deleted" })]);
        const readsWhenDone = reads;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000);
        });
        // Nothing left to wait for: it stopped polling (the servers all match the plugin set).
        expect(reads).toBe(readsWhenDone);
        // Raised once (the pop-up has gone by now; the history keeps it).
        expect(getNotificationsSnapshot().history).toEqual([expect.objectContaining({ kind: "success", title: "MAPI over HTTP's data was deleted", count: 1 })]);
    });

    it("tells the administrator when a deletion that was under way failed, and why", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        let reads = 0;
        mockApi({
            plugins: [eas],
            status: () => {
                reads++;
                return {
                    hash: "current",
                    instances: [instance()],
                    purges: [purgeOf(reads >= 2 ? { state: "failed", error: "1 of 3 steps failed. hook: boom" } : { state: "running" })],
                };
            },
        });
        renderPage();
        expect(await screen.findByText("Uninstalled - deleting its data now")).toBeInTheDocument();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5000);
        });
        expect(await screen.findByText("Data deletion failed: 1 of 3 steps failed. hook: boom")).toBeInTheDocument();
        expect(toasts()).toEqual([expect.objectContaining({ kind: "error", title: "Deleting MAPI over HTTP's data failed", message: "1 of 3 steps failed. hook: boom" })]);
    });

    it("stays quiet about a deletion that is already over when the page opens, and one that is only still waiting", async () => {
        mockApi({
            plugins: [eas],
            status: {
                hash: "current",
                instances: [instance()],
                purges: [purgeOf({ state: "done", completedAt: "2026-09-19T11:00:00.000Z" }), purgeOf({ uid: "u-2", name: "@rapidmx/two", displayName: "Two", state: "failed", error: "boom" })],
            },
        });
        renderPage();
        expect(await screen.findByText("Two")).toBeInTheDocument();
        expect(toasts()).toEqual([]);
    });

    it("warns when adding a plugin cancels the deletion of its data that was waiting", async () => {
        const fetchMock = mockApi({
            plugins: [eas],
            status: { hash: "current", instances: [instance()], purges: [purgeOf({ serversRunning: 1, serversTotal: 1 })] },
            extra: (url, init) => {
                if (url === "/api/system/plugins/registry?name=%40rapidmx%2Fmapi") {
                    return jsonResponse(200, {
                        package: { name: "@rapidmx/mapi", latest: "1.0.0", versions: ["1.0.0"] },
                        selected: { name: "@rapidmx/mapi", version: "1.0.0", peerDependencies: {}, manifest: { apiVersion: 1, displayName: "MAPI over HTTP" } },
                    });
                }
                if (url === "/api/system/plugins" && init?.method === "POST") {
                    return jsonResponse(200, {
                        plugin: mapi,
                        dependencies: [],
                        purgeCancelled: ["@rapidmx/mapi"],
                        warnings: ["The pending deletion of MAPI over HTTP's data was cancelled because the plugin was added again. Its data is kept."],
                    });
                }
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        expect(await screen.findByText("Uninstalled - data will be deleted after servers restart")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Add by name" }));
        const dialog = await screen.findByRole("dialog");
        await user.type(within(dialog).getByLabelText("Package name"), "@rapidmx/mapi");
        await user.click(within(dialog).getByRole("button", { name: "Find" }));
        await user.click(await within(dialog).findByRole("button", { name: "Add plugin" }));

        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(fetchMock.mock.calls.some((c) => c[0] === "/api/system/plugins" && (c[1] as RequestInit)?.method === "POST")).toBe(true);
        expect(toasts()).toEqual([expect.objectContaining({ kind: "warning", title: "Data deletion cancelled", message: expect.stringContaining("was cancelled because the plugin was added again") })]);
        // It is installed again, so the uninstalled entry is gone.
        expect(screen.queryByText("Uninstalled - data will be deleted after servers restart")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Enable MAPI over HTTP" })).toBeInTheDocument();
    });

    describe("installing an uninstalled plugin again from its row", () => {
        const planLatest = (url: string) =>
            url === "/api/system/plugins/plan?name=%40rapidmx%2Fmapi"
                ? jsonResponse(200, { plugin: { name: "@rapidmx/mapi", version: "1.2.0" }, install: [], enable: [], conflicts: [] })
                : undefined;

        it.each(["pending", "done", "failed"])("offers Install for a plugin whose data deletion is %s, at its latest version", async (state) => {
            const fetchMock = mockApi({
                plugins: [eas],
                status: { hash: "current", instances: [instance()], purges: [purgeOf({ state, error: state === "failed" ? "boom" : undefined })] },
                extra: (url, init) => {
                    if (url === "/api/system/plugins" && init?.method === "POST") {
                        return jsonResponse(200, { plugin: mapi, dependencies: [], warnings: state === "pending" ? ["Its data is kept."] : [] });
                    }
                    return planLatest(url);
                },
            });
            const user = userEvent.setup();
            renderPage();
            await user.click(await screen.findByRole("button", { name: "Install MAPI over HTTP" }));

            await waitFor(() => expect(screen.getByRole("button", { name: "Enable MAPI over HTTP" })).toBeInTheDocument());
            const post = fetchMock.mock.calls.find((c) => c[0] === "/api/system/plugins" && (c[1] as RequestInit)?.method === "POST")!;
            expect(JSON.parse((post[1] as RequestInit).body as string)).toMatchObject({ name: "@rapidmx/mapi", packageVersion: "1.2.0" });
            // It is installed again, so the uninstalled entry is gone.
            expect(screen.queryByRole("button", { name: "Install MAPI over HTTP" })).not.toBeInTheDocument();
        });

        it("can't be pressed while the data is being deleted", async () => {
            mockApi({ plugins: [eas], status: { hash: "current", instances: [instance()], purges: [purgeOf({ state: "running" })] } });
            renderPage();
            expect(await screen.findByRole("button", { name: "Install MAPI over HTTP" })).toBeDisabled();
        });

        it("shows why it couldn't be installed", async () => {
            mockApi({
                plugins: [eas],
                status: { hash: "current", instances: [instance()], purges: [purgeOf({ state: "done" })] },
                extra: (url, init) => {
                    if (url === "/api/system/plugins" && init?.method === "POST") {
                        return jsonResponse(409, { message: "The data of @rapidmx/mapi is being deleted right now. Try again when that has finished." });
                    }
                    return planLatest(url);
                },
            });
            const user = userEvent.setup();
            renderPage();
            await user.click(await screen.findByRole("button", { name: "Install MAPI over HTTP" }));
            expect(await screen.findByText(/is being deleted right now/)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Install MAPI over HTTP" })).toBeEnabled();
        });

        it("shows why the latest version couldn't be found", async () => {
            mockApi({
                plugins: [eas],
                status: { hash: "current", instances: [instance()], purges: [purgeOf({ state: "done" })] },
                extra: (url) => (url.startsWith("/api/system/plugins/plan?") ? jsonResponse(502, { message: "The plugin registry is unreachable." }) : undefined),
            });
            const user = userEvent.setup();
            renderPage();
            await user.click(await screen.findByRole("button", { name: "Install MAPI over HTTP" }));
            expect(await screen.findByText("The plugin registry is unreachable.")).toBeInTheDocument();
        });
    });

    it("says nothing extra when adding a plugin cancels nothing", async () => {
        mockApi({
            plugins: [eas],
            extra: (url, init) => {
                if (url === "/api/system/plugins/registry?name=%40rapidmx%2Fmapi") {
                    return jsonResponse(200, {
                        package: { name: "@rapidmx/mapi", latest: "1.0.0", versions: ["1.0.0"] },
                        selected: { name: "@rapidmx/mapi", version: "1.0.0", peerDependencies: {}, manifest: { apiVersion: 1, displayName: "MAPI over HTTP" } },
                    });
                }
                if (url === "/api/system/plugins" && init?.method === "POST") return jsonResponse(200, { plugin: mapi, dependencies: [] });
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Add by name" }));
        const dialog = await screen.findByRole("dialog");
        await user.type(within(dialog).getByLabelText("Package name"), "@rapidmx/mapi");
        await user.click(within(dialog).getByRole("button", { name: "Find" }));
        await user.click(await within(dialog).findByRole("button", { name: "Add plugin" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(toasts()).toEqual([]);
    });
});
