///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { KeyboardEvent, useEffect, useRef, useState } from "react";
import { HiOutlineArrowDownTray, HiOutlineArrowPath } from "react-icons/hi2";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import { DiagnosticsMetrics, getDiagnosticsMetrics, getDiagnosticsRuntime, getDiagnosticsVersions } from "./diagnosticsApi.js";
import { saveTextFile, SaveFile, timestampedFilename } from "./download.js";
import { describeError } from "./format.js";
import { loadInstalledPlugins } from "./InstalledPlugins.js";
import type { LogSocketFactory } from "./logClient.js";
import LogsPanel from "./LogsPanel.js";
import RuntimePanel from "./RuntimePanel.js";
import SystemPanel from "./SystemPanel.js";
import { useDiagnosticsResource } from "./useDiagnosticsResource.js";
import { useLogStream } from "./useLogStream.js";
import { useMetricsPolling } from "./useMetricsPolling.js";
import VersionsPanel from "./VersionsPanel.js";

export type DiagnosticsTab = "versions" | "runtime" | "system" | "logs";

const TABS: { id: DiagnosticsTab; label: string }[] = [
    { id: "versions", label: "Versions" },
    { id: "runtime", label: "Runtime" },
    { id: "system", label: "System" },
    { id: "logs", label: "Logs" },
];

const tabId = (tab: DiagnosticsTab) => `diagnostics-tab-${tab}`;
const panelId = (tab: DiagnosticsTab) => `diagnostics-panel-${tab}`;

export interface DiagnosticsManagerProps {
    /** Creates the log stream's WebSocket. Defaults to the browser's. For a test. */
    createLogSocket?: LogSocketFactory;
    /** Saves a downloaded file. Defaults to `saveTextFile()`. For a test. */
    saveFile?: SaveFile;
}

/**
 * The Diagnostics page: what is installed (Versions), what it runs on (Runtime), how it is doing right now (System, live) and what
 * the server is logging (Logs, live, with captures). Versions and Runtime are read when the page opens and again on Refresh, and
 * are not polled. The live tabs only work while they are open: System polls only on its tab, and the log stream is opened the
 * first time the Logs tab is (and closes with the page, or on Stop).
 */
export default function DiagnosticsManager({ createLogSocket, saveFile = saveTextFile }: DiagnosticsManagerProps) {
    const [tab, setTab] = useState<DiagnosticsTab>("versions");
    const [reloadKey, setReloadKey] = useState(0);
    const [preparingReport, setPreparingReport] = useState(false);
    const versions = useDiagnosticsResource(getDiagnosticsVersions, reloadKey, "Could not read the server's versions.");
    const runtime = useDiagnosticsResource(getDiagnosticsRuntime, reloadKey, "Could not read the runtime.");
    const plugins = useDiagnosticsResource(loadInstalledPlugins, reloadKey, "Could not read the installed plugins.");
    const polling = useMetricsPolling(tab === "system");
    const logStream = useLogStream({ createSocket: createLogSocket });
    const logsOpened = useRef(false);
    const { start: startLogs } = logStream;

    useEffect(() => {
        if (tab === "logs" && !logsOpened.current) {
            logsOpened.current = true;
            startLogs();
        }
    }, [tab]);

    const refreshing = versions.loading || runtime.loading || plugins.loading;

    function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        const index = TABS.findIndex((item) => item.id === tab);
        let next: number;
        if (event.key === "ArrowRight") {
            next = (index + 1) % TABS.length;
        } else if (event.key === "ArrowLeft") {
            next = (index + TABS.length - 1) % TABS.length;
        } else if (event.key === "Home") {
            next = 0;
        } else if (event.key === "End") {
            next = TABS.length - 1;
        } else {
            return;
        }
        event.preventDefault();
        setTab(TABS[next].id);
        document.getElementById(tabId(TABS[next].id))?.focus();
    }

    /** Saves the versions, the runtime and the latest metrics sample (asking for one if the System tab has not sampled): no logs. */
    async function downloadReport() {
        setPreparingReport(true);
        const generatedAt = new Date();
        let metrics: DiagnosticsMetrics | undefined = polling.history[polling.history.length - 1];
        let metricsError: string | undefined;
        if (!metrics) {
            try {
                metrics = await getDiagnosticsMetrics();
            } catch (err) {
                metricsError = describeError(err, "Could not read the server's metrics.");
            }
        }
        const report = {
            generatedAt: generatedAt.toISOString(),
            versions: versions.data ?? null,
            runtime: runtime.data ?? null,
            // Only what each plugin is and which version is loaded: a plugin's settings can hold secrets.
            plugins: plugins.data
                ? {
                      installed: plugins.data.plugins.map(({ name, packageVersion, enabled }) => ({ name, packageVersion, enabled })),
                      status: plugins.data.status ?? null,
                  }
                : null,
            metrics: metrics ?? null,
            errors: {
                versions: versions.error ?? null,
                runtime: runtime.error ?? null,
                plugins: plugins.error ?? null,
                metrics: metricsError ?? null,
            },
        };
        saveFile(timestampedFilename("rapidmx-diagnostics", "json", generatedAt), `${JSON.stringify(report, null, 2)}\n`, "application/json");
        setPreparingReport(false);
    }

    return (
        <>
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-xl font-bold uppercase tracking-wide">Diagnostics</h1>
                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        type="button"
                        variant="secondary"
                        className="!w-auto"
                        disabled={refreshing}
                        onClick={() => setReloadKey(reloadKey + 1)}
                    >
                        <HiOutlineArrowPath size={16} aria-hidden="true" className="mr-1 inline" />
                        Refresh
                    </Button>
                    <Button type="button" className="!w-auto" loading={preparingReport} onClick={() => void downloadReport()}>
                        <HiOutlineArrowDownTray size={16} aria-hidden="true" className="mr-1 inline" />
                        Download diagnostics report
                    </Button>
                </div>
            </div>

            <div role="tablist" aria-label="Diagnostics sections" className="mb-5 flex gap-1 overflow-x-auto rounded-lg bg-surface-alt p-1">
                {TABS.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        role="tab"
                        id={tabId(item.id)}
                        aria-selected={item.id === tab}
                        aria-controls={panelId(item.id)}
                        tabIndex={item.id === tab ? 0 : -1}
                        onClick={() => setTab(item.id)}
                        onKeyDown={handleTabKeyDown}
                        className={`flex-1 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium ${
                            item.id === tab ? "bg-surface text-text shadow-card" : "text-text-muted hover:text-text"
                        }`}
                    >
                        {item.label}
                    </button>
                ))}
            </div>

            <div role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)}>
                {tab === "versions" && <VersionsPanel versions={versions} plugins={plugins} />}
                {tab === "runtime" && <RuntimePanel runtime={runtime} />}
                {tab === "system" && <SystemPanel polling={polling} />}
                {tab === "logs" && <LogsPanel stream={logStream} saveFile={saveFile} />}
            </div>
        </>
    );
}
