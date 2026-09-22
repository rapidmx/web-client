// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
    BrandingFooter,
    BrandingHeader,
    FrameBrandingFooter,
    FrameBrandingHeader,
    parseBrandingHtml,
    sanitizeBrandingHtml,
    useBrandingHtml,
} from "../../../apps/shared/components/layout/BrandingChrome.js";

function Header({ html }: { html?: string }) {
    const parsed = useBrandingHtml(html);
    return <FrameBrandingHeader parsed={parsed} userMenu={<button type="button">Account menu</button>} appTitle="Mail" />;
}

function Footer({ html }: { html?: string }) {
    return <FrameBrandingFooter parsed={useBrandingHtml(html)} />;
}

describe("BrandingChrome without a DOM", () => {
    it("emits no branding HTML at all when there's nothing to sanitize with", () => {
        expect(typeof window).toBe("undefined");
        expect(sanitizeBrandingHtml("<b>Acme</b>")).toBe("");
        expect(parseBrandingHtml("<b>Acme</b>")).toBeNull();
    });

    it("reserves the header's place, empty and with no menu, when there is HTML that can't be parsed here - and nothing when there is none", () => {
        const html = renderToStaticMarkup(<Header html="<b>Acme</b> {USER_MENU}" />);
        expect(html).toBe(
            '<header class="sticky top-0 z-30 shrink-0 flex items-stretch bg-surface-alt" data-branding-header=""><div class="flex-1 min-w-0"></div></header>',
        );
        expect(renderToStaticMarkup(<Header />)).toBe("");
        expect(renderToStaticMarkup(<Footer html="<b>Acme</b>" />)).toBe("<div></div>");
        expect(renderToStaticMarkup(<Footer />)).toBe("");
        // The shell-less versions (public pages) do the same: an empty block for the client to fill, never unsanitized HTML.
        expect(renderToStaticMarkup(<BrandingHeader branding={{ companyName: "Acme", title: "", headerHtml: "<b>Acme</b>" }} />)).toBe("<div></div>");
        expect(renderToStaticMarkup(<BrandingFooter branding={{ companyName: "Acme", title: "", footerHtml: "<b>Acme</b>" }} />)).toBe("<div></div>");
        expect(renderToStaticMarkup(<BrandingHeader branding={null} />)).toBe("");
    });
});
