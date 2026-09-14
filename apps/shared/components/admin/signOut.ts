///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { authApiFetch } from "@rapidmx/react-shared/util/api.js";

/**
 * The cross-tab sign-out channel - must stay identical to `SIGN_OUT_CHANNEL` in
 * `apps/shared/search/localIndexRpcClient.ts` (the channel `AppShell` listens on and `destroyAllLocalIndexes()`
 * announces on). Duplicated rather than imported so the admin/escrow consoles don't pull the local-search Worker
 * client into their bundles; `test/apps/admin/_components/signOut.test.ts` fails if the two ever drift apart.
 */
export const CONSOLE_SIGN_OUT_CHANNEL = "rapidmx-localsearch";

/** How long sign-out waits for auth-server's logout before navigating anyway (same bound as `AppShell`). */
export const CONSOLE_LOGOUT_TIMEOUT_MS = 3_000;

/**
 * The local search index's pending-deletions `localStorage` key - must stay identical to `PENDING_DELETIONS_KEY`
 * in `apps/shared/search/localIndexRpcClient.ts`, duplicated for the same bundle reason as the channel above
 * (the test checks it). `"*"` is that module's "every index on this device" entry.
 */
export const CONSOLE_PENDING_DELETIONS_KEY = "rapidmx-localsearch-pending-deletions";
const ALL_LOCAL_INDEXES = "*";

/** Records that every local search index on this device must be deleted. The consoles can't delete them
 * themselves (no local-index client here); the next mail page load retries recorded deletions before opening
 * any index. With storage blocked nothing is recorded, and only an open mail tab hearing the broadcast deletes
 * them. */
function markLocalIndexesForDeletion(): void {
    try {
        localStorage.setItem(CONSOLE_PENDING_DELETIONS_KEY, JSON.stringify([ALL_LOCAL_INDEXES]));
    } catch {
        // See the doc comment.
    }
}

/** Tells every other tab of this origin that the session ended (`{ type: "sign-out" }`, `AppShell`'s message).
 * An open mail tab then destroys its unlocked keys and every local search index on the device, and leaves too.
 * A no-op where BroadcastChannel is unavailable. */
function broadcastSignOut(): void {
    if (typeof BroadcastChannel === "undefined") {
        return;
    }
    const channel = new BroadcastChannel(CONSOLE_SIGN_OUT_CHANNEL);
    channel.postMessage({ type: "sign-out" });
    channel.close();
}

/** Calls auth-server's logout (`POST ${authServerUrl}/api/auth/logout`, credentials included), bounded by
 * `CONSOLE_LOGOUT_TIMEOUT_MS`. Never rejects - a failure must not keep the user from leaving. */
async function logOutOfAuthServer(authServerUrl: string | undefined): Promise<void> {
    if (!authServerUrl) {
        return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONSOLE_LOGOUT_TIMEOUT_MS);
    try {
        await authApiFetch(authServerUrl, "/auth/logout", { method: "POST", signal: controller.signal });
    } catch {
        // Navigate anyway.
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Sign-out for `AdminShell`/`EscrowShell`: announces the sign-out to other tabs, ends the auth-server session
 * (clears the auth cookie and invalidates the refresh token - navigating alone would leave the session valid),
 * then navigates to auth-server (or `/`). Mirrors `AppShell.handleSignOut`, except that the consoles hold no
 * unlocked keys and can't delete local search indexes in their own tab: they record every index for deletion
 * (finished by the next mail page load) and rely on an open mail tab hearing the broadcast to delete them now.
 */
export async function signOutOfConsole(authServerUrl: string | undefined): Promise<void> {
    markLocalIndexesForDeletion();
    broadcastSignOut();
    await logOutOfAuthServer(authServerUrl);
    window.location.href = authServerUrl ?? "/";
}
