///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** Saves a compose window's unsaved edits (or waits for a save already on the wire), resolving to `false` when
 * something the window holds is still unsaved afterwards (any other value counts as saved). Never rejects. */
export type ComposeFlush = () => Promise<unknown>;

const flushers = new Set<ComposeFlush>();
let signingOut = false;

/**
 * Marks the app as signing out (explicitly, or forced by a sign-out in another tab), so compose windows stop
 * asking the browser to confirm leaving the page - the "Leave site?" prompt would otherwise let the user cancel
 * the sign-out's own navigation and stay on a page whose session is being ended. Call it before flushing drafts
 * and navigating. `clearSigningOut()` undoes it (a sign-out that didn't leave the page after all).
 */
export function markSigningOut(): void {
    signingOut = true;
}

/** Undoes `markSigningOut()`. */
export function clearSigningOut(): void {
    signingOut = false;
}

/** Whether `markSigningOut()` has been called (and not cleared). */
export function isSigningOut(): boolean {
    return signingOut;
}

/**
 * Registers an open compose window's draft flush, so leaving the app on purpose (Sign Out) can save the
 * last edits still waiting on the autosave debounce before the session ends. Returns the unregister
 * function. Module-level rather than React context: `AppShell` (the sign-out handler) renders the
 * `ComposeProvider` itself, so it can't read that provider's context.
 */
export function registerComposeFlush(flush: ComposeFlush): () => void {
    flushers.add(flush);
    return () => {
        flushers.delete(flush);
    };
}

/**
 * Runs every registered flush and waits for all of them, but no longer than `timeoutMs`. Resolves to `true`
 * only when every window reported its content saved in time (a window whose save failed also shows the user
 * why, with Discard / Keep editing). Never rejects.
 */
export async function flushComposeDrafts(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const all = Promise.all([...flushers].map((flush) => flush().catch(() => false))).then((results) => results.every((result) => result !== false));
    const saved = await Promise.race([all, timeout]);
    clearTimeout(timer);
    return saved;
}
