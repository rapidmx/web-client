// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { fromBase64, fromBase64Url, toBase64, toBase64Url } from "../../../lib/crypto/encoding.js";

describe("toBase64 / fromBase64", () => {
    it.each([0, 1, 2, 3, 4, 15, 16, 17])("round-trips %i random bytes", (length) => {
        const bytes = crypto.getRandomValues(new Uint8Array(length));
        expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    });
});

describe("toBase64Url / fromBase64Url", () => {
    // Byte lengths chosen to exercise every base64 padding remainder (0, 1, 2 padding chars stripped),
    // which is what determines whether fromBase64Url() needs to re-add "=" padding before decoding.
    it.each([3, 4, 5, 6, 7])("round-trips %i random bytes with no unsafe base64 characters", (length) => {
        const bytes = crypto.getRandomValues(new Uint8Array(length));
        const encoded = toBase64Url(bytes);
        expect(encoded).not.toMatch(/[+/=]/);
        expect(fromBase64Url(encoded)).toEqual(bytes);
    });

    it("round-trips a length that needs no padding restored (multiple of 3 bytes)", () => {
        const bytes = crypto.getRandomValues(new Uint8Array(12));
        expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    });

    it("round-trips an empty input", () => {
        expect(fromBase64Url(toBase64Url(new Uint8Array(0)))).toEqual(new Uint8Array(0));
    });
});
