// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { toBase64 } from "../../../lib/crypto/encoding.js";
import { base32Encode, deriveFromRecoveryCode, generateRecoveryCode, normalizeRecoveryCode } from "../../../lib/crypto/recoveryCode.js";

describe("base32Encode", () => {
    it("encodes an input whose bit length is an exact multiple of 5 with no leftover bits", () => {
        // 20 bytes = 160 bits = exactly 32 five-bit groups - generateRecoveryCode()'s own input size,
        // and the only shape reachable through the public API.
        expect(base32Encode(new Uint8Array(20)).length).toBe(32);
    });

    it("encodes an input with leftover bits, padding the final group", () => {
        // 3 bytes = 24 bits = 4 full 5-bit groups (20 bits) + 4 leftover bits, padded to a 5th character.
        const encoded = base32Encode(new Uint8Array(3));
        expect(encoded.length).toBe(5);
    });
});

describe("generateRecoveryCode", () => {
    it("produces a dash-grouped, Crockford-base32-alphabet code", () => {
        const code = generateRecoveryCode();
        expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4})+$/);
    });

    it("differs between calls", () => {
        expect(generateRecoveryCode()).not.toBe(generateRecoveryCode());
    });
});

describe("deriveFromRecoveryCode", () => {
    it("is deterministic for the same code/salt", async () => {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const code = generateRecoveryCode();
        const a = await deriveFromRecoveryCode(code, salt);
        const b = await deriveFromRecoveryCode(code, salt);
        expect(toBase64(a)).toBe(toBase64(b));
    });

    it("is case- and whitespace-insensitive (so a user retyping it still unlocks)", async () => {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const code = generateRecoveryCode();
        const canonical = await deriveFromRecoveryCode(code, salt);
        const retyped = await deriveFromRecoveryCode(` ${code.toLowerCase()} `, salt);
        expect(toBase64(retyped)).toBe(toBase64(canonical));
    });

    it("derives exactly the pre-normalization key for a generated code (existing wraps keep unlocking)", async () => {
        const { hkdfDerive } = await import("../../../lib/crypto/masterKey.js");
        const salt = crypto.getRandomValues(new Uint8Array(16));
        for (let i = 0; i < 20; i++) {
            const code = generateRecoveryCode();
            expect(normalizeRecoveryCode(code)).toBe(code);
            // The original derivation hashed `code.trim().toUpperCase()` - i.e. the dashed form verbatim.
            const legacy = await hkdfDerive(new TextEncoder().encode(code), salt, "wrap");
            expect(toBase64(await deriveFromRecoveryCode(code, salt))).toBe(toBase64(legacy));
        }
    });

    it("derives the same key for lowercase, spaced, dash-less, and O/I/L-transcribed variants", async () => {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        // A fixed code containing 0 and 1 so the O/I/L aliases are actually exercised.
        const code = "0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ";
        const canonical = toBase64(await deriveFromRecoveryCode(code, salt));
        const variants = [
            code.toLowerCase(),
            code.replace(/-/g, ""),
            code.replace(/-/g, " "),
            ` ${code.replace(/-/g, " - ")}\n`,
            code.replace("0", "O").replace("1", "I"),
            code.replace("0", "o").replace("1", "l"),
            "O L23-4567 89ab cdefGHJKMNPQRSTVWXYZ",
        ];
        for (const variant of variants) {
            expect(normalizeRecoveryCode(variant)).toBe(code);
            expect(toBase64(await deriveFromRecoveryCode(variant, salt))).toBe(canonical);
        }
    });

    it("produces different keys for different codes, same salt", async () => {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const a = await deriveFromRecoveryCode(generateRecoveryCode(), salt);
        const b = await deriveFromRecoveryCode(generateRecoveryCode(), salt);
        expect(toBase64(a)).not.toBe(toBase64(b));
    });

    it("produces a key usable to seal/open with masterKey.ts", async () => {
        const { sealWithKey, openWithKey, buildAad } = await import("../../../lib/crypto/masterKey.js");
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key = await deriveFromRecoveryCode(generateRecoveryCode(), salt);
        const aad = buildAad("mb1", "mk-wrap:recovery");
        const sealed = await sealWithKey(key, new TextEncoder().encode("mk bytes"), aad);
        const opened = await openWithKey(key, sealed, aad);
        expect(new TextDecoder().decode(opened)).toBe("mk bytes");
    });
});
