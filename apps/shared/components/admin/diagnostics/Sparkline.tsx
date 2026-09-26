///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { METRICS_HISTORY_SIZE } from "./metricsHistory.js";

const WIDTH = 240;
const HEIGHT = 48;
/** Keeps a line at the very top or bottom of the plot from being clipped by its own 2px stroke. */
const PADDING = 2;

/**
 * Where each value is drawn, as `[x, y]` in the plot's own coordinates. The x-axis always has room for a full
 * history (`METRICS_HISTORY_SIZE` samples), with the newest sample at the right edge, so a line that has just started
 * grows in from the right rather than being stretched across the plot. The y-axis runs from zero to `max` (the highest
 * value when it is not given), so the shape is never a lie about how much the value moves.
 */
export function sparklinePoints(values: number[], max?: number): [number, number][] {
    const top = max !== undefined && max > 0 ? max : Math.max(...values, 0) || 1;
    const step = WIDTH / (METRICS_HISTORY_SIZE - 1);
    return values.map((value, index) => {
        const x = WIDTH - (values.length - 1 - index) * step;
        const y = HEIGHT - PADDING - (Math.min(Math.max(value, 0), top) / top) * (HEIGHT - 2 * PADDING);
        return [x, y];
    });
}

export interface SparklineProps {
    values: number[];
    /** What is drawn, for the text alternative (`CPU used`). */
    label: string;
    /** The value the plot's top stands for. Defaults to the highest value seen. */
    max?: number;
    /** Writes a value for the text alternative. */
    format: (value: number) => string;
}

/**
 * A line with a wash of the same colour under it, over the last few minutes of a value. It carries no numbers itself: the
 * value beside it does, and the text alternative says the latest, lowest and highest.
 */
export default function Sparkline({ values, label, max, format }: SparklineProps) {
    const points = sparklinePoints(values, max);
    let description = `${label}: collecting samples`;
    if (values.length > 1) {
        description = `${label}: latest ${format(values[values.length - 1])}, lowest ${format(Math.min(...values))}, highest ${format(Math.max(...values))} over the last ${values.length} samples`;
    }
    const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    return (
        <svg
            role="img"
            aria-label={description}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            className="block h-12 w-full"
        >
            <title>{description}</title>
            <line x1="0" y1={HEIGHT - 0.5} x2={WIDTH} y2={HEIGHT - 0.5} className="stroke-border" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            {points.length > 1 && (
                <>
                    <path
                        d={`${line} L${points[points.length - 1][0].toFixed(1)} ${HEIGHT} L${points[0][0].toFixed(1)} ${HEIGHT} Z`}
                        className="fill-primary/10"
                    />
                    <path
                        d={line}
                        fill="none"
                        className="stroke-primary"
                        strokeWidth="2"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                    />
                </>
            )}
        </svg>
    );
}
