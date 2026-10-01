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

    it("returns the markup as given where there is no DOM to parse it with", async () => {
        vi.stubGlobal("DOMParser", undefined);
        expect(await embedQuotedImages('<img src="cid:a@x">', async () => PNG)).toBe('<img src="cid:a@x">');
    });
});
