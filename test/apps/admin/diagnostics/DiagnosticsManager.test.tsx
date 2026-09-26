// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import DiagnosticsManager from "../../../../apps/shared/components/admin/diagnostics/DiagnosticsManager.js";
import { ELEVATION_MESSAGE } from "../../../../apps/shared/components/admin/diagnostics/format.js";
import type { LogSocket } from "../../../../apps/shared/components/admin/diagnostics/logClient.js";
import { metricsSample, runtimeFixture, versionsFixture } from "./fixtures.js";

class FakeSocket implements LogSocket {
    static instances: FakeSocket[] = [];
    readyState = 1;
    onopen: LogSocket["onopen"] = null;
    onmessage: LogSocket["onmessage"] = null;
    onclose: LogSocket["onclose"] = null;
    onerror: LogSocket["onerror"] = null;
    closed = false;
    constructor(readonly url: string) {
        FakeSocket.instances.push(this);
    }
    close() {
        this.closed = true;
    }
}

const createLogSocket = (url: string) => new FakeSocket(url);
const socket = () => FakeSocket.instances[FakeSocket.instances.length - 1];
const receive = (data: string) => act(() => socket().onmessage?.({ data }));

const plugin = {
    uid: "p1",
    version: 1,
    name: "@rapidmx/mapi",
    packageVersion: "1.1.0",
    enabled: true,
    settings: { apiKey: "top secret" },
    manifest: { apiVersion: 1, displayName: "MAPI", settings: [] },
};

interface Options {
    versions?: () => Response;
    runtime?: () => Response;
    metrics?: () => Response;
    plugins?: () => Response;
}

function mockApi(options: Options = {}) {
    return mockFetch((url) => {
        switch (url) {
            case "/api/admin/diagnostics/versions":
                return options.versions?.() ?? jsonResponse(200, versionsFixture());
            case "/api/admin/diagnostics/runtime":
                return options.runtime?.() ?? jsonResponse(200, runtimeFixture());
            case "/api/admin/diagnostics/metrics":
                return options.metrics?.() ?? jsonResponse(200, metricsSample());
            case "/api/system/plugins":
                return options.plugins?.() ?? jsonResponse(200, [plugin]);
            case "/api/system/plugins/status":
                return jsonResponse(200, { hash: "h", instances: [] });
            default:
                throw new Error(`unexpected ${url}`);
        }
    });
}

const calls = (fetchMock: ReturnType<typeof mockFetch>, url: string) => fetchMock.mock.calls.filter((call) => call[0] === url).length;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    FakeSocket.instances = [];
});

describe("DiagnosticsManager", () => {
    it("opens on Versions and reads versions, runtime and plugins once", async () => {
        const fetchMock = mockApi();
        const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
        render(<DiagnosticsManager createLogSocket={createLogSocket} saveFile={vi.fn()} />);
        expect(screen.getByRole("heading", { level: 1, name: "Diagnostics" })).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: "Versions" })).toHaveAttribute("aria-selected", "true");
        expect(await screen.findByRole("region", { name: "Server" })).toBeInTheDocument();
        expect(await screen.findByText("MAPI")).toBeInTheDocument();
        expect(calls(fetchMock, "/api/admin/diagnostics/versions")).toBe(1);
        expect(calls(fetchMock, "/api/admin/diagnostics/runtime")).toBe(1);
        expect(calls(fetchMock, "/api/system/plugins")).toBe(1);
        // Versions and Runtime are never polled, and nothing else is running on this tab.
        expect(setIntervalSpy.mock.calls.some((call) => call[1] === 5000)).toBe(false);
        expect(calls(fetchMock, "/api/admin/diagnostics/metrics")).toBe(0);
        expect(FakeSocket.instances).toHaveLength(0);
    });

    it("shows the runtime on its tab, without asking again", async () => {
        const user = userEvent.setup();
        const fetchMock = mockApi();
        render(<DiagnosticsManager createLogSocket={createLogSocket} saveFile={vi.fn()} />);
        await screen.findByRole("region", { name: "Server" });
        await user.click(screen.getByRole("tab", { name: "Runtime" }));
        expect(await screen.findByRole("region", { name: "Kubernetes" })).toBeInTheDocument();
        expect(screen.getByText("v1.33.1+k3s1")).toBeInTheDocument();
        expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "diagnostics-tab-runtime");
        expect(calls(fetchMock, "/api/admin/diagnostics/runtime")).toBe(1);
    });

    it("reads everything again on Refresh, and only then", async () => {
        const user = userEvent.setup();
        let uptime = 100;
        const fetchMock = mockApi({ versions: () => jsonResponse(200, versionsFixture({ server: { ...versionsFixture().server, uptimeSeconds: uptime } })) });
        render(<DiagnosticsManager createLogSocket={createLogSocket} saveFile={vi.fn()} />);
        expect(await screen.findByText("1m 40s")).toBeInTheDocument();
        uptime = 200;
        await user.click(screen.getByRole("button", { name: "Refresh" }));
        expect(await screen.findByText("3m 20s")).toBeInTheDocument();
        expect(calls(fetchMock, "/api/admin/diagnostics/versions")).toBe(2);
        expect(calls(fetchMock, "/api/admin/diagnostics/runtime")).toBe(2);
        expect(calls(fetchMock, "/api/system/plugins")).toBe(2);
    });

    it("disables Refresh while it is reading", async () => {
        const user = userEvent.setup();
        mockApi();
        render(<DiagnosticsManager createLogSocket={createLogSocket} saveFile={vi.fn()} />);
        expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
        await screen.findByRole("region", { name: "Server" });
        await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
        await user.click(screen.getByRole("button", { name: "Refresh" }));
    });

    it("says elevation is needed, on the tab that failed", async () => {
        const user = userEvent.setup();
        mockApi({
            versions: () => jsonResponse(403, { code: "api-104", message: "Requires elevation." }),
            runtime: () => jsonResponse(403, { code: "api-104", message: "Requires elevation." }),
        });
        render(<DiagnosticsManager createLogSocket={createLogSocket} saveFile={vi.fn()} />);
        expect(await screen.findByText(ELEVATION_MESSAGE)).toBeInTheDocument();
        await user.click(screen.getByRole("tab", { name: "Runtime" }));
        expect(await screen.findByText(ELEVATION_MESSAGE)).toBeInTheDocument();
    });

    it("moves between tabs with the arrow keys, Home and End, and leaves other keys alone", async () => {
        const user = userEvent.setup();
        mockApi();
        render(<DiagnosticsManager createLogSocket={createLogSocket} saveFile={vi.fn()} />);
        const selected = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;
        screen.getByRole("tab", { name: "Versions" }).focus();
        await user.keyboard("{ArrowRight}");
        expect(selected()).toBe("Runtime");
        expect(screen.getByRole("tab", { name: "Runtime" })).toHaveFocus();
        await user.keyboard("{ArrowLeft}{ArrowLeft}");
        expect(selected()).toBe("Logs");
        await user.keyboard("{ArrowRight}");
        expect(selected()).toBe("Versions");
        await user.keyboard("{End}");
        expect(selected()).toBe("Logs");
        await user.keyboard("{Home}");
        expect(selected()).toBe("Versions");
        await user.keyboard("x");
        expect(selected()).toBe("Versions");
        await screen.findByRole("region", { name: "Server" });
    });

    it("samples the metrics on the System tab and shows them", async () => {
        const user = userEvent.setup();
        const fetchMock = mockApi();
        render(<DiagnosticsManager createLogSocket={createLogSocket} saveFile={vi.fn()} />);
        await user.click(screen.getByRole("tab", { name: "System" }));
        expect(await screen.findByRole("region", { name: "This server process" })).toBeInTheDocument();
        expect(screen.getByRole("region", { name: "Node running this server" })).toBeInTheDocument();
        expect(calls(fetchMock, "/api/admin/diagnostics/metrics")).toBe(1);
        // Leaving the tab stops the sampling; coming back samples again.
        await user.click(screen.getByRole("tab", { name: "Versions" }));
        await user.click(screen.getByRole("tab", { name: "System" }));
        await waitFor(() => expect(calls(fetchMock, "/api/admin/diagnostics/metrics")).toBe(2));
    });

    describe("Logs", () => {
        it("opens the stream the first time the tab is opened, at the admin logs route, and shows lines as they come", async () => {
            const user = userEvent.setup();
            mockApi();
            render(<DiagnosticsManager createLogSocket={createLogSocket} saveFile={vi.fn()} />);
            expect(FakeSocket.instances).toHaveLength(0);
            await user.click(screen.getByRole("tab", { name: "Logs" }));
            expect(FakeSocket.instances).toHaveLength(1);
            expect(socket().url).toBe("wss://x/api/admin/logs".replace("wss://x", window.location.origin.replace(/^http/, "ws")));
            expect(screen.getByText("Connecting")).toBeInTheDocument();

            receive('{"id":0,"type":"SUBSCRIBED","success":true,"data":"logs"}');
            expect(screen.getByText("Live")).toBeInTheDocument();
            receive('{"level":"warn","message":"Disk is filling","timestamp":"2026-09-26T10:00:00.000Z"}');
            receive("not json at all");
            expect(await screen.findByText("Disk is filling")).toBeInTheDocument();
            expect(screen.getByText("not json at all")).toBeInTheDocument();
            expect(screen.getByText("RAW")).toBeInTheDocument();
            expect(screen.queryByText(/SUBSCRIBED/)).not.toBeInTheDocument();
        });

        it("keeps the stream and its lines while another tab is open, and does not open a second", async () => {
            const user = userEvent.setup();
            mockApi();
            render(<DiagnosticsManager createLogSocket={createLogSocket} saveFile={vi.fn()} />);
            await user.click(screen.getByRole("tab", { name: "Logs" }));
            receive('{"level":"info","message":"kept line"}');
            await screen.findByText("kept line");
            await user.click(screen.getByRole("tab", { name: "Versions" }));
            await user.click(screen.getByRole("tab", { name: "Logs" }));
            expect(FakeSocket.instances).toHaveLength(1);
            expect(socket().closed).toBe(false);
            expect(await screen.findByText("kept line")).toBeInTheDocument();
        });

        it("does not restart a stream the administrator stopped when the tab is opened again", async () => {
            const user = userEvent.setup();
            mockApi();
            render(<DiagnosticsManager createLogSocket={createLogSocket} saveFile={vi.fn()} />);
            await user.click(screen.getByRole("tab", { name: "Logs" }));
            await user.click(screen.getByRole("button", { name: "Stop" }));
            expect(socket().closed).toBe(true);
            expect(screen.getByText("Stopped")).toBeInTheDocument();
            await user.click(screen.getByRole("tab", { name: "Versions" }));
            await user.click(screen.getByRole("tab", { name: "Logs" }));
            expect(FakeSocket.instances).toHaveLength(1);
            await user.click(screen.getByRole("button", { name: "Start" }));
            expect(FakeSocket.instances).toHaveLength(2);
        });

        it("shows a refusal (1002) as an error and does not reconnect", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
            try {
                mockApi();
                render(<DiagnosticsManager createLogSocket={createLogSocket} saveFile={vi.fn()} />);
                fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
                act(() => socket().onclose?.({ code: 1002, reason: "api-103" }));
                expect(screen.getByText(/The server refused the log stream \(api-103\)/)).toBeInTheDocument();
                expect(screen.getByText("Error")).toBeInTheDocument();
                await act(async () => void vi.advanceTimersByTime(120_000));
                expect(FakeSocket.instances).toHaveLength(1);
            } finally {
                vi.useRealTimers();
            }
        });

        it("closes the stream when the page unmounts", async () => {
            const user = userEvent.setup();
            mockApi();
            const { unmount } = render(<DiagnosticsManager createLogSocket={createLogSocket} saveFile={vi.fn()} />);
            await user.click(screen.getByRole("tab", { name: "Logs" }));
            unmount();
            expect(socket().closed).toBe(true);
        });

        it("captures and downloads through the injected save function", async () => {
            const user = userEvent.setup();
            mockApi();
            const saveFile = vi.fn();
            render(<DiagnosticsManager createLogSocket={createLogSocket} saveFile={saveFile} />);
            await user.click(screen.getByRole("tab", { name: "Logs" }));
            await user.click(screen.getByRole("button", { name: "Start capture" }));
            receive('{"level":"error","message":"captured","timestamp":"T1"}');
            await screen.findByText("captured");
            await user.click(screen.getByRole("button", { name: "Stop capture" }));
            await user.click(screen.getByRole("button", { name: "Capture (.log)" }));
            expect(saveFile).toHaveBeenCalledWith(expect.stringMatching(/^rapidmx-server-logs-.*\.log$/), "T1 ERROR captured\n", "text/plain;charset=utf-8");
        });
    });

    describe("Download diagnostics report", () => {
        const saved = (saveFile: ReturnType<typeof vi.fn>) => JSON.parse(saveFile.mock.calls[0][1] as string);

        it("saves the versions, runtime, plugins and a metrics sample as JSON, with no plugin settings and no logs", async () => {
            const user = userEvent.setup();
            const fetchMock = mockApi();
            const saveFile = vi.fn();
            render(<DiagnosticsManager createLogSocket={createLogSocket} saveFile={saveFile} />);
            await screen.findByText("MAPI");
            await user.click(screen.getByRole("button", { name: "Download diagnostics report" }));
            await waitFor(() => expect(saveFile).toHaveBeenCalledOnce());

            const [name, content, mime] = saveFile.mock.calls[0];
            expect(name).toMatch(/^rapidmx-diagnostics-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/);
            expect(mime).toBe("application/json");
            const report = saved(saveFile);
            expect(report.versions.server.nodeVersion).toBe("v24.1.0");
            expect(report.runtime.version.gitVersion).toBe("v1.33.1+k3s1");
            expect(report.plugins.installed).toEqual([{ name: "@rapidmx/mapi", packageVersion: "1.1.0", enabled: true }]);
            expect(report.plugins.status.hash).toBe("h");
            expect(report.metrics.host.cpuPercent).toBe(35);
            expect(report.errors).toEqual({ versions: null, runtime: null, plugins: null, metrics: null });
            expect(typeof report.generatedAt).toBe("string");
            expect(content).not.toContain("top secret");
            expect(content).not.toContain("logs\":");
            // Nothing had sampled, so it asked for one.
            expect(calls(fetchMock, "/api/admin/diagnostics/metrics")).toBe(1);
        });

        it("uses the latest sample the System tab took, and does not ask for another", async () => {
            const user = userEvent.setup();
            const fetchMock = mockApi();
            const saveFile = vi.fn();
            render(<DiagnosticsManager createLogSocket={createLogSocket} saveFile={saveFile} />);
            await user.click(screen.getByRole("tab", { name: "System" }));
            await screen.findByRole("region", { name: "This server process" });
            await user.click(screen.getByRole("button", { name: "Download diagnostics report" }));
            await waitFor(() => expect(saveFile).toHaveBeenCalledOnce());
            expect(saved(saveFile).metrics.collectedAt).toBe("2026-09-26T10:00:00.000Z");
            expect(calls(fetchMock, "/api/admin/diagnostics/metrics")).toBe(1);
        });

        it("still saves what it has, and says what could not be read", async () => {
            const user = userEvent.setup();
            mockApi({
                versions: () => jsonResponse(500, { message: "Versions broke." }),
                runtime: () => jsonResponse(403, { code: "api-104", message: "x" }),
                plugins: () => jsonResponse(500, { message: "Plugins broke." }),
                metrics: () => jsonResponse(403, { code: "api-103", message: "no" }),
            });
            const saveFile = vi.fn();
            render(<DiagnosticsManager createLogSocket={createLogSocket} saveFile={saveFile} />);
            await screen.findByText("Versions broke.");
            await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
            await user.click(screen.getByRole("button", { name: "Download diagnostics report" }));
            await waitFor(() => expect(saveFile).toHaveBeenCalledOnce());
            const report = saved(saveFile);
            expect(report.versions).toBeNull();
            expect(report.runtime).toBeNull();
            expect(report.plugins).toBeNull();
            expect(report.metrics).toBeNull();
            expect(report.errors).toEqual({
                versions: "Versions broke.",
                runtime: ELEVATION_MESSAGE,
                plugins: "Plugins broke.",
                metrics: "You are not authorised to view diagnostics.",
            });
        });

        it("includes the plugin list without a load status when the status could not be read", async () => {
            const user = userEvent.setup();
            mockFetch((url) => {
                if (url === "/api/system/plugins") return jsonResponse(200, [plugin]);
                if (url === "/api/system/plugins/status") return jsonResponse(500, { message: "no" });
                if (url === "/api/admin/diagnostics/versions") return jsonResponse(200, versionsFixture());
                if (url === "/api/admin/diagnostics/runtime") return jsonResponse(200, runtimeFixture());
                return jsonResponse(200, metricsSample());
            });
            const saveFile = vi.fn();
            render(<DiagnosticsManager createLogSocket={createLogSocket} saveFile={saveFile} />);
            await screen.findByText("MAPI");
            await user.click(screen.getByRole("button", { name: "Download diagnostics report" }));
            await waitFor(() => expect(saveFile).toHaveBeenCalledOnce());
            expect(saved(saveFile).plugins).toEqual({ installed: [{ name: "@rapidmx/mapi", packageVersion: "1.1.0", enabled: true }], status: null });
        });

        it("saves with the browser download by default", async () => {
            const user = userEvent.setup();
            mockApi();
            const createObjectURL = vi.fn((_blob: Blob) => "blob:report");
            vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
            const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
            render(<DiagnosticsManager createLogSocket={createLogSocket} />);
            await screen.findByText("MAPI");
            await user.click(screen.getByRole("button", { name: "Download diagnostics report" }));
            await waitFor(() => expect(click).toHaveBeenCalledOnce());
            expect(JSON.parse(await createObjectURL.mock.calls[0][0].text()).versions.server.nodeVersion).toBe("v24.1.0");
        });
    });

    it("uses the browser's WebSocket for the log stream by default", async () => {
        const user = userEvent.setup();
        mockApi();
        const created: string[] = [];
        class BrowserSocket extends FakeSocket {
            constructor(url: string) {
                super(url);
                created.push(url);
            }
        }
        vi.stubGlobal("WebSocket", BrowserSocket);
        render(<DiagnosticsManager saveFile={vi.fn()} />);
        await user.click(screen.getByRole("tab", { name: "Logs" }));
        expect(created).toEqual([`${window.location.origin.replace(/^http/, "ws")}/api/admin/logs`]);
        const tabs = within(screen.getByRole("tablist"));
        expect(tabs.getAllByRole("tab")).toHaveLength(4);
    });
});
