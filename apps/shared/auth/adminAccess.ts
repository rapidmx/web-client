///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { authApiFetch } from "@rapidmx/react-shared/util/api.js";

/**
 * Whether the signed-in user holds an administrator role, learned without elevating.
 *
 * The JWT the browser carries can't say: auth-server strips every trusted role from a token that isn't elevated
 * (`TokenUtils.resolveTokenUser()`), so `trusted` (from the JWT) is false for a real administrator until they confirm
 * their identity on auth-server's elevation page. The role itself lives on the caller's own `User` record, which they may
 * always read - `GET {authServerUrl}/api/users/me` (the same call auth-server's own UI makes "to check for admin access") -
 * so the answer is read from there, with the same cross-origin credentials the profile lookups use.
 *
 * This only decides whether a menu item is shown. The `/admin` pages and API stay authoritative: they check the role and
 * the elevation themselves, and the link only navigates (`/admin` then runs the elevation redirect), so a wrong answer
 * - a stale cache, a tampered `sessionStorage` - can show a link that leads to "no administrator access", never more.
 */

/** The roles the server treats as trusted when it isn't configured otherwise (`trusted_roles`, default `["admin"]`). */
export const DEFAULT_TRUSTED_ROLES: readonly string[] = ["admin"];

/** `sessionStorage` key prefix of a remembered answer; the user's uid follows, so another account signing in in the same
 * tab never inherits it. */
export const ADMIN_ACCESS_KEY_PREFIX = "rapidmx-admin-access:";

/** How long a remembered answer is trusted - long enough that navigating between the apps costs no request, short enough
 * that a role granted or removed shows up within the sitting. */
export const ADMIN_ACCESS_TTL_MS = 30 * 60 * 1000;

/** Lookups in flight, by key, so two components asking at once make one request. */
const lookups = new Map<string, Promise<boolean | undefined>>();

/** Forgets the lookups in flight (tests). */
export function resetAdminAccessLookups(): void {
    lookups.clear();
}

function readRemembered(key: string, now: number): boolean | undefined {
    try {
        const stored = JSON.parse(sessionStorage.getItem(key) ?? "null") as { admin?: unknown; at?: unknown } | null;
        if (typeof stored?.admin === "boolean" && typeof stored.at === "number" && now - stored.at >= 0 && now - stored.at < ADMIN_ACCESS_TTL_MS) {
            return stored.admin;
        }
    } catch {
        // Unreadable, or storage unavailable - ask again.
    }
    return undefined;
}

function remember(key: string, admin: boolean, now: number): void {
    try {
        sessionStorage.setItem(key, JSON.stringify({ admin, at: now }));
    } catch {
        // Storage unavailable - the next page load asks again.
    }
}

/**
 * Resolves `true` when `userUid`'s own `User` record on auth-server carries one of `trustedRoles`, `false` when it
 * doesn't, and `undefined` when that couldn't be established (unreachable, blocked by CORS, not signed in, an unexpected
 * body, or a record that isn't this user's). Only a real answer is remembered; a failure is asked again on the next page.
 * Never rejects.
 */
export function lookUpAdminAccess(
    authServerUrl: string,
    userUid: string,
    trustedRoles: readonly string[] = DEFAULT_TRUSTED_ROLES,
    now: number = Date.now(),
): Promise<boolean | undefined> {
    const key = `${ADMIN_ACCESS_KEY_PREFIX}${userUid}`;
    const remembered = readRemembered(key, now);
    if (remembered !== undefined) {
        return Promise.resolve(remembered);
    }
    const inFlight = lookups.get(key);
    if (inFlight) {
        return inFlight;
    }
    const lookup = (async (): Promise<boolean | undefined> => {
        try {
            const user = await authApiFetch<{ uid?: unknown; roles?: unknown } | null>(authServerUrl, "/users/me");
            if (!user || user.uid !== userUid || !Array.isArray(user.roles)) {
                return undefined;
            }
            const admin = user.roles.some((role) => typeof role === "string" && trustedRoles.includes(role));
            remember(key, admin, now);
            return admin;
        } catch {
            return undefined;
        } finally {
            // Answered: what was learned is in storage; a failure may be asked again.
            lookups.delete(key);
        }
    })();
    lookups.set(key, lookup);
    return lookup;
}
