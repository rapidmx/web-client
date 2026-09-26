///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { Branding } from "@rapidmx/react-shared/branding/brandingApi.js";

/** The name the deployment goes by in the browser tab: its branding title, else its company name, else RapidMX. */
export function brandName(branding?: Pick<Branding, "title" | "companyName"> | null): string {
    return branding?.title || branding?.companyName || "RapidMX";
}

/**
 * The `title` export of a webmail page: `export const title = pageTitle("Calendar")`. `@rapidrest/react` renders it into the
 * document's `<title>` on the server - so the tab is right from the first byte, and a crawler sees it - and sends it with every
 * client navigation, so the tab follows the page. `label` is the app's name (`Acme: Calendar`), the same for all of an app's pages.
 */
export function pageTitle(label: string): (props: { branding?: Pick<Branding, "title" | "companyName"> | null }) => string {
    return ({ branding }) => `${brandName(branding)}: ${label}`;
}
