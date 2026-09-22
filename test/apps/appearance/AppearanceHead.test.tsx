// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppearanceHead, appearanceHtmlAttributes } from "../../../apps/shared/appearance/AppearanceHead.js";
import { APPEARANCE_BOOT_SCRIPT } from "../../../apps/shared/appearance/bootScript.js";

const image = { kind: "image", imageVersion: "v1", dim: 0.2, blur: 0, fit: "cover" };

describe("appearanceHtmlAttributes", () => {
    it("names an explicit scheme, but not System, and the user", () => {
        expect(appearanceHtmlAttributes({ version: 1, mode: "dark" }, "u1")).toEqual({ "data-theme": "dark", "data-uid": "u1" });
        expect(appearanceHtmlAttributes({ version: 1, mode: "light" })).toEqual({ "data-theme": "light" });
        expect(appearanceHtmlAttributes({ version: 1, mode: "system" })).toEqual({});
    });

    it("says nothing for a prop that isn't preferences", () => {
        expect(appearanceHtmlAttributes(undefined)).toEqual({});
        expect(appearanceHtmlAttributes({ mode: "dark" }, "u1")).toEqual({ "data-uid": "u1" });
    });
});

describe("AppearanceHead", () => {
    it("renders the stylesheet made from the preferences, keyed, and the boot script after it", () => {
        const html = renderToStaticMarkup(<AppearanceHead appearance={{ version: 1, mode: "dark", colors: { primary: "#1e3a8a" }, background: image }} />);
        expect(html).toMatch(/^<style id="rr-appearance" data-key="[^"]+" data-t="0">/);
        expect(html).toContain("--rr-color-primary:#1e3a8a !important");
        expect(html).toContain('url("/api/mail/preferences/appearance/background/v1")');
        expect(html.indexOf("<style")).toBeLessThan(html.indexOf("<script"));
        expect(html).toContain(APPEARANCE_BOOT_SCRIPT);
    });

    it("carries the server's time, in milliseconds, for the boot script to compare with the browser's copy", () => {
        const html = renderToStaticMarkup(<AppearanceHead appearance={{ version: 1, mode: "dark", updatedAt: "2026-09-21T10:00:00.000Z" }} />);
        expect(html).toContain(`data-t="${Date.parse("2026-09-21T10:00:00.000Z")}"`);
    });

    it("renders an empty stylesheet, for its time, for a user with nothing chosen, and only the boot script for a prop that isn't preferences", () => {
        const empty = renderToStaticMarkup(<AppearanceHead appearance={{ version: 1, mode: "system", updatedAt: 5 }} />);
        expect(empty).toMatch(/^<style id="rr-appearance" data-key="[^"]+" data-t="5"><\/style><script>/);
        for (const appearance of [undefined, { nonsense: 1 }]) {
            const html = renderToStaticMarkup(<AppearanceHead appearance={appearance} />);
            expect(html).not.toContain("<style");
            expect(html).toContain("<script>");
        }
    });

    it("refuses an image version that is not plain characters, so nothing can close the <style> and run script", () => {
        const html = renderToStaticMarkup(
            <AppearanceHead appearance={{ version: 1, mode: "system", background: { ...image, imageVersion: "v1</style><script>alert(1)</script>" } }} />,
        );
        // Only the element's own closing tag: the version was refused, so nothing of it is in the CSS.
        expect(html.match(/<\/style>/g)).toHaveLength(1);
        expect(html).not.toContain("alert(1)");
    });
});
