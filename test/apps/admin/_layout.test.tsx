// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Layout from "../../../apps/admin/_layout.js";

describe("Layout", () => {
    it("renders the document shell with the given children inside the body", () => {
        const html = renderToStaticMarkup(
            <Layout>
                <p>page content</p>
            </Layout>,
        );

        expect(html).toContain("<title>RapidMX: Mail Admin Console</title>");
        expect(html).toContain('charSet="utf-8"');
        expect(html).toContain('href="/favicon.ico"');
        expect(html).toContain("<body><p>page content</p></body>");
    });

    it("renders the configured title and icon when branding is supplied", () => {
        const html = renderToStaticMarkup(
            <Layout
                branding={{
                    companyName: "Acme",
                    title: "Acme Mail",
                    iconUrl: "https://cdn.example.com/icon.png",
                }}
            >
                <p>page content</p>
            </Layout>,
        );

        expect(html).toContain("<title>Acme Mail: Mail Admin Console</title>");
        expect(html).toContain('href="https://cdn.example.com/icon.png"');
    });
});
