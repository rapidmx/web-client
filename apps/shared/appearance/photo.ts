///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * How light and how dark a background photo is, measured in the browser, so the panels over it are only as opaque as its busiest
 * places demand (see `panelAlpha()`). Nothing is uploaded: the picture is drawn once at 32 x 32 pixels on a canvas and its lightest and
 * darkest twentieth are taken.
 */
import { grayOfLuminance, Rgb, relativeLuminance } from "./color.js";
import type { PhotoRange } from "./theme.js";

/** The side, in pixels, of the square the picture is shrunk to for measuring. */
export const MEASURE_SIZE = 32;

/** Pixels more transparent than this don't count - a transparent PNG margin is whatever is behind it, not the picture. */
const MIN_ALPHA = 128;

function gray(level: number): Rgb {
    return { r: level, g: level, b: level };
}

/**
 * The 5th and 95th percentile of relative luminance across RGBA pixel data, as the grays that have them - the darkest and lightest
 * a panel's text may sit over. `undefined` when no pixel is opaque enough to count.
 */
export function rangeOfPixels(rgba: ArrayLike<number>): PhotoRange | undefined {
    const values: number[] = [];
    for (let i = 0; i + 3 < rgba.length; i += 4) {
        if (rgba[i + 3] >= MIN_ALPHA) {
            values.push(relativeLuminance({ r: rgba[i], g: rgba[i + 1], b: rgba[i + 2] }));
        }
    }
    if (values.length === 0) {
        return undefined;
    }
    values.sort((a, b) => a - b);
    const at = (fraction: number) => values[Math.min(values.length - 1, Math.floor(values.length * fraction))];
    return { lo: gray(grayOfLuminance(at(0.05))), hi: gray(grayOfLuminance(at(0.95))) };
}

/**
 * Loads `url` and measures it. `undefined` where it can't be done - no canvas, the picture doesn't load, or it comes from another
 * origin without CORS and taints the canvas - in which case the caller assumes the worst.
 */
export async function measureImage(url: string): Promise<PhotoRange | undefined> {
    if (typeof document === "undefined" || typeof Image === "undefined") {
        return undefined;
    }
    try {
        const image = new Image();
        image.decoding = "async";
        const loaded = new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error("The image did not load."));
        });
        image.src = url;
        await loaded;
        const canvas = document.createElement("canvas");
        canvas.width = MEASURE_SIZE;
        canvas.height = MEASURE_SIZE;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
            return undefined;
        }
        context.drawImage(image, 0, 0, MEASURE_SIZE, MEASURE_SIZE);
        return rangeOfPixels(context.getImageData(0, 0, MEASURE_SIZE, MEASURE_SIZE).data);
    } catch {
        return undefined;
    }
}

/** A measured range as the two gray levels the cache stores. */
export function rangeToLevels(range: PhotoRange): [number, number] {
    return [range.lo.r, range.hi.r];
}

/** The range for two stored gray levels; `undefined` unless both are numbers from 0 to 255. */
export function rangeFromLevels(levels: unknown): PhotoRange | undefined {
    if (
        !Array.isArray(levels) ||
        levels.length !== 2 ||
        !levels.every((level) => typeof level === "number" && Number.isFinite(level) && level >= 0 && level <= 255)
    ) {
        return undefined;
    }
    return { lo: gray(levels[0]), hi: gray(levels[1]) };
}
