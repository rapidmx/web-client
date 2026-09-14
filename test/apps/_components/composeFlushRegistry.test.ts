///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSigningOut, flushComposeDrafts, isSigningOut, markSigningOut, registerComposeFlush } from "../../../apps/shared/components/mail/compose/composeFlushRegistry.js";

describe("composeFlushRegistry", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("runs every registered flush, ignores failures, and stops calling one once it's unregistered", async () => {
        const ok = vi.fn().mockResolvedValue(true);
        const failing = vi.fn().mockRejectedValue(new Error("offline"));
        const unregisterOk = registerComposeFlush(ok);
        const unregisterFailing = registerComposeFlush(failing);

        await expect(flushComposeDrafts(1_000)).resolves.toBe(false);
        expect(ok).toHaveBeenCalledTimes(1);
        expect(failing).toHaveBeenCalledTimes(1);

        unregisterFailing();
        await expect(flushComposeDrafts(1_000)).resolves.toBe(true);
        expect(ok).toHaveBeenCalledTimes(2);

        const unsaved = registerComposeFlush(vi.fn().mockResolvedValue(false));
        await expect(flushComposeDrafts(1_000)).resolves.toBe(false);
        unsaved();

        unregisterOk();
        await expect(flushComposeDrafts(1_000)).resolves.toBe(true);
        expect(ok).toHaveBeenCalledTimes(3);
    });

    it("gives up waiting after the timeout", async () => {
        vi.useFakeTimers();
        const unregister = registerComposeFlush(() => new Promise(() => undefined));
        let settled: boolean | undefined;
        void flushComposeDrafts(500).then((saved) => (settled = saved));

        await vi.advanceTimersByTimeAsync(499);
        expect(settled).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(false);
        unregister();
    });

    it("tracks whether the app is signing out", () => {
        expect(isSigningOut()).toBe(false);
        markSigningOut();
        expect(isSigningOut()).toBe(true);
        clearSigningOut();
        expect(isSigningOut()).toBe(false);
    });
});
