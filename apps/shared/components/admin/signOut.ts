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

/** Tells every other tab of this origin that the session ended (`{ type: "sign-out" }`, `AppShell`'s message), so
 * a mail tab destroys its unlocked keys and local indexes and leaves too. A no-op where BroadcastChannel is
 * unavailable. */
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
 * then navigates to auth-server (or `/`). Mirrors `AppShell.handleSignOut` minus the mail-only key/index cleanup,
 * which the consoles never create in their own tab.
 */
export async function signOutOfConsole(authServerUrl: string | undefined): Promise<void> {
    broadcastSignOut();
    await logOutOfAuthServer(authServerUrl);
    window.location.href = authServerUrl ?? "/";
}
