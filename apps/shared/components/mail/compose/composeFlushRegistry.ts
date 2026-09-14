///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** Saves a compose window's unsaved edits (or waits for a save already on the wire). Never rejects. */
export type ComposeFlush = () => Promise<unknown>;

const flushers = new Set<ComposeFlush>();

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

/** Runs every registered flush and waits for all of them, but no longer than `timeoutMs`. Never rejects. */
export async function flushComposeDrafts(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
    });
    const all = Promise.all([...flushers].map((flush) => flush().catch(() => undefined)));
    await Promise.race([all, timeout]);
    clearTimeout(timer);
}
