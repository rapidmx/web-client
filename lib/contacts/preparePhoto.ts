///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Gets a picture the user chose - a phone's camera photo is typically 2-8 MB, may be HEIC and carries an EXIF orientation - into what the server takes for a
 * contact's picture (JPEG, PNG, GIF or WebP, at most `CONTACT_PHOTO_MAX_BYTES`, checked by its magic bytes), in the browser, before it is uploaded.
 */
import { CONTACT_PHOTO_MAX_BYTES, CONTACT_PHOTO_TYPES } from "./contactsApi.js";

/** The longest side (in pixels) an accepted picture may have and still be sent as it is. */
export const CONTACT_PHOTO_MAX_SIDE = 1024;
/** The side (in pixels) of the square picture made from one that has to be changed - an avatar is shown at 72 pixels at most, 512 covers a high-density screen. */
export const CONTACT_PHOTO_OUTPUT_SIDE = 512;
/** JPEG qualities tried in turn until the picture fits `CONTACT_PHOTO_MAX_BYTES`. */
export const CONTACT_PHOTO_QUALITIES = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];

/** The most pixels (width x height) a picture may have to be decoded: a few kilobytes of PNG can say 30000 x 30000, which takes gigabytes of memory to decode. */
export const CONTACT_PHOTO_MAX_PIXELS = 16_000_000;
/** How much of the start of a picture is read to find its size: a JPEG's EXIF segment (up to 64 KB) comes before the size. */
const HEADER_BYTES = 128 * 1024;

export const CONTACT_PHOTO_UNSUPPORTED_MESSAGE = "This picture's format isn't supported by your browser — choose a JPEG or PNG instead.";
export const CONTACT_PHOTO_TOO_LARGE_MESSAGE = "This picture could not be made small enough — choose another one.";

/** Why a chosen picture cannot be used (a format the browser cannot decode, such as HEIC, or one that stays too large); its `message` is fit to show the user. */
export class ContactPhotoError extends Error {
    constructor(message: string = CONTACT_PHOTO_UNSUPPORTED_MESSAGE) {
        super(message);
        this.name = "ContactPhotoError";
    }
}

/** What the start of a picture says about it: whether it is a JPEG, and its size when that can be read from it. */
function inspect(head: Uint8Array): { jpeg: boolean; width?: number; height?: number } {
    const at = (offset: number, text: string) => Array.from(text).every((char, i) => head[offset + i] === char.charCodeAt(0));
    const be16 = (offset: number) => (head[offset] << 8) | head[offset + 1];
    const be32 = (offset: number) => be16(offset) * 65536 + be16(offset + 2);
    const le16 = (offset: number) => head[offset] | (head[offset + 1] << 8);
    const le24 = (offset: number) => le16(offset) | (head[offset + 2] << 16);
    const known = (width: number, height: number) => ({ jpeg: false, width, height });
    if (at(0, "\x89PNG\r\n\x1a\n") && head.length >= 24) {
        return known(be32(16), be32(20));
    }
    if (at(0, "GIF8") && head.length >= 10) {
        return known(le16(6), le16(8));
    }
    if (at(0, "RIFF") && at(8, "WEBP") && head.length >= 30) {
        if (at(12, "VP8 ")) {
            return known(le16(26) & 0x3fff, le16(28) & 0x3fff);
        }
        if (at(12, "VP8L")) {
            const bits = (le16(21) | (le16(23) << 16)) >>> 0;
            return known((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
        }
        if (at(12, "VP8X")) {
            return known(le24(24) + 1, le24(27) + 1);
        }
        return { jpeg: false };
    }
    if (!(head[0] === 0xff && head[1] === 0xd8)) {
        return { jpeg: false };
    }
    // A JPEG is a run of segments (`FF marker`, then a length unless the marker stands alone); the size is in the first frame header, "SOFn".
    let offset = 2;
    while (offset + 4 <= head.length) {
        if (head[offset] !== 0xff) {
            break;
        }
        const marker = head[offset + 1];
        if (marker === 0xff) {
            offset++;
        } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            offset += 2;
        } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return offset + 9 <= head.length ? { jpeg: true, width: be16(offset + 7), height: be16(offset + 5) } : { jpeg: true };
        } else if (marker === 0xda) {
            break;
        } else {
            offset += 2 + be16(offset + 2);
        }
    }
    return { jpeg: true };
}

interface Decoded {
    source: CanvasImageSource;
    width: number;
    height: number;
    /** Frees what holds the decoded pixels. */
    release: () => void;
}

/** Decodes with the orientation of the photo's EXIF applied, so a phone's sideways-stored picture comes out upright. */
async function decode(file: Blob): Promise<Decoded> {
    if (typeof createImageBitmap === "function") {
        try {
            const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
            return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
        } catch {
            // Fall through: an `<img>` may still read what this `createImageBitmap()` would not.
        }
    }
    // An `<img>` applies the EXIF orientation itself (`image-orientation: from-image` is the default).
    const url = URL.createObjectURL(file);
    try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
            const element = new Image();
            element.onload = () => resolve(element);
            element.onerror = () => reject(new ContactPhotoError());
            element.src = url;
        });
        return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => undefined };
    } finally {
        URL.revokeObjectURL(url);
    }
}

interface Surface {
    context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    encode: (type: string, quality?: number) => Promise<Blob | null>;
}

function createSurface(side: number): Surface {
    if (typeof OffscreenCanvas === "function") {
        const canvas = new OffscreenCanvas(side, side);
        const context = canvas.getContext("2d");
        if (!context) {
            throw new ContactPhotoError();
        }
        return { context, encode: (type, quality) => canvas.convertToBlob({ type, quality }) };
    }
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const context = canvas.getContext("2d");
    if (!context) {
        throw new ContactPhotoError();
    }
    return { context, encode: (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality)) };
}

function hasTransparency(context: Surface["context"], side: number): boolean {
    const { data } = context.getImageData(0, 0, side, side);
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) {
            return true;
        }
    }
    return false;
}

function renamed(name: string, extension: "jpg" | "png" | "webp"): string {
    return `${name.replace(/\.[^./\\]*$/, "") || "photo"}.${extension}`;
}

/**
 * The picture to upload for `file`. A picture the server already takes (an accepted type within the byte limit and at most `CONTACT_PHOTO_MAX_SIDE` pixels a
 * side) is returned as it is - an animated GIF stays animated - unless it is a JPEG, which is always drawn again to drop its EXIF. Anything else (a phone's 6 MB photo, a HEIC, a huge PNG) is decoded with its EXIF orientation applied,
 * cropped to the centered square - avatars are circular, so the corners are never seen - scaled down to at most `CONTACT_PHOTO_OUTPUT_SIDE` pixels and encoded as a
 * JPEG (transparent parts on white, quality lowered step by step until it fits), or kept as PNG/WebP when it has transparency and still fits.
 *
 * @throws ContactPhotoError when the browser cannot decode it (HEIC, or not a picture at all), it says it has more than `CONTACT_PHOTO_MAX_PIXELS` pixels
 * (it is not decoded at all then) or it cannot be made small enough.
 */
export async function prepareContactPhoto(file: File): Promise<File> {
    const accepted = CONTACT_PHOTO_TYPES.includes(file.type) && file.size <= CONTACT_PHOTO_MAX_BYTES;
    const head = inspect(new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer()));
    if (head.width !== undefined && head.height !== undefined && head.width * head.height > CONTACT_PHOTO_MAX_PIXELS) {
        throw new ContactPhotoError(CONTACT_PHOTO_TOO_LARGE_MESSAGE);
    }
    // A JPEG is always drawn again: its EXIF (the camera, the time, often where it was taken) would otherwise be uploaded and shown to whoever sees the contact.
    const jpeg = head.jpeg || file.type === "image/jpeg";
    let decoded: Decoded;
    try {
        decoded = await decode(file);
    } catch (err) {
        if (accepted && !jpeg) {
            // It cannot be measured here but the server takes it as it is.
            return file;
        }
        throw err;
    }
    try {
        const { source, width, height } = decoded;
        if (accepted && !jpeg && Math.max(width, height) <= CONTACT_PHOTO_MAX_SIDE) {
            return file;
        }
        const crop = Math.min(width, height);
        // Never enlarged: a small picture only gets cropped.
        const side = Math.min(crop, CONTACT_PHOTO_OUTPUT_SIDE);
        const { context, encode } = createSurface(side);
        const draw = () => {
            context.imageSmoothingQuality = "high";
            context.drawImage(source, (width - crop) / 2, (height - crop) / 2, crop, crop, 0, 0, side, side);
        };

        draw();
        if (["image/png", "image/webp", "image/gif"].includes(file.type) && hasTransparency(context, side)) {
            const type = file.type === "image/webp" ? "image/webp" : "image/png";
            const blob = await encode(type);
            if (blob && blob.size <= CONTACT_PHOTO_MAX_BYTES) {
                // A browser that cannot encode WebP answers with a PNG instead.
                const kept = blob.type || type;
                return new File([blob], renamed(file.name, kept === "image/webp" ? "webp" : "png"), { type: kept });
            }
            // Too large to keep the transparency: a JPEG has none, so what showed through becomes white.
            context.clearRect(0, 0, side, side);
        }
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, side, side);
        draw();
        for (const quality of CONTACT_PHOTO_QUALITIES) {
            const blob = await encode("image/jpeg", quality);
            if (!blob) {
                throw new ContactPhotoError();
            }
            if (blob.size <= CONTACT_PHOTO_MAX_BYTES) {
                return new File([blob], renamed(file.name, "jpg"), { type: "image/jpeg" });
            }
        }
        throw new ContactPhotoError(CONTACT_PHOTO_TOO_LARGE_MESSAGE);
    } finally {
        decoded.release();
    }
}
