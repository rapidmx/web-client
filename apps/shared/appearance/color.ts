///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The small amount of colour maths theming needs, with no dependency: parsing and formatting `#rrggbb`, mixing, WCAG relative
 * luminance and contrast, and deriving a readable text colour or a whole shade scale from one chosen colour. Pure - nothing here
 * touches the DOM.
 */

/** A colour as 0-255 red, green and blue. */
export interface Rgb {
    r: number;
    g: number;
    b: number;
}

export const BLACK: Rgb = { r: 0, g: 0, b: 0 };
export const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** WCAG AA for normal-size text. */
export const AA_CONTRAST = 4.5;

const HEX_6 = /^#?([0-9a-f]{6})$/i;
const HEX_3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i;

/** `#rrggbb` (or, forgivingly, `rrggbb`, `#rgb` and `rgb`, in any case) as a colour; `undefined` for anything else. */
export function parseHex(input: string): Rgb | undefined {
    const text = input.trim();
    let digits: string;
    const long = HEX_6.exec(text);
    if (long) {
        digits = long[1];
    } else {
        const short = HEX_3.exec(text);
        if (!short) {
            return undefined;
        }
        digits = short[1] + short[1] + short[2] + short[2] + short[3] + short[3];
    }
    const value = parseInt(digits, 16);
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function channel(value: number): number {
    return Math.min(255, Math.max(0, Math.round(value)));
}

/** The colour as lower-case `#rrggbb` (channels are rounded and clamped). */
export function toHex({ r, g, b }: Rgb): string {
    return "#" + [r, g, b].map((value) => channel(value).toString(16).padStart(2, "0")).join("");
}

/** The lower-case `#rrggbb` form of a hex colour typed any of the forgiving ways `parseHex()` accepts; `undefined` if it isn't one. */
export function normalizeHex(input: string): string | undefined {
    const rgb = parseHex(input);
    return rgb ? toHex(rgb) : undefined;
}

/** `true` for a strict `#rrggbb` (what the server stores). */
export function isHexColor(input: string): boolean {
    return /^#[0-9a-f]{6}$/i.test(input);
}

/** The colour `amount` of the way from `from` to `to` (0 is `from`, 1 is `to`), mixed in sRGB. */
export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
    const t = Math.min(1, Math.max(0, amount));
    return { r: from.r + (to.r - from.r) * t, g: from.g + (to.g - from.g) * t, b: from.b + (to.b - from.b) * t };
}

function linear(value: number): number {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG 2 relative luminance: 0 for black, 1 for white. */
export function relativeLuminance({ r, g, b }: Rgb): number {
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** The gray (0-255) whose relative luminance is `luminance` - the inverse of `relativeLuminance()` for a gray. */
export function grayOfLuminance(luminance: number): number {
    const l = Math.min(1, Math.max(0, luminance));
    const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
    return channel(s * 255);
}

/** WCAG 2 contrast ratio between two colours: 1 (identical) to 21 (black on white). Symmetric. */
export function contrastRatio(a: Rgb, b: Rgb): number {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The contrast ratio of two `#rrggbb` colours, `undefined` when either doesn't parse. */
export function contrastOfHex(a: string, b: string): number | undefined {
    const first = parseHex(a);
    const second = parseHex(b);
    return first && second ? contrastRatio(first, second) : undefined;
}

/** The app's own two text colours, for text that must sit on a colour of unknown lightness. */
export const DARK_TEXT: Rgb = { r: 0x1c, g: 0x25, b: 0x26 };
export const LIGHT_TEXT: Rgb = { r: 0xff, g: 0xff, b: 0xff };

/**
 * The app's dark or light text colour for text on `background`: `prefer` (light by default, as on the primary colour; the accent
 * colour prefers dark) whenever that reaches AA contrast, else whichever of the two reads better.
 */
export function readableOn(background: Rgb, prefer: Rgb = LIGHT_TEXT): Rgb {
    if (contrastRatio(prefer, background) >= AA_CONTRAST) {
        return prefer;
    }
    return contrastRatio(DARK_TEXT, background) >= contrastRatio(LIGHT_TEXT, background) ? DARK_TEXT : LIGHT_TEXT;
}

/**
 * `foreground`, moved toward black or white - whichever the background is further from - just far enough to reach `minimum`
 * contrast against `background`; unchanged when it already does. Where even black or white can't (a mid-gray background can't reach
 * 7:1), the best of the two.
 */
export function ensureContrast(foreground: Rgb, background: Rgb, minimum: number = AA_CONTRAST): Rgb {
    if (contrastRatio(foreground, background) >= minimum) {
        return foreground;
    }
    const target = contrastRatio(BLACK, background) >= contrastRatio(WHITE, background) ? BLACK : WHITE;
    for (let step = 1; step <= 20; step++) {
        const candidate = mix(foreground, target, step / 20);
        if (contrastRatio(candidate, background) >= minimum) {
            return candidate;
        }
    }
    return target;
}

/** The shades the app's tokens come in, derived from one colour. */
export interface PrimaryScale {
    base: string;
    dark: string;
    darker: string;
    darkest: string;
    light: string;
    lighter: string;
    lightest: string;
    /** Text that reads on `base`: `preferOnBase` (white by default) when that reaches AA contrast, else the better of the app's two. */
    onBase: string;
}

/**
 * The seven-step scale (`base`, three darker shades, three lighter ones) plus the text colour for a button of `base`, from the single
 * `#rrggbb` a user picked. Shades are mixes with black and white, so the hue stays exactly the one chosen. `undefined` if `hex` isn't
 * a colour.
 */
export function deriveScale(hex: string, preferOnBase: Rgb = LIGHT_TEXT): PrimaryScale | undefined {
    const base = parseHex(hex);
    if (!base) {
        return undefined;
    }
    return {
        base: toHex(base),
        dark: toHex(mix(base, BLACK, 0.2)),
        darker: toHex(mix(base, BLACK, 0.4)),
        darkest: toHex(mix(base, BLACK, 0.55)),
        light: toHex(mix(base, WHITE, 0.2)),
        lighter: toHex(mix(base, WHITE, 0.4)),
        lightest: toHex(mix(base, WHITE, 0.6)),
        onBase: toHex(readableOn(base, preferOnBase)),
    };
}
