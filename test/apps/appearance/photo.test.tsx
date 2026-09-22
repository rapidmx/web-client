// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEASURE_SIZE, measureImage, rangeFromLevels, rangeOfPixels, rangeToLevels } from "../../../apps/shared/appearance/photo.js";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** RGBA data for `count` pixels of one colour. */
function pixels(count: number, r: number, g: number, b: number, a = 255): number[] {
    return Array.from({ length: count }, () => [r, g, b, a]).flat();
}

describe("rangeOfPixels", () => {
    it("is undefined when there are no opaque pixels", () => {
        expect(rangeOfPixels([])).toBeUndefined();
        expect(rangeOfPixels(pixels(10, 255, 255, 255, 0))).toBeUndefined();
    });

    it("gives the darkest and lightest twentieth as grays", () => {
        // 100 pixels: the darkest 10 are black, the lightest 10 are white, the middle 80 are mid gray.
        const data = [...pixels(10, 0, 0, 0), ...pixels(80, 128, 128, 128), ...pixels(10, 255, 255, 255)];
        const range = rangeOfPixels(data)!;
        expect(range.lo).toEqual({ r: 0, g: 0, b: 0 });
        expect(range.hi).toEqual({ r: 255, g: 255, b: 255 });
    });

    it("ignores the outermost specks: 1 pixel in 100 doesn't move the range", () => {
        const data = [...pixels(1, 0, 0, 0), ...pixels(98, 128, 128, 128), ...pixels(1, 255, 255, 255)];
        const range = rangeOfPixels(data)!;
        expect(range.lo.r).toBe(128);
        expect(range.hi.r).toBe(128);
    });

    it("skips transparent pixels and handles a single one", () => {
        const data = [...pixels(50, 0, 0, 0, 0), ...pixels(1, 200, 200, 200)];
        const range = rangeOfPixels(data)!;
        expect(range.lo.r).toBe(200);
        expect(range.hi.r).toBe(200);
    });

    it("ignores a trailing partial pixel", () => {
        expect(rangeOfPixels([...pixels(1, 10, 10, 10), 5, 5])!.lo.r).toBe(10);
    });
});

describe("rangeToLevels / rangeFromLevels", () => {
    it("round-trips", () => {
        const range = rangeOfPixels([...pixels(5, 20, 20, 20), ...pixels(5, 220, 220, 220)])!;
        expect(rangeFromLevels(rangeToLevels(range))).toEqual(range);
    });

    it("refuses anything that isn't two levels from 0 to 255", () => {
        for (const bad of [undefined, null, "12", [1], [1, 2, 3], [1, "2"], [-1, 5], [5, 300], [NaN, 3], [Infinity, 3]]) {
            expect(rangeFromLevels(bad)).toBeUndefined();
        }
    });
});

describe("measureImage", () => {
    function stubBrowser({ loads = true, context }: { loads?: boolean; context?: unknown }) {
        class FakeImage {
            decoding = "";
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            set src(_value: string) {
                setTimeout(() => (loads ? this.onload?.() : this.onerror?.()), 0);
            }
        }
        vi.stubGlobal("Image", FakeImage);
        const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) };
        const createElement = document.createElement.bind(document);
        vi.spyOn(document, "createElement").mockImplementation(((tag: string) => (tag === "canvas" ? canvas : createElement(tag))) as never);
        return canvas;
    }

    it("draws the picture at 32 x 32 and measures what it reads back", async () => {
        const drawImage = vi.fn();
        const data = [...pixels(5, 10, 10, 10), ...pixels(5, 240, 240, 240)];
        const canvas = stubBrowser({
            context: { drawImage, getImageData: vi.fn(() => ({ data })) },
        });
        const range = await measureImage("/api/x/v1");
        expect(canvas.width).toBe(MEASURE_SIZE);
        expect(canvas.height).toBe(MEASURE_SIZE);
        expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, MEASURE_SIZE, MEASURE_SIZE);
        expect(range!.lo.r).toBeLessThan(range!.hi.r);
    });

    it("is undefined when the picture doesn't load", async () => {
        stubBrowser({ loads: false, context: {} });
        expect(await measureImage("/nope")).toBeUndefined();
    });

    it("is undefined when there is no 2D context", async () => {
        stubBrowser({ context: null });
        expect(await measureImage("/x")).toBeUndefined();
    });

    it("is undefined when reading the pixels back is refused (a canvas tainted by another origin)", async () => {
        stubBrowser({
            context: {
                drawImage: vi.fn(),
                getImageData: vi.fn(() => {
                    throw new DOMException("tainted", "SecurityError");
                }),
            },
        });
        expect(await measureImage("https://other.example/x.png")).toBeUndefined();
    });

    it("is undefined where there is no Image", async () => {
        vi.stubGlobal("Image", undefined);
        expect(await measureImage("/x")).toBeUndefined();
    });
});
