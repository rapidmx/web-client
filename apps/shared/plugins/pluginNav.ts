///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * One navigation entry a plugin contributes through its manifest's `ui` field. Structurally identical to
 * `@rapidmx/restapi`'s `PluginUiNavItem`, defined locally so this package doesn't depend on restapi.
 */
export interface PluginUiNavItem {
    /** Unique within its list. A plugin page passes this as its shell's `active` to highlight the entry. */
    id: string;
    label: string;
    /** A same-origin path under the host's prefix (`/settings/...`, `/admin/...`, `/...`). */
    href: string;
}

/**
 * The navigation every enabled plugin with a successfully built UI contributes, supplied by the server's
 * `WwwRoute`/`AdminConsoleRoute` `fetchProps` as the `pluginNav` page prop.
 */
export interface PluginNav {
    /** Appended to `SettingsShell`'s section list. */
    settingsSections?: PluginUiNavItem[];
    /** Appended to `AdminShell`'s icon rail and mobile tab bar. */
    adminNav?: PluginUiNavItem[];
    /** Appended to `AppShell`'s app rail and mobile tab bar. */
    appRail?: PluginUiNavItem[];
}

/** The page prop every www and admin page receives - extended by `AppShellProps` and `AdminShellProps`, so
 * a page that spreads its props onto its shell passes `pluginNav` through with no code of its own. */
export interface PluginNavProps {
    pluginNav?: PluginNav;
}

/** A same-origin absolute path: starts with `/`, but not `//` or `/\` (both of which browsers treat as
 * protocol-relative URLs to another host). */
export function isSafePluginHref(href: string): boolean {
    return /^\/(?![/\\])/.test(href);
}

/**
 * Appends a plugin's nav items after the core ones. Skips any item that isn't well-formed, whose `href`
 * isn't a same-origin path (see `isSafePluginHref`), or whose id is already taken - by a core item or
 * `reservedIds` (core ids always win) or by an earlier plugin item.
 */
export function mergePluginNavItems<T extends { id: string }>(
    coreItems: T[],
    pluginItems: PluginUiNavItem[] | undefined,
    toItem: (item: PluginUiNavItem) => T,
    reservedIds: string[] = [],
): T[] {
    if (!pluginItems?.length) {
        return coreItems;
    }
    const taken = new Set([...coreItems.map((item) => item.id), ...reservedIds]);
    const merged = [...coreItems];
    for (const item of pluginItems) {
        if (
            typeof item?.id !== "string" ||
            typeof item.label !== "string" ||
            typeof item.href !== "string" ||
            !isSafePluginHref(item.href) ||
            taken.has(item.id)
        ) {
            continue;
        }
        taken.add(item.id);
        merged.push(toItem(item));
    }
    return merged;
}
