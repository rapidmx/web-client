///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** What the keyboard layer needs to know about where it runs. */
export interface KeyEnvironment {
    /** macOS (and iOS/iPadOS): `mod` is Cmd there, and Option is a text-entry modifier. */
    mac: boolean;
    /** The desktop client (`electron-client`), which exposes `window.rapidmx` from its preload script. */
    electron: boolean;
}

/** What the server render and the first client render use, so the two agree; the real environment is read after mount. */
export const SERVER_ENVIRONMENT: KeyEnvironment = { mac: false, electron: false };

/** Whether this is an Apple platform. Prefers `navigator.userAgentData` (Chromium), then the older `navigator.platform`. */
export function isMacPlatform(): boolean {
    if (typeof navigator === "undefined") {
        return false;
    }
    const uaData = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
    return /mac|iphone|ipad|ipod/i.test(uaData?.platform || navigator.platform || "");
}

/** Whether the page is running inside the desktop client, which is what `window.rapidmx` (its preload's `contextBridge`) tells. */
export function isElectronClient(): boolean {
    return typeof window !== "undefined" && (window as { rapidmx?: unknown }).rapidmx !== undefined;
}

/** The environment as it is right now. Only meaningful in a browser: on the server it is `SERVER_ENVIRONMENT`. */
export function currentEnvironment(): KeyEnvironment {
    return { mac: isMacPlatform(), electron: isElectronClient() };
}
