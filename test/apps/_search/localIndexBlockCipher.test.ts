// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Real WebCrypto, not jsdom's shim - web-client's vitest.config.ts defaults every test file to jsdom
// (the inverse of react-shared's own default), so this file opts back out via the pragma above,
// matching react-shared's own convention for exercising real AEAD crypto (see e.g. its
// crypto/masterKey.test.ts) rather than whatever jsdom happens to implement for crypto.subtle.
import { describe, expect, it } from "vitest";
import {
    LOGICAL_BLOCK_SIZE,
    PHYSICAL_BLOCK_SIZE,
    PageCorruptedError,
    decryptBlock,
    encryptBlock,
    importAesGcmKey,
} from "../../../apps/shared/search/localIndexBlockCipher.js";

function randomKey(): Promise<CryptoKey> {
    return importAesGcmKey(crypto.getRandomValues(new Uint8Array(32)));
}

function randomPlaintext(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(LOGICAL_BLOCK_SIZE));
}

describe("localIndexBlockCipher", () => {
    it("round-trips a block byte-for-byte through encrypt then decrypt", async () => {
        const key = await randomKey();
        const plaintext = randomPlaintext();

        const physical = await encryptBlock(key, "index.db", 3, plaintext);
        const decrypted = await decryptBlock(key, "index.db", 3, physical);

        expect(physical.length).toBe(PHYSICAL_BLOCK_SIZE);
        expect(decrypted).toEqual(plaintext);
    });

    it("produces a different physical block on every encryption of identical plaintext (random nonce, never reused)", async () => {
        const key = await randomKey();
        const plaintext = randomPlaintext();

        const first = await encryptBlock(key, "index.db", 0, plaintext);
        const second = await encryptBlock(key, "index.db", 0, plaintext);

        expect(first).not.toEqual(second);
        // Both must still decrypt back to the same plaintext despite differing on disk.
        expect(await decryptBlock(key, "index.db", 0, first)).toEqual(plaintext);
        expect(await decryptBlock(key, "index.db", 0, second)).toEqual(plaintext);
    });

    it("throws PageCorruptedError, not a raw DOMException, when the ciphertext is tampered with", async () => {
        const key = await randomKey();
        const physical = await encryptBlock(key, "index.db", 5, randomPlaintext());
        physical[physical.length - 1] ^= 0xff; // flip a bit inside the GCM tag/ciphertext region

        await expect(decryptBlock(key, "index.db", 5, physical)).rejects.toBeInstanceOf(PageCorruptedError);
    });

    it("throws PageCorruptedError when the nonce is tampered with", async () => {
        const key = await randomKey();
        const physical = await encryptBlock(key, "index.db", 5, randomPlaintext());
        physical[0] ^= 0xff; // flip a bit inside the 12-byte nonce

        await expect(decryptBlock(key, "index.db", 5, physical)).rejects.toBeInstanceOf(PageCorruptedError);
    });

    it("throws PageCorruptedError when decrypting with the wrong key", async () => {
        const physical = await encryptBlock(await randomKey(), "index.db", 5, randomPlaintext());

        await expect(decryptBlock(await randomKey(), "index.db", 5, physical)).rejects.toBeInstanceOf(PageCorruptedError);
    });

    it("throws PageCorruptedError when a block is moved to a different block index (position binding)", async () => {
        // Simulates an attacker (or a bug) relocating a valid, otherwise-untampered physical block to a
        // different position in the file - GCM alone authenticates the block's own bytes, not where it
        // sits, so this only fails because the AAD binds each block to its own index.
        const key = await randomKey();
        const physical = await encryptBlock(key, "index.db", 5, randomPlaintext());

        await expect(decryptBlock(key, "index.db", 6, physical)).rejects.toBeInstanceOf(PageCorruptedError);
    });

    it("throws PageCorruptedError when a block is moved to a different filename (position binding)", async () => {
        const key = await randomKey();
        const physical = await encryptBlock(key, "index.db", 5, randomPlaintext());

        await expect(decryptBlock(key, "other.db", 5, physical)).rejects.toBeInstanceOf(PageCorruptedError);
    });
});
