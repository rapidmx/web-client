///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { PropsWithChildren } from "react";
import { Branding } from "@rapidmx/react-shared/branding/brandingApi.js";
import { AppearanceHead, appearanceHtmlAttributes } from "../shared/appearance/AppearanceHead.js";
import { CUSTOM_STYLESHEET_LINK_ID } from "@rapidmx/react-shared/branding/useBranding.js";

export interface LayoutProps {
    /**
     * Supplied by `WwwRoute`'s `fetchProps()` override (`src/mongo/routes/wwwRoute.ts`/
     * `src/sql/routes/wwwRoute.ts`) - `@rapidrest/react` spreads the same merged page props onto this
     * layout as onto the page it wraps, so it renders correctly server-side on the very first byte of the
     * response: no client-side flash from the stock defaults below, and a crawler reading the raw HTML
     * sees the real branding too. `undefined` only on the framework's unwrapped `_500` fallback path,
     * which doesn't receive props at all - falling back to the stock defaults there is acceptable.
     */
    branding?: Branding;
    /** The signed-in user's stored appearance preferences (a page prop from the same `fetchProps()`, present only on the www pages and only when the user has any): rendered as a stylesheet in the `<head>` so the very first paint is themed - see `AppearanceHead`. */
    appearance?: unknown;
    /** The signed-in user (supplied by the framework), so a cached appearance from another account on this browser is never applied. */
    userUid?: string;
}

export default function Layout({ children, branding, appearance, userUid }: PropsWithChildren<LayoutProps>) {
    const title = branding?.title || branding?.companyName ? `${branding?.title || branding?.companyName}: Mail` : "RapidMX: Mail";
    const iconHref = branding?.iconUrl || branding?.logoUrl || "/images/logo.svg";
    const stylesheetHref = branding?.stylesheetUrl;

    return (
        <html lang="en" {...appearanceHtmlAttributes(appearance, userUid)}>
            <head>
                <meta charSet="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>{title}</title>
                <link rel="icon" type="image/svg+xml" href={iconHref} />
                <link rel="alternate icon" href="/favicon.ico" />
                <link rel="preconnect" href="https://fonts.googleapis.com" />
                <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
                <link
                    rel="stylesheet"
                    href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
                />
                {stylesheetHref && <link rel="stylesheet" href={stylesheetHref} id={CUSTOM_STYLESHEET_LINK_ID} />}
                <AppearanceHead appearance={appearance} />
            </head>
            <body>{children}</body>
        </html>
    );
}
