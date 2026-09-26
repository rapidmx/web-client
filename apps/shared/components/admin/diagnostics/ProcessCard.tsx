///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import type { DiagnosticsMetrics } from "./diagnosticsApi.js";
import { formatBytes, formatCores, formatPercent, percentOf } from "./format.js";
import { formatLoad } from "./HostCard.js";
import { seriesOf } from "./metricsHistory.js";
import MetricTile from "./MetricTile.js";

export interface ProcessCardProps {
    process: DiagnosticsMetrics["process"] | undefined;
    history: DiagnosticsMetrics[];
}

/** The server's own Node.js process: its CPU, memory, and the memory and load its container sees. Shown with or without Kubernetes. */
export default function ProcessCard({ process, history }: ProcessCardProps) {
    const heapPercent = percentOf(process?.heapUsedBytes, process?.heapTotalBytes);
    const systemUsed =
        process?.systemMemoryTotalBytes !== undefined && process.systemMemoryFreeBytes !== undefined
            ? process.systemMemoryTotalBytes - process.systemMemoryFreeBytes
            : undefined;
    const systemPercent = percentOf(systemUsed, process?.systemMemoryTotalBytes);
    return (
        <section aria-labelledby="diagnostics-process-heading" className="rounded-md border border-border bg-surface p-4">
            <h2 id="diagnostics-process-heading" className="text-base font-bold uppercase tracking-wide mb-3">
                This server process
            </h2>
            {!process ? (
                <p className="text-sm text-text-muted">The server did not report its own figures.</p>
            ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
                    <MetricTile
                        label="Process CPU"
                        value={formatPercent(process.cpuPercent)}
                        detail={`${formatCores(process.cpuCount)} available`}
                        history={{ values: seriesOf(history, (sample) => sample.process?.cpuPercent), format: formatPercent }}
                    />
                    <MetricTile
                        label="Process memory (RSS)"
                        value={formatBytes(process.rssBytes)}
                        history={{ values: seriesOf(history, (sample) => sample.process?.rssBytes), format: formatBytes }}
                    />
                    <MetricTile
                        label="Heap"
                        value={formatBytes(process.heapUsedBytes)}
                        detail={`of ${formatBytes(process.heapTotalBytes)} allocated`}
                        usage={
                            heapPercent === undefined
                                ? undefined
                                : { percent: heapPercent, detail: `${formatBytes(process.heapUsedBytes)} of ${formatBytes(process.heapTotalBytes)}`, flag: false }
                        }
                    />
                    <MetricTile label="Load average" value={formatLoad(process.loadAverage)} detail="1, 5 and 15 minutes" />
                    <MetricTile
                        label="Memory visible to the container"
                        value={formatBytes(systemUsed)}
                        detail={`of ${formatBytes(process.systemMemoryTotalBytes)}`}
                        usage={
                            systemPercent === undefined
                                ? undefined
                                : { percent: systemPercent, detail: `${formatBytes(systemUsed)} of ${formatBytes(process.systemMemoryTotalBytes)}` }
                        }
                    />
                </div>
            )}
        </section>
    );
}
