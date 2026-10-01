// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { settleWithLimit } from "../../../lib/util/settleWithLimit.js";

describe("settleWithLimit", () => {
    it("never has more than the limit running, and settles every item in order, failures included", async () => {
        let running = 0;
        let peak = 0;
        const outcomes = await settleWithLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
            running++;
            peak = Math.max(peak, running);
            await new Promise((resolve) => setTimeout(resolve, 5));
            running--;
            if (n === 4) throw new Error("four");
            return n * 10;
        });

        expect(peak).toBe(3);
        expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
        expect(outcomes.filter((o): o is PromiseFulfilledResult<number> => o.status === "fulfilled").map((o) => o.value)).toEqual([10, 20, 30, 50, 60, 70]);
        expect((outcomes[3] as PromiseRejectedResult).reason).toEqual(new Error("four"));
    });

    it("has nothing to do for no items, and runs fewer workers than the limit for few", async () => {
        expect(await settleWithLimit([], 5, async () => 1)).toEqual([]);
        expect(await settleWithLimit(["a"], 5, async (s) => s)).toEqual([{ status: "fulfilled", value: "a" }]);
    });
});
