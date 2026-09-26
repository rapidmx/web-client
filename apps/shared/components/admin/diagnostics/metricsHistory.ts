///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { DiagnosticsMetrics } from "./diagnosticsApi.js";

/** How often the System tab asks the server for a new sample. */
export const METRICS_POLL_INTERVAL_MS = 5000;

/** How many samples the System tab keeps: the last five minutes at `METRICS_POLL_INTERVAL_MS`. */
export const METRICS_HISTORY_SIZE = 60;

/** `history` with `sample` added, the oldest samples dropped beyond `METRICS_HISTORY_SIZE`. */
export function appendSample(history: DiagnosticsMetrics[], sample: DiagnosticsMetrics): DiagnosticsMetrics[] {
    return [...history, sample].slice(-METRICS_HISTORY_SIZE);
}

/** The values `pick` finds in each sample, in order. A sample it finds nothing in (a node with no stats yet, say) is skipped. */
export function seriesOf(history: DiagnosticsMetrics[], pick: (sample: DiagnosticsMetrics) => number | undefined): number[] {
    const values: number[] = [];
    for (const sample of history) {
        const value = pick(sample);
        if (typeof value === "number" && Number.isFinite(value)) {
            values.push(value);
        }
    }
    return values;
}
