// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDayKey } from "../../../lib/calendar/useDayKey.js";

describe("useDayKey", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 5, 15, 23, 59, 30));
    });
    afterEach(() => vi.useRealTimers());

    it("is today's local date, and moves on to the next day at local midnight, again each night", () => {
        const { result } = renderHook(() => useDayKey());
        expect(result.current).toBe("2026-06-15");

        act(() => void vi.advanceTimersByTime(20_000));
        expect(result.current).toBe("2026-06-15");
        act(() => void vi.advanceTimersByTime(20_000));
        expect(result.current).toBe("2026-06-16");

        act(() => void vi.advanceTimersByTime(24 * 60 * 60 * 1000));
        expect(result.current).toBe("2026-06-17");
    });

    it("is re-read when the tab becomes visible again (a slept machine's timer never fired), but not when it is hidden", () => {
        const { result } = renderHook(() => useDayKey());
        vi.setSystemTime(new Date(2026, 5, 18, 8, 0, 0));
        expect(result.current).toBe("2026-06-15");

        const visibility = vi.spyOn(document, "visibilityState", "get");
        visibility.mockReturnValue("hidden");
        act(() => void document.dispatchEvent(new Event("visibilitychange")));
        expect(result.current).toBe("2026-06-15");
        visibility.mockReturnValue("visible");
        act(() => void document.dispatchEvent(new Event("visibilitychange")));
        expect(result.current).toBe("2026-06-18");
        visibility.mockRestore();
    });

    it.each([["focus"], ["pageshow"]])("is re-read on the window's %s event: a laptop that slept through midnight with the tab still visible gets no visibilitychange", (name) => {
        const { result } = renderHook(() => useDayKey());
        vi.setSystemTime(new Date(2026, 5, 16, 7, 0, 0));
        expect(result.current).toBe("2026-06-15");
        act(() => void window.dispatchEvent(new Event(name)));
        expect(result.current).toBe("2026-06-16");
        // The timer was set again from the real clock: the next midnight, not the stale one.
        expect(vi.getTimerCount()).toBe(1);
        act(() => void vi.advanceTimersByTime(17 * 60 * 60 * 1000 + 2000));
        expect(result.current).toBe("2026-06-17");
    });

    it("stops its timer and listener when unmounted", () => {
        const { unmount } = renderHook(() => useDayKey());
        expect(vi.getTimerCount()).toBe(1);
        unmount();
        expect(vi.getTimerCount()).toBe(0);
        // Nothing listens any more: the events change nothing and set no timer.
        act(() => void window.dispatchEvent(new Event("focus")));
        act(() => void window.dispatchEvent(new Event("pageshow")));
        expect(vi.getTimerCount()).toBe(0);
    });
});
