// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTACT_PHOTO_MAX_BYTES } from "../../../lib/contacts/contactsApi.js";
import {
    CONTACT_PHOTO_TOO_LARGE_MESSAGE,
    CONTACT_PHOTO_UNSUPPORTED_MESSAGE,
    ContactPhotoError,
    prepareContactPhoto,
} from "../../../lib/contacts/preparePhoto.js";

// jsdom has no image decoding or canvas: everything below is a stand-in that records what the code asked of it. What the real browser APIs do with
// these calls (EXIF handling, scaling quality, encoding) is not exercised here.

const MB = 1024 * 1024;

function file(size: number, type: string, name = "IMG_0001.jpg"): File {
    return new File([new Uint8Array(size)], name, { type });
}

interface Recorder {
    bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> };
    context: {
        drawImage: ReturnType<typeof vi.fn>;
        fillRect: ReturnType<typeof vi.fn>;
        clearRect: ReturnType<typeof vi.fn>;
        getImageData: ReturnType<typeof vi.fn>;
        fillStyle: string;
        imageSmoothingQuality: string;
    };
    encodes: Array<{ type: string; quality?: number }>;
    sides: number[];
}

interface Options {
    width?: number;
    height?: number;
    /** What an encode of this `type` and `quality` produces: a size in bytes (and optionally the type the browser really gave), or `null` for a failure. */
    encoded?: (type: string, quality?: number) => number | { size: number; type: string } | null;
    /** Whether any pixel of the drawing is see-through. */
    transparent?: boolean;
    offscreen?: boolean;
}

function install({ width = 4000, height = 3000, encoded = () => 100_000, transparent = false, offscreen = true }: Options = {}): Recorder {
    const rec: Recorder = {
        bitmap: { width, height, close: vi.fn() },
        context: {
            drawImage: vi.fn(),
            fillRect: vi.fn(),
            clearRect: vi.fn(),
            getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(transparent ? [0, 0, 0, 255, 0, 0, 0, 0] : [0, 0, 0, 255, 9, 9, 9, 255]) })),
            fillStyle: "",
            imageSmoothingQuality: "",
        },
        encodes: [],
        sides: [],
    };
    const blobFor = (type: string, quality?: number): Blob | null => {
        rec.encodes.push({ type, quality });
        const result = encoded(type, quality);
        if (result === null) {
            return null;
        }
        const { size, type: actual } = typeof result === "number" ? { size: result, type } : result;
        return new Blob([new Uint8Array(size)], { type: actual });
    };
    vi.stubGlobal("createImageBitmap", vi.fn(async () => rec.bitmap));
    if (offscreen) {
        vi.stubGlobal(
            "OffscreenCanvas",
            class {
                constructor(w: number, h: number) {
                    expect(w).toBe(h);
                    rec.sides.push(w);
                }
                getContext() {
                    return rec.context;
                }
                async convertToBlob({ type, quality }: { type: string; quality?: number }) {
                    return blobFor(type, quality);
                }
            },
        );
    } else {
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => rec.context) as never);
        vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback: BlobCallback, type?: string, quality?: number) => {
            rec.sides.push(0);
            callback(blobFor(type!, quality));
        });
    }
    return rec;
}

beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:src");
    URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("prepareContactPhoto: a picture the server already takes", () => {
    it("is returned as it is, without making a canvas, when its type, size and pixels are within the limits", async () => {
        const rec = install({ width: 1024, height: 700 });
        const picture = file(300_000, "image/gif", "anim.gif");
        await expect(prepareContactPhoto(picture)).resolves.toBe(picture);
        expect(rec.bitmap.close).toHaveBeenCalledTimes(1);
        expect(rec.encodes).toEqual([]);
        expect(rec.sides).toEqual([]);
    });

    it("is returned as it is when the browser cannot read it to measure it (the server takes it anyway)", async () => {
        vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("no")));
        vi.stubGlobal("Image", class { set src(_: string) { (this as { onerror?: () => void }).onerror?.(); } });
        const picture = file(300_000, "image/png");
        await expect(prepareContactPhoto(picture)).resolves.toBe(picture);
    });

    it("is never a JPEG the browser could not read to strip its metadata from: a JPEG may carry the place it was taken", async () => {
        vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("no")));
        vi.stubGlobal("Image", class { set src(_: string) { (this as { onerror?: () => void }).onerror?.(); } });
        await expect(prepareContactPhoto(file(300_000, "image/jpeg"))).rejects.toThrow(CONTACT_PHOTO_UNSUPPORTED_MESSAGE);
    });

    it("is drawn again and encoded when it is a small JPEG, which would otherwise keep its EXIF (camera, time, GPS position)", async () => {
        const rec = install({ width: 400, height: 300 });
        const picture = file(300_000, "image/jpeg", "me.jpg");
        const result = await prepareContactPhoto(picture);
        expect(result).not.toBe(picture);
        expect(result.type).toBe("image/jpeg");
        expect(rec.encodes[0]).toEqual({ type: "image/jpeg", quality: 0.85 });
        // Even one that says it is a PNG, if it is a JPEG in fact.
        const mislabeled = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 4, 0, 0])], "me.png", { type: "image/png" });
        expect(await prepareContactPhoto(mislabeled)).not.toBe(mislabeled);
    });
});

const bytes = (...parts: Array<number | string | number[]>): number[] =>
    parts.flatMap((part) => (typeof part === "string" ? Array.from(part, (c) => c.charCodeAt(0)) : Array.isArray(part) ? part : [part]));
const be16 = (n: number) => [n >> 8, n & 255];
const le16 = (n: number) => [n & 255, n >> 8];
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const pad = (head: number[], length = 64) => [...head, ...new Array(Math.max(0, length - head.length)).fill(0)];

/** The start of a picture of `width` x `height` as each format writes it - just enough for its size to be read. */
const HEADERS: Record<string, { type: string; header: (width: number, height: number) => number[] }> = {
    png: { type: "image/png", header: (w, h) => pad(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, be32(13), "IHDR", be32(w), be32(h))) },
    gif: { type: "image/gif", header: (w, h) => pad(bytes("GIF89a", le16(w), le16(h))) },
    jpeg: { type: "image/jpeg", header: (w, h) => pad(bytes(0xff, 0xd8, 0xff, 0xe0, be16(4), 0, 0, 0xff, 0xff, 0xc2, be16(11), 8, be16(h), be16(w), 3)) },
    "webp (lossy)": { type: "image/webp", header: (w, h) => pad(bytes("RIFF", 0, 0, 0, 0, "WEBP", "VP8 ", 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, le16(w), le16(h))) },
    "webp (lossless)": {
        type: "image/webp",
        header: (w, h) => {
            const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
            return pad(bytes("RIFF", 0, 0, 0, 0, "WEBP", "VP8L", 0, 0, 0, 0, 0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >> 24) & 255));
        },
    },
    "webp (extended)": { type: "image/webp", header: (w, h) => pad(bytes("RIFF", 0, 0, 0, 0, "WEBP", "VP8X", 0, 0, 0, 0, 0, 0, 0, 0, le24(w - 1), le24(h - 1))) },
};

describe("prepareContactPhoto: a picture whose size says it cannot be decoded safely", () => {
    for (const [name, { type, header }] of Object.entries(HEADERS)) {
        it(`refuses a small ${name} file that says it is 30000 x 30000 pixels, without decoding it`, async () => {
            const rec = install();
            const picture = new File([new Uint8Array(header(30000, 30000))], "bomb", { type });
            const failure = prepareContactPhoto(picture);
            await expect(failure).rejects.toBeInstanceOf(ContactPhotoError);
            await expect(failure).rejects.toThrow(CONTACT_PHOTO_TOO_LARGE_MESSAGE);
            expect(createImageBitmap).not.toHaveBeenCalled();
            expect(rec.sides).toEqual([]);
        });

        it(`decodes a ${name} file of 4000 x 3000 pixels (12 megapixels) as usual`, async () => {
            install({ width: 4000, height: 3000 });
            await expect(prepareContactPhoto(new File([new Uint8Array(header(4000, 3000))], "ok", { type }))).resolves.toBeInstanceOf(File);
            expect(createImageBitmap).toHaveBeenCalled();
        });
    }

    it("decodes a picture whose size it cannot read from its start, and a short or unknown one", async () => {
        install({ width: 4000, height: 3000 });
        const unknown: number[][] = [
            [],
            [0x89, 0x50],
            bytes("RIFF", 0, 0, 0, 0, "WEBP", "VP8 "), // cut off
            bytes("RIFF", 0, 0, 0, 0, "WEBP", "VP8Q", new Array(20).fill(0)), // a chunk that has no size
            bytes("RIFF", 0, 0, 0, 0, "WAVE", "fmt ", new Array(20).fill(0)),
            bytes(0xff, 0xd8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00), // not a marker
            bytes(0xff, 0xd8, 0xff),
            bytes(0xff, 0xd8, 0xff, 0xda, be16(4), 0, 0), // the scan starts before any size
            bytes(0xff, 0xd8, 0xff, 0xd0, 0xff, 0x01, 0xff, 0xe0, be16(2000), 0), // markers without a length, then a segment that runs past the end
            bytes(0xff, 0xd8, 0xff, 0xc4, be16(4), 0, 0, 0xff, 0xc0, be16(11), 8, be16(30000)), // cut off inside the size
            bytes("GIF8"),
        ];
        for (const head of unknown) {
            await expect(prepareContactPhoto(new File([new Uint8Array(head)], "x.png", { type: "image/png" }))).resolves.toBeInstanceOf(File);
        }
        expect(createImageBitmap).toHaveBeenCalledTimes(unknown.length);
    });
});

describe("prepareContactPhoto: a JPEG whose frame header lies past the start of the file", () => {
    // Three 64 KB application segments (an ICC profile, say) push the frame header beyond the 128 KB read at first.
    const bigSegments = () => Array.from({ length: 3 }, () => bytes(0xff, 0xe2, be16(0xffff), new Array(0xffff - 2).fill(0))).flat();
    const frame = (w: number, h: number) => bytes(0xff, 0xc2, be16(11), 8, be16(h), be16(w), 3, 0, 0, 0);
    const jpegFile = (...parts: number[][]) => new File([new Uint8Array([0xff, 0xd8, ...parts.flat()])], "me.jpg", { type: "image/jpeg" });

    it("refuses one that says it is 30000 x 30000 pixels, without decoding it", async () => {
        install();
        const failure = prepareContactPhoto(jpegFile(bigSegments(), frame(30000, 30000)));
        await expect(failure).rejects.toThrow(CONTACT_PHOTO_TOO_LARGE_MESSAGE);
        expect(createImageBitmap).not.toHaveBeenCalled();
    });

    it("decodes one of 4000 x 3000 pixels as usual", async () => {
        install({ width: 4000, height: 3000 });
        await expect(prepareContactPhoto(jpegFile(bigSegments(), frame(4000, 3000)))).resolves.toBeInstanceOf(File);
    });

    it("gives up on the size, and leaves it to the decoder, after too many segments, a segment that is not one, or the end of the file", async () => {
        install({ width: 400, height: 300 });
        const tiny = Array.from({ length: 5000 }, () => [0xff, 0xe0, 0, 2]).flat();
        await expect(prepareContactPhoto(jpegFile(bigSegments(), tiny, frame(30000, 30000)))).resolves.toBeInstanceOf(File);
        await expect(prepareContactPhoto(jpegFile(bigSegments(), [0, 0, 0, 0, 0], frame(30000, 30000)))).resolves.toBeInstanceOf(File);
        await expect(prepareContactPhoto(jpegFile(bigSegments(), bytes(0xff, 0xe0, be16(5000), 0)))).resolves.toBeInstanceOf(File);
    });
});

describe("prepareContactPhoto: a picture whose size only the decoder knows", () => {
    it("is refused when what it decodes to has too many pixels, and the decoded bitmap is released", async () => {
        const rec = install({ width: 30000, height: 30000 });
        const bitmap = new File([new Uint8Array(bytes("BM", new Array(60).fill(0)))], "wide.bmp", { type: "image/bmp" });
        await expect(prepareContactPhoto(bitmap)).rejects.toThrow(CONTACT_PHOTO_TOO_LARGE_MESSAGE);
        expect(rec.bitmap.close).toHaveBeenCalledTimes(1);
        expect(rec.sides).toEqual([]);
    });
});

describe("prepareContactPhoto: a picture that has to change", () => {
    it("crops a landscape photo to the centered square, scales it to 512, applies EXIF orientation, and makes a JPEG on white", async () => {
        const rec = install({ width: 4000, height: 3000 });
        const result = await prepareContactPhoto(file(5 * MB, "image/jpeg", "IMG_0001.JPG"));

        expect(createImageBitmap).toHaveBeenCalledWith(expect.any(File), { imageOrientation: "from-image" });
        expect(rec.sides).toEqual([512]);
        // The 3000 px square from x = 500, onto 512 x 512 (drawn on white, so the first draw is for the transparency check and the last one is the JPEG's).
        expect(rec.context.drawImage).toHaveBeenLastCalledWith(rec.bitmap, 500, 0, 3000, 3000, 0, 0, 512, 512);
        expect(rec.context.fillStyle).toBe("#ffffff");
        expect(rec.context.fillRect).toHaveBeenCalledWith(0, 0, 512, 512);
        expect(rec.context.imageSmoothingQuality).toBe("high");
        expect(rec.encodes).toEqual([{ type: "image/jpeg", quality: 0.85 }]);
        expect(result.type).toBe("image/jpeg");
        expect(result.name).toBe("IMG_0001.jpg");
        expect(result.size).toBeLessThanOrEqual(CONTACT_PHOTO_MAX_BYTES);
        expect(rec.bitmap.close).toHaveBeenCalledTimes(1);
    });

    it("crops a portrait photo from the vertical center", async () => {
        const rec = install({ width: 3000, height: 4000 });
        await prepareContactPhoto(file(3 * MB, "image/jpeg"));
        expect(rec.context.drawImage).toHaveBeenLastCalledWith(rec.bitmap, 0, 500, 3000, 3000, 0, 0, 512, 512);
    });

    it("crops a picture that is only oversized in pixels, and never enlarges a small one", async () => {
        const huge = install({ width: 2000, height: 1500 });
        await prepareContactPhoto(file(200_000, "image/png", "big.png"));
        expect(huge.sides).toEqual([512]);

        const small = install({ width: 300, height: 200 });
        const result = await prepareContactPhoto(file(2 * MB, "image/png", "small.png"));
        expect(small.sides).toEqual([200]);
        expect(small.context.drawImage).toHaveBeenLastCalledWith(small.bitmap, 50, 0, 200, 200, 0, 0, 200, 200);
        expect(result.type).toBe("image/jpeg");
        expect(result.name).toBe("small.jpg");
    });

    it("lowers the JPEG quality step by step until it fits", async () => {
        const rec = install({ encoded: (_type, quality) => (quality! > 0.65 ? 2 * MB : 400_000) });
        const result = await prepareContactPhoto(file(5 * MB, "image/jpeg"));
        expect(rec.encodes.map((e) => e.quality)).toEqual([0.85, 0.75, 0.65]);
        expect(result.size).toBe(400_000);
    });

    it("says so when even the lowest quality is too large, and still frees the bitmap", async () => {
        const rec = install({ encoded: () => 2 * MB });
        const failure = prepareContactPhoto(file(5 * MB, "image/jpeg"));
        await expect(failure).rejects.toBeInstanceOf(ContactPhotoError);
        await expect(failure).rejects.toThrow(CONTACT_PHOTO_TOO_LARGE_MESSAGE);
        expect(rec.encodes).toHaveLength(6);
        expect(rec.bitmap.close).toHaveBeenCalledTimes(1);
    });

    it("keeps a transparent PNG as a PNG, and a transparent WebP as WebP, when they fit; a GIF becomes a PNG", async () => {
        const png = install({ transparent: true });
        const kept = await prepareContactPhoto(file(2 * MB, "image/png", "logo.png"));
        expect(png.encodes).toEqual([{ type: "image/png", quality: undefined }]);
        expect(kept.type).toBe("image/png");
        expect(kept.name).toBe("logo.png");
        expect(png.context.fillRect).not.toHaveBeenCalled();

        const webp = install({ transparent: true });
        const keptWebp = await prepareContactPhoto(file(2 * MB, "image/webp", "logo.webp"));
        expect(webp.encodes[0].type).toBe("image/webp");
        expect(keptWebp.type).toBe("image/webp");
        expect(keptWebp.name).toBe("logo.webp");

        const gif = install({ transparent: true });
        const keptGif = await prepareContactPhoto(file(2 * MB, "image/gif", "spin.gif"));
        expect(gif.encodes[0].type).toBe("image/png");
        expect(keptGif.name).toBe("spin.png");
    });

    it("takes the type a browser really encoded when it cannot do WebP (it answers with PNG), or the requested one when it names none", async () => {
        install({ transparent: true, encoded: () => ({ size: 1000, type: "image/png" }) });
        const fallback = await prepareContactPhoto(file(2 * MB, "image/webp", "logo.webp"));
        expect(fallback.type).toBe("image/png");
        expect(fallback.name).toBe("logo.png");

        install({ transparent: true, encoded: () => ({ size: 1000, type: "" }) });
        expect((await prepareContactPhoto(file(2 * MB, "image/png", "logo.png"))).type).toBe("image/png");
    });

    it("makes a JPEG on white from a transparent PNG too large to keep, and from an opaque one", async () => {
        const rec = install({ transparent: true, encoded: (type) => (type === "image/png" ? 2 * MB : 300_000) });
        const result = await prepareContactPhoto(file(3 * MB, "image/png", "logo.png"));
        expect(rec.encodes.map((e) => e.type)).toEqual(["image/png", "image/jpeg"]);
        expect(rec.context.clearRect).toHaveBeenCalledWith(0, 0, 512, 512);
        expect(rec.context.fillRect).toHaveBeenCalledWith(0, 0, 512, 512);
        expect(result.type).toBe("image/jpeg");
        expect(result.name).toBe("logo.jpg");

        const opaque = install({ transparent: false });
        await prepareContactPhoto(file(3 * MB, "image/png", "photo.png"));
        expect(opaque.encodes.map((e) => e.type)).toEqual(["image/jpeg"]);
    });

    it("names a picture without a usable name 'photo', and one without an extension by its name", async () => {
        install();
        expect((await prepareContactPhoto(file(3 * MB, "image/jpeg", ".jpeg"))).name).toBe("photo.jpg");
        expect((await prepareContactPhoto(file(3 * MB, "image/jpeg", "camera"))).name).toBe("camera.jpg");
    });

    it("works with a plain canvas element when there is no OffscreenCanvas", async () => {
        const rec = install({ offscreen: false });
        const result = await prepareContactPhoto(file(3 * MB, "image/jpeg"));
        expect(rec.encodes).toEqual([{ type: "image/jpeg", quality: 0.85 }]);
        expect(result.type).toBe("image/jpeg");
        expect(rec.context.drawImage).toHaveBeenCalled();
    });

    it("rejects as unsupported when the canvas cannot be drawn on, or cannot encode", async () => {
        install({ offscreen: false });
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => null) as never);
        await expect(prepareContactPhoto(file(3 * MB, "image/jpeg"))).rejects.toThrow(CONTACT_PHOTO_UNSUPPORTED_MESSAGE);

        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        install();
        vi.stubGlobal(
            "OffscreenCanvas",
            class {
                getContext() {
                    return null;
                }
            },
        );
        await expect(prepareContactPhoto(file(3 * MB, "image/jpeg"))).rejects.toThrow(CONTACT_PHOTO_UNSUPPORTED_MESSAGE);

        install({ encoded: () => null });
        await expect(prepareContactPhoto(file(3 * MB, "image/jpeg"))).rejects.toThrow(CONTACT_PHOTO_UNSUPPORTED_MESSAGE);
    });
});

describe("prepareContactPhoto: a picture the browser cannot decode", () => {
    function stubImage(outcome: "load" | "error", size = { naturalWidth: 3000, naturalHeight: 4000 }) {
        class FakeImage {
            onload?: () => void;
            onerror?: () => void;
            naturalWidth = size.naturalWidth;
            naturalHeight = size.naturalHeight;
            set src(_value: string) {
                queueMicrotask(() => (outcome === "load" ? this.onload?.() : this.onerror?.()));
            }
        }
        vi.stubGlobal("Image", FakeImage);
    }

    it("throws the friendly message for a HEIC picture", async () => {
        vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("unsupported")));
        stubImage("error");
        const failure = prepareContactPhoto(file(4 * MB, "image/heic", "IMG_0002.HEIC"));
        await expect(failure).rejects.toBeInstanceOf(ContactPhotoError);
        await expect(failure).rejects.toThrow("This picture's format isn't supported by your browser — choose a JPEG or PNG instead.");
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:src");
    });

    it("throws it for a picture of an accepted type that is too large to send as it is", async () => {
        stubImage("error");
        vi.stubGlobal("createImageBitmap", undefined);
        await expect(prepareContactPhoto(file(3 * MB, "image/jpeg"))).rejects.toThrow(CONTACT_PHOTO_UNSUPPORTED_MESSAGE);
    });

    it("decodes through an <img> when there is no createImageBitmap, or it cannot read the picture", async () => {
        const rec = install({ width: 0, height: 0 });
        stubImage("load");
        vi.stubGlobal("createImageBitmap", undefined);
        const result = await prepareContactPhoto(file(4 * MB, "image/heic", "IMG_0003.heic"));
        expect(result.type).toBe("image/jpeg");
        expect(result.name).toBe("IMG_0003.jpg");
        expect(rec.context.drawImage).toHaveBeenLastCalledWith(expect.anything(), 0, 500, 3000, 3000, 0, 0, 512, 512);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:src");

        vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("no")));
        const again = await prepareContactPhoto(file(4 * MB, "image/heic", "IMG_0004.heic"));
        expect(again.type).toBe("image/jpeg");
    });

    it("measures an accepted picture through an <img> too, and returns it as it is when it is small enough", async () => {
        stubImage("load", { naturalWidth: 800, naturalHeight: 600 });
        vi.stubGlobal("createImageBitmap", undefined);
        const picture = file(100_000, "image/png");
        await expect(prepareContactPhoto(picture)).resolves.toBe(picture);
    });
});
