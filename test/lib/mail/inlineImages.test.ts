///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    bytesToBase64,
    findInlineAttachment,
    newContentId,
    normalizeContentId,
    parseDataImage,
    toDataUri,
} from "../../../lib/mail/inlineImages.js";

describe("normalizeContentId", () => {
    it("drops the angle brackets, percent-encoding and case that two references to one part may differ in", () => {
        expect(normalizeContentId(" <Image001@X.test> ")).toBe("image001@x.test");
        expect(normalizeContentId("image%40x.test")).toBe("image@x.test");
        expect(normalizeContentId("a b")).toBe("a b");
    });

    it("takes a token that is not valid percent-encoding as written", () => {
        expect(normalizeContentId("100%@x")).toBe("100%@x");
    });
});

describe("findInlineAttachment", () => {
    const logo = { uid: "a1", filename: "logo.png", mimeType: "image/png", contentId: "Logo@X" };
    const shot = { uid: "a2", filename: "Screenshot 2025-12-02 223133.png", mimeType: "image/png" };
    const notes = { uid: "a3", filename: "notes.pdf", mimeType: "application/pdf" };
    const all = [logo, shot, notes];

    it("finds the part whose Content-ID the reference names, whatever the brackets, encoding or case", () => {
        expect(findInlineAttachment(all, { cid: "logo@x" })).toBe(logo);
        expect(findInlineAttachment(all, { cid: "<LOGO%40x>" })).toBe(logo);
    });

    it("finds nothing without attachments", () => {
        expect(findInlineAttachment(undefined, { cid: "logo@x", alt: "logo.png" })).toBeUndefined();
    });

    it("finds an image attached without a Content-ID by the file name its alt text carries (a form-encoded name included)", () => {
        expect(findInlineAttachment(all, { alt: "Screenshot 2025-12-02 223133.png" })).toBe(shot);
        expect(findInlineAttachment(all, { alt: "screenshot+2025-12-02+223133.png" })).toBe(shot);
        expect(findInlineAttachment(all, { alt: "Screenshot%202025-12-02%20223133.png" })).toBe(shot);
        // A cid that names no part falls back to the alt text too.
        expect(findInlineAttachment(all, { cid: "unknown@x", alt: "logo.png" })).toBe(logo);
    });

    it("does not guess: not by the alt text of a file that is not an image, an alt that names two files, or none at all", () => {
        expect(findInlineAttachment(all, { alt: "notes.pdf" })).toBeUndefined();
        expect(findInlineAttachment([shot, { ...shot, uid: "a4" }], { alt: shot.filename })).toBeUndefined();
        expect(findInlineAttachment(all, { alt: "other.png" })).toBeUndefined();
        expect(findInlineAttachment(all, { alt: "   " })).toBeUndefined();
        expect(findInlineAttachment(all, {})).toBeUndefined();
        expect(findInlineAttachment(all, { cid: "unknown@x" })).toBeUndefined();
        // A part without a Content-ID is not matched by one.
        expect(findInlineAttachment([shot], { cid: "x" })).toBeUndefined();
    });

    it("takes an alt that is not valid percent-encoding as written", () => {
        const odd = { uid: "a5", filename: "100%.png", mimeType: "image/png" };
        expect(findInlineAttachment([odd], { alt: "100%.png" })).toBe(odd);
    });
});

describe("data URIs", () => {
    it("encodes bytes in slices, and decodes them back", () => {
        const big = new Uint8Array(70_000).map((_, i) => i % 251);
        const uri = toDataUri("image/jpeg", big);
        expect(uri.startsWith("data:image/jpeg;base64,")).toBe(true);
        expect(bytesToBase64(new Uint8Array([137, 80, 78, 71]))).toBe("iVBORw==");
        expect(parseDataImage(uri)).toEqual({ contentType: "image/jpeg", bytes: big });
    });

    it("reads only a base64 image", () => {
        expect(parseDataImage(" data:IMAGE/PNG;base64,iVBO\nRw== ")).toEqual({ contentType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) });
        expect(parseDataImage("data:text/html;base64,PGI+")).toBeUndefined();
        expect(parseDataImage("data:image/png,raw")).toBeUndefined();
        expect(parseDataImage("data:image/png;base64,a")).toBeUndefined();
        expect(parseDataImage("https://example.com/a.png")).toBeUndefined();
    });

    it("gives every image its own Content-ID", () => {
        expect(newContentId()).toMatch(/^[0-9a-f-]{36}@inline\.rapidmx$/);
        expect(newContentId()).not.toBe(newContentId());
    });
});
