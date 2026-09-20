///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";

/**
 * The `ApiRequestError.code` a `@RequiresElevation()` endpoint answers a caller whose token isn't elevated with
 * (a 403 - `ApiErrors.AUTH_REQUIRES_ELEVATION` in `@rapidrest/service-core`). Distinct from `api-103` (the caller is
 * elevated but lacks the trusted role), which no amount of elevating fixes.
 */
export const ELEVATION_REQUIRED_CODE = "api-104";

/** `sessionStorage` key holding the time (`Date.now()`) the browser was last sent to auth-server to elevate. */
export const ELEVATION_ATTEMPT_KEY = "rapidmx-admin-elevation-attempt";

/** How long after sending the browser to elevate a second `api-104` is taken to mean the elevation didn't take
 * effect (e.g. auth-server's elevated cookie never reaching this origin), rather than a fresh need to elevate. */
export const ELEVATION_RETRY_WINDOW_MS = 2 * 60 * 1000;

/** Whether `err` is a 403 from an elevation-gated endpoint for a caller whose token isn't elevated. */
export function isElevationRequired(err: unknown): boolean {
    return err instanceof ApiRequestError && err.status === 403 && err.code === ELEVATION_REQUIRED_CODE;
}

/** auth-server's elevation page: it sends the browser back to `returnTo` once the user has confirmed their
 * identity, or to its own account page if they cancel. */
export function elevationUrl(authServerUrl: string, returnTo: string): string {
    return `${authServerUrl}/auth/elevate?return_to=${encodeURIComponent(returnTo)}`;
}

/** Whether the browser was sent to elevate within `ELEVATION_RETRY_WINDOW_MS` of `now`. `false` when nothing was
 * recorded, the record is unreadable or from the future, or storage is unavailable. */
export function elevationAttemptedRecently(now: number = Date.now()): boolean {
    try {
        const recorded = Number(sessionStorage.getItem(ELEVATION_ATTEMPT_KEY));
        const elapsed = now - recorded;
        return recorded > 0 && elapsed >= 0 && elapsed < ELEVATION_RETRY_WINDOW_MS;
    } catch {
        return false;
    }
}

/** Remembers, for this tab, that the browser is about to be sent to elevate. A no-op where storage is unavailable
 * (then only the first-round protection is lost - elevating needs the user to confirm each time round). */
export function recordElevationAttempt(now: number = Date.now()): void {
    try {
        sessionStorage.setItem(ELEVATION_ATTEMPT_KEY, String(now));
    } catch {
        // See the doc comment.
    }
}

/** Forgets any recorded attempt - once elevation has worked, or when the user asks to try again. */
export function clearElevationAttempt(): void {
    try {
        sessionStorage.removeItem(ELEVATION_ATTEMPT_KEY);
    } catch {
        // Nothing was recorded.
    }
}
