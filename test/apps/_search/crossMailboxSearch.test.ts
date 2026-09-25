///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    MailboxHit,
    SEARCH_LIMITS,
    SearchTimeoutError,
    classifyFailure,
    describeFailures,
    hitKey,
    mergeSearchResults,
    runLimited,
    searchPageSize,
    tagHits,
    withTimeout,
} from "../../../apps/shared/search/crossMailboxSearch.js";

function hit(mailboxUid: string, entityUid: string, score: number, extra: Partial<MailboxHit> = {}): MailboxHit {
    return { entityType: "message", entityUid, score, mailboxUid, ...extra };
}

afterEach(() => {
    vi.useRealTimers();
});

describe("searchPageSize", () => {
    it("gives one mailbox the whole page and shares it between several, never below the minimum", () => {
        expect(searchPageSize(0, 50)).toBe(50);
        expect(searchPageSize(1, 50)).toBe(50);
        expect(searchPageSize(2, 50)).toBe(25);
        expect(searchPageSize(3, 50)).toBe(17);
        expect(searchPageSize(25, 50)).toBe(10);
    });
});

describe("tagHits and hitKey", () => {
    it("remembers the mailbox on each hit, and keys a hit by mailbox and uid", () => {
        const tagged = tagHits("mb1", [{ entityType: "message", entityUid: "m1", score: 1 }]);
        expect(tagged).toEqual([{ entityType: "message", entityUid: "m1", score: 1, mailboxUid: "mb1" }]);
        expect(hitKey(tagged[0])).not.toBe(hitKey({ mailboxUid: "mb2", entityUid: "m1" }));
        expect(hitKey(tagged[0])).toBe(hitKey({ mailboxUid: "mb1", entityUid: "m1" }));
    });
});

describe("mergeSearchResults", () => {
    it("ranks each tier's hits pooled across mailboxes, best first", () => {
        // Pooled per tier: mb2's 20 is the tier's best (1.0) and mb1's 10 the worst (0.0), so mb1 is not automatically "1.0" in its own mailbox.
        const merged = mergeSearchResults([hit("mb1", "a", 10), hit("mb1", "b", 15), hit("mb2", "c", 20)], [], []);
        expect(merged.map((h) => h.entityUid)).toEqual(["c", "b", "a"]);
        expect(merged.map((h) => h.mailboxUid)).toEqual(["mb2", "mb1", "mb1"]);
    });

    it("keeps the same uid found in two mailboxes as two hits", () => {
        const merged = mergeSearchResults([hit("mb1", "m1", 2), hit("mb2", "m1", 1)], [], []);
        expect(merged.map((h) => h.mailboxUid)).toEqual(["mb1", "mb2"]);
    });

    it("lets Tier 2 win over Tier 3 win over Tier 1 for the same hit in the same mailbox", () => {
        const merged = mergeSearchResults(
            [hit("mb1", "m1", 5, { metadataOnly: true }), hit("mb1", "m2", 1)],
            [hit("mb1", "m1", 1, { source: "local" })],
            [hit("mb1", "m1", 1, { source: "candidate" }), hit("mb1", "m3", 9, { source: "candidate" })],
        );
        expect(merged.find((h) => h.entityUid === "m1")?.source).toBe("local");
        expect(merged).toHaveLength(3);
    });

    it("keeps the order the lists were given in among equal scores", () => {
        const merged = mergeSearchResults([hit("mb1", "a", 1), hit("mb2", "b", 1), hit("mb3", "c", 1)], [], []);
        expect(merged.map((h) => h.mailboxUid)).toEqual(["mb1", "mb2", "mb3"]);
    });

    it("returns nothing for no hits", () => {
        expect(mergeSearchResults([], [], [])).toEqual([]);
    });
});

describe("withTimeout", () => {
    it("resolves with the value, and rejects with the promise's own reason", async () => {
        await expect(withTimeout(Promise.resolve(3), 1_000)).resolves.toBe(3);
        await expect(withTimeout(Promise.reject(new Error("boom")), 1_000)).rejects.toThrow("boom");
    });

    it("rejects with a SearchTimeoutError once the time is up", async () => {
        vi.useFakeTimers();
        const pending = withTimeout(new Promise<number>(() => undefined), 50);
        const assertion = expect(pending).rejects.toBeInstanceOf(SearchTimeoutError);
        await vi.advanceTimersByTimeAsync(60);
        await assertion;
    });

    it("waits as long as it takes for a non-finite time", async () => {
        const promise = Promise.resolve("late");
        expect(withTimeout(promise, Infinity)).toBe(promise);
    });
});

describe("runLimited", () => {
    it("never runs more than `concurrency` tasks at once and runs them all, in order", async () => {
        let running = 0;
        let peak = 0;
        const started: number[] = [];
        await runLimited(
            [1, 2, 3, 4, 5],
            2,
            async (item) => {
                started.push(item);
                running += 1;
                peak = Math.max(peak, running);
                await new Promise((resolve) => setTimeout(resolve, 5));
                running -= 1;
            },
            () => false,
        );
        expect(started).toEqual([1, 2, 3, 4, 5]);
        expect(peak).toBe(2);
    });

    it("does nothing for no items", async () => {
        const task = vi.fn();
        await runLimited([], 4, task, () => false);
        expect(task).not.toHaveBeenCalled();
    });

    it("stops starting tasks once cancelled", async () => {
        let cancelled = false;
        const started: number[] = [];
        await runLimited(
            [1, 2, 3, 4],
            1,
            async (item) => {
                started.push(item);
                cancelled = true;
            },
            () => cancelled,
        );
        expect(started).toEqual([1]);
    });

    it("rejects with the first failure and starts no more tasks after it", async () => {
        const started: number[] = [];
        await expect(
            runLimited(
                [1, 2, 3, 4],
                1,
                async (item) => {
                    started.push(item);
                    if (item === 2) {
                        throw new Error("second");
                    }
                },
                () => false,
            ),
        ).rejects.toThrow("second");
        expect(started).toEqual([1, 2]);
    });
});

describe("classifyFailure", () => {
    it("names the class of failure, never the server's own text", () => {
        expect(classifyFailure(new SearchTimeoutError())).toBe("timed out");
        expect(classifyFailure(new ApiRequestError("nope", 403))).toBe("access denied");
        expect(classifyFailure(new ApiRequestError("nope", 401))).toBe("access denied");
        expect(classifyFailure(new ApiRequestError("nope", 500))).toBe("server error");
        expect(classifyFailure(new ApiRequestError("nope", 503))).toBe("server error");
        expect(classifyFailure(new ApiRequestError("nope", 404))).toBe("rejected by the server");
        expect(classifyFailure(new TypeError("Failed to fetch"))).toBe("network error");
    });
});

describe("describeFailures", () => {
    it("lists each mailbox with why, marking an encrypted-mail-only failure", () => {
        expect(
            describeFailures([
                { mailboxUid: "mb2", mailboxName: "Support", encrypted: false, reason: "timed out" },
                { mailboxUid: "mb3", mailboxName: "Sales", encrypted: true, reason: "server error" },
            ]),
        ).toBe("Support (timed out), Sales (encrypted mail: server error) could not be searched.");
    });
});

describe("SEARCH_LIMITS", () => {
    it("defaults to four at once, twenty-five mailboxes and the page's own row cap", () => {
        expect(SEARCH_LIMITS.concurrency).toBe(4);
        expect(SEARCH_LIMITS.maxMailboxes).toBe(25);
        expect(SEARCH_LIMITS.maxRows).toBe(500);
    });
});
