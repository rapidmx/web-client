///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Turns a user's `AppearancePreferences` into CSS - pure functions, no DOM (`AppearanceProvider` applies the result).
 *
 * **How the theme reaches the app.** The app's colours are custom properties (`--rr-color-*`, mapped to Tailwind's colours in
 * `app.css`'s `@theme`), with a light set on `:root` and a dark set for `prefers-color-scheme: dark` and `[data-theme="dark"]`. A
 * deployment's branding stylesheet re-points the same properties. The user's choices are emitted as one more set of those
 * properties, `!important` and for both schemes (`appearanceCss()`), so precedence is: built-in defaults < the branding stylesheet <
 * the user. A custom property declared `!important` on `<html>` cannot be beaten by any ordinary rule, however specific - but a
 * branding stylesheet's own *rules* (say `nav { background: ... }`) are untouched and still decide their element, exactly as they
 * always did; only the tokens are the user's.
 *
 * **Background.** With a background set, `--color-surface` and `--color-surface-alt` (what `bg-surface` and `bg-surface-alt` read)
 * become the scheme's surface colour at an alpha, so the rail and header are translucent panels over the fixed background layer,
 * and the content region (`#app-content`) is one such panel itself, its own `bg-surface` children transparent so panels never stack
 * into an opaque slab; menus, dialogs and pop-ups reset both tokens to the opaque colour again (see `app.css`). The alpha is chosen
 * so text stays at AA contrast over the photo (`panelAlpha()`).
 */
import type {
    AppearanceBackground,
    AppearanceColors,
    AppearancePreferences,
} from "@rapidmx/react-shared/appearance/preferencesApi.js";
import {
    AA_CONTRAST,
    BLACK,
    DARK_TEXT,
    Rgb,
    WHITE,
    contrastRatio,
    deriveScale,
    ensureContrast,
    mix,
    parseHex,
    readableOn,
    relativeLuminance,
    toHex,
} from "./color.js";
import type { ResolvedTheme } from "./resolvedTheme.js";

/** What each scheme's tokens are without any customisation - `app.css`'s own values. */
export interface SchemePalette {
    surface: string;
    text: string;
    muted: string;
}

export const DEFAULT_PALETTE: Record<ResolvedTheme, SchemePalette> = {
    light: { surface: "#ffffff", text: "#1c2526", muted: "#5a6b6e" },
    dark: { surface: "#1b2022", text: "#eef2f3", muted: "#9fb0b3" },
};

/** The colours in effect for a scheme: the user's surface and text where chosen, else the defaults. */
export interface EffectivePalette {
    surface: Rgb;
    text: Rgb;
    muted: Rgb;
    /** The user chose a surface. */
    surfaceChosen: boolean;
    /** The user chose a text colour, or the default one could not be read on their surface and was replaced. */
    textAdjusted: boolean;
}

/** How far the text colour is mixed toward the surface to get the muted text colour. */
const MUTED_MIX: Record<ResolvedTheme, number> = { light: 0.3, dark: 0.35 };
/** How far the surface is mixed toward the text colour to get `surface-alt`. */
const ALT_MIX: Record<ResolvedTheme, number> = { light: 0.04, dark: 0.03 };
const BORDER_MIX = 0.12;
/** How far the text colour is mixed toward the surface to get the muted text colour while a background is set - less than usual, so the panels can be more see-through. */
const BACKGROUND_MUTED_MIX = 0.18;

/** `#rrggbb` known valid (`normalizeAppearance()` and the colour inputs guarantee it). */
function rgbOf(hex: string): Rgb {
    return parseHex(hex) as Rgb;
}

export function effectivePalette(colors: AppearanceColors | undefined, scheme: ResolvedTheme): EffectivePalette {
    const defaults = DEFAULT_PALETTE[scheme];
    const surface = rgbOf(colors?.surface ?? defaults.surface);
    let text = rgbOf(colors?.text ?? defaults.text);
    let textAdjusted = colors?.text !== undefined;
    if (!textAdjusted && colors?.surface !== undefined && contrastRatio(text, surface) < AA_CONTRAST) {
        // A surface the app's own text can't be read on: the text follows it, rather than leaving the page unreadable.
        text = readableOn(surface, DARK_TEXT);
        textAdjusted = true;
    }
    const customised = colors?.surface !== undefined || textAdjusted;
    const muted = customised
        ? ensureContrast(mix(text, surface, MUTED_MIX[scheme]), surface, AA_CONTRAST)
        : rgbOf(defaults.muted);
    return { surface, text, muted, surfaceChosen: colors?.surface !== undefined, textAdjusted };
}

/**
 * The custom properties a user's colours set for one scheme - only those they changed (and what derives from them): the primary
 * colour's seven-step scale and the text on it, the accent and its shades, and the surface / text family. Empty when they chose
 * no colours.
 */
export function colorVariables(colors: AppearanceColors | undefined, scheme: ResolvedTheme): Record<string, string> {
    const vars: Record<string, string> = {};
    if (!colors) {
        return vars;
    }
    const primary = colors.primary ? deriveScale(colors.primary) : undefined;
    if (primary) {
        vars["--rr-color-primary"] = primary.base;
        vars["--rr-color-primary-dark"] = primary.dark;
        vars["--rr-color-primary-darker"] = primary.darker;
        vars["--rr-color-primary-darkest"] = primary.darkest;
        vars["--rr-color-primary-light"] = primary.light;
        vars["--rr-color-primary-lighter"] = primary.lighter;
        vars["--rr-color-primary-lightest"] = primary.lightest;
        vars["--rr-color-text-on-primary"] = primary.onBase;
    }
    const accent = colors.accent ? parseHex(colors.accent) : undefined;
    if (accent) {
        vars["--rr-color-accent"] = toHex(accent);
        vars["--rr-color-accent-dark"] = toHex(mix(accent, BLACK, 0.25));
        vars["--rr-color-accent-soft"] = toHex(mix(accent, WHITE, 0.2));
        vars["--rr-color-accent-pale"] = toHex(mix(accent, WHITE, 0.8));
        vars["--rr-color-text-on-accent"] = toHex(readableOn(accent, DARK_TEXT));
    }
    const palette = effectivePalette(colors, scheme);
    if (palette.surfaceChosen || palette.textAdjusted) {
        vars["--rr-color-border"] = toHex(mix(palette.surface, palette.text, BORDER_MIX));
        vars["--rr-color-text-muted"] = toHex(palette.muted);
    }
    if (palette.surfaceChosen) {
        vars["--rr-color-surface"] = toHex(palette.surface);
        vars["--rr-color-surface-alt"] = toHex(mix(palette.surface, palette.text, ALT_MIX[scheme]));
        // The page behind the panels: the surface itself, except that a dark surface sits on a slightly deeper page, as the defaults do.
        vars["--rr-color-bg"] = toHex(relativeLuminance(palette.surface) < 0.18 ? mix(palette.surface, BLACK, 0.25) : palette.surface);
    }
    if (palette.textAdjusted) {
        vars["--rr-color-text"] = toHex(palette.text);
    }
    return vars;
}

/** The lightest and darkest a background can be behind a panel, as colours. */
export interface PhotoRange {
    lo: Rgb;
    hi: Rgb;
}

/** What is assumed of a photo nobody has measured: black in one corner and white in another. */
export const WORST_CASE_PHOTO: PhotoRange = { lo: BLACK, hi: WHITE };

/** The panels are never more see-through than this ... */
export const PANEL_ALPHA_MIN = 0.5;
/** ... nor less than this (still a hint of the picture). */
export const PANEL_ALPHA_MAX = 0.96;
/** Contrast the panels are made to keep, a little over AA to leave room for the compression of a photo. */
const PANEL_CONTRAST = 4.6;

/**
 * The opacity (0.5 to 0.96) of the surface panels over a background, the lowest for which text and muted text keep AA contrast
 * against the worst place the picture can be. What is behind a panel is the picture under the dim (`dim` of the surface colour laid
 * over it); the panel is `alpha` of the surface over that, so the picture's share of what the text sits on is `(1 - alpha) *
 * (1 - dim)`. A wide-ranging (busy) photo therefore gets more opaque panels than a plain one, and more dim allows less opaque
 * panels.
 */
export function panelAlpha(palette: Pick<EffectivePalette, "surface" | "text" | "muted">, dim: number, photo: PhotoRange): number {
    for (let alpha = PANEL_ALPHA_MIN; alpha < PANEL_ALPHA_MAX; alpha = Math.round((alpha + 0.01) * 100) / 100) {
        const share = (1 - alpha) * (1 - dim);
        const readable = [photo.lo, photo.hi].every((behind) => {
            const under = mix(palette.surface, behind, share);
            return contrastRatio(palette.text, under) >= PANEL_CONTRAST && contrastRatio(palette.muted, under) >= PANEL_CONTRAST;
        });
        if (readable) {
            return alpha;
        }
    }
    return PANEL_ALPHA_MAX;
}

/** What a background shows behind the panels - `undefined` for none: a colour, or an image of unknown or measured lightness. */
export function backgroundPhoto(background: AppearanceBackground | undefined, measured?: PhotoRange): PhotoRange | undefined {
    if (!background || background.kind === "none") {
        return undefined;
    }
    if (background.kind === "color") {
        const colour = rgbOf(background.color as string);
        return { lo: colour, hi: colour };
    }
    return measured ?? WORST_CASE_PHOTO;
}

/** The dim actually laid over the background: a colour has no picture to dim. */
export function effectiveDim(background: AppearanceBackground): number {
    return background.kind === "image" ? background.dim : 0;
}

/**
 * The custom properties for one scheme: the user's colours, plus - when a background is set - the translucent panel colours and the
 * transparent frame. `measured` is the image's measured lightness range, when known (`photo.ts`).
 */
export function themeVariables(prefs: AppearancePreferences, scheme: ResolvedTheme, measured?: PhotoRange): Record<string, string> {
    const vars = colorVariables(prefs.colors, scheme);
    const photo = backgroundPhoto(prefs.background, measured);
    if (photo && prefs.background) {
        const palette = effectivePalette(prefs.colors, scheme);
        // Muted text is what limits how see-through the panels can be, so over a background it is a shade stronger.
        const muted = ensureContrast(mix(palette.text, palette.surface, BACKGROUND_MUTED_MIX), palette.surface, AA_CONTRAST);
        const alpha = panelAlpha({ surface: palette.surface, text: palette.text, muted }, effectiveDim(prefs.background), photo);
        const percent = `${Math.round(alpha * 100)}%`;
        vars["--rr-panel"] = `color-mix(in srgb, var(--rr-color-surface) ${percent}, transparent)`;
        vars["--color-surface"] = "var(--rr-panel)";
        vars["--color-surface-alt"] = `color-mix(in srgb, var(--rr-color-surface-alt) ${percent}, transparent)`;
        vars["--rr-color-text-muted"] = toHex(muted);
        vars["--rr-panel-alpha"] = String(alpha);
        vars["--rr-frame-bg"] = "transparent";
    }
    return vars;
}

function declarations(vars: Record<string, string>): string {
    return Object.entries(vars)
        .map(([name, value]) => `${name}:${value} !important;`)
        .join("");
}

/** The element `appearanceCss()` writes into `<head>`, so an update replaces rather than duplicates it. */
export const APPEARANCE_STYLE_ID = "rr-appearance";

/** A string as a CSS `url()` argument: quoted, with what could end the string or the declaration escaped. */
export function cssUrl(url: string): string {
    const escaped = url.replace(/[\\"\p{Cc}]/gu, (char) => "\\" + char.charCodeAt(0).toString(16) + " ");
    return `url("${escaped}")`;
}

/**
 * The rules for the background layer, which is two pseudo-elements of `<html>` rather than any markup - so it exists from the
 * first byte of a server-rendered page (no flash), follows a live preview by rewriting one stylesheet, and needs no component.
 * `::before` is the picture (or colour): `position: fixed`, behind everything (`z-index: -1` puts it above the page's own canvas
 * colour and below every in-flow box), its box grown by twice the blur so the blurred edge falls outside the window. `::after` is the
 * dim: the scheme's surface colour at the chosen opacity. Neither takes a click, and neither prints.
 */
export function backgroundCss(background: AppearanceBackground | undefined, imageUrl?: string): string {
    if (!background || background.kind === "none") {
        return "";
    }
    const layer = "content:\"\";position:fixed;z-index:-1;pointer-events:none;";
    if (background.kind === "color") {
        return [`html::before{${layer}inset:0;background-color:${background.color};}`, "@media print{html::before{display:none}}"].join("\n");
    }
    const grow = -Math.round(background.blur * 2);
    const size =
        background.fit === "cover"
            ? "background-size:cover;background-repeat:no-repeat;background-position:center;"
            : background.fit === "contain"
              ? "background-size:contain;background-repeat:no-repeat;background-position:center;"
              : "background-size:auto;background-repeat:repeat;background-position:center;";
    const image = imageUrl ? `background-image:${cssUrl(imageUrl)};` : "";
    const color = background.color ?? "var(--rr-color-surface-alt)";
    const blur = background.blur > 0 ? `filter:blur(${background.blur}px);` : "";
    return [
        `html::before{${layer}inset:${grow}px;background-color:${color};${image}${size}${blur}}`,
        `html::after{${layer}inset:0;background-color:var(--rr-color-surface);opacity:${background.dim};}`,
        "@media print{html::before,html::after{display:none}}",
    ].join("\n");
}

export interface AppearanceCssOptions {
    /** The image's measured lightness range, when known (`photo.ts`); an unmeasured photo is assumed the worst case. */
    measured?: PhotoRange;
    /** Where the background image comes from - the server's URL for the stored version, or a `blob:` URL while an upload is in flight. */
    imageUrl?: string;
}

/**
 * The stylesheet text for the user's preferences, or `""` when they change nothing. Three rules per set of properties so each
 * scheme is right in every case: the light set for everything except an explicit dark (`data-theme="dark"`) - which also covers
 * a page with no `data-theme` at all; the dark set for a dark operating system on a page with no `data-theme` yet (before the
 * provider ran, or a server-rendered page following "System"); and the dark set for an explicit `data-theme="dark"`. All three are
 * `html:root...` (0,2,1) so the later dark rules win the equal-specificity tie against the light one. Then the background layer
 * (`backgroundCss()`).
 */
export function appearanceCss(prefs: AppearancePreferences | undefined, options: AppearanceCssOptions = {}): string {
    if (!prefs) {
        return "";
    }
    const light = declarations(themeVariables(prefs, "light", options.measured));
    const dark = declarations(themeVariables(prefs, "dark", options.measured));
    const rules: string[] = [];
    if (light || dark) {
        rules.push(
            `html:root:not([data-theme="dark"]){${light}}`,
            `@media (prefers-color-scheme:dark){html:root:not([data-theme]){${dark}}}`,
            `html:root[data-theme="dark"]{${dark}}`,
        );
    }
    if (prefs.colors?.primary) {
        // Several components write `bg-primary text-white`; on a primary colour the user picked, white may be unreadable.
        rules.push(".bg-primary.text-white{color:var(--rr-color-text-on-primary)}");
    }
    const background = backgroundCss(prefs.background, options.imageUrl);
    if (background) {
        // The content region is one translucent panel; what is inside it (`bg-surface`) shows it instead of adding a second layer.
        rules.push(
            "#app-content{background-color:var(--rr-panel);--color-surface:transparent;}",
            // Fields keep a solid surface: a box that is see-through has no edge to find.
            "#app-content :is(input,select,textarea){--color-surface:var(--rr-color-surface);}",
            // Someone who asked their system for less transparency gets solid panels.
            "@media (prefers-reduced-transparency:reduce){html:root{--rr-panel:var(--rr-color-surface) !important;--color-surface-alt:var(--rr-color-surface-alt) !important;}}",
            background,
        );
    }
    return rules.join("\n");
}

/** A pair of colours that is hard to read, as `ContrastWarning`s describe them. */
export interface ContrastWarning {
    id: "text-surface" | "accent-text";
    ratio: number;
    message: string;
}

/**
 * The colour pairs the user's choices make hard to read (contrast below 4.5:1, WCAG AA for normal text) in `scheme`: the text on the
 * surface, and the text on an accent-coloured button. A warning, never a block - it is their app. Nothing for a pair they haven't
 * touched (the app's own pairs are the app's business).
 */
export function contrastWarnings(colors: AppearanceColors | undefined, scheme: ResolvedTheme): ContrastWarning[] {
    const warnings: ContrastWarning[] = [];
    if (!colors) {
        return warnings;
    }
    if (colors.surface !== undefined || colors.text !== undefined) {
        const palette = effectivePalette(colors, scheme);
        const ratio = contrastRatio(palette.text, palette.surface);
        if (ratio < AA_CONTRAST) {
            warnings.push({
                id: "text-surface",
                ratio,
                message: `Text on the surface colour has a contrast of ${ratio.toFixed(1)}:1; 4.5:1 or more is easier to read.`,
            });
        }
    }
    if (colors.accent !== undefined) {
        const accent = rgbOf(colors.accent);
        const ratio = contrastRatio(readableOn(accent, DARK_TEXT), accent);
        if (ratio < AA_CONTRAST) {
            warnings.push({
                id: "accent-text",
                ratio,
                message: `Text on buttons in the accent colour has a contrast of ${ratio.toFixed(1)}:1; 4.5:1 or more is easier to read.`,
            });
        }
    }
    return warnings;
}
