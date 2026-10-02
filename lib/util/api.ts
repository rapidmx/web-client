///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Minimal client-side helper shared by every app in this project: a `fetch` wrapper that talks to the
 * same-origin RapidMX API. There is no client router or HTTP client shipped by `@rapidrest/react`, so this
 * is deliberately small and framework-free.
 *
 * This service never issues its own JWTs — identity comes entirely from a separate `auth-server` deployment
 * (see `.claude/NOTES.md`). Authentication rides along via the `jwt` HttpOnly cookie that auth-server sets on
 * sign-in — the browser attaches it automatically to every same-origin `fetch()` call (the default
 * `credentials: "same-origin"` mode), and this server's `JWTStrategy` accepts it as a credential for every
 * authenticated request, not just SSR page loads. There is no local elevation/step-up flow here (unlike
 * auth-server's own `api.ts`, which this is a trimmed sibling of): a request to an elevation-gated endpoint
 * (`@RequiresElevation()` on the server) made with a non-elevated token fails with an `ApiRequestError` of
 * status 403 and code `"api-104"`, and it is up to the caller to send the browser to auth-server's
 * `/auth/elevate?return_to=...` page, which returns it to `return_to` once the user has confirmed their identity
 * (the admin console does exactly that - see `AdminShell` in `@rapidmx/web-client`). Code `"api-103"` is a
 * different 403 - the caller lacks a required role, and elevating won't help.
 */

export class ApiRequestError extends Error {
    status: number;
    code?: string;
    /**
     * The response's whole parsed JSON body, for an endpoint that says more than `message` - e.g. a failed send's
     * per-recipient SMTP results under `details`. `undefined` when the response had no JSON body (or the error
     * was raised on the client), so a caller must treat it as untyped, untrusted data and read it defensively.
     */
    details?: unknown;

    constructor(message: string, status: number, code?: string, details?: unknown) {
        super(message);
        this.name = "ApiRequestError";
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

/**
 * Absolute origin `apiFetch()` targets instead of a same-origin relative path - unset (`""`, the
 * default) everywhere this library has run until now (the SSR web/admin apps, always served from the
 * same origin as the API they call). Set once via `configureApiBaseUrl()` by a consumer that genuinely
 * runs on a *different* origin than the API - e.g. the Electron desktop client, whose renderer has no
 * "same origin as the server" to rely on the way a browser tab loaded from that server does.
 */
let apiBaseUrl = "";

/**
 * Points `apiFetch()` at `baseUrl` (e.g. `"https://mail.example.com"`) instead of the default
 * same-origin relative path. Only needed by a consumer whose own origin genuinely differs from the
 * RapidMX server's - see `apiBaseUrl`'s own doc comment. Requires that server's `cors:origins` config
 * include this consumer's own origin (see `@rapidrest/service-core`'s `Server.js` CORS middleware,
 * which only reflects `access-control-allow-credentials` for an explicitly allow-listed origin - the
 * default "allow every origin" behavior when `cors:origins` is unset does NOT carry credentials) and
 * that whatever sets the `jwt` cookie issues it with `SameSite=None; Secure` - a same-origin deployment
 * never needed either, and this function alone does not make a cross-origin deployment secure or
 * functional on its own.
 */
export function configureApiBaseUrl(baseUrl: string): void {
    apiBaseUrl = baseUrl.replace(/\/$/, "");
}

/**
 * The origin `configureApiBaseUrl()` set - `""` (same origin) when it never was. For a caller that talks to the
 * RapidMX server some way `apiFetch()` can't, such as the push WebSocket, which must go to the same origin.
 */
export function apiOrigin(): string {
    return apiBaseUrl;
}

/**
 * The full URL for an `@ApiRoute`-declared `path` (e.g. `/mail/attachments/a1/content`) - the `/api`
 * prefix plus whatever origin `configureApiBaseUrl()` set (a same-origin relative `/api/...` path when
 * it was never called). Every call site that can't go through `apiFetch()` - a raw-bytes upload, a
 * non-JSON download, or a plain URL handed to an `<a href>`/`<img src>` - must build its URL here rather
 * than hard-coding `/api...`, or it silently ignores a configured cross-origin base URL. A raw `fetch()`
 * built on this should also pass `credentials: "include"` so a cross-origin call still carries the `jwt`
 * cookie (harmless for a same-origin one).
 */
export function apiUrl(path: string): string {
    return `${apiBaseUrl}/api${path}`;
}

/**
 * Mirrors `@rapidrest/service-core`'s `DEFAULT_CSRF_COOKIE_NAME`/`DEFAULT_CSRF_HEADER_NAME` — kept as
 * local literals since this package has no dependency on that one.
 */
const CSRF_COOKIE_NAME = "csrf";
const CSRF_HEADER_NAME = "x-csrf-token";
const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Reads the CSRF double-submit cookie a `jwt`-cookie-issuing server sets (see `@rapidrest/auth`'s
 * `CsrfUtils`) directly off `document.cookie`. That cookie is deliberately host-only and non-`HttpOnly`
 * — see `@rapidrest/service-core`'s `src/http/csrf/csrf.ts` for the full rationale, in particular why a
 * *cross-origin* call (`authApiFetch()` below) can never find one here: a cookie set by auth-server's
 * host is never present in this app's own `document.cookie`, by design — that's what makes the cookie
 * host-only in the first place, and it's why `authApiFetch()`'s CSRF protection has to come from the
 * server checking its Origin allow-list instead (see its own doc comment).
 */
function readCsrfCookie(): string | undefined {
    if (typeof document === "undefined") {
        return undefined;
    }
    for (const part of document.cookie.split("; ")) {
        const idx = part.indexOf("=");
        if (idx > 0 && part.slice(0, idx) === CSRF_COOKIE_NAME) {
            return part.slice(idx + 1);
        }
    }
    return undefined;
}

/**
 * Echoes the CSRF double-submit cookie back as a header on `headers`, for a mutating request that doesn't
 * already carry one — the browser-side half of the double-submit check `@rapidrest/service-core`'s
 * `RouteUtils.checkCsrf()` enforces server-side. A safe method, a caller-supplied header already present,
 * or simply no cookie yet (e.g. this page's very first request) all leave `headers` untouched — the
 * server itself never requires this for any of those cases.
 */
function applyCsrfHeader(headers: Headers, method: string | undefined): void {
    const m = (method ?? "GET").toUpperCase();
    if (CSRF_SAFE_METHODS.has(m) || headers.has(CSRF_HEADER_NAME)) {
        return;
    }
    const token = readCsrfCookie();
    if (token) {
        headers.set(CSRF_HEADER_NAME, token);
    }
}

/**
 * `headers` as a `Headers` with the CSRF double-submit header added, for a mutating request that is built without `apiFetch()` - an upload of a
 * file's own bytes, which cannot go through `apiFetch()` because that always sends JSON. Without it the server refuses the request as "missing a valid
 * CSRF token". `method` defaults to `POST`; a safe method or no cookie leaves the headers as they were, exactly as `apiFetch()` does.
 */
export function withCsrfHeader(headers: Record<string, string>, method: string = "POST"): Headers {
    const result = new Headers(headers);
    applyCsrfHeader(result, method);
    return result;
}

/**
 * `fetch()` against the RapidMX server's API - same-origin unless `configureApiBaseUrl()` has been
 * called, in which case this also switches to `credentials: "include"` so the configured cross-origin
 * call still carries the `jwt` cookie (a plain relative fetch never needs this - `credentials:
 * "same-origin"`, fetch's own default, already attaches it). `path` is the route as declared by
 * `@ApiRoute` (e.g. `/mail/mailboxes`) — the `/api` prefix that decorator always adds is applied here,
 * in one place, rather than repeated at every call site.
 */
export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    applyCsrfHeader(headers, init.method);
    const credentials = apiBaseUrl ? "include" : init.credentials;

    const res = await fetchWithRecovery(path, { ...init, headers, credentials });
    return decodeApiResponse<T>(res, (error) => unauthorizedObserver?.(error));
}

/** `fetch()` of `path` against the global origin. When the access token has run out (a sleeping tab or laptop stops the timer that renews it in
 * time) it renews the session, and asks again once. */
async function fetchWithRecovery(path: string, init: RequestInit): Promise<Response> {
    let res = await fetch(apiUrl(path), init);
    if (res.status === 401 && sessionRecovery && (await recoverSession())) {
        res = await fetch(apiUrl(path), init);
    }
    return res;
}

let sessionRecovery: (() => Promise<boolean>) | undefined;

/**
 * Registers what `apiFetch()` does when the server answers `401`: try to renew the signed-in session and, when that worked, send the request once
 * more. `recovery` resolves whether the session was renewed. The app frame registers it while a session is open (`useSessionRefresh()`); pass
 * `undefined` to remove it. A rejection counts as "not renewed".
 */
export function setApiSessionRecovery(recovery: (() => Promise<boolean>) | undefined): void {
    sessionRecovery = recovery;
}

async function recoverSession(): Promise<boolean> {
    try {
        return await sessionRecovery!();
    } catch {
        return false;
    }
}

/**
 * `fetch()` against auth-server's API — a *different* origin than this app, unlike `apiFetch()` above. Used
 * only for the handful of actions that must be issued by auth-server itself (e.g. admin impersonation, which
 * needs to mint a token with the target user's real roles/scopes the way auth-server's own sign-in does —
 * see `.claude/NOTES.md`).
 *
 * Requires `credentials: "include"` so the browser both attaches this app's own `jwt` cookie to the request
 * and accepts whatever `Set-Cookie` auth-server's response carries back. This only actually works when
 * auth-server and this app are deployed under a shared parent cookie domain (e.g. `Domain=.example.com`) —
 * a deployment-level requirement owned by auth-server/the Helm chart, not configured here — and auth-server's
 * CORS config must explicitly allow this app's origin with credentials.
 *
 * No `x-csrf-token` header is sent, deliberately. A double-submit token is only meaningful to the server that issued it, and the `csrf`
 * cookie this app's JavaScript can read is *this* host's own (`mail.example.com`), never auth-server's - so echoing it
 * would be a wrong token for the wrong server. Worse, auth-server's CORS rules do not allow that header, so the browser
 * blocked the preflight of every such call (the silent session refresh, sign-out) before it ever reached the server: "Request header
 * field x-csrf-token is not allowed by Access-Control-Allow-Headers". Auth-server's CSRF protection for this cross-origin call shape is
 * its Origin allow-list check, which needs no header.
 */
export async function authApiFetch<T = unknown>(authServerUrl: string, path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");

    const res = await fetch(`${authServerUrl}/api${path}`, { ...init, headers, credentials: "include" });
    return decodeApiResponse<T>(res);
}

let unauthorizedObserver: ((error: ApiRequestError) => void) | undefined;

/**
 * Registers the one function that hears about every `401` this server's API (`apiFetch()`, not auth-server's) answers - the
 * signed-in session has ended or expired. It only observes: the request still rejects with the same `ApiRequestError`, so
 * a caller's own handling is unchanged. The app frame uses it to say "Your session expired" once, whichever request noticed
 * first (a background refresh included). Pass `undefined` to remove it. A throwing observer never affects the request.
 */
export function setApiUnauthorizedObserver(observer: ((error: ApiRequestError) => void) | undefined): void {
    unauthorizedObserver = observer;
}

/**
 * `onUnauthorized`, when given, is invoked (never awaited) for a `401` response only - `apiFetch()` passes one
 * that forwards to whatever `setApiUnauthorizedObserver()` last registered; `authApiFetch()` and a plain
 * `createApiClient()`-made client's `fetch()` (which forwards to that instance's own
 * `setUnauthorizedObserver()`) pass their own. A throwing `onUnauthorized` never changes what the caller sees.
 */
async function decodeApiResponse<T>(
    res: Response,
    onUnauthorized?: (error: ApiRequestError) => void,
    failureMessage: string = "Request failed.",
): Promise<T> {
    const contentType = res.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await res.json().catch(() => undefined) : undefined;

    if (!res.ok) {
        // A body is untrusted: only a non-empty string is a message (anything else would read "[object Object]"), only a string a code.
        const reported = body && (body.message || body.error);
        const message = (typeof reported === "string" && reported) || res.statusText || failureMessage;
        const error = new ApiRequestError(message, res.status, typeof body?.code === "string" ? body.code : undefined, body);
        if (res.status === 401 && onUnauthorized) {
            try {
                onUnauthorized(error);
            } catch {
                // An observer's failure must not change what the caller sees.
            }
        }
        throw error;
    }

    return body as T;
}

/**
 * The low-level shape both the default global client (`apiFetch()`, driven by `configureApiBaseUrl()` and the
 * `jwt` cookie) and an explicit `createApiClient()` instance expose - so a `mailApi.ts`-style module can be
 * written once against this interface and used from either. There is deliberately no `authFetch`/cross-origin
 * counterpart here: `authApiFetch()`'s `authServerUrl` is already explicit per call, so it doesn't need this
 * abstraction the way the single implicit `apiBaseUrl` global does.
 */
export interface ApiClient {
    /** Same contract as `apiFetch()`: prefixes `path` with `/api`, parses a JSON response, and rejects with
     * `ApiRequestError` on a non-ok response. */
    fetch<T = unknown>(path: string, init?: RequestInit): Promise<T>;
    /**
     * Like `fetch()` - same origin, authentication and error decoding - but resolves the response's own bytes instead of parsing JSON, for a picture or other
     * file. An `<img src>` cannot send an `Authorization` header, so a token-authenticated client shows such a file by fetching it here and displaying a
     * `blob:` URL. No `Content-Type` is added.
     */
    fetchBlob(path: string, init?: RequestInit): Promise<Blob>;
    /**
     * This client instance's own `setApiUnauthorizedObserver()` equivalent - see `createApiClient()`'s doc
     * comment for why it is per-instance rather than shared with the module-level `setApiUnauthorizedObserver()`
     * (or across other `ApiClient` instances).
     */
    setUnauthorizedObserver(observer: ((error: ApiRequestError) => void) | undefined): void;
}

/** `createApiClient()`'s options. */
export interface CreateApiClientOptions {
    /** This client's origin, e.g. `"https://mail.example.com"` - always used, never the global
     * `configureApiBaseUrl()` value. A trailing slash is stripped, matching `configureApiBaseUrl()`. */
    baseUrl: string;
    /**
     * Called fresh before every single request this client makes - never cached or reused across calls, so a
     * caller can transparently rotate/refresh the underlying session token between requests (e.g. a
     * background refresh keyed on this one account) without this client needing to know anything about
     * refresh logic itself. Its resolved value is sent as `Authorization: jwt <token>` - the same header
     * format `JWTStrategy` already accepts server-side alongside the `jwt` cookie - never `credentials:
     * "include"`, since a native multi-account app has no relevant cookie jar for a given account's origin.
     * A rejection here rejects the request itself (the underlying `fetch()` is never called).
     */
    getAccessToken: () => Promise<string>;
}

/**
 * Builds an explicit-context `ApiClient`: everything `apiFetch()` does, but always against `baseUrl` (never
 * the `configureApiBaseUrl()` global) and always authenticated with a bearer token from `getAccessToken()`
 * (never the `jwt` cookie / `credentials: "include"`). ADDITIVE to the existing global-config mode -
 * `apiFetch()`/`authApiFetch()`/`configureApiBaseUrl()` are untouched and keep working exactly as before for
 * every existing caller; this is for a consumer (the Tauri multi-account client) that needs several fully
 * independent origin/session contexts open at once, which the single module-level `apiBaseUrl` global can't
 * represent.
 *
 * Distinct instances never share state: each closes over its own `baseUrl`, `getAccessToken` and unauthorized
 * observer, so two accounts' clients never cross-talk even when both are live in the same process.
 *
 * **401 handling is per-instance, not global.** The existing `setApiUnauthorizedObserver()` is one process-wide
 * "you're signed out" signal, correct for a single-session app (one browser tab, one Electron window - there is
 * only ever one session to lose). A multi-account app has no single account whose 401 means "the app" is
 * unauthorized, so an `ApiClient` from `createApiClient()` does NOT invoke the global observer at all; instead
 * each instance has its own `setUnauthorizedObserver()` a caller can register per account (e.g. to mark that
 * one account's tab as needing re-authentication without touching the others).
 */
export function createApiClient(options: CreateApiClientOptions): ApiClient {
    const baseUrl = options.baseUrl.replace(/\/$/, "");
    const { getAccessToken } = options;
    let unauthorizedObserver: ((error: ApiRequestError) => void) | undefined;

    async function send(path: string, init: RequestInit, json: boolean): Promise<Response> {
        const headers = new Headers(init.headers);
        // JSON unless the caller sent a body of its own kind (an upload names the file's type).
        if (json && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json");
        }
        const token = await getAccessToken();
        headers.set("Authorization", `jwt ${token}`);

        return fetch(`${baseUrl}/api${path}`, { ...init, headers });
    }

    async function clientFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
        return decodeApiResponse<T>(await send(path, init, true), (error) => unauthorizedObserver?.(error));
    }

    async function clientFetchBlob(path: string, init: RequestInit = {}): Promise<Blob> {
        const res = await send(path, init, false);
        if (!res.ok) {
            // Throws the same `ApiRequestError` (and tells the observer of a 401) as every other request.
            await decodeApiResponse<never>(res, (error) => unauthorizedObserver?.(error));
        }
        return res.blob();
    }

    return {
        fetch: clientFetch,
        fetchBlob: clientFetchBlob,
        setUnauthorizedObserver(observer) {
            unauthorizedObserver = observer;
        },
    };
}

/**
 * Routes a request to `client.fetch()` when `client` is given, else to the default global `apiFetch()` - the
 * one call every REST client module (`mailApi.ts` etc.) uses to add optional explicit-`ApiClient` support to
 * each of its exported functions with minimal churn: give the function a trailing `client?: ApiClient`
 * parameter (so every existing call site, which never passes one, is unaffected - `undefined` here means
 * exactly what calling `apiFetch()` directly always meant), and swap its `apiFetch(...)` call for
 * `withClient(client, ...)`. A function that calls another exported function of the same module internally
 * (e.g. `mailApi.ts`'s `grantMailboxAccess()` calling `getMailboxAcl()`) threads its own `client` through
 * that call too, so a whole call chain stays pinned to one account.
 */
export function withClient<T = unknown>(client: ApiClient | undefined, path: string, init?: RequestInit): Promise<T> {
    return client ? client.fetch<T>(path, init) : apiFetch<T>(path, init);
}

/**
 * Sends a file's own bytes (not JSON) to `path` - the upload counterpart of `withClient()`. With an explicit `client` the request goes through it, so it
 * reaches that account's origin with its token (the client keeps the `Content-Type` given here). Without one it is a plain `fetch()` to the global
 * origin that carries the `jwt` cookie and the CSRF header, exactly as a same-origin upload always was. Resolves the decoded JSON response and rejects with
 * an `ApiRequestError` (`failureMessage` when the server gave no message) on a non-ok one.
 */
export async function withClientRaw<T = unknown>(
    client: ApiClient | undefined,
    path: string,
    method: string,
    file: Blob,
    contentType: string = file.type,
    failureMessage: string = "Upload failed.",
): Promise<T> {
    if (client) {
        return client.fetch<T>(path, { method, headers: { "Content-Type": contentType }, body: file });
    }
    const res = await fetchWithRecovery(path, {
        method,
        credentials: "include",
        headers: withCsrfHeader({ "Content-Type": contentType }, method),
        body: file,
    });
    return decodeApiResponse<T>(res, (error) => unauthorizedObserver?.(error), failureMessage);
}

/**
 * Fetches `path`'s own bytes (a message's raw source, say) rather than JSON - the download counterpart of `withClient()`. With an explicit `client` the
 * request goes through its `fetchBlob()`, so it reaches that account's origin with its token. Without one it is a plain `fetch()` to the global origin
 * with the `jwt` cookie, renewing the session and asking again once on a `401`, as `apiFetch()` does. Rejects with an `ApiRequestError`
 * (`failureMessage` when the server gave no message) on a non-ok response.
 */
export async function withClientBlob(
    client: ApiClient | undefined,
    path: string,
    failureMessage: string = "Download failed.",
): Promise<Blob> {
    if (client) {
        return client.fetchBlob(path);
    }
    const res = await fetchWithRecovery(path, { credentials: "include" });
    if (!res.ok) {
        // Throws the same `ApiRequestError` (and tells the observer of a 401) as every other request.
        await decodeApiResponse<never>(res, (error) => unauthorizedObserver?.(error), failureMessage);
    }
    return res.blob();
}
