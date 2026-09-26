///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import type { DiagnosticsMetrics, DiagnosticsPressure } from "./diagnosticsApi.js";
import { formatBytes, formatPercent, percentOf } from "./format.js";
import { seriesOf } from "./metricsHistory.js";
import MetricTile from "./MetricTile.js";

/** From this share of the last 10 seconds spent stalled, pressure is called elevated ... */
export const ELEVATED_PRESSURE_PERCENT = 10;

/** ... and from this, high. Kernel documentation treats a few percent as ordinary and tens of percent as a machine that is struggling. */
export const HIGH_PRESSURE_PERCENT = 30;

export type PressureLevel = "Low" | "Elevated" | "High";

/** Pressure in words, so that it is never only a number or a colour. */
export function pressureLevel(percent: number): PressureLevel {
    if (percent >= HIGH_PRESSURE_PERCENT) {
        return "High";
    }
    return percent >= ELEVATED_PRESSURE_PERCENT ? "Elevated" : "Low";
}

type Host = NonNullable<DiagnosticsMetrics["host"]>;
type Resource = keyof NonNullable<Host["pressure"]>;

const RESOURCES: { key: Resource; label: string; waiting: string }[] = [
    { key: "memory", label: "Memory pressure", waiting: "waiting for memory" },
    { key: "io", label: "I/O pressure", waiting: "waiting for the disk" },
    { key: "cpu", label: "CPU pressure", waiting: "waiting for a CPU" },
];

function PressureTile({ label, waiting, stall, history, resource }: { label: string; waiting: string; stall: DiagnosticsPressure; history: DiagnosticsMetrics[]; resource: Resource }) {
    const level = pressureLevel(stall.some.avg10);
    return (
        <MetricTile
            label={label}
            value={formatPercent(stall.some.avg10)}
            detail={`${level}: tasks ${waiting}, last 10 seconds`}
            history={{
                values: seriesOf(history, (sample) => sample.host?.pressure?.[resource]?.some.avg10),
                max: 100,
                format: formatPercent,
            }}
        >
            <div className="mt-2 text-xs text-text-muted">
                Last minute {formatPercent(stall.some.avg60)}, last 5 minutes {formatPercent(stall.some.avg300)}
                {stall.full && ` · every task waiting: ${formatPercent(stall.full.avg10)}`}
            </div>
        </MetricTile>
    );
}

export interface PressureTilesProps {
    host: Host;
    history: DiagnosticsMetrics[];
}

/**
 * How stalled the node is (Linux pressure stall information: the share of recent time tasks spent waiting for memory, the disk or
 * a CPU), and how much memory the hypervisor holds in the machine's balloon. Both explain a node that is slow while nothing on it
 * uses much: a guest counts ballooned memory as used though no process holds it, and a machine short of memory stalls on the disk.
 * Nothing is shown where the kernel gives no such figures.
 */
export default function PressureTiles({ host, history }: PressureTilesProps) {
    const tiles = RESOURCES.filter(({ key }) => host.pressure?.[key]);
    const balloon = host.balloon;
    if (tiles.length === 0 && !balloon) {
        return null;
    }
    const heldPercent = percentOf(balloon?.heldBytes, host.memoryTotalBytes);
    return (
        <>
            <h3 className="mt-4 mb-2 text-xs uppercase tracking-wide text-text-muted">Pressure</h3>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
                {RESOURCES.map(({ key, label, waiting }) => {
                    const stall = host.pressure?.[key];
                    return stall && <PressureTile key={key} label={label} waiting={waiting} stall={stall} history={history} resource={key} />;
                })}
                {balloon && (
                    <MetricTile
                        label="Held by the hypervisor"
                        value={formatBytes(balloon.heldBytes)}
                        detail={`of ${formatBytes(host.memoryTotalBytes)}`}
                        usage={
                            heldPercent === undefined
                                ? undefined
                                : { percent: heldPercent, detail: `${formatBytes(balloon.heldBytes)} in the memory balloon`, flag: false }
                        }
                        history={{
                            values: seriesOf(history, (sample) => sample.host?.balloon?.heldBytes),
                            max: host.memoryTotalBytes,
                            format: formatBytes,
                        }}
                    >
                        <div className="mt-2 text-xs text-text-muted">
                            Memory the hypervisor has taken back through the balloon. It counts as used above though no process holds it.{" "}
                            {formatBytes(balloon.inflatedTotalBytes)} taken since the node booted.
                        </div>
                    </MetricTile>
                )}
            </div>
        </>
    );
}
