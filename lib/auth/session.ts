///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Session handling for a service that never issues its own JWTs — identity comes entirely from a separate
 * `auth-server` deployment (see `.claude/NOTES.md`). `userUid` (present when the `jwt` cookie auth-server
 * set is valid) and `authServerUrl` are both supplied by the page's server-side `fetchProps` (see
 * `src/{mongo,sql}/routes/{wwwRoute,AdminConsoleRoute}.ts`), not fetched client-side.
 *
 * The access token auth-server issues lives an hour, the refresh token two weeks. `useSessionRefresh()` keeps the
 * first alive for as long as the second is valid by calling auth-server's `POST /api/auth/refresh` cross-origin
 * (`authApiFetch()`), which reissues both cookies. That works because the deployment scopes both cookies to the shared
 * parent domain and auth-server's CORS/CSRF origin allow-list includes this app's origin - the same requirements
 * sign-out already has.
 */
import { useEffect, useRef } from "react";
import { ApiRequestError, authApiFetch, setApiSessionRecovery } from "../util/api.js";
import { useApiClient } from "../util/apiClientContext.js";

/** An access token's age at which it is refreshed. The token lives an hour; the margin leaves time to retry a failed refresh. */
export const SESSION_REFRESH_AFTER_MS = 45 * 60 * 1000;
/** How often an open page checks whether its token is due. Also what retries a refresh that failed for a transient reason. */
export const SESSION_REFRESH_CHECK_MS = 60 * 1000;
/** A reload that follows a successful recovery refresh but still finds no session is not repeated within this window. */
export const SESSION_RELOAD_GUARD_MS = 60 * 1000;

const LOCK_NAME = "rapidmx-session-refresh";
const REFRESHED_AT_KEY = "rapidmx.session.refreshedAt";
const RELOADED_AT_KEY = "rapidmx.session.reloadedAt";

function readTimestamp(storage: () => Storage, key: string): number {
    try {
        const value = Number(storage().getItem(key));
        return Number.isFinite(value) ? value : 0;
    } catch {
        return 0;
    }
}

function writeTimestamp(storage: () => Storage, key: string, value: number): void {
    try {
        storage().setItem(key, String(value));
    } catch {
        // Storage can be blocked or full; the timestamp only avoids redundant refreshes.
    }
}

/** The URL of auth-server's sign-in page, carrying the current URL as `return_to` so it can send the browser back here. */
function signInUrl(authServerUrl: string): string {
    return `${authServerUrl}/auth/signin?return_to=${encodeURIComponent(window.location.href)}`;
}

/**
 * Refreshes the signed-in session through auth-server: exchanges the `refresh` cookie for a new access token and
 * refresh token, both set as cookies on the response. Rejects with the `ApiRequestError` auth-server answered
 * (`401`/`403` when the refresh token has expired or was revoked).
 *
 * A refresh token is single-use and bound to the session, so two tabs refreshing at once would make the second one look
 * like a dead session. Refreshes are therefore serialised across tabs (Web Locks, where the browser has them) and each
 * tab records when the last one happened, so a tab that gets its turn right after another tab refreshed does nothing.
 *
 * @param force Refresh even when the last refresh, by this tab or another, was recent.
 * @returns `true` when a refresh was made, `false` when one was not needed.
 */
export async function refreshSession(authServerUrl: string, force = false): Promise<boolean> {
    const run = async (): Promise<boolean> => {
        if (!force && Date.now() - readTimestamp(() => localStorage, REFRESHED_AT_KEY) < SESSION_REFRESH_AFTER_MS) {
            return false;
        }
        await authApiFetch(authServerUrl, "/auth/refresh", { method: "POST" });
        writeTimestamp(() => localStorage, REFRESHED_AT_KEY, Date.now());
        return true;
    };
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    return locks ? locks.request(LOCK_NAME, run) : run();
}

/** How long the outcome of a recovery is reused for: requests that fail together share one refresh, and a session that will not come back is not asked again at once. */
export const SESSION_RECOVERY_COOLDOWN_MS = 10 * 1000;

let recovery: Promise<boolean> | undefined;
let lastRecovery: { at: number; renewed: boolean } | undefined;

/**
 * Renews the session because a request was refused for lack of one, whatever this browser's record of the last refresh says. Every request
 * refused at about the same time shares one refresh, and its outcome is reused for `SESSION_RECOVERY_COOLDOWN_MS`. A refusal also clears the record of
 * the last refresh, so the next regular check asks again (and sends the browser to sign-in if the refresh token is truly gone).
 *
 * @returns Whether the session was renewed.
 */
export function recoverSession(authServerUrl: string): Promise<boolean> {
    if (lastRecovery && Date.now() - lastRecovery.at < SESSION_RECOVERY_COOLDOWN_MS) {
        return Promise.resolve(lastRecovery.renewed);
    }
    recovery ??= refreshSession(authServerUrl, true)
        .then(
            () => true,
            () => {
                writeTimestamp(() => localStorage, REFRESHED_AT_KEY, 0);
                return false;
            },
        )
        .then((renewed) => {
            lastRecovery = { at: Date.now(), renewed };
            recovery = undefined;
            return renewed;
        });
    return recovery;
}

/** Forgets what recoveries have done (for tests). */
export function resetSessionRecovery(): void {
    recovery = undefined;
    lastRecovery = undefined;
}

/** Whether `err` says auth-server rejected the refresh token itself, as opposed to a failure worth retrying. */
function isAuthRejection(err: unknown): boolean {
    return err instanceof ApiRequestError && (err.status === 401 || err.status === 403);
}

/**
 * Redirects the browser to auth-server's sign-in page when `userUid` is absent, carrying the current URL as
 * `return_to` so auth-server can send the browser back here afterward. A no-op once `userUid` is present.
 *
 * This does not try to recover the session first; `useSessionRefresh()` does, and is what an app frame should call.
 *
 * A no-op under an `ApiClientContext.Provider` (see `useSessionRefresh()`'s own doc comment for why) — there is
 * no `jwt` cookie in that context for `userUid` to ever meaningfully reflect, and redirecting to auth-server's
 * cookie-based sign-in page would be wrong for a session whose lifecycle a host app's own `ApiClient` manages.
 */
export function useRedirectIfUnauthenticated(userUid: string | undefined, authServerUrl: string | undefined): void {
    const explicitClient = useApiClient();
    useEffect(() => {
        if (explicitClient || userUid) {
            return;
        }
        if (!authServerUrl) {
            console.error("Cannot redirect to sign-in: mail:auth_server_url is not configured.");
            return;
        }
        window.location.href = signInUrl(authServerUrl);
    }, [userUid, authServerUrl, explicitClient]);
}

/** Options for `useSessionRefresh()`. */
export interface SessionRefreshOptions {
    /**
     * Do not refresh, and send a page with no session straight to sign-in. For a session whose access token was not
     * issued from the refresh token in its cookie: an admin viewing as another user holds that user's token beside their
     * own refresh token, and a refresh would silently swap the admin back in.
     */
    paused?: boolean;
    /**
     * Runs before the browser leaves for sign-in because a refresh was refused while the page still had a session - the
     * access token in hand is valid for a while yet, so this is the moment to save work in progress. The caller bounds how
     * long it takes; a rejection is ignored and never stops the redirect.
     */
    beforeRedirect?: () => Promise<unknown>;
}

/**
 * Keeps a page's session alive for as long as auth-server's refresh token is valid, so the user is not sent to sign in
 * again every time the access token's hour is up:
 *
 * - `userUid` unset (the page was rendered without a valid `jwt` cookie - the tab was left open past the token's
 * lifetime, or reopened later): attempts one silent refresh and reloads so the server renders the page with the new
 * cookie. If the refresh is refused (the refresh token expired or was revoked, or there was none), or a reload just
 * made still found no session, redirects to sign-in as `useRedirectIfUnauthenticated()` does.
 * - `userUid` set: also renews the session when a request is refused for lack of one (`apiFetch()` asks `recoverSession()` and sends the request
 * again), so a token that ran out while timers were stopped costs nothing. Refreshes once the token is `SESSION_REFRESH_AFTER_MS` old (and right away when this browser has no
 * record of a recent refresh, since the page's token age is unknown), checked every `SESSION_REFRESH_CHECK_MS` and
 * whenever the tab becomes visible or the network returns, because a sleeping laptop stops timers. A failure that is
 * not a rejection is simply retried at the next check. A rejection (`401`/`403`: the refresh token expired or was
 * revoked, so the session cannot be kept) redirects to sign-in with `return_to` after `options.beforeRedirect` has run.
 *
 * **A no-op under an `ApiClientContext.Provider`** (see `util/apiClientContext.ts`): everything above assumes a
 * `jwt`/`refresh` cookie pair this app can renew through auth-server's own `/auth/refresh` - meaningless for a
 * component whose network calls actually go through an explicit `ApiClient` from `createApiClient()` instead
 * (e.g. one account of the native, multi-account `tauri-client`), which has no cookie jar for that origin at all
 * and whose token lifecycle is the host app's own job via a completely different mechanism (its own refresh
 * flow, keyed to `ApiClient.getAccessToken()`). Detected via `useApiClient()`; when it returns anything other
 * than `undefined`, this hook does nothing at all - no timer, no listener, no redirect, regardless of `userUid`/
 * `authServerUrl`/`options`. The default (no `ApiClientContext.Provider` anywhere - every existing browser/SSR/
 * Electron consumer) is completely unchanged: `useApiClient()` there always returns `undefined`.
 */
export function useSessionRefresh(userUid: string | undefined, authServerUrl: string | undefined, options: SessionRefreshOptions = {}): void {
    const paused = !!options.paused;
    const explicitClient = useApiClient();
    const beforeRedirectRef = useRef(options.beforeRedirect);
    beforeRedirectRef.current = options.beforeRedirect;

    useEffect(() => {
        if (explicitClient) {
            return;
        }
        if (!authServerUrl) {
            if (!userUid) {
                console.error("Cannot redirect to sign-in: mail:auth_server_url is not configured.");
            }
            return;
        }

        let cancelled = false;

        if (!userUid) {
            if (paused || Date.now() - readTimestamp(() => sessionStorage, RELOADED_AT_KEY) < SESSION_RELOAD_GUARD_MS) {
                window.location.href = signInUrl(authServerUrl);
                return;
            }
            // Forced: the page has no session, so what this browser remembers of the last refresh says nothing about whether one is due.
            refreshSession(authServerUrl, true)
                .then(() => {
                    if (!cancelled) {
                        writeTimestamp(() => sessionStorage, RELOADED_AT_KEY, Date.now());
                        window.location.reload();
                    }
                })
                .catch(() => {
                    if (!cancelled) {
                        window.location.href = signInUrl(authServerUrl);
                    }
                });
            return () => {
                cancelled = true;
            };
        }

        if (paused) {
            return;
        }

        // A request the server refuses for lack of a session renews it (see `apiFetch()`), instead of waiting for the next check.
        setApiSessionRecovery(() => recoverSession(authServerUrl));

        let leaving = false;
        let inFlight = false;
        const leave = async () => {
            leaving = true;
            try {
                await beforeRedirectRef.current?.();
            } catch {
                // Saving what can be saved is best effort; the session is over either way.
            }
            if (!cancelled) {
                window.location.href = signInUrl(authServerUrl);
            }
        };
        const check = () => {
            if (cancelled || leaving || inFlight) {
                return;
            }
            inFlight = true;
            refreshSession(authServerUrl)
                .catch((err) => {
                    if (isAuthRejection(err)) {
                        void leave();
                    }
                })
                .finally(() => {
                    inFlight = false;
                });
        };
        const onVisible = () => {
            if (document.visibilityState === "visible") {
                check();
            }
        };

        check();
        const interval = window.setInterval(check, SESSION_REFRESH_CHECK_MS);
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("online", check);
        return () => {
            cancelled = true;
            setApiSessionRecovery(undefined);
            window.clearInterval(interval);
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener("online", check);
        };
    }, [userUid, authServerUrl, paused, explicitClient]);
}
