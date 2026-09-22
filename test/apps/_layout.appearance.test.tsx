// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import WwwLayout from "../../apps/www/_layout.js";
import AdminLayout from "../../apps/admin/_layout.js";
import EscrowLayout from "../../apps/escrow/_layout.js";
import { APPEARANCE_BOOT_SCRIPT } from "../../apps/shared/appearance/bootScript.js";

const prefs = { version: 1, mode: "dark", colors: { primary: "#1e3a8a" }, updatedAt: "2026-09-21T10:00:00.000Z" };
const branding = { companyName: "Acme", title: "Acme Mail", stylesheetUrl: "https://cdn.example.com/theme.css" };

describe.each([
    ["www", WwwLayout],
    ["admin", AdminLayout],
    ["escrow", EscrowLayout],
])("the %s layout and the user's appearance", (_name, Layout) => {
    it("renders the stylesheet made from the server's preferences, the explicit scheme and the user on <html>, and the boot script last in <head>", () => {
        const html = renderToStaticMarkup(
            <Layout appearance={prefs} userUid="u1">
                <p>page</p>
            </Layout>,
        );
        expect(html).toMatch(/^<html lang="en" data-theme="dark" data-uid="u1">/);
        expect(html).toContain('<style id="rr-appearance"');
        expect(html).toContain("--rr-color-primary:#1e3a8a !important");
        expect(html).toContain(`<script>${APPEARANCE_BOOT_SCRIPT}</script></head>`);
    });

    it("has only the boot script for a page given nothing, and no data attributes", () => {
        const html = renderToStaticMarkup(
            <Layout>
                <p>page</p>
            </Layout>,
        );
        expect(html).toMatch(/^<html lang="en">/);
        expect(html).not.toContain('<style id="rr-appearance"');
        expect(html).toContain(`<script>${APPEARANCE_BOOT_SCRIPT}</script></head>`);
    });

    it("leaves the scheme to the operating system for System", () => {
        const html = renderToStaticMarkup(
            <Layout appearance={{ version: 1, mode: "system", colors: { accent: "#ffd60a" }, updatedAt: 5 }} userUid="u1">
                <p>page</p>
            </Layout>,
        );
        expect(html).toMatch(/^<html lang="en" data-uid="u1">/);
        expect(html).toContain('data-t="5"');
    });
});

describe("the boot script's place next to the branding stylesheet", () => {
    it("comes after the custom stylesheet link, so the user's stylesheet and the branding's are both in place before the body", () => {
        for (const Layout of [WwwLayout, AdminLayout]) {
            const html = renderToStaticMarkup(
                <Layout branding={branding} appearance={prefs} userUid="u1">
                    <p>page</p>
                </Layout>,
            );
            expect(html.indexOf('id="branding-stylesheet"')).toBeLessThan(html.indexOf('id="rr-appearance"'));
            expect(html.indexOf('id="rr-appearance"')).toBeLessThan(html.indexOf("<script>"));
        }
    });

    it("never links the branding stylesheet on the escrow console, which still gets the user's own", () => {
        const html = renderToStaticMarkup(
            <EscrowLayout branding={branding} appearance={prefs}>
                <p>page</p>
            </EscrowLayout>,
        );
        expect(html).not.toContain("theme.css");
        expect(html).toContain('id="rr-appearance"');
    });
});
