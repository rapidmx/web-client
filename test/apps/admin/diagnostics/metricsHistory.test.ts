// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import type { DiagnosticsMetrics } from "../../../../apps/shared/components/admin/diagnostics/diagnosticsApi.js";
import {
    appendSample,
    METRICS_HISTORY_SIZE,
    METRICS_POLL_INTERVAL_MS,
    seriesOf,
} from "../../../../apps/shared/components/admin/diagnostics/metricsHistory.js";
import { metricsSample } from "./fixtures.js";

describe("metrics history", () => {
    it("polls every five seconds and keeps sixty samples", () => {
        expect(METRICS_POLL_INTERVAL_MS).toBe(5000);
        expect(METRICS_HISTORY_SIZE).toBe(60);
    });

    it("drops the oldest samples beyond sixty", () => {
        let history: DiagnosticsMetrics[] = [];
        for (let index = 0; index < 65; index++) {
            history = appendSample(history, metricsSample({ collectedAt: `sample-${index}` }));
        }
        expect(history).toHaveLength(60);
        expect(history[0].collectedAt).toBe("sample-5");
        expect(history[59].collectedAt).toBe("sample-64");
    });

    it("reads a series, skipping samples without the value", () => {
        const withCpu = (cpuPercent: number) => metricsSample({ process: { ...metricsSample().process, cpuPercent } });
        const history = [withCpu(10), withCpu(Number.NaN), withCpu(30)];
        expect(seriesOf(history, (sample) => sample.process.cpuPercent)).toEqual([10, 30]);
        expect(seriesOf(history, () => undefined)).toEqual([]);
    });
});
