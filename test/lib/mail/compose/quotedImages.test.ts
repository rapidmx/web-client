// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_QUOTED_IMAGES_CHARS, embedQuotedImages } from "../../../../lib/mail/compose/quotedImages.js";

const PNG = "data:image/png;base64,iVBORw==";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("embedQuotedImages", () => {
    it("replaces an image that names a part by cid:, and one with no source at all, by what the resolver gives", async () => {
        const resolve = vi.fn(async (reference: { cid?: string; alt?: string }) => (reference.cid === "logo@x" || reference.alt === "shot.png" ? PNG : undefined));

        const html = await embedQuotedImages('<p>Hi</p><img src="cid:logo@x" alt="logo"><img alt="shot.png"><img src="cid:gone@x">', resolve);

        expect(html).toBe(`<p>Hi</p><img src="${PNG}" alt="logo"><img alt="shot.png" src="${PNG}"><img src="cid:gone@x">`);
        expect(resolve.mock.calls.map(([reference]) => reference)).toEqual([
            { cid: "logo@x", alt: "logo" },
            { alt: "shot.png" },
            { cid: "gone@x", alt: undefined },
        ]);
    });

    it("does not ask about an image that already carries its picture, or one that is remote", async () => {
        const resolve = vi.fn(async () => PNG);
        const html = `<img src="${PNG}"><img src="https://example.com/a.png">`;
        expect(await embedQuotedImages(html, resolve)).toBe(html);
        expect(resolve).not.toHaveBeenCalled();
    });

    it("returns the markup as given when there is no image, or nothing to put in one", async () => {
        const resolve = vi.fn(async () => undefined);
        expect(await embedQuotedImages("<p>No pictures</p>", resolve)).toBe("<p>No pictures</p>");
        expect(await embedQuotedImages('<img src="cid:a@x">', resolve)).toBe('<img src="cid:a@x">');
        expect(resolve).toHaveBeenCalledTimes(1);
    });

    it("stops carrying pictures once their total would be more than a message should hold", async () => {
        const huge = `data:image/png;base64,${"A".repeat(MAX_QUOTED_IMAGES_CHARS - 40)}`;
        const resolve = vi.fn(async (reference: { cid?: string }) => (reference.cid === "a" ? huge : PNG));
        const html = await embedQuotedImages('<img src="cid:a"><img src="cid:b">', resolve);
        expect(html).toContain(huge);
        expect(html).toContain('<img src="cid:b">');
    });

    it("resolves several images at once, but never more than four", async () => {
        let running = 0;
        let peak = 0;
        const resolve = vi.fn(async () => {
            running++;
            peak = Math.max(peak, running);
            await new Promise((done) => setTimeout(done, 5));
            running--;
            return PNG;
        });
        const html = await embedQuotedImages(Array.from({ length: 9 }, (_, n) => `<img src="cid:i${n}">`).join(""), resolve);
        expect(resolve).toHaveBeenCalledTimes(9);
        expect(peak).toBe(4);
        expect(html.match(/data:image\/png/g)).toHaveLength(9);
    });

    it("keeps the pictures that arrived before the deadline, and does not wait for the rest", async () => {
        const controller = new AbortController();
        const seen: (AbortSignal | undefined)[] = [];
        const resolve = vi.fn((reference: { cid?: string }, signal?: AbortSignal) => {
            seen.push(signal);
            return reference.cid === "fast" ? Promise.resolve(PNG) : new Promise<string | undefined>(() => undefined);
        });
        const result = embedQuotedImages('<img src="cid:fast"><img src="cid:slow1"><img src="cid:slow2">', resolve, controller.signal);
        await new Promise((done) => setTimeout(done, 10));
        controller.abort();
        expect(await result).toBe(`<img src="${PNG}"><img src="cid:slow1"><img src="cid:slow2">`);
        expect(seen.every((signal) => signal === controller.signal)).toBe(true);
    });

    it("starts nothing once the deadline has passed", async () => {
        const controller = new AbortController();
        controller.abort();
        const resolve = vi.fn(async () => PNG);
        expect(await embedQuotedImages('<img src="cid:a"><img src="cid:b">', resolve, controller.signal)).toBe('<img src="cid:a"><img src="cid:b">');
        expect(resolve).not.toHaveBeenCalled();
    });

    it("leaves an image as it is when its resolver fails, and carries the others", async () => {
        const resolve = vi.fn(async (reference: { cid?: string }) => {
            if (reference.cid === "bad") throw new Error("boom");
            return PNG;
        });
        expect(await embedQuotedImages('<img src="cid:bad"><img src="cid:ok">', resolve)).toBe(`<img src="cid:bad"><img src="${PNG}">`);
    });

    it("spends the size budget in document order however the pictures arrive", async () => {
        const huge = `data:image/png;base64,${"A".repeat(MAX_QUOTED_IMAGES_CHARS - 40)}`;
        const resolve = vi.fn(async (reference: { cid?: string }) => {
            if (reference.cid === "a") await new Promise((done) => setTimeout(done, 10));
            return reference.cid === "a" ? huge : PNG;
        });
        const html = await embedQuotedImages('<img src="cid:a"><img src="cid:b">', resolve);
        expect(html).toContain(huge);
        expect(html).toContain('<img src="cid:b">');
    });

    it("returns the markup as given where there is no DOM to parse it with", async () => {
        vi.stubGlobal("DOMParser", undefined);
        expect(await embedQuotedImages('<img src="cid:a@x">', async () => PNG)).toBe('<img src="cid:a@x">');
    });
});
