///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** The `localStorage` key of the privacy preference: `"on"` lets contact avatars ask Gravatar for a picture; anything else (including unset or an old `"off"`) does not. */
export const GRAVATAR_PREFERENCE_KEY = "rapidmx:gravatar";

/** Fired on `window` when this tab changes the preference (the `storage` event covers other tabs). */
export const GRAVATAR_PREFERENCE_EVENT = "rapidmx:gravatar-changed";

/**
 * Whether avatars may look a person up at Gravatar by the SHA-256 hash of their address (never the address itself). Off unless the reader turned it on
 * in Settings > Privacy (`localStorage["rapidmx:gravatar"] = "on"`): it tells gravatar.com the hash and the reader's IP address. A browser without
 * storage stays off.
 */
export function gravatarEnabled(): boolean {
    try {
        return globalThis.localStorage.getItem(GRAVATAR_PREFERENCE_KEY) === "on";
    } catch {
        return false;
    }
}

/** Turns the Gravatar lookup on or off and tells every subscriber (`subscribeGravatarPreference()`) in this tab. */
export function setGravatarEnabled(enabled: boolean): void {
    try {
        globalThis.localStorage.setItem(GRAVATAR_PREFERENCE_KEY, enabled ? "on" : "off");
    } catch {
        // Storage is unavailable: the preference cannot be kept, so it stays off.
    }
    globalThis.dispatchEvent(new Event(GRAVATAR_PREFERENCE_EVENT));
}

/** Calls `listener` whenever the preference changes in this tab or another; returns the unsubscribe function. Shaped for `useSyncExternalStore`. */
export function subscribeGravatarPreference(listener: () => void): () => void {
    const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key === GRAVATAR_PREFERENCE_KEY) {
            listener();
        }
    };
    globalThis.addEventListener(GRAVATAR_PREFERENCE_EVENT, listener);
    globalThis.addEventListener("storage", onStorage);
    return () => {
        globalThis.removeEventListener(GRAVATAR_PREFERENCE_EVENT, listener);
        globalThis.removeEventListener("storage", onStorage);
    };
}

/** Gravatar URLs that answered with nothing, so a list that shows the same person again does not ask again for the page's lifetime. */
const missing = new Set<string>();

/** Remembers that Gravatar has no picture at `url`. */
export function markGravatarMissing(url: string): void {
    missing.add(url);
}

/** Whether Gravatar already answered with no picture at `url`. */
export function isGravatarMissing(url: string): boolean {
    return missing.has(url);
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
