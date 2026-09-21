///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ComponentType } from "react";

/**
 * One page the client-side router (`AppRouter`) can show without a page load. The table of them (`apps/www/_routes.ts`)
 * mirrors the files under `apps/www`: what isn't in it (the admin and escrow consoles, plugin pages, anything else) is
 * reached by a normal navigation.
 */
export interface RouteDefinition {
    /** The route template: literal segments and `:name` parameters, the same shape as the file path (`/messages/:uid`
     * for `messages/[uid].tsx`). The first entry that matches a URL wins, so list literal routes before parameterized
     * ones (`/settings/filters/new` before `/settings/filters/:uid`). */
    path: string;
    /** The app-rail entry (or `"settings"`) highlighted while this page shows - what the page's shell passes as `active`. */
    active: string;
    /**
     * Loads the page's module, which must have a `routedPage()` component as its default export. Written as
     * `() => import("./calendar/index.js")` so the bundler makes the page its own chunk; it is called the first time the
     * page is shown or prefetched (pointer over or focus on a link to it, or when the browser is idle).
     */
    load: () => Promise<{ default: ComponentType<any> }>;
    /** Downloaded when the browser is idle after the first page has loaded - the app rail's own pages, which are the
     * likeliest next click. */
    idlePrefetch?: boolean;
}

export interface RouteMatch {
    route: RouteDefinition;
    /** The values of the template's `:name` segments, decoded. */
    params: Record<string, string>;
}

/** Splits a path into segments, ignoring a trailing slash: `/` and `""` have none. */
function segmentsOf(path: string): string[] {
    return path.split("/").filter((segment) => segment !== "");
}

/** Matches `pathname` against one route template - `undefined` when it doesn't, or a parameter isn't valid percent-encoding. */
function matchTemplate(template: string, pathname: string): Record<string, string> | undefined {
    const expected = segmentsOf(template);
    const actual = segmentsOf(pathname);
    if (expected.length !== actual.length) {
        return undefined;
    }
    const params: Record<string, string> = {};
    for (let i = 0; i < expected.length; i++) {
        if (expected[i].startsWith(":")) {
            try {
                params[expected[i].slice(1)] = decodeURIComponent(actual[i]);
            } catch {
                return undefined;
            }
        } else if (expected[i] !== actual[i]) {
            return undefined;
        }
    }
    return params;
}

/** The first route in `routes` whose template matches `pathname`, with its parameters. */
export function matchRoute(routes: readonly RouteDefinition[], pathname: string): RouteMatch | undefined {
    for (const route of routes) {
        const params = matchTemplate(route.path, pathname);
        if (params) {
            return { route, params };
        }
    }
    return undefined;
}
