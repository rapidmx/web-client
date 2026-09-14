///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { PropsWithChildren } from "react";
import { Branding } from "@rapidmx/react-shared/branding/brandingApi.js";

export interface LayoutProps {
    /** See `apps/www/_layout.tsx`'s `LayoutProps` doc comment — identical mechanism, supplied by
     * `EscrowConsoleRoute`'s `fetchProps()`. */
    branding?: Branding;
}

/** Unlike the other apps, never links the admin-configured custom stylesheet: the escrow console handles escrow
 * key material, so no admin-supplied CSS is loaded on it. */
export default function Layout({ children, branding }: PropsWithChildren<LayoutProps>) {
    const title = branding?.title || branding?.companyName
        ? `${branding?.title || branding?.companyName}: Escrow Console`
        : "RapidMX: Escrow Console";
    const iconHref = branding?.iconUrl || branding?.logoUrl || "/images/logo.svg";

    return (
        <html lang="en">
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
            </head>
            <body>{children}</body>
        </html>
    );
}
