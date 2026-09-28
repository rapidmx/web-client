///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Destroys every unlocked mailbox's in-memory keys after this device's configured idle period
 * (`idleTimeout.ts`) with no user activity — `specs/end-to-end_encryption.md`'s "destroyed on ...
 * a configurable idle period" trigger for `keySession.ts`'s `destroyUnlockedKeys()`.
 *
 * Listened at the `document` level (not scoped to any one app's own content area) specifically so
 * activity in *any* app — Contacts, Calendar, Tasks, not just Mail/Settings, where the unlocked keys
 * are actually read/used — resets the clock. A user reading a long document in Tasks for 40 minutes
 * without touching Mail again is still an actively-attended device, not an idle one; scoping this to
 * only the app(s) that touch key material would time it out from underneath a session that was never
 * actually unattended.
 *
 * **Iframes.** Events inside an iframe never reach the parent `document`, so activity is also listened
 * for inside every *same-origin* iframe's own document (attached as iframes appear or (re)load, found via
 * a `MutationObserver` plus a capture-phase `load` listener). A sandboxed/cross-origin iframe's document
 * is inaccessible by design — notably `MessageDetailPane`'s `sandbox=""` message body — so for those the
 * one observable signal is used instead: the parent window blurring *because focus moved into an iframe*
 * (a click inside it) counts as activity. Scrolling such an iframe without clicking is not observable.
 *
 * **Sleep/suspend.** Timers don't run while a laptop sleeps, so a `setTimeout` alone could fire long after
 * the idle deadline has passed by wall clock. Whenever the page becomes visible or the window regains
 * focus, elapsed wall-clock time since the last activity is checked and keys are destroyed immediately if
 * the deadline already passed (otherwise the timer is re-armed for just the remaining time).
 */
import { useEffect } from "react";
import { destroyUnlockedKeys } from "./keySession.js";
import { getIdleTimeoutMinutes } from "./idleTimeout.js";

const ACTIVITY_EVENTS = ["mousedown", "keydown", "scroll", "touchstart"] as const;

/** Reads an iframe's document if (and only if) this origin may access it — `null` for a cross-origin or
 * `sandbox`ed (opaque-origin) frame, whichever way the browser reports that (a `null` or a throw). */
function accessibleFrameDocument(frame: HTMLIFrameElement): Document | null {
    try {
        return frame.contentDocument;
    } catch {
        return null;
    }
}

/**
 * Safe to mount unconditionally, even before any mailbox has been unlocked this session -
 * `destroyUnlockedKeys()` is a no-op against an empty session store, so an idle period elapsing with
 * nothing unlocked yet has no observable effect. Reads the configured duration once, at mount - the
 * host component (`AppShell.tsx`) remounts on every navigation in this framework's own no-client-
 * router design (see that component's own doc comment), so a preference change made on the Settings
 * page takes effect the next time the user goes anywhere, without needing this hook to poll for
 * changes itself.
 */
export function useIdleKeyTimeout(): void {
    useEffect(() => {
        const minutes = getIdleTimeoutMinutes();
        if (!minutes) {
            return;
        }
        const timeoutMs = minutes * 60_000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let blurCheck: ReturnType<typeof setTimeout> | undefined;
        let lastActivity = Date.now();

        function arm(delayMs: number) {
            clearTimeout(timer);
            timer = setTimeout(() => destroyUnlockedKeys(), delayMs);
        }

        function reset() {
            lastActivity = Date.now();
            arm(timeoutMs);
        }

        /** Wall-clock check on resume - see this module's doc comment. */
        function checkElapsed() {
            if (document.visibilityState === "hidden") {
                return;
            }
            const remaining = timeoutMs - (Date.now() - lastActivity);
            if (remaining <= 0) {
                clearTimeout(timer);
                destroyUnlockedKeys();
            } else {
                arm(remaining);
            }
        }

        function handleWindowBlur() {
            // `document.activeElement` isn't reliably updated to the iframe until after the blur event
            // itself has finished dispatching, so check on the next tick.
            clearTimeout(blurCheck);
            blurCheck = setTimeout(() => {
                if (document.activeElement instanceof HTMLIFrameElement) {
                    reset();
                }
            }, 0);
        }

        const frameDocs = new Map<HTMLIFrameElement, Document>();

        function attachFrame(frame: HTMLIFrameElement) {
            const doc = accessibleFrameDocument(frame);
            const previous = frameDocs.get(frame);
            if (previous === doc) {
                return;
            }
            if (previous) {
                removeActivityListeners(previous);
                frameDocs.delete(frame);
            }
            if (doc) {
                addActivityListeners(doc);
                frameDocs.set(frame, doc);
            }
        }

        function scanFrames() {
            const current = new Set(document.querySelectorAll("iframe"));
            for (const [frame, doc] of frameDocs) {
                if (!current.has(frame)) {
                    removeActivityListeners(doc);
                    frameDocs.delete(frame);
                }
            }
            for (const frame of current) {
                attachFrame(frame);
            }
        }

        function handleLoad(e: Event) {
            if (e.target instanceof HTMLIFrameElement) {
                attachFrame(e.target);
            }
        }

        function addActivityListeners(target: Document) {
            for (const event of ACTIVITY_EVENTS) {
                target.addEventListener(event, reset, { passive: true });
            }
        }

        function removeActivityListeners(target: Document) {
            for (const event of ACTIVITY_EVENTS) {
                target.removeEventListener(event, reset);
            }
        }

        reset();
        addActivityListeners(document);
        document.addEventListener("visibilitychange", checkElapsed);
        document.addEventListener("load", handleLoad, true);
        window.addEventListener("focus", checkElapsed);
        window.addEventListener("pageshow", checkElapsed);
        window.addEventListener("blur", handleWindowBlur);
        const observer = new MutationObserver(scanFrames);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        scanFrames();

        return () => {
            clearTimeout(timer);
            clearTimeout(blurCheck);
            observer.disconnect();
            removeActivityListeners(document);
            document.removeEventListener("visibilitychange", checkElapsed);
            document.removeEventListener("load", handleLoad, true);
            window.removeEventListener("focus", checkElapsed);
            window.removeEventListener("pageshow", checkElapsed);
            window.removeEventListener("blur", handleWindowBlur);
            for (const doc of frameDocs.values()) {
                removeActivityListeners(doc);
            }
            frameDocs.clear();
        };
    }, []);
}
