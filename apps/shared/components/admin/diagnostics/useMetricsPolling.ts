///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useState } from "react";
import { DiagnosticsMetrics, getDiagnosticsMetrics } from "./diagnosticsApi.js";
import { describeError, isPermissionError } from "./format.js";
import { appendSample, METRICS_POLL_INTERVAL_MS } from "./metricsHistory.js";

export interface MetricsPolling {
    /** The last `METRICS_HISTORY_SIZE` samples, oldest first. */
    history: DiagnosticsMetrics[];
    /** Why the last request failed, until one succeeds. */
    error: string | undefined;
    /** Whether nothing has been answered yet. */
    loading: boolean;
    /** Whether polling is stopped by the viewer (Pause), or because the server refused the viewer. */
    paused: boolean;
    setPaused: (paused: boolean) => void;
}

/**
 * Samples `getDiagnosticsMetrics()` every `METRICS_POLL_INTERVAL_MS` while `enabled` and not paused, keeping the last
 * `METRICS_HISTORY_SIZE`. A request is only ever made when the previous one has answered, none is made while the page is
 * hidden (one is made at once when it is shown again), and polling stops when the component unmounts. A refusal (401/403)
 * pauses polling, since asking again would only be refused again; Resume tries once more. Any other failure is shown
 * and polling carries on, so a blip on the server does not need the viewer to do anything.
 */
export function useMetricsPolling(enabled: boolean): MetricsPolling {
    const [history, setHistory] = useState<DiagnosticsMetrics[]>([]);
    const [error, setError] = useState<string | undefined>();
    const [loading, setLoading] = useState(true);
    const [paused, setPaused] = useState(false);

    useEffect(() => {
        if (!enabled || paused) {
            return;
        }
        let cancelled = false;
        let inFlight = false;

        async function sample() {
            if (inFlight || document.hidden) {
                return;
            }
            inFlight = true;
            try {
                const next = await getDiagnosticsMetrics();
                if (!cancelled) {
                    setHistory((previous) => appendSample(previous, next));
                    setError(undefined);
                }
            } catch (err) {
                if (!cancelled) {
                    setError(describeError(err, "Could not read the server's metrics."));
                    if (isPermissionError(err)) {
                        setPaused(true);
                    }
                }
            } finally {
                inFlight = false;
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }

        void sample();
        const timer = setInterval(() => void sample(), METRICS_POLL_INTERVAL_MS);
        const onVisibilityChange = () => {
            if (!document.hidden) {
                void sample();
            }
        };
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
            cancelled = true;
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
    }, [enabled, paused]);

    return { history, error, loading, paused, setPaused };
}
