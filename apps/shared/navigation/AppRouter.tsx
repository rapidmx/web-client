///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The web client's client-side router: what lets Mail, Calendar, Contacts, Tasks and Settings replace one another - and a
 * folder replace a folder - without a page load.
 *
 * `@rapidrest/react` has no router of its own: every page is a server-rendered document with its own hydration entry, and
 * hydrates only the page component (never `_layout.tsx`). So the router is a component the pages render themselves - each
 * page's default export is `routedPage(path, Page)` (see `apps/www/_routedPage.tsx`), which renders `AppRouter` with the page
 * as its first content. The first load is unchanged: the server renders the same tree, the browser hydrates it.
 *
 * `AppRouter` keeps ONE `AppChrome` (the icon rail, header, user menu, impersonation banner, compose windows, unlock prompt,
 * idle-key timer, sign-out listener) mounted and swaps only what is inside it. A page's own shell (`MailShell`,
 * `CalendarShell`, ...) still renders `AppShell` as it always did; inside the frame that renders nothing but its children.
 *
 * Navigation:
 *
 * Every `<a href>` to a same-origin path in the route table is intercepted (plain left clicks only - not with a modifier key, not
 * `target`/`download`, not a hash-only link, not one marked `data-full-reload`), so pages just write ordinary links and
 * middle-click, "open in new tab" and copy-link keep working. Anything not in the table - the admin and escrow consoles, plugin
 * pages, other sites - is left to the browser. `useNavigate()` does the same for code (`navigate("/contacts")`).
 *
 * Back and forward work (`popstate`), and the URL is always the real, shareable one (`?mailboxUid=&folderUid=` and all).
 *
 * A route's code is loaded (`route.load()`) before the URL and the page change, so the old page stays up meanwhile (the frame is
 * `aria-busy`); a route that fails to load falls back to a real navigation, which also picks up a new deploy.
 *
 * The next page's code is fetched on hover, focus and pointer-down of a link to it, and for the app rail's pages when the browser
 * is idle.
 *
 * After a page change the frame moves keyboard focus to the content region, scrolls to the top, sets `document.title` and
 * announces the new page to screen readers.
 *
 * The props of every `apps/www` page are the same for all of them (`WwwRoute.fetchProps()`: the user, auth-server URL,
 * branding, plugin navigation, impersonation) except `params`, which the router recomputes from the URL - so the props of the
 * page that was loaded are what every later page gets.
 */
import React, { ComponentType, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppChrome, type AppShellProps } from "../components/layout/AppShell.js";
import { AppFrameContext, AppFrameContextValue } from "./frameContext.js";
import { whenIdle, shouldSaveData } from "./idle.js";
import { RouteDefinition, RouteMatch, matchRoute } from "./routes.js";
import { NavigateFn, RouterContext, RouterContextValue, RouterLocation, UNKNOWN_LOCATION, readWindowLocation } from "./routerContext.js";

export { useLocation, useLocationSearch, useNavigate } from "./routerContext.js";
export type { NavigateFn, NavigateOptions, RouterLocation } from "./routerContext.js";

/** What `routedPage()` gives the router: the page component itself, without the router around it. */
export type RoutedPageComponent<P = any> = ComponentType<P> & { page: ComponentType<P> };

interface CurrentPage {
    Page: ComponentType<any>;
    /** The route template shown. */
    routePath: string;
    active: string;
    params: Record<string, string>;
    /** Changes with the pathname, so a different page (or the same page for a different `:uid`) mounts fresh, while a change
     * of query string alone - a folder - keeps the page and its state. */
    key: string;
}

export interface AppRouterProps {
    routes: readonly RouteDefinition[];
    /** The template of the route this document was rendered for. */
    initialPath: string;
    initialPage: ComponentType<any>;
    /** The props the server rendered the page with. */
    pageProps: Record<string, any>;
}

function pickChromeProps(props: Record<string, any>): Omit<AppShellProps, "active"> {
    const { userUid, authServerUrl, impersonating, impersonationBaseUrl, trusted, trustedRoles, pluginNav, branding, appearance } = props;
    return { userUid, authServerUrl, impersonating, impersonationBaseUrl, trusted, trustedRoles, pluginNav, branding, appearance };
}

/** The anchor a click/pointer event is on or in, if it is a link. */
function linkOf(event: Event): HTMLAnchorElement | null {
    const target = event.target;
    return target instanceof Element ? target.closest("a[href]") : null;
}

/** The URL of a link the router may take over, `null` for one the browser must handle itself. */
function routerUrlOf(link: HTMLAnchorElement): URL | null {
    if ((link.target && link.target !== "_self") || link.hasAttribute("download") || link.hasAttribute("data-full-reload")) {
        return null;
    }
    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin) {
        return null;
    }
    // A link that only moves within the page (`#section`) is the browser's own.
    if (url.hash !== "" && url.pathname === window.location.pathname && url.search === window.location.search) {
        return null;
    }
    return url;
}

export default function AppRouter({ routes, initialPath, initialPage, pageProps }: AppRouterProps) {
    const [current, setCurrent] = useState<CurrentPage>(() => ({
        Page: initialPage,
        routePath: initialPath,
        active: routes.find((route) => route.path === initialPath)?.active ?? "mail",
        params: pageProps.params ?? {},
        key: "initial",
    }));
    const [location, setLocation] = useState<RouterLocation>(UNKNOWN_LOCATION);
    const [pending, setPending] = useState(false);
    const [takeovers, setTakeovers] = useState(0);

    const currentRef = useRef(current);
    currentRef.current = current;
    /** Identifies the latest navigation; one that finds it changed while loading has been overtaken and does nothing. */
    const navigationRef = useRef(0);
    /** The page components loaded or loading, by route template - one request per page however many links are touched. */
    const pagesRef = useRef(new Map<string, Promise<ComponentType<any>>>([[initialPath, Promise.resolve(initialPage)]]));
    const routesRef = useRef(routes);
    routesRef.current = routes;

    /** Loads a route's page component (once). Rejects if its code can't be loaded - and then a later attempt tries again. */
    const pageFor = useCallback((route: RouteDefinition): Promise<ComponentType<any>> => {
        let loading = pagesRef.current.get(route.path);
        if (!loading) {
            loading = route.load().then((module) => {
                const page = (module.default as Partial<RoutedPageComponent>).page;
                if (!page) {
                    throw new Error(`The page for ${route.path} is not a routedPage().`);
                }
                return page;
            });
            pagesRef.current.set(route.path, loading);
            loading.catch(() => pagesRef.current.delete(route.path));
        }
        return loading;
    }, []);

    /** The pathname of the page on screen (the address bar's, once a navigation has been committed). */
    const shownPathRef = useRef<string | null>(null);

    /**
     * Shows `match` (loading its page first if it is a different page from the one on screen), calling `commit` - which puts
     * the URL in the address bar - at the moment the new page replaces the old one. Resolves `false` when the page's code
     * couldn't be loaded, and `true` otherwise, including when a newer navigation overtook this one while it loaded.
     */
    const show = useCallback(
        async (match: RouteMatch, target: RouterLocation, sequence: number, commit: () => void): Promise<boolean> => {
            const pathChanged = target.pathname !== shownPathRef.current;
            let Page = currentRef.current.Page;
            if (pathChanged && match.route.path !== currentRef.current.routePath) {
                try {
                    Page = await pageFor(match.route);
                } catch {
                    return false;
                }
            }
            if (sequence !== navigationRef.current) {
                return true;
            }
            commit();
            shownPathRef.current = target.pathname;
            if (pathChanged) {
                setCurrent({ Page, routePath: match.route.path, active: match.route.active, params: match.params, key: target.pathname });
            }
            setLocation(target);
            return true;
        },
        [pageFor],
    );

    const navigate = useCallback<NavigateFn>(
        (href, options = {}) => {
            const url = new URL(href, window.location.href);
            const leave = () => (options.replace ? window.location.replace(url.href) : (window.location.href = url.href));
            const match = url.origin === window.location.origin ? matchRoute(routesRef.current, url.pathname) : undefined;
            if (!match) {
                leave();
                return;
            }
            const target: RouterLocation = { pathname: url.pathname, search: url.search, hash: url.hash };
            const now = readWindowLocation();
            if (target.pathname === now.pathname && target.search === now.search && target.hash === now.hash) {
                return;
            }
            const sequence = ++navigationRef.current;
            setPending(true);
            void show(match, target, sequence, () => {
                window.history[options.replace ? "replaceState" : "pushState"](null, "", target.pathname + target.search + target.hash);
            }).then((ok) => {
                if (!ok) {
                    leave();
                }
                if (sequence === navigationRef.current) {
                    setPending(false);
                }
            });
        },
        [show],
    );

    // The browser's own location is read after the first render, never during it: the server can't know the query string.
    useEffect(() => {
        const here = readWindowLocation();
        shownPathRef.current = here.pathname;
        setLocation(here);
    }, []);

    // Back and forward.
    useEffect(() => {
        function handlePopState() {
            const here = readWindowLocation();
            const match = matchRoute(routesRef.current, here.pathname);
            if (!match) {
                window.location.reload();
                return;
            }
            const sequence = ++navigationRef.current;
            setPending(true);
            void show(match, here, sequence, () => undefined).then((ok) => {
                if (!ok) {
                    window.location.reload();
                }
                if (sequence === navigationRef.current) {
                    setPending(false);
                }
            });
        }
        window.addEventListener("popstate", handlePopState);
        return () => window.removeEventListener("popstate", handlePopState);
    }, [show]);

    // Plain links, and fetching what they lead to before they are clicked.
    useEffect(() => {
        function handleClick(event: MouseEvent) {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                return;
            }
            const link = linkOf(event);
            const url = link && routerUrlOf(link);
            if (!url || !matchRoute(routesRef.current, url.pathname)) {
                return;
            }
            event.preventDefault();
            navigate(url.pathname + url.search + url.hash);
        }
        function handleIntent(event: Event) {
            const link = linkOf(event);
            const url = link && routerUrlOf(link);
            const match = url && matchRoute(routesRef.current, url.pathname);
            if (match) {
                pageFor(match.route).catch(() => undefined);
            }
        }
        document.addEventListener("click", handleClick);
        document.addEventListener("pointerover", handleIntent);
        document.addEventListener("pointerdown", handleIntent);
        document.addEventListener("focusin", handleIntent);
        return () => {
            document.removeEventListener("click", handleClick);
            document.removeEventListener("pointerover", handleIntent);
            document.removeEventListener("pointerdown", handleIntent);
            document.removeEventListener("focusin", handleIntent);
        };
    }, [navigate, pageFor]);

    // The app rail's other pages, once the browser has nothing else to do - so that the likeliest next click is instant.
    useEffect(() => {
        if (shouldSaveData()) {
            return;
        }
        const cancels = routesRef.current
            .filter((route) => route.idlePrefetch)
            .map((route) => whenIdle(() => void pageFor(route).catch(() => undefined)));
        return () => cancels.forEach((cancel) => cancel());
    }, [pageFor]);

    const enterTakeover = useCallback(() => {
        setTakeovers((n) => n + 1);
        return () => setTakeovers((n) => n - 1);
    }, []);
    const frame = useMemo<AppFrameContextValue>(() => ({ enterTakeover }), [enterTakeover]);
    const router = useMemo<RouterContextValue>(() => ({ location, navigate }), [location, navigate]);

    const Page = current.Page;
    return (
        <RouterContext.Provider value={router}>
            <AppFrameContext.Provider value={frame}>
                <AppChrome
                    active={current.active}
                    routeKey={current.key}
                    busy={pending}
                    hideChrome={takeovers > 0}
                    {...pickChromeProps(pageProps)}
                >
                    <Page key={current.key} {...pageProps} params={current.params} />
                </AppChrome>
            </AppFrameContext.Provider>
        </RouterContext.Provider>
    );
}
