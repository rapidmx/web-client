// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    AA_CONTRAST,
    BLACK,
    DARK_TEXT,
    LIGHT_TEXT,
    WHITE,
    contrastOfHex,
    contrastRatio,
    deriveScale,
    ensureContrast,
    grayOfLuminance,
    isHexColor,
    mix,
    normalizeHex,
    parseHex,
    readableOn,
    relativeLuminance,
    toHex,
} from "../../../apps/shared/appearance/color.js";

describe("parseHex / toHex / normalizeHex", () => {
    it("parses #rrggbb in either case, with or without the hash and surrounding space", () => {
        expect(parseHex("#0d9488")).toEqual({ r: 13, g: 148, b: 136 });
        expect(parseHex("0D9488")).toEqual({ r: 13, g: 148, b: 136 });
        expect(parseHex("  #FFFFFF ")).toEqual({ r: 255, g: 255, b: 255 });
    });

    it("expands the short form", () => {
        expect(parseHex("#abc")).toEqual({ r: 170, g: 187, b: 204 });
        expect(parseHex("f00")).toEqual({ r: 255, g: 0, b: 0 });
    });

    it("rejects anything else", () => {
        for (const bad of ["", "#", "#12", "#12345", "#1234567", "#gggggg", "red", "rgb(0,0,0)", "#12 345", "url(x)"]) {
            expect(parseHex(bad)).toBeUndefined();
        }
    });

    it("formats lower-case with each channel rounded and clamped", () => {
        expect(toHex({ r: 13, g: 148, b: 136 })).toBe("#0d9488");
        expect(toHex({ r: 300, g: -5, b: 127.6 })).toBe("#ff0080");
        expect(toHex(BLACK)).toBe("#000000");
    });

    it("normalizes forgiving input and says undefined for junk", () => {
        expect(normalizeHex("ABC")).toBe("#aabbcc");
        expect(normalizeHex("#0D9488")).toBe("#0d9488");
        expect(normalizeHex("blue")).toBeUndefined();
    });

    it("isHexColor is the strict #rrggbb", () => {
        expect(isHexColor("#0d9488")).toBe(true);
        expect(isHexColor("#0D9488")).toBe(true);
        expect(isHexColor("0d9488")).toBe(false);
        expect(isHexColor("#abc")).toBe(false);
    });
});

describe("mix", () => {
    it("goes from the first colour to the second and clamps the amount", () => {
        expect(mix(BLACK, WHITE, 0)).toEqual(BLACK);
        expect(mix(BLACK, WHITE, 1)).toEqual(WHITE);
        expect(mix(BLACK, WHITE, 0.5)).toEqual({ r: 127.5, g: 127.5, b: 127.5 });
        expect(mix(BLACK, WHITE, -1)).toEqual(BLACK);
        expect(mix(BLACK, WHITE, 7)).toEqual(WHITE);
    });
});

describe("luminance and contrast", () => {
    it("matches the WCAG definitions at the extremes and at a known mid value", () => {
        expect(relativeLuminance(BLACK)).toBe(0);
        expect(relativeLuminance(WHITE)).toBeCloseTo(1, 10);
        // #767676 is the classic lightest gray that still has 4.54:1 on white.
        expect(contrastRatio({ r: 0x76, g: 0x76, b: 0x76 }, WHITE)).toBeCloseTo(4.54, 2);
        expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 5);
    });

    it("is symmetric and 1 for identical colours", () => {
        const a = { r: 10, g: 200, b: 90 };
        expect(contrastRatio(a, a)).toBe(1);
        expect(contrastRatio(a, WHITE)).toBe(contrastRatio(WHITE, a));
    });

    it("uses the low-light linear segment for near-black channels", () => {
        expect(relativeLuminance({ r: 5, g: 5, b: 5 })).toBeCloseTo(5 / 255 / 12.92, 6);
    });

    it("contrastOfHex reads two hex colours and is undefined when either is not one", () => {
        expect(contrastOfHex("#000000", "#ffffff")).toBeCloseTo(21, 5);
        expect(contrastOfHex("nope", "#ffffff")).toBeUndefined();
        expect(contrastOfHex("#ffffff", "nope")).toBeUndefined();
    });

    it("grayOfLuminance inverts relativeLuminance for grays, clamping outside 0..1", () => {
        for (const level of [0, 1, 40, 128, 200, 255]) {
            expect(grayOfLuminance(relativeLuminance({ r: level, g: level, b: level }))).toBe(level);
        }
        expect(grayOfLuminance(-1)).toBe(0);
        expect(grayOfLuminance(2)).toBe(255);
        // The linear segment: a tiny luminance is a tiny gray.
        expect(grayOfLuminance(0.001)).toBe(3);
    });
});

describe("readableOn", () => {
    it("keeps the preferred colour when it reaches AA", () => {
        expect(readableOn({ r: 20, g: 30, b: 40 })).toBe(LIGHT_TEXT);
        expect(readableOn({ r: 250, g: 240, b: 200 }, DARK_TEXT)).toBe(DARK_TEXT);
    });

    it("falls back to whichever of the two reads better", () => {
        // Bright yellow: white is unreadable, so the dark text wins.
        expect(readableOn({ r: 255, g: 230, b: 0 })).toBe(DARK_TEXT);
        // Deep navy asked for dark text: white is the better of the two.
        expect(readableOn({ r: 10, g: 20, b: 90 }, DARK_TEXT)).toBe(LIGHT_TEXT);
    });
});

describe("ensureContrast", () => {
    it("returns the colour untouched when it already reaches the minimum", () => {
        const gray = { r: 40, g: 40, b: 40 };
        expect(ensureContrast(gray, WHITE)).toBe(gray);
    });

    it("moves toward black on a light background until the minimum is reached", () => {
        const result = ensureContrast({ r: 200, g: 200, b: 200 }, WHITE, AA_CONTRAST);
        expect(contrastRatio(result, WHITE)).toBeGreaterThanOrEqual(AA_CONTRAST);
        expect(result.r).toBeLessThan(200);
    });

    it("moves toward white on a dark background", () => {
        const result = ensureContrast({ r: 60, g: 60, b: 60 }, BLACK, AA_CONTRAST);
        expect(contrastRatio(result, BLACK)).toBeGreaterThanOrEqual(AA_CONTRAST);
        expect(result.r).toBeGreaterThan(60);
    });

    it("returns the extreme when even that cannot reach the minimum", () => {
        // 21:1 is the most there is; nothing reaches 25.
        expect(ensureContrast({ r: 128, g: 128, b: 128 }, WHITE, 25)).toEqual(BLACK);
    });
});

describe("deriveScale", () => {
    it("derives seven steps from one colour: three darker, three lighter, keeping the hue", () => {
        const scale = deriveScale("#0d9488")!;
        expect(scale.base).toBe("#0d9488");
        expect(scale.dark).toBe("#0a766d");
        expect(scale.darker).toBe("#085952");
        expect(scale.darkest).toBe("#06433d");
        expect(scale.light).toBe("#3da9a0");
        expect(scale.lighter).toBe("#6ebfb8");
        expect(scale.lightest).toBe("#9ed4cf");
        // Darker steps get progressively darker, lighter steps lighter.
        const order = [scale.darkest, scale.darker, scale.dark, scale.base, scale.light, scale.lighter, scale.lightest].map((hex) =>
            relativeLuminance(parseHex(hex)!),
        );
        expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it("chooses the text on the base colour: white when that reads, else the dark text", () => {
        expect(deriveScale("#1e3a8a")!.onBase).toBe("#ffffff");
        expect(deriveScale("#ffd60a")!.onBase).toBe("#1c2526");
        // The accent-style preference.
        expect(deriveScale("#a3690a", DARK_TEXT)!.onBase).toBe(toHex(readableOn({ r: 0xa3, g: 0x69, b: 0x0a }, DARK_TEXT)));
    });

    it("is undefined for something that is not a colour", () => {
        expect(deriveScale("teal")).toBeUndefined();
    });
});
