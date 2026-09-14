// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
    BrandingFooter,
    BrandingHeader,
    sanitizeBrandingHtml,
} from "../../../apps/shared/components/layout/BrandingChrome.js";

const BASE = { companyName: "Acme", title: "Acme Mail" };

describe("BrandingChrome", () => {
    it("renders nothing without branding or without configured HTML", () => {
        expect(render(<BrandingHeader branding={null} />).container.innerHTML).toBe("");
        expect(render(<BrandingFooter branding={BASE} />).container.innerHTML).toBe("");
    });

    it("renders nothing when the HTML sanitizes down to empty", () => {
        const { container } = render(<BrandingHeader branding={{ ...BASE, headerHtml: "<script>alert(1)</script>" }} />);
        expect(container.innerHTML).toBe("");
    });

    it("strips scripts, event handlers, javascript: URLs, forms, and iframes but keeps ordinary markup", () => {
        const { container } = render(
            <BrandingHeader
                branding={{
                    ...BASE,
                    headerHtml:
                        '<p data-testid="ok" class="banner"><b>Acme</b> <a href="https://acme.example">home</a></p>' +
                        '<img src="x.png" onerror="alert(1)">' +
                        '<a href="javascript:alert(1)">bad</a>' +
                        '<form action="https://evil.example"><input name="password"><button>Go</button></form>' +
                        '<iframe src="https://evil.example"></iframe>' +
                        "<style>body{display:none}</style>" +
                        "<script>alert(1)</script>",
                }}
            />,
        );
        const html = container.innerHTML;
        expect(html).toContain('<b>Acme</b>');
        expect(html).toContain('href="https://acme.example"');
        expect(html).not.toContain("onerror");
        expect(html).not.toContain("javascript:");
        expect(html).not.toContain("<form");
        expect(html).not.toContain("<input");
        expect(html).not.toContain("<button");
        expect(html).not.toContain("<iframe");
        expect(html).not.toContain("<style");
        expect(html).not.toContain("<script");
    });

    it("sanitizes the footer too", () => {
        const { container } = render(
            <BrandingFooter branding={{ ...BASE, footerHtml: '<span onclick="alert(1)">Acme footer</span>' }} />,
        );
        expect(container.innerHTML).toBe("<div><span>Acme footer</span></div>");
        expect(sanitizeBrandingHtml('<a href="https://x.example" formaction="https://evil.example">x</a>')).toBe(
            '<a href="https://x.example">x</a>',
        );
    });
});
