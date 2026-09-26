///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { HiOutlineInformationCircle } from "react-icons/hi2";
import type { DiagnosticsMetrics } from "./diagnosticsApi.js";
import { formatBytes, formatCores, NO_VALUE } from "./format.js";
import { seriesOf } from "./metricsHistory.js";
import MetricTile from "./MetricTile.js";

type NamespaceMetrics = NonNullable<DiagnosticsMetrics["kubernetes"]["namespace"]>;

export interface NamespaceCardProps {
    namespace: NamespaceMetrics | undefined;
    history: DiagnosticsMetrics[];
}

const POD_HEADINGS = ["Pod", "Component", "CPU", "Memory"];

/**
 * The install's namespace: what all its pods use together, and what each pod uses. The figures come from metrics-server; without
 * it there are none, and that is said as a hint (it is a choice of the cluster), not as a failure.
 */
export default function NamespaceCard({ namespace, history }: NamespaceCardProps) {
    // Biggest memory first; a pod with no figure last.
    const pods = [...(namespace?.pods ?? [])].sort((a, b) => (b.memoryUsedBytes ?? -1) - (a.memoryUsedBytes ?? -1));
    return (
        <section aria-labelledby="diagnostics-namespace-heading" className="rounded-md border border-border bg-surface p-4">
            <h2 id="diagnostics-namespace-heading" className="text-base font-bold uppercase tracking-wide mb-3">
                Namespace{namespace?.name ? ` ${namespace.name}` : ""}
            </h2>
            {!namespace ? (
                <p className="text-sm text-text-muted">The server did not report the namespace&rsquo;s figures.</p>
            ) : !namespace.podMetricsAvailable ? (
                <div role="status" className="flex items-start gap-3 rounded-md border border-border bg-surface-alt p-4 text-sm">
                    <HiOutlineInformationCircle size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-text-muted" />
                    <div>
                        <p className="font-medium">Per-pod CPU and memory are not available.</p>
                        <p className="mt-1 text-text-muted">
                            They come from metrics-server, which this cluster does not provide or the server may not read.
                            {namespace.podMetricsReason ? ` ${namespace.podMetricsReason}` : ""}
                        </p>
                    </div>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <MetricTile
                            label="Namespace CPU"
                            value={formatCores(namespace.cpuUsedCores)}
                            history={{ values: seriesOf(history, (sample) => sample.kubernetes?.namespace?.cpuUsedCores), format: formatCores }}
                        />
                        <MetricTile
                            label="Namespace memory"
                            value={formatBytes(namespace.memoryUsedBytes)}
                            history={{ values: seriesOf(history, (sample) => sample.kubernetes?.namespace?.memoryUsedBytes), format: formatBytes }}
                        />
                    </div>
                    <h3 className="mt-4 mb-2 text-xs uppercase tracking-wide text-text-muted">Pods</h3>
                    {pods.length === 0 ? (
                        <p className="text-sm text-text-muted">No pod figures were reported.</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm border-collapse">
                                <thead>
                                    <tr>
                                        {POD_HEADINGS.map((heading) => (
                                            <th
                                                key={heading}
                                                className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border"
                                            >
                                                {heading}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {pods.map((pod) => (
                                        <tr key={pod.name}>
                                            <td className="py-2 px-2.5 border-b border-border font-mono break-all">{pod.name}</td>
                                            <td className="py-2 px-2.5 border-b border-border">{pod.component ?? NO_VALUE}</td>
                                            <td className="py-2 px-2.5 border-b border-border tabular-nums">{formatCores(pod.cpuUsedCores)}</td>
                                            <td className="py-2 px-2.5 border-b border-border tabular-nums">{formatBytes(pod.memoryUsedBytes)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
