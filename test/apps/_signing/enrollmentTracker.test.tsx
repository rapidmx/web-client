// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";

const { checkSignEnrollmentStatus, checkSignEnrollmentNow } = vi.hoisted(() => ({
    checkSignEnrollmentStatus: vi.fn(),
    checkSignEnrollmentNow: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/crypto/keyvaultApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/crypto/keyvaultApi.js")>()),
    checkSignEnrollmentStatus,
    checkSignEnrollmentNow,
}));

import {
    ENROLLMENT_CHECK_COOLDOWN_MS,
    ENROLLMENT_POLL_DELAYS_MS,
    UNKNOWN_ENROLLMENT_CODE,
    checkEnrollmentNow,
    forgetEnrollment,
    getEnrollmentSnapshot,
    onEnrollmentEnded,
    recordEnrollmentResult,
    resetEnrollmentTracker,
    subscribeToEnrollments,
    useEnrollmentSnapshot,
    watchCurrentEnrollment,
    watchEnrollment,
} from "../../../apps/shared/signing/enrollmentTracker.js";
import { readStoredSignEnrollment } from "../../../apps/shared/signing/enrollmentStorage.js";

const MB = "mb1";
const pending = (extra = {}) => ({ status: "pending" as const, ...extra });

function setVisibility(state: "visible" | "hidden") {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
    vi.useFakeTimers();
    checkSignEnrollmentStatus.mockReset();
    checkSignEnrollmentNow.mockReset();
    localStorage.setItem(`rapidmx.signEnrollment.${MB}`, "enr-1");
});

afterEach(() => {
    vi.useRealTimers();
    // Back to visible for the next test.
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

describe("watching an enrollment", () => {
    it("reads it at once, then again after 15 s, 30 s and then every 60 s while it stays pending", async () => {
        checkSignEnrollmentStatus.mockResolvedValue(pending());
        watchEnrollment(MB, "enr-1");
        expect(getEnrollmentSnapshot(MB)).toMatchObject({ enrollmentId: "enr-1", result: null, checking: true });
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(1);
        expect(checkSignEnrollmentStatus).toHaveBeenCalledWith(MB, "enr-1");
        expect(getEnrollmentSnapshot(MB)).toMatchObject({ result: { status: "pending" }, checking: false, offline: false });
        expect(ENROLLMENT_POLL_DELAYS_MS).toEqual([15_000, 30_000, 60_000]);

        await act(() => vi.advanceTimersByTimeAsync(14_999));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(1);
        await act(() => vi.advanceTimersByTimeAsync(1));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(2);
        await act(() => vi.advanceTimersByTimeAsync(29_999));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(2);
        await act(() => vi.advanceTimersByTimeAsync(1));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(3);
        await act(() => vi.advanceTimersByTimeAsync(60_000));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(4);
        await act(() => vi.advanceTimersByTimeAsync(60_000));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(5);
    });

    it("does not ask first when told what the enrollment is, and starts the backoff from there", async () => {
        watchEnrollment(MB, "enr-1", { initial: pending({ progress: 20 }) });
        expect(getEnrollmentSnapshot(MB)?.result).toEqual({ status: "pending", progress: 20 });
        expect(checkSignEnrollmentStatus).not.toHaveBeenCalled();
        checkSignEnrollmentStatus.mockResolvedValue(pending({ progress: 40 }));
        await act(() => vi.advanceTimersByTimeAsync(15_000));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(1);
        expect(getEnrollmentSnapshot(MB)?.result?.progress).toBe(40);
    });

    it("stops for good when it is issued: forgets the stored id, tells the listeners once, and drops the entry when the last watcher lets go", async () => {
        checkSignEnrollmentStatus.mockResolvedValueOnce(pending()).mockResolvedValue({ status: "issued", subject: "E=a@b.c" });
        const ended = vi.fn();
        onEnrollmentEnded(ended);
        const release = watchEnrollment(MB, "enr-1");
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(ended).not.toHaveBeenCalled();
        await act(() => vi.advanceTimersByTimeAsync(15_000));
        expect(ended).toHaveBeenCalledTimes(1);
        expect(ended.mock.calls[0][0]).toMatchObject({ mailboxUid: MB, enrollmentId: "enr-1", result: { status: "issued" } });
        expect(readStoredSignEnrollment(MB)).toBeNull();

        await act(() => vi.advanceTimersByTimeAsync(300_000));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(2);
        // A second (issued) answer for the same enrollment is not announced again.
        recordEnrollmentResult(MB, "enr-1", { status: "issued" });
        expect(ended).toHaveBeenCalledTimes(1);

        release();
        release();
        expect(getEnrollmentSnapshot(MB)).toBeUndefined();
    });

    it("announces a failure too, but not the end of one that was never seen pending", async () => {
        const ended = vi.fn();
        onEnrollmentEnded(ended);
        checkSignEnrollmentStatus.mockResolvedValue({ status: "failed", error: "No." });
        watchEnrollment(MB, "enr-1");
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(ended).toHaveBeenCalledTimes(1);
        expect(readStoredSignEnrollment(MB)).toBeNull();

        watchEnrollment("mb2", "enr-9", { initial: { status: "issued" }, expectPending: false });
        expect(getEnrollmentSnapshot("mb2")?.result?.status).toBe("issued");
        expect(ended).toHaveBeenCalledTimes(1);
    });

    it("a later watcher that expects it to be pending makes its end news, unless it has already ended", async () => {
        const ended = vi.fn();
        onEnrollmentEnded(ended);
        watchEnrollment(MB, "enr-1", { initial: pending(), expectPending: false });
        watchEnrollment(MB, "enr-1", { expectPending: true });
        recordEnrollmentResult(MB, "enr-1", { status: "issued" });
        expect(ended).toHaveBeenCalledTimes(1);

        watchEnrollment("mb2", "e", { initial: { status: "issued" }, expectPending: false });
        watchEnrollment("mb2", "e", { expectPending: true });
        recordEnrollmentResult("mb2", "e", { status: "issued" });
        expect(ended).toHaveBeenCalledTimes(1);
    });

    it("forgets an enrollment the server no longer knows (404, coded or not)", async () => {
        checkSignEnrollmentStatus.mockRejectedValue(new ApiRequestError("gone", 404, "signing-enrollment-unknown"));
        watchEnrollment(MB, "enr-1");
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(getEnrollmentSnapshot(MB)).toMatchObject({ gone: true, result: null, checking: false });
        expect(readStoredSignEnrollment(MB)).toBeNull();
        await act(() => vi.advanceTimersByTimeAsync(120_000));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(1);
    });

    it("keeps asking after a failed read, and says it is offline until one answers", async () => {
        checkSignEnrollmentStatus.mockRejectedValueOnce(new Error("network")).mockResolvedValue(pending());
        watchEnrollment(MB, "enr-1");
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(getEnrollmentSnapshot(MB)).toMatchObject({ offline: true, result: null });
        await act(() => vi.advanceTimersByTimeAsync(15_000));
        expect(getEnrollmentSnapshot(MB)).toMatchObject({ offline: false, result: { status: "pending" } });
    });

    it("asks nothing while the page is hidden, and asks at once (backoff restarted) when it is shown or the window is focused", async () => {
        checkSignEnrollmentStatus.mockResolvedValue(pending());
        watchEnrollment(MB, "enr-1");
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(1);

        setVisibility("hidden");
        await act(() => vi.advanceTimersByTimeAsync(200_000));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(1);
        // Still hidden: nothing happens on a focus event either.
        window.dispatchEvent(new Event("focus"));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(1);

        setVisibility("visible");
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(2);
        // The backoff started over: the next look is 15 s away, not 60 s.
        await act(() => vi.advanceTimersByTimeAsync(15_000));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(3);

        setVisibility("hidden");
        await act(() => vi.advanceTimersByTimeAsync(100_000));
        setVisibility("visible");
        setVisibility("visible");
        await act(() => vi.advanceTimersByTimeAsync(0));
        // The second event finds nothing paused any more.
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(4);

        setVisibility("hidden");
        await act(() => vi.advanceTimersByTimeAsync(100_000));
        window.dispatchEvent(new Event("online"));
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(4);
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        window.dispatchEvent(new Event("focus"));
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(5);
    });

    it("shares one follower between watchers, keeps a pending enrollment after the last lets go, and replaces it for a different id", async () => {
        checkSignEnrollmentStatus.mockResolvedValue(pending());
        const first = watchEnrollment(MB, "enr-1");
        const second = watchEnrollment(MB, "enr-1", { initial: pending({ progress: 1 }) });
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(1);
        first();
        second();
        // Nobody is looking, but it is pending: it goes on (the frame tells the user when it ends).
        await act(() => vi.advanceTimersByTimeAsync(30_000));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(2);
        expect(getEnrollmentSnapshot(MB)).toBeDefined();

        const before = getEnrollmentSnapshot(MB);
        const third = watchEnrollment(MB, "enr-2", { initial: pending() });
        expect(getEnrollmentSnapshot(MB)).not.toBe(before);
        expect(getEnrollmentSnapshot(MB)?.enrollmentId).toBe("enr-2");
        // The old holders' release does nothing to the new entry.
        first();
        expect(getEnrollmentSnapshot(MB)?.enrollmentId).toBe("enr-2");
        third();
        expect(getEnrollmentSnapshot(MB)).toBeDefined();
    });

    it("releases a gone enrollment's entry", async () => {
        checkSignEnrollmentStatus.mockRejectedValue(new ApiRequestError("gone", 404));
        const release = watchEnrollment(MB, "enr-1");
        await act(() => vi.advanceTimersByTimeAsync(0));
        release();
        expect(getEnrollmentSnapshot(MB)).toBeUndefined();
    });

    it("adopts what the server reports as the current enrollment", async () => {
        const release = watchCurrentEnrollment(MB, { enrollmentId: "enr-7", status: "pending", stage: "validating" });
        expect(getEnrollmentSnapshot(MB)).toMatchObject({ enrollmentId: "enr-7", result: { status: "pending", stage: "validating" } });
        expect(getEnrollmentSnapshot(MB)?.result).not.toHaveProperty("enrollmentId");
        const ended = vi.fn();
        onEnrollmentEnded(ended);
        recordEnrollmentResult(MB, "enr-7", { status: "issued" });
        expect(ended).toHaveBeenCalledTimes(1);
        release();

        watchCurrentEnrollment("mb2", { enrollmentId: "old", status: "issued" }, false);
        expect(ended).toHaveBeenCalledTimes(1);
    });

    it("ignores a result for an enrollment that is not the one followed, and forgets one that was cancelled", async () => {
        watchEnrollment(MB, "enr-1", { initial: pending() });
        recordEnrollmentResult(MB, "other", { status: "issued" });
        recordEnrollmentResult("nobody", "enr-1", { status: "issued" });
        expect(getEnrollmentSnapshot(MB)?.result?.status).toBe("pending");
        forgetEnrollment("nobody");
        forgetEnrollment(MB);
        expect(getEnrollmentSnapshot(MB)).toBeUndefined();
        // Nothing is left running.
        checkSignEnrollmentStatus.mockResolvedValue(pending());
        await act(() => vi.advanceTimersByTimeAsync(120_000));
        expect(checkSignEnrollmentStatus).not.toHaveBeenCalled();
    });

    it("ignores an answer that arrives after the entry was replaced or forgotten", async () => {
        let answer: (value: unknown) => void = () => undefined;
        checkSignEnrollmentStatus.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
        watchEnrollment(MB, "enr-1");
        forgetEnrollment(MB);
        await act(async () => answer({ status: "issued" }));
        expect(getEnrollmentSnapshot(MB)).toBeUndefined();

        let fail: (error: unknown) => void = () => undefined;
        checkSignEnrollmentStatus.mockReturnValueOnce(new Promise((_resolve, reject) => (fail = reject)));
        watchEnrollment(MB, "enr-1");
        forgetEnrollment(MB);
        await act(async () => fail(new Error("late")));
        expect(getEnrollmentSnapshot(MB)).toBeUndefined();
    });

    it("does nothing when a timer comes due for an entry that has been forgotten or that ended meanwhile", async () => {
        watchEnrollment(MB, "enr-1", { initial: pending() });
        forgetEnrollment(MB);
        await act(() => vi.advanceTimersByTimeAsync(20_000));
        expect(checkSignEnrollmentStatus).not.toHaveBeenCalled();
    });

    it("tells the subscribers about every change, and stops when they unsubscribe", () => {
        const listener = vi.fn();
        const off = subscribeToEnrollments(listener);
        watchEnrollment(MB, "enr-1", { initial: pending() });
        expect(listener).toHaveBeenCalled();
        listener.mockClear();
        off();
        recordEnrollmentResult(MB, "enr-1", { status: "issued" });
        expect(listener).not.toHaveBeenCalled();
        const ended = vi.fn();
        onEnrollmentEnded(ended)();
        resetEnrollmentTracker();
        expect(getEnrollmentSnapshot(MB)).toBeUndefined();
    });
});

describe("Check status", () => {
    it("asks the server to re-check, reports a change or no change, and is unavailable for the cooldown", async () => {
        watchEnrollment(MB, "enr-1", { initial: pending({ stage: "awaiting-challenge", progress: 30 }) });
        checkSignEnrollmentNow.mockResolvedValueOnce(pending({ stage: "awaiting-challenge", progress: 30 })).mockResolvedValueOnce(pending({ stage: "validating", progress: 70 }));

        const done = checkEnrollmentNow(MB);
        expect(getEnrollmentSnapshot(MB)).toMatchObject({ checkingNow: true, checking: true });
        await act(async () => {
            await done;
        });
        expect(checkSignEnrollmentNow).toHaveBeenCalledWith(MB, "enr-1");
        const snapshot = getEnrollmentSnapshot(MB)!;
        expect(snapshot).toMatchObject({ checkingNow: false, lastCheck: { outcome: "unchanged" } });
        expect(snapshot.retryAt).toBe(Date.now() + ENROLLMENT_CHECK_COOLDOWN_MS);

        // Within the cooldown nothing is sent.
        await act(async () => {
            await checkEnrollmentNow(MB);
        });
        expect(checkSignEnrollmentNow).toHaveBeenCalledTimes(1);

        await act(() => vi.advanceTimersByTimeAsync(ENROLLMENT_CHECK_COOLDOWN_MS));
        await act(async () => {
            await checkEnrollmentNow(MB);
        });
        expect(getEnrollmentSnapshot(MB)).toMatchObject({ result: { stage: "validating" }, lastCheck: { outcome: "changed" } });
    });

    it("counts a first answer as a change, ends the enrollment when the check finds it issued, and does nothing afterwards", async () => {
        watchEnrollment(MB, "enr-1", { initial: pending() });
        const ended = vi.fn();
        onEnrollmentEnded(ended);
        checkSignEnrollmentNow.mockResolvedValue({ status: "issued" });
        await act(async () => {
            await checkEnrollmentNow(MB);
        });
        expect(ended).toHaveBeenCalledTimes(1);
        expect(getEnrollmentSnapshot(MB)?.lastCheck?.outcome).toBe("changed");
        await act(async () => {
            await checkEnrollmentNow(MB);
        });
        expect(checkSignEnrollmentNow).toHaveBeenCalledTimes(1);
    });

    it("does nothing for a mailbox nobody follows, or while a check is already under way", async () => {
        await checkEnrollmentNow("nobody");
        expect(checkSignEnrollmentNow).not.toHaveBeenCalled();
        watchEnrollment(MB, "enr-1", { initial: pending() });
        let answer: (value: unknown) => void = () => undefined;
        checkSignEnrollmentNow.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
        const first = checkEnrollmentNow(MB);
        await checkEnrollmentNow(MB);
        expect(checkSignEnrollmentNow).toHaveBeenCalledTimes(1);
        await act(async () => {
            answer(pending());
            await first;
        });
    });

    it("waits out a 429 for as long as the server said, else the default ten seconds", async () => {
        watchEnrollment(MB, "enr-1", { initial: pending() });
        checkSignEnrollmentNow.mockRejectedValueOnce(new ApiRequestError("Too soon.", 429, undefined, { retryAfter: 4 }));
        await act(async () => {
            await checkEnrollmentNow(MB);
        });
        expect(getEnrollmentSnapshot(MB)).toMatchObject({ checkingNow: false, checking: false, lastCheck: { outcome: "limited" }, retryAt: Date.now() + 4000 });
        await act(() => vi.advanceTimersByTimeAsync(4000));
        checkSignEnrollmentNow.mockRejectedValueOnce(new ApiRequestError("Too soon.", 429));
        await act(async () => {
            await checkEnrollmentNow(MB);
        });
        expect(getEnrollmentSnapshot(MB)?.retryAt).toBe(Date.now() + 10_000);
    });

    it("falls back to a plain read on a server without the check endpoint", async () => {
        watchEnrollment(MB, "enr-1", { initial: pending() });
        for (const status of [404, 405, 501]) {
            checkSignEnrollmentNow.mockRejectedValueOnce(new ApiRequestError("No such route.", status));
            checkSignEnrollmentStatus.mockResolvedValueOnce(pending());
            await act(async () => {
                await checkEnrollmentNow(MB);
            });
            expect(getEnrollmentSnapshot(MB)).toMatchObject({ result: { status: "pending" }, lastCheck: { outcome: "unchanged" } });
            await act(() => vi.advanceTimersByTimeAsync(ENROLLMENT_CHECK_COOLDOWN_MS));
        }
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(3);
        // ...and it says when that read found something new.
        checkSignEnrollmentNow.mockRejectedValueOnce(new ApiRequestError("No such route.", 404));
        checkSignEnrollmentStatus.mockResolvedValueOnce(pending({ stage: "validating" }));
        await act(async () => {
            await checkEnrollmentNow(MB);
        });
        expect(getEnrollmentSnapshot(MB)?.lastCheck?.outcome).toBe("changed");
    });

    it("says so when the fallback read finds the enrollment gone, or cannot reach the server", async () => {
        watchEnrollment(MB, "enr-1", { initial: pending() });
        checkSignEnrollmentNow.mockRejectedValue(new ApiRequestError("No such route.", 404));
        checkSignEnrollmentStatus.mockRejectedValueOnce(new Error("network"));
        await act(async () => {
            await checkEnrollmentNow(MB);
        });
        expect(getEnrollmentSnapshot(MB)).toMatchObject({ offline: true, checkingNow: false, lastCheck: { outcome: "failed" } });
        await act(() => vi.advanceTimersByTimeAsync(ENROLLMENT_CHECK_COOLDOWN_MS));
        checkSignEnrollmentStatus.mockRejectedValueOnce(new ApiRequestError("gone", 404));
        await act(async () => {
            await checkEnrollmentNow(MB);
        });
        expect(getEnrollmentSnapshot(MB)).toMatchObject({ gone: true, checkingNow: false, lastCheck: { outcome: "failed" } });
    });

    it("ends a check at once, with no fallback read, when the server says it does not know the enrollment (another provider after a configuration change)", async () => {
        expect(UNKNOWN_ENROLLMENT_CODE).toBe("signing-enrollment-unknown");
        watchEnrollment(MB, "enr-1", { initial: pending() });
        checkSignEnrollmentNow.mockRejectedValue(new ApiRequestError("Unknown request.", 404, UNKNOWN_ENROLLMENT_CODE));
        await act(async () => {
            await checkEnrollmentNow(MB);
        });
        expect(checkSignEnrollmentStatus).not.toHaveBeenCalled();
        expect(getEnrollmentSnapshot(MB)).toMatchObject({ gone: true, checkingNow: false, lastCheck: { outcome: "failed" } });
        expect(readStoredSignEnrollment(MB)).toBeNull();
        // Nothing is polled for ever: the request is over.
        await act(() => vi.advanceTimersByTimeAsync(300_000));
        expect(checkSignEnrollmentStatus).not.toHaveBeenCalled();
    });

    it("reports a failure that is not a missing route, and lets it be tried again at once", async () => {
        watchEnrollment(MB, "enr-1", { initial: pending() });
        checkSignEnrollmentNow.mockRejectedValueOnce(new ApiRequestError("Boom.", 500)).mockRejectedValueOnce(new Error("network"));
        await act(async () => {
            await checkEnrollmentNow(MB);
        });
        expect(getEnrollmentSnapshot(MB)).toMatchObject({ checkingNow: false, checking: false, retryAt: 0, lastCheck: { outcome: "failed" } });
        await act(async () => {
            await checkEnrollmentNow(MB);
        });
        expect(checkSignEnrollmentNow).toHaveBeenCalledTimes(2);
    });

    it("drops the outcome of a check whose entry was forgotten while it was under way", async () => {
        watchEnrollment(MB, "enr-1", { initial: pending() });
        let fail: (error: unknown) => void = () => undefined;
        checkSignEnrollmentNow.mockReturnValueOnce(new Promise((_resolve, reject) => (fail = reject)));
        const done = checkEnrollmentNow(MB);
        forgetEnrollment(MB);
        await act(async () => {
            fail(new Error("late"));
            await done;
        });
        expect(getEnrollmentSnapshot(MB)).toBeUndefined();
    });
});

describe("useEnrollmentSnapshot", () => {
    function Probe({ mailboxUid }: { mailboxUid?: string }) {
        const snapshot = useEnrollmentSnapshot(mailboxUid);
        return <span data-testid="state">{snapshot ? `${snapshot.enrollmentId}:${snapshot.result?.status ?? "unknown"}` : "none"}</span>;
    }

    it("follows the mailbox's enrollment as it changes", () => {
        const { rerender } = render(<Probe mailboxUid={MB} />);
        expect(screen.getByTestId("state")).toHaveTextContent("none");
        act(() => {
            watchEnrollment(MB, "enr-1", { initial: pending() });
        });
        expect(screen.getByTestId("state")).toHaveTextContent("enr-1:pending");
        act(() => recordEnrollmentResult(MB, "enr-1", { status: "failed" }));
        expect(screen.getByTestId("state")).toHaveTextContent("enr-1:failed");
        rerender(<Probe />);
        expect(screen.getByTestId("state")).toHaveTextContent("none");
    });
});
