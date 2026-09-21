// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_FALLBACK_DELAY_MS, IDLE_TIMEOUT_MS, shouldSaveData, whenIdle } from "../../../apps/shared/navigation/idle.js";

function setReadyState(state: DocumentReadyState | undefined) {
    if (state === undefined) {
        delete (document as any).readyState;
    } else {
        Object.defineProperty(document, "readyState", { configurable: true, get: () => state });
    }
}

afterEach(() => {
    setReadyState(undefined);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete (window as any).requestIdleCallback;
    delete (window as any).cancelIdleCallback;
    delete (navigator as any).connection;
});

describe("whenIdle", () => {
    describe("with requestIdleCallback", () => {
        let idleCallbacks: (() => void)[];
        let cancelIdleCallback: ReturnType<typeof vi.fn>;
        let requestIdleCallback: ReturnType<typeof vi.fn>;
        beforeEach(() => {
            idleCallbacks = [];
            requestIdleCallback = vi.fn((callback: () => void) => idleCallbacks.push(callback));
            cancelIdleCallback = vi.fn();
            (window as any).requestIdleCallback = requestIdleCallback;
            (window as any).cancelIdleCallback = cancelIdleCallback;
        });

        it("asks for an idle period with a timeout at once when the page has already loaded, and runs the callback in it", () => {
            const callback = vi.fn();
            whenIdle(callback);
            expect(requestIdleCallback).toHaveBeenCalledWith(callback, { timeout: IDLE_TIMEOUT_MS });
        });

        it("waits for the load event while the page is still loading", () => {
            setReadyState("loading");
            const callback = vi.fn();
            whenIdle(callback);
            expect(requestIdleCallback).not.toHaveBeenCalled();
            window.dispatchEvent(new Event("load"));
            expect(requestIdleCallback).toHaveBeenCalledTimes(1);
        });

        it("cancels the idle callback once requested", () => {
            const cancel = whenIdle(vi.fn());
            cancel();
            expect(cancelIdleCallback).toHaveBeenCalledWith(expect.anything());
        });

        it("never schedules anything when cancelled before the page has loaded", () => {
            setReadyState("loading");
            const cancel = whenIdle(vi.fn());
            cancel();
            window.dispatchEvent(new Event("load"));
            expect(requestIdleCallback).not.toHaveBeenCalled();
        });
    });

    describe("without requestIdleCallback", () => {
        it("runs the callback shortly after the page has loaded", () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const callback = vi.fn();
            whenIdle(callback);
            expect(callback).not.toHaveBeenCalled();
            vi.advanceTimersByTime(IDLE_FALLBACK_DELAY_MS);
            expect(callback).toHaveBeenCalledTimes(1);
        });

        it("can be cancelled before it runs", () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const callback = vi.fn();
            const cancel = whenIdle(callback);
            cancel();
            vi.advanceTimersByTime(IDLE_FALLBACK_DELAY_MS * 2);
            expect(callback).not.toHaveBeenCalled();
        });
    });
});

describe("shouldSaveData", () => {
    it("is false when the browser reports nothing about the connection", () => {
        expect(shouldSaveData()).toBe(false);
    });

    it("is true when the user asked to save data", () => {
        (navigator as any).connection = { saveData: true };
        expect(shouldSaveData()).toBe(true);
    });

    it("is true on a 2G-class connection and false on a fast one", () => {
        (navigator as any).connection = { effectiveType: "2g" };
        expect(shouldSaveData()).toBe(true);
        (navigator as any).connection = { effectiveType: "slow-2g" };
        expect(shouldSaveData()).toBe(true);
        (navigator as any).connection = { effectiveType: "4g", saveData: false };
        expect(shouldSaveData()).toBe(false);
    });
});
