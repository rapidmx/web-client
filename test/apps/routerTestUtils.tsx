///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React, { ComponentType, ReactNode, useEffect, useMemo, useState } from "react";
import { RouterProvider, type RouterApi } from "@rapidrest/react/client";
import { vi } from "vitest";

/**
 * A stand-in for the client-side router (`@rapidrest/react`) for rendering one page or component the way the app renders it: inside a
 * `RouterProvider`, with an `api` that works like the real one closely enough for the page's own behaviour - not a copy of it (the library
 * tests its router; `test/apps/navigation/shell.navigation.test.tsx` here runs the real one against the real app shell).
 *
 * The location starts at the browser's (`window.history.pushState(null, "", "/?mailboxUid=a")` before rendering is how a test sets it), or
 * at `url`, and follows `navigate()`, which also records the entry in the browser's history. A navigation that isn't `shallow` remounts
 * what is rendered inside (the page is a new instance), a shallow one keeps it: the contract a page relies on. A click on a plain link, or a
 * `navigate()`, to an address `handles` accepts (default: every path of the app) is done in place; one it doesn't is left to the browser,
 * which here is `window.location.href = ...` (`mockLocation()` records it).
 */

export interface NavigateCall {
    to: string;
    replace?: boolean;
    shallow?: boolean;
    remount?: boolean;
}

export interface FakeRouter {
    /** The `RouterApi` given to the provider; every method is a spy. */
    api: RouterApi;
    /** `api.navigate`, for assertions: `expect(router.navigate).toHaveBeenCalledWith("/contacts/c1", expect.objectContaining({ shallow: false }))`. */
    navigate: ReturnType<typeof vi.fn>;
    /** Where the router is now, as `/path?query#hash`. */
    url(): string;
    /** Sets whether a navigation is pending, as the router does while a page loads. */
    setPending(pending: boolean): void;
    /** Calls `listener` whenever a navigation is done in place; returns the function that stops it. */
    subscribe(listener: (url: string, options: { shallow: boolean }) => void): () => void;
    /** What `useNavigationEffects()` registered. */
    readonly effects: Array<{ slot: number; get(): any }>;
    /** What `useBlocker()` registered. */
    readonly blockers: Set<any>;
}

export interface FakeRouterOptions {
    /** Where the router starts. Default: the browser's own address. */
    url?: string;
    /** Whether an address is one of the app's pages (done in place) - else the browser loads it. Default: every path. */
    handles?: (href: string) => boolean;
}

function browserAddress(): string {
    const { pathname = "/", search = "", hash = "" } = window.location;
    return pathname + search + hash;
}

export function createFakeRouter(options: FakeRouterOptions = {}): FakeRouter {
    let current = options.url ?? browserAddress();
    let pending = false;
    const pendingListeners = new Set<() => void>();
    const locationListeners = new Set<(url: string, options: { shallow: boolean }) => void>();
    const effects: FakeRouter["effects"] = [];
    const blockers = new Set<any>();
    const handles = options.handles ?? (() => true);
    const resolve = (href: string): URL => new URL(href, `http://localhost${current}`);

    const navigate = vi.fn(async (to: string, navigateOptions: Omit<NavigateCall, "to"> = {}) => {
        const target = resolve(to);
        if (target.origin !== "http://localhost" || !handles(to)) {
            window.location.href = to;
            return false;
        }
        current = target.pathname + target.search + target.hash;
        window.history[navigateOptions.replace ? "replaceState" : "pushState"](null, "", current);
        const shallow = navigateOptions.shallow === true || navigateOptions.remount === false;
        locationListeners.forEach((listener) => listener(current, { shallow }));
        return true;
    });
    const api: RouterApi = {
        navigate,
        prefetch: vi.fn(),
        canHandle: vi.fn((href: string) => resolve(href).origin === "http://localhost" && handles(href)),
        block: vi.fn((blocker: any) => {
            blockers.add(blocker);
            return () => void blockers.delete(blocker);
        }),
        addEffects: vi.fn((source: any) => {
            effects.push(source);
            return () => void effects.splice(effects.indexOf(source), 1);
        }),
        currentUrl: () => resolve(current),
        isPending: () => pending,
        subscribePending: (listener: () => void) => {
            pendingListeners.add(listener);
            return () => void pendingListeners.delete(listener);
        },
    };
    return {
        api,
        navigate,
        url: () => current,
        setPending(value: boolean) {
            pending = value;
            pendingListeners.forEach((listener) => listener());
        },
        subscribe(listener) {
            locationListeners.add(listener);
            return () => void locationListeners.delete(listener);
        },
        effects,
        blockers,
    };
}

let latest: FakeRouter | null = null;

/** The router of the `TestRouter` that rendered last - for a test whose page was rendered by `withTestRouter()` and made its own. */
export function latestRouter(): FakeRouter {
    if (!latest) {
        throw new Error("No TestRouter has rendered.");
    }
    return latest;
}

export interface TestRouterProps extends FakeRouterOptions {
    children?: ReactNode;
    /** The route template the page is (the page's own file: `/contacts/:uid`). Default `/`. */
    route?: string;
    params?: Record<string, string>;
    /** A router made by the test (`createFakeRouter()`), to assert on or to drive; else one is made. */
    router?: FakeRouter;
    /** Whether a navigation that isn't shallow makes the page a new instance, as it does (default). `false` keeps the page on screen, for a test
     * that goes on using it after it navigated - what is asserted is where it was sent. */
    remount?: boolean;
}

/** Renders `children` inside a router (see the file's comment). */
export function TestRouter({ children, route = "/", params, router: given, url, handles, remount = true }: TestRouterProps) {
    const [owned] = useState(() => (given ? null : createFakeRouter({ url, handles })));
    const router = given ?? owned!;
    latest = router;
    const [address, setAddress] = useState(() => router.url());
    // What a navigation that isn't shallow changes: the page is a new instance.
    const [instance, setInstance] = useState(0);
    useEffect(
        () =>
            router.subscribe((next, { shallow }) => {
                setAddress(next);
                if (!shallow && remount) {
                    setInstance((n) => n + 1);
                }
            }),
        [router, remount],
    );

    // The router's own click handling, for the plain links a page renders: a plain left click on an app page is taken over.
    useEffect(() => {
        function onClick(event: MouseEvent) {
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                return;
            }
            const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
            const target = anchor?.getAttribute("target");
            if (!anchor || (target && target !== "_self") || anchor.hasAttribute("download") || anchor.hasAttribute("data-router-ignore")) {
                return;
            }
            const href = anchor.getAttribute("href")!;
            if (!router.api.canHandle(href)) {
                return;
            }
            event.preventDefault();
            void router.api.navigate(href, {
                replace: anchor.hasAttribute("data-router-replace"),
                ...(anchor.hasAttribute("data-router-shallow") ? { shallow: true } : {}),
            });
        }
        document.addEventListener("click", onClick);
        return () => document.removeEventListener("click", onClick);
    }, [router]);

    const location = useMemo(() => {
        const hashAt = address.indexOf("#");
        const beforeHash = hashAt < 0 ? address : address.slice(0, hashAt);
        const queryAt = beforeHash.indexOf("?");
        return {
            pathname: queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt),
            search: queryAt < 0 ? "" : beforeHash.slice(queryAt),
            hash: hashAt < 0 ? "" : address.slice(hashAt),
            params: params ?? {},
            route,
        };
    }, [address, params, route]);

    return (
        <RouterProvider location={location} api={router.api}>
            <React.Fragment key={instance}>{children}</React.Fragment>
        </RouterProvider>
    );
}

/**
 * `Page` rendered inside a `TestRouter` - what a page test renders: `const InboxPage = withTestRouter(InboxPageBase)`. The options are
 * the `TestRouter`'s, for every render of it.
 */
export function withTestRouter<P extends object>(Page: ComponentType<P>, options: Omit<TestRouterProps, "children"> = {}): ComponentType<P> {
    function Routed(props: P) {
        return (
            <TestRouter {...options}>
                <Page {...props} />
            </TestRouter>
        );
    }
    Routed.displayName = `Routed(${Page.displayName ?? Page.name})`;
    return Routed;
}
