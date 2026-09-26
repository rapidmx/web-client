///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import type { DiagnosticsDiskMetrics, DiagnosticsMetrics } from "./diagnosticsApi.js";
import { formatBytes, formatCores, formatPercent, NO_VALUE, percentOf } from "./format.js";
import { seriesOf } from "./metricsHistory.js";
import MetricTile from "./MetricTile.js";
import UsageMeter from "./UsageMeter.js";

const percentLabel = (value: number) => formatPercent(value);

/** `1.23, 0.98, 0.5`, or a dash for a load average the server left out. */
export function formatLoad(load: number[] | undefined): string {
    return load && load.length > 0 ? load.map((value) => value.toFixed(2)).join(", ") : NO_VALUE;
}

export interface HostCardProps {
    host: DiagnosticsMetrics["host"] | undefined;
    history: DiagnosticsMetrics[];
}

function DiskRow({ disk }: { disk: DiagnosticsDiskMetrics }) {
    const percent = percentOf(disk.usedBytes, disk.capacityBytes);
    return (
        <li className="rounded-sm border border-border p-3">
            <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-mono break-all">{disk.path}</span>
                {disk.pvc && <span className="text-xs text-text-muted">volume {disk.pvc}</span>}
            </div>
            {percent === undefined ? (
                <p className="text-sm text-text-muted">No usage figures.</p>
            ) : (
                <UsageMeter
                    label={`Disk usage of ${disk.path}`}
                    percent={percent}
                    detail={`${formatBytes(disk.usedBytes)} of ${formatBytes(disk.capacityBytes)}, ${formatBytes(disk.availableBytes)} free`}
                />
            )}
            {disk.sharesNodeDisk && <p className="mt-1 text-xs text-text-muted">Shares the node&rsquo;s disk.</p>}
        </li>
    );
}

/**
 * The node the server pod runs on, as its own container sees it: whole-host CPU, memory, load and disks. It is only that
 * node in a cluster of several, and the whole machine on a single-node install or under Docker Compose.
 */
export default function HostCard({ host, history }: HostCardProps) {
    const memoryPercent = percentOf(host?.memoryUsedBytes, host?.memoryTotalBytes);
    const disks = host?.disks ?? [];
    return (
        <section aria-labelledby="diagnostics-host-heading" className="rounded-md border border-border bg-surface p-4">
            <h2 id="diagnostics-host-heading" className="text-base font-bold uppercase tracking-wide mb-1">
                Node running this server
            </h2>
            <p className="mb-3 text-xs text-text-muted">
                As the server&rsquo;s own container sees it. In a cluster of several nodes this is only the node the server runs on.
            </p>
            {!host ? (
                <p className="text-sm text-text-muted">The server did not report the node&rsquo;s figures.</p>
            ) : (
                <>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                        <MetricTile
                            label="CPU"
                            value={formatPercent(host.cpuPercent)}
                            detail={formatCores(host.cpuCount)}
                            usage={Number.isFinite(host.cpuPercent) ? { percent: host.cpuPercent, detail: "Whole host, all cores" } : undefined}
                            history={{
                                values: seriesOf(history, (sample) => sample.host?.cpuPercent),
                                max: 100,
                                format: percentLabel,
                            }}
                        />
                        <MetricTile
                            label="Memory"
                            value={formatBytes(host.memoryUsedBytes)}
                            detail={`of ${formatBytes(host.memoryTotalBytes)}`}
                            usage={
                                memoryPercent === undefined
                                    ? undefined
                                    : { percent: memoryPercent, detail: `${formatBytes(host.memoryUsedBytes)} of ${formatBytes(host.memoryTotalBytes)}` }
                            }
                            history={{
                                values: seriesOf(history, (sample) => percentOf(sample.host?.memoryUsedBytes, sample.host?.memoryTotalBytes)),
                                max: 100,
                                format: percentLabel,
                            }}
                        />
                        <MetricTile label="Load average" value={formatLoad(host.loadAverage)} detail="1, 5 and 15 minutes" />
                    </div>
                    <h3 className="mt-4 mb-2 text-xs uppercase tracking-wide text-text-muted">Disks</h3>
                    {disks.length === 0 ? (
                        <p className="text-sm text-text-muted">No disks were reported.</p>
                    ) : (
                        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            {disks.map((disk) => (
                                <DiskRow key={disk.path} disk={disk} />
                            ))}
                        </ul>
                    )}
                </>
            )}
        </section>
    );
}
