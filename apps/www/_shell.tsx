///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { PropsWithChildren, useCallback, useMemo, useState } from "react";
import { useNavigationEffects, useRouter } from "@rapidrest/react/client";
import { AppChrome, type AppShellActive, type AppShellProps } from "../shared/components/layout/AppShell.js";
import { AppFrameContext, type AppFrameContextValue } from "../shared/navigation/frameContext.js";
import { titleWithUnread } from "../shared/mail/useUnreadTitle.js";

/**
 * The webmail's persistent app frame: `@rapidrest/react`'s app shell (`_shell.tsx`), rendered around every page of `apps/www` -
 * on the server, in the same tree the browser hydrates - and kept mounted while the router swaps the pages inside it, so that
 * moving between Mail, Calendar, Contacts, Tasks and Settings replaces only the page. It is what holds the state that must outlive
 * a page: the compose windows in progress, the unlock prompt, the idle-key timer, the sign-out listener, the mail connection (one
 * push socket for every app), the user menu and the notification pop-ups (all `AppChrome`'s).
 *
 * The props are the current page's - `WwwRoute.fetchProps()`'s, the same for every page: the user, the auth-server URL, the
 * branding, the plugin navigation, the impersonation state and the appearance - and are fetched again on every navigation, so a
 * change of any of them (a plugin installed, the branding edited) shows on the next page. A page still renders its own shell
 * (`MailShell`, `CalendarShell`, ...) with `AppShell` inside it as it always did; inside this frame that renders only its children.
 *
 * What a page load did by itself and the router now does after each navigation - focus moves to the content, the window scrolls to
 * the top, a screen reader is told the page's title - is configured here (`useNavigationEffects()`); the tab's title is each
 * page's `title` export (`pageTitle()`). `busy` is the router's pending state: the content is `aria-busy` while the next page
 * loads and the old one is still on screen.
 */
export type WwwShellProps = PropsWithChildren<Omit<AppShellProps, "active">>;

/**
 * The app-rail entry (or `"settings"`, which has none) that a route highlights: the first segment of its template names the
 * app. Anything else - Mail's `/` and `/messages/:uid` - is Mail.
 */
export function activeAppOf(route: string): AppShellActive {
    const app = route.split("/")[1];
    return app === "calendar" || app === "contacts" || app === "tasks" || app === "settings" ? app : "mail";
}

export default function WwwShell({
    children,
    userUid,
    authServerUrl,
    impersonating,
    impersonationBaseUrl,
    trusted,
    trustedRoles,
    pluginNav,
    branding,
    appearance,
}: WwwShellProps) {
    const { route, pending } = useRouter();
    const [takeovers, setTakeovers] = useState(0);
    const enterTakeover = useCallback(() => {
        setTakeovers((n) => n + 1);
        return () => setTakeovers((n) => n - 1);
    }, []);
    const frame = useMemo<AppFrameContextValue>(() => ({ enterTakeover }), [enterTakeover]);
    // The content region is what a page load would have started at: focus it (it is only focusable by script), start at the top, and say the
    // page's title - without the unread count that the tab's title carries in front of it.
    useNavigationEffects({ focus: "#app-content", scroll: "top", announce: ({ title }) => titleWithUnread(title, 0) });

    return (
        <AppFrameContext.Provider value={frame}>
            <AppChrome
                active={activeAppOf(route)}
                busy={pending}
                hideChrome={takeovers > 0}
                userUid={userUid}
                authServerUrl={authServerUrl}
                impersonating={impersonating}
                impersonationBaseUrl={impersonationBaseUrl}
                trusted={trusted}
                trustedRoles={trustedRoles}
                pluginNav={pluginNav}
                branding={branding}
                appearance={appearance}
            >
                {children}
            </AppChrome>
        </AppFrameContext.Provider>
    );
}
