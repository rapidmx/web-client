///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode } from "react";
import Sparkline, { SparklineProps } from "./Sparkline.js";
import UsageMeter from "./UsageMeter.js";

export interface MetricTileProps {
    /** What is measured (`CPU`). */
    label: string;
    /** The current value, written out (`1.2 cores`). */
    value: string;
    /** Smaller text under the value. */
    detail?: string;
    /** When the value is a share of a capacity: the share (0 to 100) and the amounts it comes from. */
    usage?: { percent: number; detail: string; flag?: boolean };
    /** The value's recent history, drawn under it. */
    history?: Omit<SparklineProps, "label">;
    children?: ReactNode;
}

/** One measurement: its label, the current value in numbers, a meter when it has a capacity, and a sparkline of its recent past. */
export default function MetricTile({ label, value, detail, usage, history, children }: MetricTileProps) {
    return (
        <div className="rounded-md border border-border bg-surface p-4">
            <div className="text-xs uppercase tracking-wide text-text-muted">{label}</div>
            <div className="mt-1 text-xl font-semibold">{value}</div>
            {detail && <div className="text-xs text-text-muted">{detail}</div>}
            {usage && (
                <div className="mt-3">
                    <UsageMeter label={`${label} usage`} percent={usage.percent} detail={usage.detail} flag={usage.flag} />
                </div>
            )}
            {history && (
                <div className="mt-3">
                    <Sparkline label={label} {...history} />
                </div>
            )}
            {children}
        </div>
    );
}
