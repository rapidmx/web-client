// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RailIcon, { canMeasureImages, emptyRowsAtTop, measureTopMargin } from "../../../apps/shared/components/layout/RailIcon.js";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const SIZE = 63;

/** RGBA data for a `SIZE` x `SIZE` square, transparent except a block starting at row `firstRow`. */
function artwork(firstRow: number | null): Uint8ClampedArray {
    const data = new Uint8ClampedArray(SIZE * SIZE * 4);
    if (firstRow !== null) {
        for (let y = firstRow; y < SIZE; y++) {
            for (let x = 10; x < 20; x++) {
                data[(y * SIZE + x) * 4 + 3] = 255;
            }
        }
    }
    return data;
}

function stubBrowser({ naturalWidth = 150, naturalHeight = 150, decode = () => Promise.resolve(), context }: { naturalWidth?: number; naturalHeight?: number; decode?: () => Promise<void>; context: unknown }) {
    class FakeImage {
        src = "";
        naturalWidth = naturalWidth;
        naturalHeight = naturalHeight;
        decode = decode;
    }
    vi.stubGlobal("Image", FakeImage);
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) };
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => (tag === "canvas" ? canvas : createElement(tag))) as never);
}

describe("canMeasureImages", () => {
    it("is false where images can't be decoded: jsdom, no Image at all, or an Image that can't be made", () => {
        expect(canMeasureImages()).toBe(false);
        vi.stubGlobal("Image", undefined);
        expect(canMeasureImages()).toBe(false);
        vi.stubGlobal(
            "Image",
            class {
                constructor() {
                    throw new Error("no images here");
                }
            },
        );
        expect(canMeasureImages()).toBe(false);
    });

    it("is true where an image has decode()", () => {
        stubBrowser({ context: null });
        expect(canMeasureImages()).toBe(true);
    });
});

describe("emptyRowsAtTop", () => {
    it("counts the transparent rows above the first visible pixel", () => {
        expect(emptyRowsAtTop(artwork(6), SIZE)).toBe(6);
        expect(emptyRowsAtTop(artwork(0), SIZE)).toBe(0);
    });

    it("is 0 for a picture with nothing visible, and ignores almost-transparent pixels", () => {
        expect(emptyRowsAtTop(artwork(null), SIZE)).toBe(0);
        const faint = artwork(null);
        faint[(4 * SIZE + 3) * 4 + 3] = 20;
        expect(emptyRowsAtTop(faint, SIZE)).toBe(0);
        faint[(9 * SIZE + 3) * 4 + 3] = 200;
        expect(emptyRowsAtTop(faint, SIZE)).toBe(9);
    });
});

describe("measureTopMargin", () => {
    it("draws the icon fitted into the square and reads back the empty rows", async () => {
        const drawImage = vi.fn();
        stubBrowser({ context: { drawImage, getImageData: () => ({ data: artwork(6) }) } });
        expect(await measureTopMargin("/icon.svg")).toBe(6);
        // A square icon fills the square.
        expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, SIZE, SIZE);
    });

    it("centres a wide icon, as object-fit: contain does", async () => {
        const drawImage = vi.fn();
        stubBrowser({ naturalWidth: 200, naturalHeight: 100, context: { drawImage, getImageData: () => ({ data: artwork(20) }) } });
        await measureTopMargin("/wide.png");
        expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, SIZE / 4, SIZE, SIZE / 2);
    });

    it("is 0 when the picture doesn't decode, has no size, has no canvas, or the pixels can't be read", async () => {
        stubBrowser({ decode: () => Promise.reject(new Error("bad")), context: {} });
        expect(await measureTopMargin("/bad")).toBe(0);
        stubBrowser({ naturalWidth: 0, naturalHeight: 0, context: { drawImage: vi.fn() } });
        expect(await measureTopMargin("/empty")).toBe(0);
        stubBrowser({ context: null });
        expect(await measureTopMargin("/nocanvas")).toBe(0);
        stubBrowser({
            context: {
                drawImage: vi.fn(),
                getImageData: () => {
                    throw new DOMException("tainted", "SecurityError");
                },
            },
        });
        expect(await measureTopMargin("https://other.example/i.png")).toBe(0);
    });
});

describe("RailIcon", () => {
    it("shows the icon as it is, at once, where nothing can be measured (jsdom, and so every test of a shell)", () => {
        const { container } = render(<RailIcon src="/icon.svg" />);
        const img = container.querySelector("img")!;
        expect(img.style.opacity).toBe("1");
        expect(img.style.transform).toBe("");
    });

    it("is a block as wide as the rail and as tall as the title bar, flush with the top, hidden until measured", async () => {
        stubBrowser({ context: { drawImage: vi.fn(), getImageData: () => ({ data: artwork(6) }) } });
        const { container } = render(<RailIcon src="/icon.svg" />);
        const block = container.querySelector("[data-rail-icon]")!;
        expect(block).toHaveClass("h-16", "w-full", "overflow-hidden", "border-b");
        // No padding above it: nothing but the block's own classes.
        expect(block.className).not.toMatch(/\bp[ty]?-\d/);
        const img = container.querySelector("img")!;
        expect(img).toHaveAttribute("src", "/icon.svg");
        expect(img).toHaveAttribute("alt", "");
        expect(img.style.opacity).toBe("0");
        await act(async () => undefined);
        expect(img.style.opacity).toBe("1");
        // Raised by the icon's own margin so the first visible pixel is at the very top.
        expect(img.style.transform).toBe("translateY(-6px)");
    });

    it("leaves an icon that has no margin where it is", async () => {
        stubBrowser({ context: { drawImage: vi.fn(), getImageData: () => ({ data: artwork(0) }) } });
        const { container } = render(<RailIcon src="/icon.svg" />);
        await act(async () => undefined);
        const img = container.querySelector("img")!;
        expect(img.style.transform).toBe("");
        expect(img.style.opacity).toBe("1");
    });

    it("measures again for another icon, and ignores a measurement that arrives after it went", async () => {
        let finish!: () => void;
        stubBrowser({ decode: () => new Promise<void>((resolve) => (finish = resolve)), context: { drawImage: vi.fn(), getImageData: () => ({ data: artwork(6) }) } });
        const { container, rerender, unmount } = render(<RailIcon src="/a.svg" />);
        rerender(<RailIcon src="/b.svg" />);
        expect(container.querySelector("img")!.style.opacity).toBe("0");
        unmount();
        await act(async () => finish());
    });
});
