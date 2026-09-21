///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * What the client-side router (`AppRouter.tsx`) offers to the tree under it - the location and a way to navigate - and the hooks that read
 * it. Kept apart from the router itself so that the app frame (`AppShell`), which the router renders, can use `useNavigate()` without a
 * circular import. `AppRouter.tsx` re-exports everything here, so callers keep importing from there.
 */
import { createContext, useContext, useEffect, useState } from "react";

export interface RouterLocation {
    pathname: string;
    /** With the leading `?`, or `""`. */
    search: string;
    /** With the leading `#`, or `""`. */
    hash: string;
}

export interface NavigateOptions {
    /** Replaces the current history entry instead of adding one (a redirect, or a state change that isn't a "place"). */
    replace?: boolean;
}

/** Goes to `href`: without a page load when it is a route of the app, else as an ordinary navigation. */
export type NavigateFn = (href: string, options?: NavigateOptions) => void;

export interface RouterContextValue {
    location: RouterLocation;
    navigate: NavigateFn;
}

export const RouterContext = createContext<RouterContextValue | null>(null);

/** Before the browser's own location has been read (the server render and the first client render, which must match). */
export const UNKNOWN_LOCATION: RouterLocation = { pathname: "", search: "", hash: "" };

export function readWindowLocation(): RouterLocation {
    const { pathname, search, hash } = window.location;
    return { pathname, search, hash };
}

/** What `useNavigate()` does outside a router: an ordinary navigation, exactly as `window.location.href = href` always was. */
function navigateWithBrowser(href: string, options: NavigateOptions = {}): void {
    if (options.replace) {
        window.location.replace(href);
    } else {
        window.location.href = href;
    }
}

/**
 * The function to go somewhere with. `navigate("/calendar")` and `navigate("/?mailboxUid=a&folderUid=b")` change the page and
 * the URL without a page load when the router knows the route (Mail, Calendar, Contacts, Tasks, Settings and their subpages),
 * and load the page normally otherwise; outside the router it is always a normal navigation. Prefer a plain `<a href>` for
 * anything the user clicks - the router intercepts it, and it stays a real link - and this for what code decides (after a
 * save, a delete, a select). The returned function is stable across renders.
 */
export function useNavigate(): NavigateFn {
    const router = useContext(RouterContext);
    return router ? router.navigate : navigateWithBrowser;
}

/**
 * Where the app is now, as `{ pathname, search, hash }`, updating as the router navigates (folder changes are `search`
 * changes, not page changes). Empty until the browser's location has been read in an effect after the first render, so that
 * the server render and the first client render agree - read query parameters from it in an effect, not during render.
 */
export function useLocation(): RouterLocation {
    const router = useContext(RouterContext);
    const [own, setOwn] = useState<RouterLocation>(UNKNOWN_LOCATION);
    useEffect(() => {
        if (!router) {
            setOwn(readWindowLocation());
        }
    }, [router]);
    return router ? router.location : own;
}

/** `useLocation().search` - what the shells read `?mailboxUid=` and the like from. */
export function useLocationSearch(): string {
    return useLocation().search;
}
