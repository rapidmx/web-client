///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { accountUrlOf } from "../auth/accountUrl.js";
import { APP_HREFS, SETTINGS_HREF, isSettingsPath } from "../navigation/appHrefs.js";
import { useNavigate } from "../navigation/routerContext.js";
import { SHORTCUTS } from "./keymap.js";
import { useShortcut } from "./useShortcut.js";

export interface GlobalShortcutsProps {
    /** auth-server's base URL - "Go to Account" is offered only when it is set. */
    authServerUrl?: string;
    /** Opens the keyboard shortcuts dialog, or closes it if it is open. */
    onToggleHelp: () => void;
}

/**
 * The shortcuts that work in every view: the "Go to ..." navigation set and the keyboard help. Mounted once by `AppChrome`, next to the
 * `ShortcutProvider`, so it works from Settings and every app alike. Renders nothing.
 *
 * In-app places go through the client-side router (`useNavigate()`); Account is another origin, so it is a plain navigation. Asking for the
 * page you are already on does nothing - but the key is still taken, so the browser doesn't act on it either.
 */
export function GlobalShortcuts({ authServerUrl, onToggleHelp }: GlobalShortcutsProps) {
    const navigate = useNavigate();
    const accountUrl = accountUrlOf(authServerUrl);

    /** A handler that goes to `href` unless the address bar's path says it is already there. */
    const goTo = (href: string, isHere: (pathname: string) => boolean) => () => {
        if (!isHere(window.location.pathname)) {
            navigate(href);
        }
    };
    const isPath = (path: string) => (pathname: string) => pathname === path;

    useShortcut(SHORTCUTS.global.mail, goTo(APP_HREFS.mail, isPath(APP_HREFS.mail)));
    useShortcut(SHORTCUTS.global.calendar, goTo(APP_HREFS.calendar, isPath(APP_HREFS.calendar)));
    useShortcut(SHORTCUTS.global.contacts, goTo(APP_HREFS.contacts, isPath(APP_HREFS.contacts)));
    useShortcut(SHORTCUTS.global.tasks, goTo(APP_HREFS.tasks, isPath(APP_HREFS.tasks)));
    useShortcut(SHORTCUTS.global.settings, goTo(SETTINGS_HREF, isSettingsPath));
    useShortcut(
        SHORTCUTS.global.account,
        () => {
            window.location.href = accountUrl!;
        },
        { enabled: !!accountUrl },
    );
    useShortcut(SHORTCUTS.global.help, onToggleHelp);
    return null;
}
