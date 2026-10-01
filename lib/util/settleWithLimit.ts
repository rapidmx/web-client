///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Runs `task` for each of `items`, never more than `limit` of them at once, and resolves to what became of every one in the order of `items`, as
 * `Promise.allSettled()` does - a task that fails does not stop the others. For a batch of requests too big to send all at once (a thousand rows ticked).
 */
export async function settleWithLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
    const outcomes = new Array<PromiseSettledResult<R>>(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const index = next++;
            try {
                outcomes[index] = { status: "fulfilled", value: await task(items[index]) };
            } catch (reason) {
                outcomes[index] = { status: "rejected", reason };
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return outcomes;
}
