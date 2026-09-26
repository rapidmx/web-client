///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * What the web client's code uses to go somewhere. The client-side router is `@rapidrest/react`'s (`router = true` on the
 * route, the app's `_shell.tsx` as the persistent frame - see `apps/www/_shell.tsx`); this is the one thing on top of it: a
 * `navigate()` that keeps the page when only the query string changes.
 */
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useLocation as useRouterLocation, useRouter } from "@rapidrest/react/client";

export interface NavigateOptions {
    /** Replaces the current history entry instead of adding one (a redirect, or a state change that isn't a "place"). */
    replace?: boolean;
}

/** Goes to `href`: without a page load when it is a page of the app, else as an ordinary navigation. */
export type NavigateFn = (href: string, options?: NavigateOptions) => void;

/**
 * The function to go somewhere with, for what code decides (after a save, a select, a folder change). `navigate("/calendar")`
 * changes the page and the URL without a page load when the router knows the page (Mail, Calendar, Contacts, Tasks, Settings
 * and their subpages), and loads it normally otherwise (another app, a plugin's page); outside a router it is always a
 * normal navigation. A destination with the path the page is at - only its query string is different (`/?mailboxUid=a&folderUid=b`,
 * `/tasks?mailboxUid=b`) - is a shallow navigation: the page instance keeps its state, and what reads the location follows. Prefer
 * a plain `<a href>` for anything the user clicks - the router takes it over, and it stays a real link. The returned function is
 * stable across renders.
 */
export function useNavigate(): NavigateFn {
    const { navigate, pathname } = useRouter();
    // The latest, through a ref: the router value is replaced whenever the location or a navigation's pending state changes, and
    // callers keep this function in effect dependencies (the mail connection's `open`).
    const latest = useRef({ navigate, pathname });
    latest.current = { navigate, pathname };
    return useCallback<NavigateFn>((href, options = {}) => {
        const { navigate: go, pathname: here } = latest.current;
        // A relative or absolute-path destination is resolved against the page's own address, and only ever compared by path.
        const destination = new URL(href, `http://router.invalid${here}`);
        const shallow = destination.origin === "http://router.invalid" && destination.pathname === here;
        void go(href, { replace: options.replace, shallow });
    }, []);
}

function subscribeToHistory(onChange: () => void): () => void {
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
}

const currentAddress = (): string => window.location.pathname + window.location.search + window.location.hash;
const noAddress = (): string => "";

/**
 * Where the page is, as `{ pathname, search, hash }`: the router's location when the page is under a router, else the browser's.
 * A page a plugin renders has no router (`router = false`), where `@rapidrest/react`'s `useLocation()` is empty and the query a
 * shell reads its mailbox from (`?mailboxUid=`) would be lost. Without one, the address is the browser's - and empty on the
 * server and while hydrating, so the page hydrates as it was rendered and then follows the address.
 */
export function useLocation(): { pathname: string; search: string; hash: string } {
    const routed = useRouterLocation();
    const own = useSyncExternalStore(subscribeToHistory, currentAddress, noAddress);
    const ownLocation = useMemo(() => {
        // Split by hand, not with `URL`: a page that stubs the global `URL` (for `createObjectURL`) must still render.
        const [beforeHash, ...fragment] = own.split("#");
        const [pathname, ...query] = beforeHash.split("?");
        return { pathname, search: query.length ? `?${query.join("?")}` : "", hash: fragment.length ? `#${fragment.join("#")}` : "" };
    }, [own]);
    return routed.pathname !== "" ? routed : ownLocation;
}
