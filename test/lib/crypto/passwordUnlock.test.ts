// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { toBase64 } from "../../../lib/crypto/encoding.js";
import {
    DEFAULT_ARGON2ID_PARAMS,
    argon2idKdfLabel,
    deriveFromPassword,
    generateSalt,
    parseArgon2idKdfLabel,
} from "../../../lib/crypto/passwordUnlock.js";

// Argon2id is intentionally slow (memory-hard) - use lighter parameters than the real default so this
// suite stays fast, while still exercising the real hash-wasm computation end to end.
const FAST_PARAMS = { memorySize: 8, iterations: 1, parallelism: 1 };

describe("parseArgon2idKdfLabel", () => {
    it("is the exact inverse of argon2idKdfLabel", () => {
        expect(parseArgon2idKdfLabel(argon2idKdfLabel(DEFAULT_ARGON2ID_PARAMS))).toEqual(DEFAULT_ARGON2ID_PARAMS);
        expect(parseArgon2idKdfLabel(argon2idKdfLabel(FAST_PARAMS))).toEqual(FAST_PARAMS);
    });

    it("returns undefined for a different KDF label entirely (e.g. recovery codes' own)", () => {
        expect(parseArgon2idKdfLabel("hkdf-sha256")).toBeUndefined();
    });

    it("returns undefined for a malformed label", () => {
        expect(parseArgon2idKdfLabel("argon2id:m=not-a-number,t=3,p=4")).toBeUndefined();
    });

    it("returns undefined for parameters a hostile server could use to exhaust the device", () => {
        expect(parseArgon2idKdfLabel("argon2id:m=4294967295,t=3,p=4")).toBeUndefined();
        expect(parseArgon2idKdfLabel("argon2id:m=65536,t=999,p=4")).toBeUndefined();
        expect(parseArgon2idKdfLabel("argon2id:m=65536,t=3,p=64")).toBeUndefined();
        expect(parseArgon2idKdfLabel("argon2id:m=0,t=3,p=4")).toBeUndefined();
        expect(parseArgon2idKdfLabel("argon2id:m=65536,t=0,p=4")).toBeUndefined();
        expect(parseArgon2idKdfLabel("argon2id:m=65536,t=3,p=0")).toBeUndefined();
        expect(parseArgon2idKdfLabel("argon2id:m=1048576,t=10,p=16")).toEqual({ memorySize: 1048576, iterations: 10, parallelism: 16 });
    });
});

describe("argon2idKdfLabel", () => {
    it("formats the kdf string", () => {
        expect(argon2idKdfLabel(DEFAULT_ARGON2ID_PARAMS)).toBe("argon2id:m=65536,t=3,p=4");
        expect(argon2idKdfLabel(FAST_PARAMS)).toBe("argon2id:m=8,t=1,p=1");
    });
});

describe("generateSalt", () => {
    it("defaults to 16 bytes and differs between calls", () => {
        const a = generateSalt();
        const b = generateSalt();
        expect(a.length).toBe(16);
        expect(toBase64(a)).not.toBe(toBase64(b));
    });

    it("respects a custom length", () => {
        expect(generateSalt(32).length).toBe(32);
    });
});

describe("deriveFromPassword", () => {
    it("is deterministic for the same password/salt/params", async () => {
        const salt = generateSalt();
        const a = await deriveFromPassword("correct horse battery staple", salt, FAST_PARAMS);
        const b = await deriveFromPassword("correct horse battery staple", salt, FAST_PARAMS);
        expect(a.authProof).toBe(b.authProof);
        expect(toBase64(a.wrappingKey)).toBe(toBase64(b.wrappingKey));
    });

    it("produces independent authProof and wrappingKey values", async () => {
        const salt = generateSalt();
        const { authProof, wrappingKey } = await deriveFromPassword("a password", salt, FAST_PARAMS);
        expect(authProof).not.toBe(toBase64(wrappingKey));
    });

    it("produces a different wrappingKey for a different password, same salt", async () => {
        const salt = generateSalt();
        const a = await deriveFromPassword("password one", salt, FAST_PARAMS);
        const b = await deriveFromPassword("password two", salt, FAST_PARAMS);
        expect(toBase64(a.wrappingKey)).not.toBe(toBase64(b.wrappingKey));
    });

    it("produces a different wrappingKey for the same password, different salt", async () => {
        const a = await deriveFromPassword("same password", generateSalt(), FAST_PARAMS);
        const b = await deriveFromPassword("same password", generateSalt(), FAST_PARAMS);
        expect(toBase64(a.wrappingKey)).not.toBe(toBase64(b.wrappingKey));
    });

    it("wrappingKey is usable to seal/open with masterKey.ts", async () => {
        const { sealWithKey, openWithKey, buildAad } = await import("../../../lib/crypto/masterKey.js");
        const salt = generateSalt();
        const { wrappingKey } = await deriveFromPassword("hunter2", salt, FAST_PARAMS);
        const aad = buildAad("mb1", "mk-wrap:password");
        const sealed = await sealWithKey(wrappingKey, new TextEncoder().encode("the master key bytes"), aad);
        const opened = await openWithKey(wrappingKey, sealed, aad);
        expect(new TextDecoder().decode(opened)).toBe("the master key bytes");
    });
});
