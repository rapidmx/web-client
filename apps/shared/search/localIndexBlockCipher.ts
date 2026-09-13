///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The actual AES-256-GCM block cipher `localIndexVFS.ts`'s `EncryptingVFS` uses to encrypt/decrypt one
 * physical storage block - deliberately split out from that file so it can be exercised with real
 * WebCrypto in a plain unit test, with no OPFS/Worker/wa-sqlite involved at all (none of those are
 * available under Vitest's jsdom environment, matching the same "node" test environment convention
 * `react-shared`'s other crypto modules already use for exactly this reason).
 *
 * See `localIndexVFS.ts`'s own doc comment for the full design rationale (page layout, why a fresh
 * random nonce per write, why AAD binds to filename+block index). This module is pure mechanism; that
 * one is where the design is explained.
 */

/** The logical SQLite page size `EncryptingVFS` is designed for - MUST match the `PRAGMA page_size` the
 * database was created with (`localIndexWorker.ts` sets this before the first write). */
export const LOGICAL_BLOCK_SIZE = 4096;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
/** One physical block on disk: `nonce || ciphertext || tag`. */
export const PHYSICAL_BLOCK_SIZE = LOGICAL_BLOCK_SIZE + NONCE_LENGTH + TAG_LENGTH;

/** Thrown when a stored block fails AES-GCM authentication - a wrong/rotated key, on-disk corruption, or
 * a block moved to the wrong position (see `localIndexVFS.ts`'s doc comment on why AAD binds position).
 * The worker's caller treats this identically to a schema-version mismatch: discard the whole index and
 * rebuild (spec §11 "Invalidation"). */
export class PageCorruptedError extends Error {
    /** The underlying `DOMException`/error `crypto.subtle.decrypt()` threw, or an inner-VFS read failure
     * - kept as a plain field rather than the ES2022 `Error` constructor's `cause` option, since
     * web-client's `tsconfig.json` targets ES2020. */
    readonly cause: unknown;

    constructor(filename: string, blockIndex: number, cause: unknown) {
        super(`Local search index block ${blockIndex} of '${filename}' failed to decrypt.`);
        this.cause = cause;
    }
}

export async function importAesGcmKey(rawKey: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey("raw", rawKey as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function buildBlockAad(filename: string, blockIndex: number): Uint8Array {
    return new TextEncoder().encode(`rapidmx-local-index-block:${filename}:${blockIndex}`);
}

/** Encrypts one logical block (`plaintext`, exactly `LOGICAL_BLOCK_SIZE` bytes) into its physical,
 * on-disk representation (`PHYSICAL_BLOCK_SIZE` bytes: a fresh random nonce followed by
 * ciphertext+tag). */
export async function encryptBlock(key: CryptoKey, filename: string, blockIndex: number, plaintext: Uint8Array): Promise<Uint8Array> {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
    const ciphertextAndTag = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: nonce as BufferSource, additionalData: buildBlockAad(filename, blockIndex) as BufferSource },
            key,
            plaintext as BufferSource,
        ),
    );
    const physical = new Uint8Array(PHYSICAL_BLOCK_SIZE);
    physical.set(nonce, 0);
    physical.set(ciphertextAndTag, NONCE_LENGTH);
    return physical;
}

/** Inverse of `encryptBlock()`. Throws `PageCorruptedError` (never a raw `DOMException`) on auth
 * failure - a wrong key, tampered ciphertext, or a block swapped into the wrong position (caught by the
 * position-bound AAD not matching). */
export async function decryptBlock(key: CryptoKey, filename: string, blockIndex: number, physical: Uint8Array): Promise<Uint8Array> {
    const nonce = physical.subarray(0, NONCE_LENGTH);
    const ciphertextAndTag = physical.subarray(NONCE_LENGTH, PHYSICAL_BLOCK_SIZE);
    try {
        const plaintext = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: nonce as BufferSource, additionalData: buildBlockAad(filename, blockIndex) as BufferSource },
            key,
            ciphertextAndTag as BufferSource,
        );
        return new Uint8Array(plaintext);
    } catch (err) {
        throw new PageCorruptedError(filename, blockIndex, err);
    }
}
