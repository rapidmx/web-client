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

/** A refresh answered with a refusal is asked once more after this long, in case the cookies were rotated by another tab or the server's session save lagged. */
export const SESSION_REFRESH_RETRY_MS = 1500;
/** A forced refresh (a request was refused, or the page has no session) does nothing when a refresh succeeded within this long: the refusal came from the old cookies. */
export const SESSION_REFRESH_MIN_GAP_MS = 10 * 1000;
/** How many entries `rapidmx.session.log` keeps. */
export const SESSION_LOG_MAX = 40;

const LOCK_NAME = "rapidmx-session-refresh";
const REFRESHED_AT_KEY = "rapidmx.session.refreshedAt";
const RELOADED_AT_KEY = "rapidmx.session.reloadedAt";
const LOG_KEY = "rapidmx.session.log";

let retryDelayMs = SESSION_REFRESH_RETRY_MS;

/** Sets how long a refused refresh waits before its one retry (for tests); `resetSessionRecovery()` restores the default. */
export function setSessionRefreshRetryDelay(ms: number): void {
    retryDelayMs = ms;
}

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

/** Whether a refresh succeeded within the last `ms`, in this tab or another (they share `localStorage`). A cleared or future-dated record counts as no. */
export function refreshedRecently(ms: number): boolean {
    const at = readTimestamp(() => localStorage, REFRESHED_AT_KEY);
    const age = Date.now() - at;
    return at > 0 && age >= 0 && age < ms;
}

/** One entry of the session log (`rapidmx.session.log`). */
export interface SessionLogEntry {
    /** When it happened, ISO 8601. */
    t: string;
    /** What happened, e.g. `refresh:start`, `refresh:rejected`, `leave`. */
    e: string;
    /** A short detail (a reason, a status, an age). Never a token or cookie value. */
    d?: string;
}

/** The session log: the last `SESSION_LOG_MAX` things the silent refresh did, oldest first, kept in `localStorage['rapidmx.session.log']` so the cause of an unexpected sign-in can be read afterward. */
export function getSessionLog(): SessionLogEntry[] {
    try {
        const value = JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]");
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}

/** Appends to the session log, dropping the oldest entries past `SESSION_LOG_MAX`. Best effort: blocked storage loses the entry. */
export function logSessionEvent(e: string, d?: string): void {
    try {
        const entries = getSessionLog();
        entries.push(d === undefined ? { t: new Date().toISOString(), e } : { t: new Date().toISOString(), e, d });
        localStorage.setItem(LOG_KEY, JSON.stringify(entries.slice(-SESSION_LOG_MAX)));
    } catch {
        // The log is evidence only; it must never get in the way of the session.
    }
}

/** How long ago the last successful refresh was, for log entries: `12s`, or `never` when this browser has no record. */
function sinceLastRefresh(): string {
    const at = readTimestamp(() => localStorage, REFRESHED_AT_KEY);
    return at > 0 ? `${Math.round((Date.now() - at) / 1000)}s` : "never";
}

/** The URL of auth-server's sign-in page, carrying the current URL as `return_to` so it can send the browser back here. */
function signInUrl(authServerUrl: string): string {
    return `${authServerUrl}/auth/signin?return_to=${encodeURIComponent(window.location.href)}`;
}

/** Sends the browser to auth-server's sign-in page, first writing why to the session log and printing the log to the console. */
function goToSignIn(authServerUrl: string, reason: string): void {
    logSessionEvent("leave", `${reason} sinceOk=${sinceLastRefresh()}`);
    console.info("[rapidmx] Going to sign-in. Session log:", getSessionLog());
    window.location.href = signInUrl(authServerUrl);
}

/** Why a refresh was made, for the session log. */
export type SessionRefreshReason = "check" | "recovery" | "nouser";

/** Whether `err` says auth-server rejected the refresh token itself, as opposed to a failure worth retrying. */
function isAuthRejection(err: unknown): boolean {
    return err instanceof ApiRequestError && (err.status === 401 || err.status === 403);
}

function describeFailure(err: unknown): string {
    if (err instanceof ApiRequestError) {
        return `status=${err.status}${err.code ? ` code=${err.code}` : ""} sinceOk=${sinceLastRefresh()}`;
    }
    return `${err instanceof Error ? err.message : "unknown"}`.slice(0, 80);
}

/** One `POST /auth/refresh`, recording when it succeeded. */
async function postRefresh(authServerUrl: string): Promise<void> {
    await authApiFetch(authServerUrl, "/auth/refresh", { method: "POST" });
    writeTimestamp(() => localStorage, REFRESHED_AT_KEY, Date.now());
}

let refreshing: { promise: Promise<boolean>; forced: boolean } | undefined;

/**
 * Refreshes the signed-in session through auth-server: exchanges the `refresh` cookie for a new access token and
 * refresh token, both set as cookies on the response. Rejects with the `ApiRequestError` auth-server answered
 * (`401`/`403` when the refresh token has expired or was revoked).
 *
 * A refresh token is single-use and bound to the session, and auth-server saves the rotated token a moment after it
 * answers, so refreshing twice in quick succession makes the second look like a dead session. Refreshes are therefore
 * shared by every caller in the tab (one in flight at a time), serialised across tabs (Web Locks, where the browser has
 * them), and each tab records when the last one succeeded, so a caller that gets its turn right after a refresh does
 * nothing. A refresh that is refused is asked once more after `SESSION_REFRESH_RETRY_MS` (the cookies may have been
 * rotated meanwhile) before it counts as a rejection.
 *
 * @param force Refresh even when the last refresh, by this tab or another, was `SESSION_REFRESH_AFTER_MS` ago or less. Even forced, a refresh made within `SESSION_REFRESH_MIN_GAP_MS` is not repeated.
 * @param reason Why, for the session log.
 * @returns `true` when a refresh was made, `false` when one was not needed.
 */
export function refreshSession(authServerUrl: string, force = false, reason: SessionRefreshReason = force ? "recovery" : "check"): Promise<boolean> {
    if (refreshing) {
        // A forced caller must not take the outcome of a refresh that may have been skipped as not due: ask again once it is over (which the minimum gap keeps from being a second POST when it did refresh).
        return force && !refreshing.forced ? refreshing.promise.then(() => refreshSession(authServerUrl, true, reason)) : refreshing.promise;
    }
    const run = async (): Promise<boolean> => {
        if (refreshedRecently(force ? SESSION_REFRESH_MIN_GAP_MS : SESSION_REFRESH_AFTER_MS)) {
            if (force) {
                logSessionEvent("refresh:skip", `recent sinceOk=${sinceLastRefresh()} reason=${reason}`);
            }
            return false;
        }
        logSessionEvent("refresh:start", `reason=${reason} sinceOk=${sinceLastRefresh()}`);
        try {
            await postRefresh(authServerUrl);
        } catch (err) {
            if (!isAuthRejection(err)) {
                logSessionEvent("refresh:error", describeFailure(err));
                throw err;
            }
            logSessionEvent("refresh:rejected", `${describeFailure(err)} attempt=1`);
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            if (refreshedRecently(SESSION_REFRESH_MIN_GAP_MS)) {
                // Another tab renewed the session while this one waited.
                logSessionEvent("refresh:skip", `recent-after-retry-wait reason=${reason}`);
                return false;
            }
            logSessionEvent("refresh:retry", `reason=${reason}`);
            try {
                await postRefresh(authServerUrl);
            } catch (err2) {
                logSessionEvent(isAuthRejection(err2) ? "refresh:rejected" : "refresh:error", `${describeFailure(err2)} attempt=2`);
                throw err2;
            }
        }
        logSessionEvent("refresh:ok", `reason=${reason}`);
        return true;
    };
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    const promise = (locks ? locks.request(LOCK_NAME, run) : run()).finally(() => {
        refreshing = undefined;
    });
    refreshing = { promise, forced: force };
    return promise;
}

/** How long the outcome of a recovery is reused for: requests that fail together share one refresh, and a session that will not come back is not asked again at once. */
export const SESSION_RECOVERY_COOLDOWN_MS = 10 * 1000;

let recovery: Promise<boolean> | undefined;
let lastRecovery: { at: number; renewed: boolean } | undefined;

/**
 * Renews the session because a request was refused for lack of one, whatever this browser's record of the last refresh says - except that a refresh that
 * succeeded within `SESSION_REFRESH_MIN_GAP_MS` (by this tab or another) is not repeated: the request was refused with the cookies from before it, so it is
 * simply sent again with the new ones. Every request refused at about the same time shares one refresh, and its outcome is reused for `SESSION_RECOVERY_COOLDOWN_MS`.
 * A refusal also clears the record of the last refresh, so the next regular check asks again (and sends the browser to sign-in if the refresh token is truly gone).
 *
 * @returns Whether the session was renewed.
 */
export function recoverSession(authServerUrl: string): Promise<boolean> {
    if (lastRecovery && Date.now() - lastRecovery.at < SESSION_RECOVERY_COOLDOWN_MS) {
        return Promise.resolve(lastRecovery.renewed);
    }
    recovery ??= refreshSession(authServerUrl, true, "recovery")
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

/** Forgets what recoveries and refreshes have done, and restores the retry delay (for tests). */
export function resetSessionRecovery(): void {
    recovery = undefined;
    lastRecovery = undefined;
    refreshing = undefined;
    retryDelayMs = SESSION_REFRESH_RETRY_MS;
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
        goToSignIn(authServerUrl, "no-session");
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
 * whenever the tab becomes visible or focused or the network returns, because a sleeping laptop stops timers (a tab that wakes after the
 * token's hour checks first, and a request refused meanwhile waits for that same refresh rather than starting its own). A failure that is
 * not a rejection is simply retried at the next check. A rejection (`401`/`403` twice running, `SESSION_REFRESH_RETRY_MS` apart: the refresh
 * token expired or was revoked, so the session cannot be kept) redirects to sign-in with `return_to` after `options.beforeRedirect` has run.
 * Everything it does is recorded in the session log (`getSessionLog()`), which is also printed to the console when the browser goes to sign-in.
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
            if (paused) {
                goToSignIn(authServerUrl, "no-session paused");
                return;
            }
            if (Date.now() - readTimestamp(() => sessionStorage, RELOADED_AT_KEY) < SESSION_RELOAD_GUARD_MS) {
                goToSignIn(authServerUrl, "no-session after-reload");
                return;
            }
            // Forced: the page has no session, so what this browser remembers of the last refresh says nothing about whether one is due (but one made seconds ago is not repeated).
            refreshSession(authServerUrl, true, "nouser")
                .then(() => {
                    if (!cancelled) {
                        logSessionEvent("reload-after-refresh");
                        writeTimestamp(() => sessionStorage, RELOADED_AT_KEY, Date.now());
                        window.location.reload();
                    }
                })
                .catch(() => {
                    if (!cancelled) {
                        goToSignIn(authServerUrl, "no-session refresh-rejected");
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
        let hiddenAt: number | undefined;
        const leave = async (reason: string) => {
            leaving = true;
            logSessionEvent("leave:pending", reason);
            try {
                await beforeRedirectRef.current?.();
            } catch {
                // Saving what can be saved is best effort; the session is over either way.
            }
            if (!cancelled) {
                goToSignIn(authServerUrl, reason);
            }
        };
        // `trigger` names what woke the check, for the log; the periodic tick passes none, so it logs only when it actually refreshes.
        const check = (trigger?: string) => {
            if (cancelled || leaving || inFlight) {
                return;
            }
            if (trigger) {
                logSessionEvent("check", trigger);
            }
            inFlight = true;
            refreshSession(authServerUrl, false, "check")
                .catch((err) => {
                    if (isAuthRejection(err)) {
                        void leave("refresh-rejected");
                    }
                })
                .finally(() => {
                    inFlight = false;
                });
        };
        const onVisible = () => {
            if (document.visibilityState === "hidden") {
                hiddenAt = Date.now();
                return;
            }
            logSessionEvent("visible", hiddenAt === undefined ? "hiddenFor=unknown" : `hiddenFor=${Date.now() - hiddenAt}ms`);
            hiddenAt = undefined;
            check("visible");
        };
        const onFocus = () => check("focus");
        const onOnline = () => check("online");
        const onTick = () => check();

        check("mount");
        const interval = window.setInterval(onTick, SESSION_REFRESH_CHECK_MS);
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("focus", onFocus);
        window.addEventListener("online", onOnline);
        return () => {
            cancelled = true;
            setApiSessionRecovery(undefined);
            window.clearInterval(interval);
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener("focus", onFocus);
            window.removeEventListener("online", onOnline);
        };
    }, [userUid, authServerUrl, paused, explicitClient]);
}
