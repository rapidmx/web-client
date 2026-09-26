// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import { useMetricsPolling } from "../../../../apps/shared/components/admin/diagnostics/useMetricsPolling.js";
import { METRICS_HISTORY_SIZE, METRICS_POLL_INTERVAL_MS } from "../../../../apps/shared/components/admin/diagnostics/metricsHistory.js";
import { ELEVATION_MESSAGE, NOT_AUTHORISED_MESSAGE } from "../../../../apps/shared/components/admin/diagnostics/format.js";
import { metricsSample } from "./fixtures.js";

const URL = "/api/admin/diagnostics/metrics";

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Lets the timers advance by `ms` and the requests they started answer. */
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

function metricsCalls(fetchMock: ReturnType<typeof mockFetch>) {
    return fetchMock.mock.calls.filter((call) => call[0] === URL).length;
}

describe("useMetricsPolling", () => {
    it("samples at once and then every five seconds, oldest first", async () => {
        vi.useFakeTimers();
        let count = 0;
        const fetchMock = mockFetch(() => jsonResponse(200, metricsSample({ collectedAt: `sample-${++count}` })));
        const { result } = renderHook(() => useMetricsPolling(true));
        expect(result.current.loading).toBe(true);
        await advance(0);
        expect(result.current.loading).toBe(false);
        expect(result.current.history.map((sample) => sample.collectedAt)).toEqual(["sample-1"]);

        await advance(METRICS_POLL_INTERVAL_MS - 1);
        expect(metricsCalls(fetchMock)).toBe(1);
        await advance(1);
        expect(result.current.history.map((sample) => sample.collectedAt)).toEqual(["sample-1", "sample-2"]);
        await advance(2 * METRICS_POLL_INTERVAL_MS);
        expect(result.current.history).toHaveLength(4);
        expect(result.current.error).toBeUndefined();
    });

    it("keeps only the last sixty samples", async () => {
        vi.useFakeTimers();
        let count = 0;
        mockFetch(() => jsonResponse(200, metricsSample({ collectedAt: `sample-${++count}` })));
        const { result } = renderHook(() => useMetricsPolling(true));
        await advance(65 * METRICS_POLL_INTERVAL_MS);
        expect(result.current.history).toHaveLength(METRICS_HISTORY_SIZE);
        expect(result.current.history[METRICS_HISTORY_SIZE - 1].collectedAt).toBe("sample-66");
        expect(result.current.history[0].collectedAt).toBe("sample-7");
    });

    it("does not poll while disabled, and starts when enabled", async () => {
        vi.useFakeTimers();
        const fetchMock = mockFetch(() => jsonResponse(200, metricsSample()));
        const { result, rerender } = renderHook(({ enabled }) => useMetricsPolling(enabled), { initialProps: { enabled: false } });
        await advance(3 * METRICS_POLL_INTERVAL_MS);
        expect(fetchMock).not.toHaveBeenCalled();
        rerender({ enabled: true });
        await advance(0);
        expect(metricsCalls(fetchMock)).toBe(1);
        expect(result.current.history).toHaveLength(1);
        rerender({ enabled: false });
        await advance(3 * METRICS_POLL_INTERVAL_MS);
        expect(metricsCalls(fetchMock)).toBe(1);
        // What it has sampled stays.
        expect(result.current.history).toHaveLength(1);
    });

    it("never has two requests in flight", async () => {
        vi.useFakeTimers();
        const resolvers: ((response: Response) => void)[] = [];
        const fetchMock = mockFetch(() => new Promise<Response>((resolve) => resolvers.push(resolve)));
        const { result } = renderHook(() => useMetricsPolling(true));
        await advance(10 * METRICS_POLL_INTERVAL_MS);
        expect(metricsCalls(fetchMock)).toBe(1);

        resolvers[0](jsonResponse(200, metricsSample()));
        await advance(0);
        expect(result.current.history).toHaveLength(1);
        await advance(METRICS_POLL_INTERVAL_MS);
        expect(metricsCalls(fetchMock)).toBe(2);
    });

    it("makes no request while the page is hidden, and one at once when it is shown", async () => {
        vi.useFakeTimers();
        const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        const fetchMock = mockFetch(() => jsonResponse(200, metricsSample()));
        const { result } = renderHook(() => useMetricsPolling(true));
        await advance(4 * METRICS_POLL_INTERVAL_MS);
        expect(fetchMock).not.toHaveBeenCalled();
        // A visibility change that leaves the page hidden is not a reason to ask.
        await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
        expect(fetchMock).not.toHaveBeenCalled();

        hidden.mockReturnValue(false);
        await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
        await advance(0);
        expect(metricsCalls(fetchMock)).toBe(1);
        expect(result.current.history).toHaveLength(1);

        hidden.mockReturnValue(true);
        await advance(3 * METRICS_POLL_INTERVAL_MS);
        expect(metricsCalls(fetchMock)).toBe(1);
    });

    it("stops when paused and samples again at once on resume", async () => {
        vi.useFakeTimers();
        const fetchMock = mockFetch(() => jsonResponse(200, metricsSample()));
        const { result } = renderHook(() => useMetricsPolling(true));
        await advance(0);
        expect(result.current.paused).toBe(false);

        act(() => result.current.setPaused(true));
        await advance(3 * METRICS_POLL_INTERVAL_MS);
        expect(metricsCalls(fetchMock)).toBe(1);
        expect(result.current.paused).toBe(true);

        act(() => result.current.setPaused(false));
        await advance(0);
        expect(metricsCalls(fetchMock)).toBe(2);
        await advance(METRICS_POLL_INTERVAL_MS);
        expect(metricsCalls(fetchMock)).toBe(3);
    });

    it("stops the timer and the visibility listener when it unmounts", async () => {
        vi.useFakeTimers();
        const fetchMock = mockFetch(() => jsonResponse(200, metricsSample()));
        const removed = vi.spyOn(document, "removeEventListener");
        const { unmount } = renderHook(() => useMetricsPolling(true));
        await advance(0);
        unmount();
        expect(removed).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
        await advance(5 * METRICS_POLL_INTERVAL_MS);
        await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
        expect(metricsCalls(fetchMock)).toBe(1);
    });

    it("drops an answer that arrives after it unmounted, a good one or a failed one", async () => {
        vi.useFakeTimers();
        const resolvers: ((response: Response) => void)[] = [];
        const rejecters: ((error: Error) => void)[] = [];
        let call = 0;
        mockFetch(
            () =>
                new Promise<Response>((resolve, reject) => {
                    resolvers.push(resolve);
                    rejecters.push(reject);
                    call += 1;
                })
        );
        const first = renderHook(() => useMetricsPolling(true));
        await advance(0);
        first.unmount();
        resolvers[0](jsonResponse(200, metricsSample()));
        await advance(0);
        expect(first.result.current.history).toEqual([]);

        const second = renderHook(() => useMetricsPolling(true));
        await advance(0);
        second.unmount();
        rejecters[1](new Error("offline"));
        await advance(0);
        expect(call).toBe(2);
        expect(second.result.current.error).toBeUndefined();
        expect(second.result.current.loading).toBe(true);
    });

    it("shows a failure, keeps what it had and keeps polling, then clears the error on the next good sample", async () => {
        vi.useFakeTimers();
        let fail = false;
        mockFetch(() => (fail ? jsonResponse(502, { message: "Kubernetes is down." }) : jsonResponse(200, metricsSample())));
        const { result } = renderHook(() => useMetricsPolling(true));
        await advance(0);
        expect(result.current.history).toHaveLength(1);

        fail = true;
        await advance(METRICS_POLL_INTERVAL_MS);
        expect(result.current.error).toBe("Kubernetes is down.");
        expect(result.current.history).toHaveLength(1);
        expect(result.current.paused).toBe(false);

        fail = false;
        await advance(METRICS_POLL_INTERVAL_MS);
        expect(result.current.error).toBeUndefined();
        expect(result.current.history).toHaveLength(2);
    });

    it("uses a fallback message for a failure that is not an API error", async () => {
        vi.useFakeTimers();
        mockFetch(() => {
            throw new Error("network down");
        });
        const { result } = renderHook(() => useMetricsPolling(true));
        await advance(0);
        expect(result.current.error).toBe("Could not read the server's metrics.");
        expect(result.current.loading).toBe(false);
    });

    it("pauses on a refusal, saying why, and tries again on resume", async () => {
        vi.useFakeTimers();
        let elevated = false;
        const fetchMock = mockFetch(() =>
            elevated ? jsonResponse(200, metricsSample()) : jsonResponse(403, { code: "api-104", message: "Requires elevation." })
        );
        const { result } = renderHook(() => useMetricsPolling(true));
        await advance(0);
        expect(result.current.error).toBe(ELEVATION_MESSAGE);
        expect(result.current.paused).toBe(true);
        expect(result.current.loading).toBe(false);
        await advance(3 * METRICS_POLL_INTERVAL_MS);
        expect(metricsCalls(fetchMock)).toBe(1);

        elevated = true;
        act(() => result.current.setPaused(false));
        await advance(0);
        expect(result.current.error).toBeUndefined();
        expect(result.current.history).toHaveLength(1);
    });

    it("says the caller is not authorised for any other 403", async () => {
        vi.useFakeTimers();
        mockFetch(() => jsonResponse(403, { code: "api-103", message: "No." }));
        const { result } = renderHook(() => useMetricsPolling(true));
        await advance(0);
        expect(result.current.error).toBe(NOT_AUTHORISED_MESSAGE);
        expect(result.current.paused).toBe(true);
    });
});
