///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushComposeDrafts, registerComposeFlush } from "../../../apps/shared/components/mail/compose/composeFlushRegistry.js";

describe("composeFlushRegistry", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("runs every registered flush, ignores failures, and stops calling one once it's unregistered", async () => {
        const ok = vi.fn().mockResolvedValue("saved");
        const failing = vi.fn().mockRejectedValue(new Error("offline"));
        const unregisterOk = registerComposeFlush(ok);
        const unregisterFailing = registerComposeFlush(failing);

        await expect(flushComposeDrafts(1_000)).resolves.toBeUndefined();
        expect(ok).toHaveBeenCalledTimes(1);
        expect(failing).toHaveBeenCalledTimes(1);

        unregisterOk();
        unregisterFailing();
        await flushComposeDrafts(1_000);
        expect(ok).toHaveBeenCalledTimes(1);
    });

    it("gives up waiting after the timeout", async () => {
        vi.useFakeTimers();
        const unregister = registerComposeFlush(() => new Promise(() => undefined));
        let settled = false;
        void flushComposeDrafts(500).then(() => (settled = true));

        await vi.advanceTimersByTimeAsync(499);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
        unregister();
    });
});
