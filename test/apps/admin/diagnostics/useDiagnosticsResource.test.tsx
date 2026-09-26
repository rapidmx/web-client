// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { ELEVATION_MESSAGE } from "../../../../apps/shared/components/admin/diagnostics/format.js";
import { useDiagnosticsResource } from "../../../../apps/shared/components/admin/diagnostics/useDiagnosticsResource.js";

describe("useDiagnosticsResource", () => {
    it("loads on mount and again when the reload key changes, keeping what it had meanwhile", async () => {
        let calls = 0;
        const gates: (() => void)[] = [];
        const load = () =>
            new Promise<string>((resolve) => {
                calls += 1;
                const value = `value ${calls}`;
                gates.push(() => resolve(value));
            });
        const { result, rerender } = renderHook(({ key }) => useDiagnosticsResource(load, key, "failed"), { initialProps: { key: 0 } });
        expect(result.current).toEqual({ data: undefined, error: undefined, loading: true });
        await act(async () => gates[0]());
        expect(result.current).toEqual({ data: "value 1", error: undefined, loading: false });

        rerender({ key: 1 });
        expect(result.current).toEqual({ data: "value 1", error: undefined, loading: true });
        await act(async () => gates[1]());
        expect(result.current).toEqual({ data: "value 2", error: undefined, loading: false });
    });

    it("says why a load failed, in the words for the administrator, and keeps the earlier data", async () => {
        let fail = false;
        const load = () => (fail ? Promise.reject(new ApiRequestError("Requires elevation.", 403, "api-104")) : Promise.resolve("ok"));
        const { result, rerender } = renderHook(({ key }) => useDiagnosticsResource(load, key, "failed"), { initialProps: { key: 0 } });
        await waitFor(() => expect(result.current.data).toBe("ok"));
        fail = true;
        rerender({ key: 1 });
        await waitFor(() => expect(result.current.error).toBe(ELEVATION_MESSAGE));
        expect(result.current).toEqual({ data: "ok", error: ELEVATION_MESSAGE, loading: false });
    });

    it("uses the fallback for a failure that is not an API error", async () => {
        const { result } = renderHook(() => useDiagnosticsResource(() => Promise.reject(new Error("boom")), 0, "Could not read it."));
        await waitFor(() => expect(result.current.error).toBe("Could not read it."));
    });

    it("drops the answer of a load that was overtaken or unmounted, good or failed", async () => {
        const settlers: { resolve: (value: string) => void; reject: (error: Error) => void }[] = [];
        const load = () =>
            new Promise<string>((resolve, reject) => {
                settlers.push({ resolve, reject });
            });
        const { result, rerender, unmount } = renderHook(({ key }) => useDiagnosticsResource(load, key, "failed"), { initialProps: { key: 0 } });
        rerender({ key: 1 });
        // The first load answers after the second began.
        await act(async () => settlers[0].resolve("stale"));
        expect(result.current.data).toBeUndefined();
        rerender({ key: 2 });
        await act(async () => settlers[1].reject(new Error("stale failure")));
        expect(result.current.error).toBeUndefined();
        expect(result.current.loading).toBe(true);

        unmount();
        await act(async () => settlers[2].resolve("late"));
        expect(result.current.data).toBeUndefined();
    });
});
