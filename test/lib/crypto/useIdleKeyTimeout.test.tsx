// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { destroyUnlockedKeys } = vi.hoisted(() => ({ destroyUnlockedKeys: vi.fn() }));
vi.mock("../../../lib/crypto/keySession.js", () => ({ destroyUnlockedKeys }));

const { getIdleTimeoutMinutes } = vi.hoisted(() => ({ getIdleTimeoutMinutes: vi.fn() }));
vi.mock("../../../lib/crypto/idleTimeout.js", () => ({ getIdleTimeoutMinutes }));

import { useIdleKeyTimeout } from "../../../lib/crypto/useIdleKeyTimeout.js";

function Harness() {
    useIdleKeyTimeout();
    return null;
}

afterEach(() => {
    vi.useRealTimers();
    destroyUnlockedKeys.mockReset();
    getIdleTimeoutMinutes.mockReset();
});

describe("useIdleKeyTimeout", () => {
    it("destroys unlocked keys after the configured idle period with no activity", () => {
        vi.useFakeTimers();
        getIdleTimeoutMinutes.mockReturnValue(5);
        render(<Harness />);

        vi.advanceTimersByTime(5 * 60_000 - 1);
        expect(destroyUnlockedKeys).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(destroyUnlockedKeys).toHaveBeenCalledTimes(1);
        expect(destroyUnlockedKeys).toHaveBeenCalledWith();
    });

    it("resets the timer on mousedown/keydown activity, so it never fires while the user keeps interacting", () => {
        vi.useFakeTimers();
        getIdleTimeoutMinutes.mockReturnValue(5);
        render(<Harness />);

        vi.advanceTimersByTime(4 * 60_000);
        document.dispatchEvent(new Event("mousedown"));
        vi.advanceTimersByTime(4 * 60_000);
        document.dispatchEvent(new Event("keydown"));
        vi.advanceTimersByTime(4 * 60_000);
        expect(destroyUnlockedKeys).not.toHaveBeenCalled();

        vi.advanceTimersByTime(60_000 + 1);
        expect(destroyUnlockedKeys).toHaveBeenCalledTimes(1);
    });

    it("resets on scroll and touchstart too", () => {
        vi.useFakeTimers();
        getIdleTimeoutMinutes.mockReturnValue(5);
        render(<Harness />);

        vi.advanceTimersByTime(4 * 60_000);
        document.dispatchEvent(new Event("scroll"));
        vi.advanceTimersByTime(4 * 60_000);
        document.dispatchEvent(new Event("touchstart"));
        vi.advanceTimersByTime(4 * 60_000);
        expect(destroyUnlockedKeys).not.toHaveBeenCalled();
    });

    it("does nothing at all when the configured timeout is 0 (disabled)", () => {
        vi.useFakeTimers();
        getIdleTimeoutMinutes.mockReturnValue(0);
        render(<Harness />);

        vi.advanceTimersByTime(365 * 24 * 60 * 60_000);
        expect(destroyUnlockedKeys).not.toHaveBeenCalled();
    });

    it("stops listening and clears its pending timer after unmount", () => {
        vi.useFakeTimers();
        getIdleTimeoutMinutes.mockReturnValue(5);
        const { unmount } = render(<Harness />);
        unmount();

        vi.advanceTimersByTime(10 * 60_000);
        expect(destroyUnlockedKeys).not.toHaveBeenCalled();
    });
});

/** Simulates a laptop sleep: wall-clock time jumps forward while no timer gets a chance to run. */
function sleepFor(ms: number) {
    vi.setSystemTime(Date.now() + ms);
}

function setVisibility(state: DocumentVisibilityState) {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

describe("useIdleKeyTimeout - wall-clock check on resume", () => {
    afterEach(() => {
        setVisibility("visible");
    });

    it("destroys keys immediately on visibilitychange if the idle deadline passed while asleep", () => {
        vi.useFakeTimers();
        getIdleTimeoutMinutes.mockReturnValue(5);
        render(<Harness />);

        sleepFor(6 * 60_000);
        expect(destroyUnlockedKeys).not.toHaveBeenCalled();

        document.dispatchEvent(new Event("visibilitychange"));
        expect(destroyUnlockedKeys).toHaveBeenCalledTimes(1);

        // The stale timer was cleared, so it doesn't fire a second destroy later.
        vi.advanceTimersByTime(10 * 60_000);
        expect(destroyUnlockedKeys).toHaveBeenCalledTimes(1);
    });

    it("also checks on window focus and pageshow", () => {
        vi.useFakeTimers();
        getIdleTimeoutMinutes.mockReturnValue(5);
        render(<Harness />);

        sleepFor(5 * 60_000);
        window.dispatchEvent(new Event("focus"));
        expect(destroyUnlockedKeys).toHaveBeenCalledTimes(1);

        document.dispatchEvent(new Event("mousedown"));
        sleepFor(5 * 60_000);
        window.dispatchEvent(new Event("pageshow"));
        expect(destroyUnlockedKeys).toHaveBeenCalledTimes(2);
    });

    it("re-arms the timer for only the remaining time when resuming before the deadline", () => {
        vi.useFakeTimers();
        getIdleTimeoutMinutes.mockReturnValue(5);
        render(<Harness />);

        sleepFor(3 * 60_000);
        window.dispatchEvent(new Event("focus"));
        expect(destroyUnlockedKeys).not.toHaveBeenCalled();

        vi.advanceTimersByTime(2 * 60_000 - 1);
        expect(destroyUnlockedKeys).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(destroyUnlockedKeys).toHaveBeenCalledTimes(1);
    });

    it("ignores a visibilitychange to hidden", () => {
        vi.useFakeTimers();
        getIdleTimeoutMinutes.mockReturnValue(5);
        render(<Harness />);

        sleepFor(6 * 60_000);
        setVisibility("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
        expect(destroyUnlockedKeys).not.toHaveBeenCalled();
    });

    it("stops checking on resume after unmount", () => {
        vi.useFakeTimers();
        getIdleTimeoutMinutes.mockReturnValue(5);
        const { unmount } = render(<Harness />);
        unmount();

        sleepFor(6 * 60_000);
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("pageshow"));
        expect(destroyUnlockedKeys).not.toHaveBeenCalled();
    });
});

describe("useIdleKeyTimeout - iframe activity", () => {
    afterEach(() => {
        document.body.innerHTML = "";
    });

    /** Lets the MutationObserver callback (a microtask) run - fake timers don't fake microtasks. */
    async function flushObserver() {
        await Promise.resolve();
    }

    it("counts activity inside a same-origin iframe that was already present at mount", () => {
        vi.useFakeTimers();
        getIdleTimeoutMinutes.mockReturnValue(5);
        const frame = document.createElement("iframe");
        document.body.appendChild(frame);
        render(<Harness />);

        vi.advanceTimersByTime(4 * 60_000);
        frame.contentDocument!.dispatchEvent(new Event("keydown"));
        vi.advanceTimersByTime(4 * 60_000);
        expect(destroyUnlockedKeys).not.toHaveBeenCalled();
        vi.advanceTimersByTime(60_000);
        expect(destroyUnlockedKeys).toHaveBeenCalledTimes(1);
    });

    it("picks up an iframe added after mount, and detaches from one that is removed", async () => {
        vi.useFakeTimers();
        getIdleTimeoutMinutes.mockReturnValue(5);
        render(<Harness />);

        const frame = document.createElement("iframe");
        document.body.appendChild(frame);
        await flushObserver();
        const frameDoc = frame.contentDocument!;
        const removeSpy = vi.spyOn(frameDoc, "removeEventListener");

        vi.advanceTimersByTime(4 * 60_000);
        frameDoc.dispatchEvent(new Event("mousedown"));
        vi.advanceTimersByTime(4 * 60_000);
        expect(destroyUnlockedKeys).not.toHaveBeenCalled();

        frame.remove();
        await flushObserver();
        expect(removeSpy).toHaveBeenCalledWith("mousedown", expect.any(Function));
    });

    it("re-attaches to a frame's new document when it (re)loads, dropping the old one", () => {
        vi.useFakeTimers();
        getIdleTimeoutMinutes.mockReturnValue(5);
        const frame = document.createElement("iframe");
        document.body.appendChild(frame);
        const firstDoc = document.implementation.createHTMLDocument("first");
        const secondDoc = document.implementation.createHTMLDocument("second");
        let currentDoc = firstDoc;
        Object.defineProperty(frame, "contentDocument", { configurable: true, get: () => currentDoc });
        render(<Harness />);

        currentDoc = secondDoc;
        frame.dispatchEvent(new Event("load"));

        vi.advanceTimersByTime(4 * 60_000);
        firstDoc.dispatchEvent(new Event("keydown"));
        vi.advanceTimersByTime(60_000);
        expect(destroyUnlockedKeys).toHaveBeenCalledTimes(1);

        destroyUnlockedKeys.mockClear();
        vi.advanceTimersByTime(4 * 60_000);
        secondDoc.dispatchEvent(new Event("keydown"));
        vi.advanceTimersByTime(4 * 60_000);
        expect(destroyUnlockedKeys).not.toHaveBeenCalled();
    });

    it("drops a frame whose document becomes inaccessible, and ignores load events from non-iframes", () => {
        vi.useFakeTimers();
        getIdleTimeoutMinutes.mockReturnValue(5);
        const frame = document.createElement("iframe");
        document.body.appendChild(frame);
        const doc = document.implementation.createHTMLDocument("x");
        let accessible = true;
        Object.defineProperty(frame, "contentDocument", {
            configurable: true,
            get: () => {
                if (!accessible) {
                    throw new DOMException("Blocked a frame from accessing a cross-origin frame.", "SecurityError");
                }
                return doc;
            },
        });
        const img = document.createElement("img");
        document.body.appendChild(img);
        render(<Harness />);

        img.dispatchEvent(new Event("load"));
        accessible = false;
        frame.dispatchEvent(new Event("load"));

        vi.advanceTimersByTime(4 * 60_000);
        doc.dispatchEvent(new Event("keydown"));
        vi.advanceTimersByTime(60_000);
        expect(destroyUnlockedKeys).toHaveBeenCalledTimes(1);
    });

    it("tolerates a sandboxed (inaccessible) iframe, counting focus moving into it as activity", () => {
        vi.useFakeTimers();
        getIdleTimeoutMinutes.mockReturnValue(5);
        const frame = document.createElement("iframe");
        Object.defineProperty(frame, "contentDocument", { configurable: true, get: () => null });
        document.body.appendChild(frame);
        const button = document.createElement("button");
        document.body.appendChild(button);
        render(<Harness />);

        vi.advanceTimersByTime(4 * 60_000);
        frame.focus();
        window.dispatchEvent(new Event("blur"));
        vi.advanceTimersByTime(4 * 60_000);
        expect(destroyUnlockedKeys).not.toHaveBeenCalled();

        // A blur that isn't focus moving into an iframe (e.g. switching to another app) is not activity.
        button.focus();
        window.dispatchEvent(new Event("blur"));
        window.dispatchEvent(new Event("blur"));
        vi.advanceTimersByTime(60_000 + 1);
        expect(destroyUnlockedKeys).toHaveBeenCalledTimes(1);
    });

    it("detaches from iframe documents, the observer, and the blur check on unmount", async () => {
        vi.useFakeTimers();
        getIdleTimeoutMinutes.mockReturnValue(5);
        const frame = document.createElement("iframe");
        document.body.appendChild(frame);
        const { unmount } = render(<Harness />);
        const frameDoc = frame.contentDocument!;
        const removeSpy = vi.spyOn(frameDoc, "removeEventListener");

        frame.focus();
        window.dispatchEvent(new Event("blur"));
        unmount();
        expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));

        document.body.appendChild(document.createElement("iframe"));
        await flushObserver();
        vi.advanceTimersByTime(10 * 60_000);
        expect(destroyUnlockedKeys).not.toHaveBeenCalled();
    });
});
