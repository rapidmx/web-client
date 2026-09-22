///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** A colour as the browser reports it: channels 0-255 and an alpha 0-1. */
export interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
}

/** A colour with no transparency worth speaking of - what a contrast ratio is computed between. */
export type Rgb = Pick<Rgba, "r" | "g" | "b">;

/** The handful of named colours a `bgcolor`/`text` attribute is realistically written with. Anything else is not guessed at. */
const NAMED_COLOURS: Record<string, [number, number, number]> = {
    white: [255, 255, 255],
    black: [0, 0, 0],
    red: [255, 0, 0],
    green: [0, 128, 0],
    blue: [0, 0, 255],
    yellow: [255, 255, 0],
    gray: [128, 128, 128],
    grey: [128, 128, 128],
    silver: [192, 192, 192],
    navy: [0, 0, 128],
    teal: [0, 128, 128],
    maroon: [128, 0, 0],
    purple: [128, 0, 128],
    orange: [255, 165, 0],
    lime: [0, 255, 0],
    aqua: [0, 255, 255],
    fuchsia: [255, 0, 255],
    olive: [128, 128, 0],
};

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** One `rgb()` channel: a number 0-255, or a percentage of it. */
function channel(token: string): number {
    return token.endsWith("%") ? (parseFloat(token) / 100) * 255 : parseFloat(token);
}

/** An alpha: a number 0-1, or a percentage. */
function alpha(token: string | undefined): number {
    if (token === undefined) {
        return 1;
    }
    return token.endsWith("%") ? parseFloat(token) / 100 : parseFloat(token);
}

/**
 * Reads the colour notations a browser's computed style and an old-fashioned `bgcolor` attribute produce: `#rgb`, `#rgba`,
 * `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` in the comma and the space syntax, `color(srgb ...)`, `transparent` and a few names.
 * `undefined` for anything else (a gradient, `currentcolor`, `oklch()`), which callers treat as "unknown, leave it alone".
 */
export function parseColour(input: string | undefined | null): Rgba | undefined {
    const text = (input ?? "").trim().toLowerCase();
    if (text === "transparent") {
        return { r: 0, g: 0, b: 0, a: 0 };
    }
    if (text in NAMED_COLOURS) {
        const [r, g, b] = NAMED_COLOURS[text];
        return { r, g, b, a: 1 };
    }
    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)?.[1];
    if (hex) {
        const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
        const [r, g, b, a] = [0, 2, 4, 6].map((i) => (full.length > i ? parseInt(full.slice(i, i + 2), 16) : 255));
        return { r, g, b, a: a / 255 };
    }
    const functional = /^(rgba?|color)\(\s*(?:srgb\s+)?([^)]*)\)$/.exec(text);
    if (functional) {
        const parts = functional[2].split(/[\s,/]+/).filter(Boolean);
        if (parts.length < 3 || parts.length > 4 || parts.some((part) => !/^[-+]?(\d+\.?\d*|\.\d+)%?$/.test(part))) {
            return undefined;
        }
        const scale = functional[1] === "color" ? 255 : 1;
        const [r, g, b] = parts.slice(0, 3).map((part) => clamp(channel(part) * scale, 0, 255));
        return { r, g, b, a: clamp(alpha(parts[3]), 0, 1) };
    }
    return undefined;
}

/** `rgb(r, g, b)` for an opaque colour, `rgba(...)` otherwise - what goes into a generated stylesheet. */
export function formatColour(colour: Rgba | Rgb): string {
    const { r, g, b } = colour;
    const a = "a" in colour ? colour.a : 1;
    const rgb = [r, g, b].map((value) => Math.round(clamp(value, 0, 255))).join(", ");
    return a >= 1 ? `rgb(${rgb})` : `rgba(${rgb}, ${Math.round(a * 1000) / 1000})`;
}

/** `top` painted over `bottom`, as the opaque colour that results. */
export function composite(top: Rgba, bottom: Rgb): Rgb {
    return {
        r: top.r * top.a + bottom.r * (1 - top.a),
        g: top.g * top.a + bottom.g * (1 - top.a),
        b: top.b * top.a + bottom.b * (1 - top.a),
    };
}

function linear(value: number): number {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(colour: Rgb): number {
    return 0.2126 * linear(colour.r) + 0.7152 * linear(colour.g) + 0.0722 * linear(colour.b);
}

/** WCAG contrast ratio between two opaque colours, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
    const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (lighter + 0.05) / (darker + 0.05);
}

/** The lowest contrast ratio WCAG accepts for body text. */
export const MIN_TEXT_CONTRAST = 4.5;

export interface Hsl {
    h: number;
    s: number;
    l: number;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
    const [rn, gn, bn] = [r / 255, g / 255, b / 255];
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) {
        return { h: 0, s: 0, l };
    }
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
    return { h: h * 60, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
        const k = (n + h / 30) % 12;
        return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
    };
    return { r: f(0), g: f(8), b: f(4) };
}

/** Whether two colours are the same to the eye's tolerance - what "unchanged" means when deciding to emit a rule. */
export function sameColour(a: Rgb, b: Rgb): boolean {
    return Math.abs(a.r - b.r) < 1 && Math.abs(a.g - b.g) < 1 && Math.abs(a.b - b.b) < 1;
}

/**
 * `colour` moved along its own hue and saturation - lighter over a dark background, darker over a light one - until it reaches
 * `min` contrast against `background`. A colour that already has it is returned untouched; one that cannot get there (a mid-grey
 * background) becomes whichever of white and black reads better.
 */
export function ensureContrast(colour: Rgb, background: Rgb, min = MIN_TEXT_CONTRAST): Rgb {
    // Judged as the whole-number colour it will be written as: a fractional colour that reads can round to one that does not.
    const whole = roundColour(colour);
    if (contrastRatio(whole, background) >= min) {
        return whole;
    }
    const target = luminance(background) < 0.5 ? 1 : 0;
    const hsl = rgbToHsl(colour);
    if (contrastRatio(hslToRgb({ ...hsl, l: target }), background) < min) {
        return blackOrWhite(background);
    }
    let [near, far] = [hsl.l, target];
    for (let i = 0; i < 16; i++) {
        const middle = (near + far) / 2;
        if (contrastRatio(roundColour(hslToRgb({ ...hsl, l: middle })), background) >= min) {
            far = middle;
        } else {
            near = middle;
        }
    }
    return roundColour(hslToRgb({ ...hsl, l: far }));
}

function roundColour({ r, g, b }: Rgb): Rgb {
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}

/** How far from grey a colour may be and still count as a neutral (black, white, greys) rather than a colour with a hue to keep. */
const NEUTRAL_SATURATION = 0.12;

/** The theme a message is shown in: the opaque surface behind the body, its text and link colours, and whether it is a dark one. */
export interface ThemeSurface {
    background: Rgb;
    text: Rgb;
    link: Rgb;
    dark: boolean;
}

/** Whichever of black and white reads better on `background`. */
export function blackOrWhite(background: Rgb): Rgb {
    const [white, black] = [
        { r: 255, g: 255, b: 255 },
        { r: 0, g: 0, b: 0 },
    ];
    return contrastRatio(white, background) >= contrastRatio(black, background) ? white : black;
}

/**
 * An authored text colour that cannot be read against the theme's background, adapted so it can. A neutral (black, white, a
 * grey) is flipped to the other end of the scale - black becomes the theme's text colour, a dark grey a light one, and in a
 * light theme white becomes dark text - by placing it between the theme's text and background colours according to how far it
 * is from the one it must not be. Any other colour keeps its hue and saturation and only has its lightness moved, as little as
 * it takes to reach 4.5:1 (`ensureContrast()`), so navy stays a navy and a brand red stays red. One that already reads is
 * returned untouched.
 */
export function adaptForeground(colour: Rgb, surface: ThemeSurface): Rgb {
    if (contrastRatio(colour, surface.background) >= MIN_TEXT_CONTRAST) {
        return colour;
    }
    const hsl = rgbToHsl(colour);
    if (hsl.s >= NEUTRAL_SATURATION) {
        return ensureContrast(colour, surface.background);
    }
    // The distance from the end of the scale that would have been readable: a dark theme wants light text, so it is how dark
    // the colour is; a light theme, how light.
    const t = surface.dark ? hsl.l : 1 - hsl.l;
    const mixed = {
        r: surface.text.r + (surface.background.r - surface.text.r) * t,
        g: surface.text.g + (surface.background.g - surface.text.g) * t,
        b: surface.text.b + (surface.background.b - surface.text.b) * t,
    };
    return ensureContrast(mixed, surface.background);
}

/**
 * The first colour in a computed `background-image` (a gradient's first stop): the best guess at what text over a gradient sits
 * on. `undefined` for an image (`url(...)`) or anything with no colour in it.
 */
export function firstColourStop(backgroundImage: string): Rgba | undefined {
    const match = /rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/i.exec(backgroundImage);
    return match ? parseColour(match[0]) : undefined;
}
