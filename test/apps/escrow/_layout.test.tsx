// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Layout from "../../../apps/escrow/_layout.js";

describe("Layout", () => {
    it("renders the document shell with the given children inside the body", () => {
        const html = renderToStaticMarkup(
            <Layout>
                <p>page content</p>
            </Layout>,
        );

        expect(html).toContain("<title>RapidMX: Escrow Console</title>");
        expect(html).toContain('charSet="utf-8"');
        expect(html).toContain('href="/favicon.ico"');
        expect(html).toContain("<body><p>page content</p></body>");
    });

    it("renders the configured title, icon, and custom stylesheet when branding is supplied", () => {
        const html = renderToStaticMarkup(
            <Layout
                branding={{
                    companyName: "Acme",
                    title: "Acme Mail",
                    iconUrl: "https://cdn.example.com/icon.png",
                    logoUrl: "https://cdn.example.com/logo.png",
                    stylesheetUrl: "https://cdn.example.com/theme.css",
                }}
            >
                <p>page content</p>
            </Layout>,
        );

        expect(html).toContain("<title>Acme Mail: Escrow Console</title>");
        expect(html).toContain('href="https://cdn.example.com/icon.png"');
        expect(html).toContain('id="branding-stylesheet"');
        expect(html).toContain('href="https://cdn.example.com/theme.css"');
    });

    it("falls back to the logo for the favicon and to companyName for the title when no icon/title is configured", () => {
        const html = renderToStaticMarkup(
            <Layout branding={{ companyName: "Acme", title: "", logoUrl: "https://cdn.example.com/logo.png" }}>
                <p>page content</p>
            </Layout>,
        );

        expect(html).toContain("<title>Acme: Escrow Console</title>");
        expect(html).toContain('href="https://cdn.example.com/logo.png"');
    });
});
