// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandingHeader, sanitizeBrandingHtml } from "../../../apps/shared/components/layout/BrandingChrome.js";

describe("BrandingChrome without a DOM", () => {
    it("emits no branding HTML at all when there's nothing to sanitize with", () => {
        expect(typeof window).toBe("undefined");
        expect(sanitizeBrandingHtml("<b>Acme</b>")).toBe("");
        expect(
            renderToStaticMarkup(<BrandingHeader branding={{ companyName: "Acme", title: "", headerHtml: "<b>Acme</b>" }} />),
        ).toBe("");
    });
});
