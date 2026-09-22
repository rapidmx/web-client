// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import type { AppearancePreferences } from "@rapidmx/react-shared/appearance/preferencesApi.js";
import { BLACK, WHITE, contrastRatio, parseHex } from "../../../apps/shared/appearance/color.js";
import {
    DEFAULT_PALETTE,
    PANEL_ALPHA_MAX,
    PANEL_ALPHA_MIN,
    WORST_CASE_PHOTO,
    appearanceCss,
    backgroundCss,
    backgroundPhoto,
    colorVariables,
    contrastWarnings,
    cssUrl,
    effectiveDim,
    effectivePalette,
    panelAlpha,
    themeVariables,
} from "../../../apps/shared/appearance/theme.js";

const prefs = (extra: Partial<AppearancePreferences> = {}): AppearancePreferences => ({ version: 1, mode: "system", ...extra });
const rgb = (hex: string) => parseHex(hex)!;

describe("effectivePalette", () => {
    it("is the app's own palette when nothing is chosen", () => {
        const palette = effectivePalette(undefined, "dark");
        expect(palette).toMatchObject({ surfaceChosen: false, textAdjusted: false });
        expect(palette.surface).toEqual(rgb(DEFAULT_PALETTE.dark.surface));
        expect(palette.muted).toEqual(rgb(DEFAULT_PALETTE.dark.muted));
    });

    it("takes the chosen surface and keeps the default text while that can be read on it", () => {
        const palette = effectivePalette({ surface: "#f0f0f0" }, "light");
        expect(palette.surfaceChosen).toBe(true);
        expect(palette.textAdjusted).toBe(false);
        expect(palette.text).toEqual(rgb(DEFAULT_PALETTE.light.text));
    });

    it("moves the text when the chosen surface can't be read with the default", () => {
        // The dark scheme's near-white text on a pale surface.
        const palette = effectivePalette({ surface: "#fdf6e3" }, "dark");
        expect(palette.textAdjusted).toBe(true);
        expect(contrastRatio(palette.text, palette.surface)).toBeGreaterThanOrEqual(4.5);
    });

    it("uses a chosen text colour as it is, and a muted colour that reads on the surface", () => {
        const palette = effectivePalette({ text: "#222222", surface: "#ffffff" }, "light");
        expect(palette.text).toEqual(rgb("#222222"));
        expect(contrastRatio(palette.muted, palette.surface)).toBeGreaterThanOrEqual(4.5);
    });
});

describe("colorVariables", () => {
    it("is empty when no colours were chosen", () => {
        expect(colorVariables(undefined, "light")).toEqual({});
        expect(colorVariables({}, "dark")).toEqual({});
    });

    it("derives the primary scale and the text on it", () => {
        const vars = colorVariables({ primary: "#1e3a8a" }, "light");
        expect(vars["--rr-color-primary"]).toBe("#1e3a8a");
        expect(Object.keys(vars).filter((name) => name.startsWith("--rr-color-primary"))).toHaveLength(7);
        expect(vars["--rr-color-text-on-primary"]).toBe("#ffffff");
        // Nothing else is touched.
        expect(Object.keys(vars).every((name) => name.includes("primary"))).toBe(true);
    });

    it("derives the accent, its shades and readable text", () => {
        const vars = colorVariables({ accent: "#ffd60a" }, "dark");
        expect(vars["--rr-color-accent"]).toBe("#ffd60a");
        expect(vars["--rr-color-accent-dark"]).toBeDefined();
        expect(vars["--rr-color-accent-soft"]).toBeDefined();
        expect(vars["--rr-color-accent-pale"]).toBeDefined();
        expect(vars["--rr-color-text-on-accent"]).toBe("#1c2526");
    });

    it("derives the surface family from a surface: alt, page, border and muted text", () => {
        const vars = colorVariables({ surface: "#fff8e1" }, "light");
        expect(vars["--rr-color-surface"]).toBe("#fff8e1");
        expect(vars["--rr-color-surface-alt"]).toBeDefined();
        expect(vars["--rr-color-bg"]).toBe("#fff8e1");
        expect(vars["--rr-color-border"]).toBeDefined();
        expect(vars["--rr-color-text-muted"]).toBeDefined();
        expect(vars["--rr-color-text"]).toBeUndefined();
    });

    it("puts a dark surface's page a little deeper than the surface, as the defaults do", () => {
        const vars = colorVariables({ surface: "#202830" }, "dark");
        expect(vars["--rr-color-surface"]).toBe("#202830");
        expect(relativeChannel(vars["--rr-color-bg"])).toBeLessThan(relativeChannel("#202830"));
    });

    it("sets the text colour and what derives from it (muted, border) without touching the surface", () => {
        const vars = colorVariables({ text: "#101820" }, "light");
        expect(vars["--rr-color-text"]).toBe("#101820");
        expect(vars["--rr-color-text-muted"]).toBeDefined();
        expect(vars["--rr-color-border"]).toBeDefined();
        expect(vars["--rr-color-surface"]).toBeUndefined();
    });

    it("also sets the text when the surface made the default unreadable", () => {
        const vars = colorVariables({ surface: "#fdf6e3" }, "dark");
        expect(vars["--rr-color-text"]).toBeDefined();
    });

    it("ignores a value that isn't a colour", () => {
        expect(colorVariables({ primary: "red", accent: "blue" }, "light")).toEqual({});
    });
});

function relativeChannel(hex: string): number {
    return rgb(hex).r;
}

describe("panelAlpha", () => {
    const light = effectivePalette(undefined, "light");
    const dark = effectivePalette(undefined, "dark");

    it("is only as opaque as the worst case demands, never outside its bounds", () => {
        for (const palette of [light, dark]) {
            for (const dim of [0, 0.2, 0.5, 0.8]) {
                const alpha = panelAlpha(palette, dim, WORST_CASE_PHOTO);
                expect(alpha).toBeGreaterThanOrEqual(PANEL_ALPHA_MIN);
                expect(alpha).toBeLessThanOrEqual(PANEL_ALPHA_MAX);
            }
        }
    });

    it("keeps text and muted text at 4.5:1 or better against the worst place the photo can be", () => {
        for (const [palette, dim] of [
            [light, 0],
            [light, 0.3],
            [dark, 0],
            [dark, 0.3],
        ] as const) {
            const alpha = panelAlpha(palette, dim, WORST_CASE_PHOTO);
            const share = (1 - alpha) * (1 - dim);
            for (const behind of [BLACK, WHITE]) {
                const under = {
                    r: palette.surface.r + (behind.r - palette.surface.r) * share,
                    g: palette.surface.g + (behind.g - palette.surface.g) * share,
                    b: palette.surface.b + (behind.b - palette.surface.b) * share,
                };
                expect(contrastRatio(palette.text, under)).toBeGreaterThanOrEqual(4.5);
                expect(contrastRatio(palette.muted, under)).toBeGreaterThanOrEqual(4.5);
            }
        }
    });

    it("lets more dim make the panels more see-through", () => {
        expect(panelAlpha(light, 0.6, WORST_CASE_PHOTO)).toBeLessThanOrEqual(panelAlpha(light, 0, WORST_CASE_PHOTO));
    });

    it("lets a photo that stays clear of the text's colour use the most see-through panels", () => {
        // A pale photo behind light-scheme panels is no threat to dark text on a white surface.
        expect(panelAlpha(light, 0.2, { lo: rgb("#f0f0f0"), hi: rgb("#ffffff") })).toBe(PANEL_ALPHA_MIN);
        expect(panelAlpha(dark, 0.2, { lo: rgb("#000000"), hi: rgb("#202020") })).toBe(PANEL_ALPHA_MIN);
    });

    it("falls back to the most opaque panel when nothing reaches AA (text as dark as the surface)", () => {
        const flat = { surface: rgb("#808080"), text: rgb("#808080"), muted: rgb("#808080") };
        expect(panelAlpha(flat, 0, WORST_CASE_PHOTO)).toBe(PANEL_ALPHA_MAX);
    });
});

describe("backgroundPhoto / effectiveDim", () => {
    it("is undefined without a background", () => {
        expect(backgroundPhoto(undefined)).toBeUndefined();
        expect(backgroundPhoto({ kind: "none", dim: 0.2, blur: 0, fit: "cover" })).toBeUndefined();
    });

    it("is the colour itself for a colour, and the measured (else worst-case) range for an image", () => {
        expect(backgroundPhoto({ kind: "color", color: "#336699", dim: 0, blur: 0, fit: "cover" })).toEqual({ lo: rgb("#336699"), hi: rgb("#336699") });
        const measured = { lo: rgb("#101010"), hi: rgb("#909090") };
        const image = { kind: "image", imageVersion: "1", dim: 0.2, blur: 0, fit: "cover" } as const;
        expect(backgroundPhoto(image, measured)).toBe(measured);
        expect(backgroundPhoto(image)).toBe(WORST_CASE_PHOTO);
    });

    it("dims only a picture", () => {
        expect(effectiveDim({ kind: "image", imageVersion: "1", dim: 0.4, blur: 0, fit: "cover" })).toBe(0.4);
        expect(effectiveDim({ kind: "color", color: "#000000", dim: 0.4, blur: 0, fit: "cover" })).toBe(0);
    });
});

describe("themeVariables", () => {
    it("is only the user's colours when there is no background", () => {
        expect(themeVariables(prefs({ colors: { primary: "#1e3a8a" } }), "light")["--rr-panel"]).toBeUndefined();
        expect(themeVariables(prefs(), "light")).toEqual({});
    });

    it("makes the panels translucent, the frame transparent and the muted text stronger when a background is set", () => {
        const vars = themeVariables(
            prefs({ background: { kind: "image", imageVersion: "1", dim: 0.2, blur: 0, fit: "cover" } }),
            "dark",
        );
        expect(vars["--rr-panel"]).toMatch(/^color-mix\(in srgb, var\(--rr-color-surface\) \d+%, transparent\)$/);
        expect(vars["--color-surface"]).toBe("var(--rr-panel)");
        expect(vars["--color-surface-alt"]).toMatch(/^color-mix\(in srgb, var\(--rr-color-surface-alt\) \d+%, transparent\)$/);
        expect(vars["--rr-frame-bg"]).toBe("transparent");
        expect(Number(vars["--rr-panel-alpha"])).toBeGreaterThanOrEqual(PANEL_ALPHA_MIN);
        expect(vars["--rr-color-text-muted"]).toMatch(/^#[0-9a-f]{6}$/);
    });

    it("uses the measured photo when given: a plainer photo gives more see-through panels", () => {
        const background = { kind: "image", imageVersion: "1", dim: 0.2, blur: 0, fit: "cover" } as const;
        const worst = Number(themeVariables(prefs({ background }), "light")["--rr-panel-alpha"]);
        const plain = Number(themeVariables(prefs({ background }), "light", { lo: rgb("#e0e0e0"), hi: rgb("#ffffff") })["--rr-panel-alpha"]);
        expect(plain).toBeLessThan(worst);
    });

    it("keeps the user's colours next to the background's", () => {
        const vars = themeVariables(
            prefs({ colors: { surface: "#101418" }, background: { kind: "color", color: "#203040", dim: 0, blur: 0, fit: "cover" } }),
            "dark",
        );
        expect(vars["--rr-color-surface"]).toBe("#101418");
        expect(vars["--rr-panel"]).toBeDefined();
    });
});

describe("cssUrl", () => {
    it("quotes the URL and escapes what could end the string", () => {
        expect(cssUrl("/api/x/v1")).toBe('url("/api/x/v1")');
        expect(cssUrl('/a"b')).toBe('url("/a\\22 b")');
        expect(cssUrl("/a\\b")).toBe('url("/a\\5c b")');
        expect(cssUrl("/a\nb")).toBe('url("/a\\a b")');
        expect(cssUrl("/a);}body{x:y")).toBe('url("/a);}body{x:y")');
    });
});

describe("backgroundCss", () => {
    it("is nothing for no background", () => {
        expect(backgroundCss(undefined)).toBe("");
        expect(backgroundCss({ kind: "none", dim: 0, blur: 0, fit: "cover" })).toBe("");
    });

    it("is one fixed layer of the colour for a colour", () => {
        const css = backgroundCss({ kind: "color", color: "#336699", dim: 0.5, blur: 9, fit: "tile" });
        expect(css).toContain("html::before{content:\"\";position:fixed;z-index:-1;pointer-events:none;inset:0;background-color:#336699;}");
        expect(css).not.toContain("html::after");
        expect(css).toContain("@media print");
    });

    it("is a picture layer and a dim layer for an image: behind everything, no clicks, and grown by twice the blur", () => {
        const css = backgroundCss({ kind: "image", imageVersion: "v1", dim: 0.3, blur: 8, fit: "cover" }, "/api/x/v1");
        expect(css).toContain("html::before{content:\"\";position:fixed;z-index:-1;pointer-events:none;inset:-16px;");
        expect(css).toContain('background-image:url("/api/x/v1");');
        expect(css).toContain("background-size:cover;background-repeat:no-repeat;background-position:center;");
        expect(css).toContain("filter:blur(8px);");
        expect(css).toContain("html::after{content:\"\";position:fixed;z-index:-1;pointer-events:none;inset:0;background-color:var(--rr-color-surface);opacity:0.3;}");
    });

    it("maps each fit, omits the blur at 0, the image before it is known, and uses the colour behind the image", () => {
        const image = { kind: "image", imageVersion: "1", dim: 0, blur: 0, fit: "contain", color: "#112233" } as const;
        const contain = backgroundCss(image);
        expect(contain).toContain("background-size:contain;background-repeat:no-repeat;");
        expect(contain).not.toContain("filter:");
        expect(contain).not.toContain("background-image");
        expect(contain).toContain("background-color:#112233;");
        const tile = backgroundCss({ ...image, fit: "tile", color: undefined }, "/x");
        expect(tile).toContain("background-size:auto;background-repeat:repeat;");
        expect(tile).toContain("background-color:var(--rr-color-surface-alt);");
    });
});

describe("appearanceCss", () => {
    it("is empty for nothing, for defaults and for a background of none", () => {
        expect(appearanceCss(undefined)).toBe("");
        expect(appearanceCss(prefs())).toBe("");
        expect(appearanceCss(prefs({ background: { kind: "none", dim: 0.2, blur: 0, fit: "cover" } }))).toBe("");
    });

    it("writes the light set for everything but an explicit dark, and the dark set for a dark system or an explicit dark", () => {
        const css = appearanceCss(prefs({ colors: { primary: "#1e3a8a" } }));
        const lines = css.split("\n");
        expect(lines[0]).toMatch(/^html:root:not\(\[data-theme="dark"\]\)\{--rr-color-primary:#1e3a8a !important;/);
        expect(lines[1]).toMatch(/^@media \(prefers-color-scheme:dark\)\{html:root:not\(\[data-theme\]\)\{--rr-color-primary:#1e3a8a !important;/);
        expect(lines[2]).toMatch(/^html:root\[data-theme="dark"\]\{--rr-color-primary:#1e3a8a !important;/);
        // The light-on-primary text rule for the components that hard-code `text-white`.
        expect(css).toContain(".bg-primary.text-white{color:var(--rr-color-text-on-primary)}");
    });

    it("declares every custom property !important, so a branding stylesheet's own selectors can't beat it", () => {
        const css = appearanceCss(prefs({ colors: { surface: "#101418", accent: "#ffd60a" } }));
        const declarations = css.match(/--[a-z-]+:[^;]+;/g)!;
        expect(declarations.length).toBeGreaterThan(6);
        expect(declarations.every((declaration) => declaration.endsWith(" !important;"))).toBe(true);
    });

    it("adds the background layer and the content panel with an image, and the two schemes differ in their panel alpha", () => {
        const css = appearanceCss(prefs({ background: { kind: "image", imageVersion: "v1", dim: 0.2, blur: 0, fit: "cover" } }), {
            imageUrl: "/api/x/v1",
        });
        expect(css).toContain("#app-content{background-color:var(--rr-panel);--color-surface:transparent;}");
        expect(css).toContain("#app-content :is(input,select,textarea){--color-surface:var(--rr-color-surface);}");
        // Solid panels for someone who asked their system for less transparency, after the scheme blocks that would otherwise win the tie.
        expect(css).toContain("@media (prefers-reduced-transparency:reduce){html:root{--rr-panel:var(--rr-color-surface) !important;--color-surface-alt:var(--rr-color-surface-alt) !important;}}");
        expect(css.indexOf("prefers-reduced-transparency")).toBeGreaterThan(css.indexOf('html:root[data-theme="dark"]'));
        expect(css).toContain('background-image:url("/api/x/v1")');
        const alphas = [...css.matchAll(/--rr-panel-alpha:([0-9.]+) !important/g)].map((match) => Number(match[1]));
        expect(alphas).toHaveLength(3);
        expect(alphas[0]).not.toBe(alphas[1]);
        expect(alphas[1]).toBe(alphas[2]);
    });

    it("has no colour rules for a background alone, no text-white rule without a primary, and passes the measurement through", () => {
        const background = { kind: "image", imageVersion: "v1", dim: 0.2, blur: 0, fit: "cover" } as const;
        const worst = appearanceCss(prefs({ background }));
        expect(worst).not.toContain(".bg-primary.text-white");
        const plain = appearanceCss(prefs({ background }), { measured: { lo: rgb("#e8e8e8"), hi: WHITE } });
        expect(plain).not.toBe(worst);
    });
});

describe("contrastWarnings", () => {
    it("warns about nothing for no choices, sensible ones, or a pair the user didn't touch", () => {
        expect(contrastWarnings(undefined, "light")).toEqual([]);
        expect(contrastWarnings({ primary: "#ffffff" }, "light")).toEqual([]);
        expect(contrastWarnings({ surface: "#ffffff", text: "#000000", accent: "#a3690a" }, "light")).toEqual([]);
    });

    it("warns when the chosen text can't be read on the surface, with the ratio", () => {
        const [warning] = contrastWarnings({ text: "#f0f0f0", surface: "#ffffff" }, "light");
        expect(warning).toMatchObject({ id: "text-surface" });
        expect(warning.ratio).toBeLessThan(4.5);
        expect(warning.message).toMatch(/^Text on the surface colour has a contrast of 1\.1:1; 4\.5:1 or more is easier to read\.$/);
    });

    it("judges a lone text colour against the scheme's own surface", () => {
        expect(contrastWarnings({ text: "#fafafa" }, "light").map((w) => w.id)).toEqual(["text-surface"]);
        expect(contrastWarnings({ text: "#fafafa" }, "dark")).toEqual([]);
    });

    it("warns when neither dark nor white text reads on the accent colour", () => {
        // A mid-gray gets under 4.5:1 with both.
        const [warning] = contrastWarnings({ accent: "#808080" }, "light");
        expect(warning).toMatchObject({ id: "accent-text" });
        expect(warning.message).toMatch(/^Text on buttons in the accent colour has a contrast of [0-9.]+:1;/);
    });

    it("can warn about both at once", () => {
        expect(contrastWarnings({ text: "#f0f0f0", surface: "#ffffff", accent: "#808080" }, "light").map((w) => w.id)).toEqual([
            "text-surface",
            "accent-text",
        ]);
    });
});
