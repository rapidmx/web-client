///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { isFileDrag, isInlineImage } from "../../../apps/shared/components/mail/compose/dropFiles.js";

describe("isInlineImage", () => {
    it.each(["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/avif"])("puts a %s file into the message", (type) => {
        expect(isInlineImage({ name: "x", type })).toBe(true);
    });

    it.each(["application/pdf", "text/plain", "application/octet-stream", "video/mp4"])("attaches a %s file", (type) => {
        expect(isInlineImage({ name: "x.png", type })).toBe(false);
    });

    it("goes by the name when the browser gave no type", () => {
        expect(isInlineImage({ name: "scan.PNG", type: "" })).toBe(true);
        expect(isInlineImage({ name: "photo.jpeg", type: "" })).toBe(true);
        expect(isInlineImage({ name: "logo.svg", type: "" })).toBe(true);
        expect(isInlineImage({ name: "report.pdf", type: "" })).toBe(false);
        expect(isInlineImage({ name: "png", type: "" })).toBe(false);
    });
});

describe("isFileDrag", () => {
    it("is a drag that carries files", () => {
        expect(isFileDrag({ types: ["Files"] })).toBe(true);
        expect(isFileDrag({ types: ["text/plain", "Files"] })).toBe(true);
    });

    it("is not a drag of text or nothing at all", () => {
        expect(isFileDrag({ types: ["text/plain", "text/html"] })).toBe(false);
        expect(isFileDrag({ types: [] })).toBe(false);
        expect(isFileDrag(null)).toBe(false);
        expect(isFileDrag(undefined)).toBe(false);
    });
});
