// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SettingsAppearancePageRouted from "../../../../apps/www/settings/appearance/index.js";
import AppearanceForm from "../../../../apps/shared/appearance/AppearanceForm.js";
import AppearanceProvider from "../../../../apps/shared/appearance/AppearanceProvider.js";

describe("Settings > Appearance on the server", () => {
    it("renders the page's shell, and the form itself renders with the defaults, without a document", () => {
        expect(typeof document).toBe("undefined");
        const Page = SettingsAppearancePageRouted.page;
        expect(renderToString(<Page userUid="u1" />)).toContain("Apps");
        const form = renderToString(
            <AppearanceProvider userUid="u1" initial={{ version: 1, mode: "dark", colors: { primary: "#1e3a8a" } }}>
                <AppearanceForm />
            </AppearanceProvider>,
        );
        expect(form).toContain("Appearance");
        expect(form).toContain("#1e3a8a");
        expect(form).toMatch(/<input(?=[^>]*value="dark")(?=[^>]*checked)[^>]*>/);
    });
});
