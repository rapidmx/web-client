///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrapper over `@rapidrest/auth`'s `BaseProfileRoute`, mounted by auth-server at `/api/profiles`. Used
 * for the signed-in user's own display name/avatar in the top-right user menu (see `UserMenu.tsx`) — this
 * service has no local user directory of its own (see `.claude/NOTES.md`), so name/avatar can only ever come
 * from auth-server.
 *
 * Deliberately NOT given the explicit-`ApiClient` `client?` parameter every other converted module in this
 * package has — see `withClient()`'s doc comment in `util/api.ts`. Both `getMyProfile()` and `getMyUsername()`
 * already take an explicit `authServerUrl` targeting a *different* origin than this app's own API (auth-server,
 * not the RapidMX server `ApiClient`/`apiFetch()` talk to) — the same shape as `mailApi.ts`'s `impersonateUser()`/
 * `stopImpersonating()`, which is why those were left unconverted too. A per-account auth-server session (the
 * multi-account app's own credentials for *that* origin, not this app's) is a separate future change, out of
 * scope here.
 */
import { authApiFetch } from "../util/api.js";

export interface Profile {
    uid: string;
    /** URL to the user's avatar image (e.g. gravatar). Absent for most password-registered accounts. */
    avatar?: string;
    givenName?: string;
    familyName?: string;
}

/** Fetches the signed-in caller's own profile — `"me"` resolves to the caller's own uid server-side. */
export function getMyProfile(authServerUrl: string): Promise<Profile> {
    return authApiFetch(authServerUrl, "/profiles/me");
}

/**
 * One of the caller's own aliases as auth-server's `GET /api/aliases` returns it - only the fields read here.
 * `type: "name"` is a username (the local part of a mailbox address); `verified` is false until it's confirmed.
 */
export interface Alias {
    alias: string;
    type: string;
    verified?: boolean;
}

/**
 * The caller's username - their first verified auth-server alias of type `name` (`GET /api/aliases?type=name`,
 * which lists only the caller's own). The display-name fallback for an account with no profile name: some
 * accounts have no profile document at all (`/profiles/me` is a 404 for them), yet every account has a
 * username. Never rejects - a failed call, an unexpected body or no verified name alias all resolve
 * `undefined`, since a missing nicety must not surface as an error.
 */
export async function getMyUsername(authServerUrl: string): Promise<string | undefined> {
    try {
        const aliases = await authApiFetch<Alias[]>(authServerUrl, "/aliases?type=name");
        return Array.isArray(aliases) ? aliases.find((a) => a?.type === "name" && a.verified === true && !!a.alias)?.alias : undefined;
    } catch {
        return undefined;
    }
}

/** `"Jane Doe"`, `"Jane"`, `"Doe"`, or `undefined` if neither name field is set. */
export function formatProfileName(profile: Pick<Profile, "givenName" | "familyName"> | undefined): string | undefined {
    const name = [profile?.givenName, profile?.familyName].filter(Boolean).join(" ").trim();
    return name || undefined;
}

/**
 * A 1-2 letter initials badge, derived from the profile's name, else the first letter of `username` (see
 * `getMyUsername()`), else the first letter of the given uid.
 */
export function profileInitials(
    profile: Pick<Profile, "givenName" | "familyName"> | undefined,
    uid: string,
    username?: string,
): string {
    const initials = [profile?.givenName?.[0], profile?.familyName?.[0]].filter(Boolean).join("");
    return (initials || username?.[0] || uid[0] || "?").toUpperCase();
}
