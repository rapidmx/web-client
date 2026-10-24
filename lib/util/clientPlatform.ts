///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * What kind of client this is, for work that should prefer one over another - the search index's week compaction, which a phone
 * should leave to a computer (restapi `specs/search.md` §8 *Who compacts*).
 *
 * - `"desktop"`: a native app on a computer (`tauri-client`, `electron-client`), which installs `window.rapidmx`.
 * - `"mobile"`: a native app on a phone or tablet (the host sets `window.rapidmx.formFactor: "mobile"`), or a phone or tablet browser.
 * - `"web"`: any other browser.
 */
export type ClientPlatform = "desktop" | "web" | "mobile";

interface NavigatorHints {
    userAgent?: string;
    userAgentData?: { mobile?: boolean };
    connection?: { type?: string; saveData?: boolean };
}

const MOBILE_USER_AGENT = /Android|iPhone|iPad|iPod|Mobile/i;

function navigatorHints(): NavigatorHints | undefined {
    return typeof navigator === "undefined" ? undefined : navigator;
}

/** Whether this browser runs on a phone or tablet, by its User-Agent Client Hints, else its user agent string. */
function isMobileBrowser(): boolean {
    const hints = navigatorHints();
    if (typeof hints?.userAgentData?.mobile === "boolean") {
        return hints.userAgentData.mobile;
    }
    return MOBILE_USER_AGENT.test(hints?.userAgent ?? "");
}

/** This client's platform (see the module comment). */
export function clientPlatform(): ClientPlatform {
    const host = typeof window === "undefined" ? undefined : (window as { rapidmx?: { formFactor?: string } }).rapidmx;
    if (host) {
        return host.formFactor === "mobile" ? "mobile" : "desktop";
    }
    return isMobileBrowser() ? "mobile" : "web";
}

/** Whether the connection is one to spare: cellular, or the user asked to save data (Network Information API, where the browser
 * has it - absent, the connection is taken as unconstrained). */
export function isConstrainedConnection(): boolean {
    const connection = navigatorHints()?.connection;
    return connection?.saveData === true || connection?.type === "cellular";
}
