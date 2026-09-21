///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ComponentType } from "react";
import AppRouter, { RoutedPageComponent } from "../shared/navigation/AppRouter.js";
import { wwwRoutes } from "./_routes.js";

/**
 * Makes a `www` page the entry of the client-side router: the page's default export is `routedPage("/its/route", Page)`.
 * `@rapidrest/react` server-renders and hydrates exactly that component, so what it renders - the router, with the persistent
 * app frame (`AppChrome`) and `Page` inside it - is the whole client tree, and later pages replace `Page` without a page load.
 * `path` is the page's route template, the same as its entry in `_routes.ts`.
 *
 * The result carries the plain `Page` as `.page`, which is what the router shows when it loads this module for a navigation
 * (rendering the wrapped default export there would nest a second router).
 */
export function routedPage<P extends object>(path: string, Page: ComponentType<P>): RoutedPageComponent<P> {
    function RoutedPage(props: P) {
        return <AppRouter routes={wwwRoutes} initialPath={path} initialPage={Page} pageProps={props} />;
    }
    RoutedPage.page = Page;
    return RoutedPage;
}
