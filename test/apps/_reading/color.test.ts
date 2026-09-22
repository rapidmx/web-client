///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    MIN_TEXT_CONTRAST,
    ThemeSurface,
    adaptForeground,
    blackOrWhite,
    composite,
    contrastRatio,
    ensureContrast,
    firstColourStop,
    formatColour,
    hslToRgb,
    luminance,
    parseColour,
    rgbToHsl,
    sameColour,
} from "../../../apps/shared/components/mail/reading/color.js";

const DARK: ThemeSurface = { background: { r: 27, g: 32, b: 34 }, text: { r: 238, g: 242, b: 243 }, link: { r: 45, g: 212, b: 191 }, dark: true };
const LIGHT: ThemeSurface = { background: { r: 255, g: 255, b: 255 }, text: { r: 28, g: 37, b: 38 }, link: { r: 20, g: 138, b: 128 }, dark: false };

describe("parseColour", () => {
    it.each([
        ["#fff", { r: 255, g: 255, b: 255, a: 1 }],
        ["#000f", { r: 0, g: 0, b: 0, a: 1 }],
        ["#1a2B3c", { r: 26, g: 43, b: 60, a: 1 }],
        ["rgb(1, 2, 3)", { r: 1, g: 2, b: 3, a: 1 }],
        ["rgba(1, 2, 3, 0.5)", { r: 1, g: 2, b: 3, a: 0.5 }],
        ["rgb(1 2 3 / 25%)", { r: 1, g: 2, b: 3, a: 0.25 }],
        ["rgb(100% 0% 50%)", { r: 255, g: 0, b: 127.5, a: 1 }],
        ["color(srgb 1 0.5 0 / 0.5)", { r: 255, g: 127.5, b: 0, a: 0.5 }],
        ["  WHITE ", { r: 255, g: 255, b: 255, a: 1 }],
        ["navy", { r: 0, g: 0, b: 128, a: 1 }],
        ["transparent", { r: 0, g: 0, b: 0, a: 0 }],
    ])("reads %s", (input, expected) => {
        expect(parseColour(input)).toEqual(expected);
    });

    it("reads an 8-digit hex with its alpha", () => {
        const colour = parseColour("#ff000080")!;
        expect(colour).toMatchObject({ r: 255, g: 0, b: 0 });
        expect(colour.a).toBeCloseTo(0.5, 2);
    });

    it("clamps channels and alpha into range", () => {
        expect(parseColour("rgba(300, -5, 10, 2)")).toEqual({ r: 255, g: 0, b: 10, a: 1 });
    });

    it.each([undefined, null, "", "currentcolor", "oklch(50% 0.2 200)", "rgb(1, 2)", "rgb(1, 2, 3, 4, 5)", "rgb(a, b, c)", "#12", "linear-gradient(red, blue)", "notacolour"])(
        "answers nothing for %s",
        (input) => {
            expect(parseColour(input as string)).toBeUndefined();
        },
    );
});

describe("formatColour", () => {
    it("writes an opaque colour as rgb() and rounds the channels", () => {
        expect(formatColour({ r: 1.4, g: 2.6, b: 300 })).toBe("rgb(1, 3, 255)");
        expect(formatColour({ r: 1, g: 2, b: 3, a: 1 })).toBe("rgb(1, 2, 3)");
    });

    it("writes a translucent one as rgba()", () => {
        expect(formatColour({ r: 1, g: 2, b: 3, a: 0.12345 })).toBe("rgba(1, 2, 3, 0.123)");
    });
});

describe("composite", () => {
    it("paints a colour over another by its alpha", () => {
        expect(composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255 })).toEqual({ r: 127.5, g: 127.5, b: 127.5 });
        expect(composite({ r: 10, g: 20, b: 30, a: 1 }, { r: 255, g: 255, b: 255 })).toEqual({ r: 10, g: 20, b: 30 });
    });
});

describe("luminance and contrast", () => {
    it("puts white at 1 and black at 0", () => {
        expect(luminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
        expect(luminance({ r: 0, g: 0, b: 0 })).toBe(0);
        // Both branches of the sRGB transfer function.
        expect(luminance({ r: 5, g: 5, b: 5 })).toBeCloseTo(5 / 255 / 12.92, 6);
    });

    it("computes the WCAG ratio, symmetrically", () => {
        const white = { r: 255, g: 255, b: 255 };
        const black = { r: 0, g: 0, b: 0 };
        expect(contrastRatio(white, black)).toBeCloseTo(21, 3);
        expect(contrastRatio(black, white)).toBeCloseTo(21, 3);
        expect(contrastRatio(white, white)).toBe(1);
        // #767676 on white is the classic 4.54:1.
        expect(contrastRatio({ r: 0x76, g: 0x76, b: 0x76 }, white)).toBeCloseTo(4.54, 2);
    });
});

describe("HSL conversion", () => {
    it.each([
        [{ r: 255, g: 0, b: 0 }, { h: 0, s: 1, l: 0.5 }],
        [{ r: 0, g: 255, b: 0 }, { h: 120, s: 1, l: 0.5 }],
        [{ r: 0, g: 0, b: 255 }, { h: 240, s: 1, l: 0.5 }],
        [{ r: 255, g: 0, b: 128 }, { h: 330, s: 1, l: 0.5 }],
        [{ r: 128, g: 128, b: 128 }, { h: 0, s: 0, l: 128 / 255 }],
        [{ r: 255, g: 204, b: 204 }, { h: 0, s: 1, l: 0.9 }],
    ])("round-trips %j", (rgb, hsl) => {
        const converted = rgbToHsl(rgb);
        expect(converted.h).toBeCloseTo(hsl.h, 0);
        expect(converted.s).toBeCloseTo(hsl.s, 2);
        expect(converted.l).toBeCloseTo(hsl.l, 2);
        const back = hslToRgb(converted);
        expect(back.r).toBeCloseTo(rgb.r, 0);
        expect(back.g).toBeCloseTo(rgb.g, 0);
        expect(back.b).toBeCloseTo(rgb.b, 0);
    });
});

describe("sameColour", () => {
    it("tolerates less than a channel step", () => {
        expect(sameColour({ r: 10, g: 10, b: 10 }, { r: 10.4, g: 9.6, b: 10 })).toBe(true);
        expect(sameColour({ r: 10, g: 10, b: 10 }, { r: 12, g: 10, b: 10 })).toBe(false);
        expect(sameColour({ r: 10, g: 10, b: 10 }, { r: 10, g: 12, b: 10 })).toBe(false);
        expect(sameColour({ r: 10, g: 10, b: 10 }, { r: 10, g: 10, b: 12 })).toBe(false);
    });
});

describe("blackOrWhite", () => {
    it("picks whichever reads better", () => {
        expect(blackOrWhite({ r: 255, g: 255, b: 255 })).toEqual({ r: 0, g: 0, b: 0 });
        expect(blackOrWhite({ r: 11, g: 42, b: 91 })).toEqual({ r: 255, g: 255, b: 255 });
    });
});

describe("ensureContrast", () => {
    it("returns a colour that already reads, untouched", () => {
        const colour = { r: 240, g: 240, b: 240 };
        expect(ensureContrast(colour, DARK.background)).toEqual(colour);
    });

    it("lightens over a dark background, keeping the hue, until it reads - and no further than it has to", () => {
        const navy = { r: 0, g: 31, b: 92 };
        const result = ensureContrast(navy, DARK.background);
        expect(contrastRatio(result, DARK.background)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        expect(contrastRatio(result, DARK.background)).toBeLessThan(MIN_TEXT_CONTRAST + 0.3);
        expect(rgbToHsl(result).h).toBeCloseTo(rgbToHsl(navy).h, 0);
        expect(rgbToHsl(result).s).toBeCloseTo(rgbToHsl(navy).s, 1);
    });

    it("darkens over a light background", () => {
        const yellow = { r: 255, g: 230, b: 100 };
        const result = ensureContrast(yellow, LIGHT.background);
        expect(contrastRatio(result, LIGHT.background)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        expect(luminance(result)).toBeLessThan(luminance(yellow));
    });

    it("falls back to black when even white cannot read on a light-ish mid background", () => {
        // Luminance ~0.39: below the line that says "lighten", yet white is only 2.4:1 on it - black is 9:1.
        expect(ensureContrast({ r: 190, g: 190, b: 190 }, { r: 168, g: 168, b: 168 })).toEqual({ r: 0, g: 0, b: 0 });
    });

    it("reaches white only as far as it must: a hue that can read by lightening stops short of it", () => {
        const result = ensureContrast({ r: 130, g: 130, b: 130 }, { r: 118, g: 118, b: 118 });
        expect(contrastRatio(result, { r: 118, g: 118, b: 118 })).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        expect(result.r).toBeLessThan(255);
    });
});

describe("adaptForeground", () => {
    it("leaves a colour that already reads on the theme", () => {
        const red = { r: 248, g: 113, b: 113 };
        expect(adaptForeground(red, DARK)).toBe(red);
    });

    it("flips black to the theme's text colour on a dark theme, and a dark grey to a light grey", () => {
        expect(adaptForeground({ r: 0, g: 0, b: 0 }, DARK)).toEqual(DARK.text);
        const grey = adaptForeground({ r: 51, g: 51, b: 51 }, DARK);
        expect(contrastRatio(grey, DARK.background)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        expect(luminance(grey)).toBeGreaterThan(0.5);
    });

    it("flips white to the theme's text colour on a light theme", () => {
        expect(adaptForeground({ r: 255, g: 255, b: 255 }, LIGHT)).toEqual(LIGHT.text);
        expect(contrastRatio(adaptForeground({ r: 245, g: 245, b: 245 }, LIGHT), LIGHT.background)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    });

    it("moves a coloured text only as far as its hue allows, so navy stays navy-ish and red stays red", () => {
        const navy = adaptForeground({ r: 0, g: 31, b: 92 }, DARK);
        expect(contrastRatio(navy, DARK.background)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        expect(navy.b).toBeGreaterThan(navy.r);
        const red = adaptForeground({ r: 120, g: 0, b: 0 }, DARK);
        expect(contrastRatio(red, DARK.background)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        expect(red.r).toBeGreaterThan(red.g * 2);
    });
});

describe("firstColourStop", () => {
    it("reads the first colour of a gradient, as the browser writes it or as hex", () => {
        expect(firstColourStop("linear-gradient(90deg, rgb(255, 126, 95), rgb(254, 180, 123))")).toEqual({ r: 255, g: 126, b: 95, a: 1 });
        expect(firstColourStop("linear-gradient(#ff0000, #0000ff)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
        expect(firstColourStop("linear-gradient(rgba(0, 0, 0, 0.5), red)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    });

    it("has nothing to say about a picture", () => {
        expect(firstColourStop('url("data:image/png;base64,AAAA")')).toBeUndefined();
    });
});
