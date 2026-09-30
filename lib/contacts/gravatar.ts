///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** The `localStorage` key of the privacy preference: `"off"` stops contact avatars from asking Gravatar for a picture. */
export const GRAVATAR_PREFERENCE_KEY = "rapidmx:gravatar";

/**
 * Whether avatars may look a person up at Gravatar by the SHA-256 hash of their address (never the address itself). On unless the reader turned
 * it off (`localStorage["rapidmx:gravatar"] = "off"`); a browser without storage keeps the default.
 */
export function gravatarEnabled(): boolean {
    try {
        return globalThis.localStorage?.getItem(GRAVATAR_PREFERENCE_KEY) !== "off";
    } catch {
        return true;
    }
}

const hashes = new Map<string, Promise<string | undefined>>();

/** The lowercase-hex SHA-256 of a trimmed, lowercased `email`, or `undefined` where the browser has no Web Crypto (an insecure page). */
function hashOf(email: string): Promise<string | undefined> {
    const normalized = email.trim().toLowerCase();
    let hash = hashes.get(normalized);
    if (!hash) {
        hash = (async () => {
            const digest = await globalThis.crypto?.subtle?.digest("SHA-256", new TextEncoder().encode(normalized));
            return digest && Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        })().catch(() => undefined);
        hashes.set(normalized, hash);
    }
    return hash;
}

/**
 * The Gravatar picture URL for `email`, `size` pixels square. It answers `404` (`d=404`) for a person with no Gravatar, so an `<img>` fails to load
 * and the caller falls back to initials rather than showing Gravatar's placeholder. `undefined` for an empty address or without Web Crypto.
 */
export async function gravatarUrl(email: string, size: number): Promise<string | undefined> {
    if (!email.trim()) {
        return undefined;
    }
    const hash = await hashOf(email);
    return hash && `https://gravatar.com/avatar/${hash}?s=${Math.max(1, Math.round(size))}&d=404`;
}
