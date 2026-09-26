///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import type { DiagnosticsPvcMetrics } from "./diagnosticsApi.js";
import { formatBytes, NO_VALUE, percentOf } from "./format.js";
import UsageMeter from "./UsageMeter.js";

const HEADINGS = ["Volume", "Phase", "Storage class", "Size", "Usage"];

function Usage({ pvc }: { pvc: DiagnosticsPvcMetrics }) {
    if (!pvc.mountedByServer) {
        return <span className="text-text-muted">Usage not available: not mounted in the server pod.</span>;
    }
    const percent = percentOf(pvc.usedBytes, pvc.capacityBytes);
    if (percent === undefined) {
        return <span className="text-text-muted">The server has no usage figures for this volume.</span>;
    }
    return (
        <div>
            <UsageMeter
                label={`Usage of volume ${pvc.name}`}
                percent={percent}
                detail={`${formatBytes(pvc.usedBytes)} of ${formatBytes(pvc.capacityBytes)}`}
                flag={!pvc.sharesNodeDisk}
            />
            {pvc.sharesNodeDisk && (
                <p className="mt-1 text-xs text-text-muted">Shares the node&rsquo;s disk; the volume&rsquo;s size is not enforced.</p>
            )}
        </div>
    );
}

/** The install's persistent volume claims, with a usage bar for the ones the server can measure. */
export default function PvcTable({ pvcs }: { pvcs: DiagnosticsPvcMetrics[] }) {
    return (
        <section aria-labelledby="diagnostics-pvc-heading" className="rounded-md border border-border bg-surface p-4">
            <h2 id="diagnostics-pvc-heading" className="text-base font-bold uppercase tracking-wide mb-3">
                Persistent volumes
            </h2>
            {pvcs.length === 0 ? (
                <p className="text-sm text-text-muted">This install has no persistent volume claims.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr>
                                {HEADINGS.map((heading) => (
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
                            {pvcs.map((pvc) => (
                                <tr key={pvc.name} className="align-top">
                                    <td className="py-2 px-2.5 border-b border-border font-mono break-all">{pvc.name}</td>
                                    <td className="py-2 px-2.5 border-b border-border">{pvc.phase}</td>
                                    <td className="py-2 px-2.5 border-b border-border">{pvc.storageClass ?? NO_VALUE}</td>
                                    <td className="py-2 px-2.5 border-b border-border tabular-nums">
                                        {formatBytes(pvc.capacityBytes ?? pvc.requestedBytes)}
                                    </td>
                                    <td className="py-2 px-2.5 border-b border-border min-w-56">
                                        <Usage pvc={pvc} />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
