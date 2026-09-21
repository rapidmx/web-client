///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** Where each of the four rail apps lives - what the icon rail links to and what the keyboard's "Go to ..." shortcuts navigate to. */
export const APP_HREFS = {
    mail: "/",
    calendar: "/calendar",
    contacts: "/contacts",
    tasks: "/tasks",
} as const;

/**
 * Settings is reached from the account menu, not the rail. It links straight to the first settings section, the only one that always
 * exists - repoint this at a real `/settings` landing page once there is one.
 */
export const SETTINGS_HREF = "/settings/auto-reply";

/** Whether `pathname` is a page of Settings (any section), which is what "already there" means for it. */
export function isSettingsPath(pathname: string): boolean {
    return pathname === "/settings" || pathname.startsWith("/settings/");
}
