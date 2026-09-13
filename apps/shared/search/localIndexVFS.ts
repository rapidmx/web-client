///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * `EncryptingVFS` - the Tier 2 local index's at-rest encryption layer (`specs/search.md` §11
 * "Persistence and protection", §13 "Encryption at Rest": "no official SQLCipher WASM build exists...
 * encryption at rest requires a custom VFS that encrypts pages before they reach OPFS").
 *
 * Wraps (composes, does not subclass - `AccessHandlePoolVFS`'s own file-table state is private `#`
 * fields) an `AccessHandlePoolVFS` instance and delegates every `FacadeVFS` method straight through
 * except `jRead`/`jWrite`, which it intercepts to decrypt/encrypt pages.
 *
 * ## Page layout
 *
 * SQLite is opened with a fixed 4096-byte page size (`PRAGMA page_size=4096` - set by
 * `localIndexWorker.ts` before the first write, since SQLite fixes a database's page size on creation).
 * Each *logical* 4096-byte page is stored *physically* as `nonce(12) || AES-256-GCM(ciphertext(4096) ||
 * tag(16))` = 4124 bytes, at a remapped offset (`physicalOffset(page) = page * 4124`). This block size
 * is this class's own fixed constant, independent of whatever byte range a given `jRead`/`jWrite` call
 * actually requests - reads/writes are handled generically over whichever physical blocks the requested
 * logical range overlaps (including a read-modify-write for a sub-block write), not by assuming SQLite
 * only ever issues page-aligned, page-sized I/O. That assumption holds for the *main database file* once
 * its page size is fixed, but handling the general case costs little and removes the need to rely on it.
 *
 * **A fresh random nonce is generated on every write, never reused or derived from a counter** - the
 * simplest way to make an AES-GCM (key, nonce) pair never repeat across different plaintexts, which is
 * the one hard requirement GCM has. The nonce travels with its block, so decryption never needs any
 * external state (a lost/corrupted counter, a persisted salt) to reconstruct it.
 *
 * **AAD binds each block to its logical filename and page index** (not just its own ciphertext) - GCM
 * authenticates a block's own content but not its *position*; without this, an attacker able to write
 * directly into this origin's OPFS storage (outside this codebase's own threat model per spec §4, which
 * excludes a compromised client, but cheap to close off anyway) could silently swap two blocks and each
 * would still decrypt "successfully" on its own, corrupting data instead of failing loudly. Binding to
 * position turns a swap into a caught decryption failure - see `PageCorruptedError` below - the same
 * "invalidate and rebuild" path a schema-version mismatch already takes (spec §11 "Invalidation").
 *
 * **No WAL, no rollback journal.** `localIndexWorker.ts` opens the database with `journal_mode=OFF`. A
 * page cipher for the main database file is one encryption surface; WAL frames (their own header +
 * checksum format) and rollback-journal records (their own, different record format) would each be a
 * *second* one. This index has no durability requirement to justify that cost - spec §11 already
 * requires discarding and rebuilding it on corruption, schema change, key rotation, or platform storage
 * eviction, and eviction "MUST NOT block search" - so an interrupted write in the worst case is just
 * caught by the same GCM-auth-failure -> rebuild path as any other corruption, never partial/torn state
 * silently trusted.
 *
 * Every `jRead`/`jWrite` here is `async` (declared `async` specifically so `FacadeVFS.hasAsyncMethod()`
 * detects it via `instanceof AsyncFunction` and awaits it) because `crypto.subtle.encrypt`/`decrypt` has
 * no synchronous form in a browser - this is *why* `localIndexWorker.ts` boots the Asyncify SQLite build
 * (`dist/wa-sqlite-async.mjs`), not the plain synchronous one `AccessHandlePoolVFS`'s own doc comment
 * says it's designed for: that claim is about `AccessHandlePoolVFS`'s *own* methods (real synchronous
 * OPFS access-handle calls), which stay synchronous and work fine wrapped underneath an async outer VFS
 * on an Asyncify build - the build choice is driven by this class's needs, not the inner VFS's.
 */
import { FacadeVFS } from "@journeyapps/wa-sqlite/src/FacadeVFS.js";
import { AccessHandlePoolVFS } from "@journeyapps/wa-sqlite/src/examples/AccessHandlePoolVFS.js";
import * as VFS from "@journeyapps/wa-sqlite/src/VFS.js";
import {
    LOGICAL_BLOCK_SIZE,
    PHYSICAL_BLOCK_SIZE,
    PageCorruptedError,
    decryptBlock,
    encryptBlock,
    importAesGcmKey,
} from "./localIndexBlockCipher.js";

export { PageCorruptedError } from "./localIndexBlockCipher.js";

export class EncryptingVFS extends FacadeVFS {
    #inner: AccessHandlePoolVFS;
    #key: CryptoKey | undefined;
    /** `jOpen`'s `filename` is stable across the life of a fileId; `fileId` itself is only valid for one
     * open handle, never persisted - this map lets `jRead`/`jWrite` recover the stable filename an AAD
     * needs to bind to, from the ephemeral fileId SQLite actually passes them. */
    #filenamesByFileId = new Map<number, string>();

    private constructor(name: string, module: unknown, inner: AccessHandlePoolVFS) {
        super(name, module);
        this.#inner = inner;
    }

    /** `rawKey` MUST be exactly 32 bytes (AES-256) - see `localIndexKey.ts`'s `deriveLocalIndexKey()`,
     * the only intended source of this value. */
    static async create(name: string, module: unknown, rawKey: Uint8Array): Promise<EncryptingVFS> {
        const inner = await AccessHandlePoolVFS.create(name, module);
        const vfs = new EncryptingVFS(name, module, inner);
        vfs.#key = await importAesGcmKey(rawKey);
        return vfs;
    }

    /**
     * Releases every pooled OPFS sync access handle `AccessHandlePoolVFS` opened and holds open for its
     * entire lifetime (not per SQLite-file-open/close - `jOpen`/`jClose` above only associate/disassociate
     * a SQLite fileId with an already-open handle, they never open or close the handles themselves). MUST
     * be called before creating another VFS instance against the same OPFS pool `name` - confirmed by
     * direct reproduction: skipping this and calling `create()` again with the same `name` throws
     * "Access Handles cannot be created if there is another open Access Handle," since the previous
     * instance's handles are still live. `localIndexWorker.ts` calls this alongside `sqlite3.close(db)`
     * (which closes the SQLite *connection*, a separate, shorter-lived thing from the VFS itself) whenever
     * it tears down a mailbox's connection - on `destroy()` and in `selfTest()`'s own close/reopen check.
     */
    close(): void | Promise<void> {
        return this.#inner.close();
    }

    // Every method below except jRead/jWrite is a pure passthrough to the inner (real storage) VFS -
    // this class's only job is to sit in the read/write path.
    jOpen(filename: string | null, pFile: number, flags: number, pOutFlags: DataView): number | Promise<number> {
        const result = this.#inner.jOpen(filename, pFile, flags, pOutFlags);
        this.#filenamesByFileId.set(pFile, filename ?? `(anon:${pFile})`);
        return result;
    }
    jClose(pFile: number): number | Promise<number> {
        this.#filenamesByFileId.delete(pFile);
        return this.#inner.jClose(pFile);
    }
    jDelete(filename: string, syncDir: number): number | Promise<number> {
        return this.#inner.jDelete(filename, syncDir);
    }
    jAccess(filename: string, flags: number, pResOut: DataView): number | Promise<number> {
        return this.#inner.jAccess(filename, flags, pResOut);
    }
    jFullPathname(filename: string, zOut: Uint8Array): number | Promise<number> {
        return this.#inner.jFullPathname(filename, zOut);
    }
    jSync(pFile: number, flags: number): number | Promise<number> {
        return this.#inner.jSync(pFile, flags);
    }
    jSectorSize(pFile: number): number {
        return LOGICAL_BLOCK_SIZE;
    }
    jDeviceCharacteristics(pFile: number): number {
        return this.#inner.jDeviceCharacteristics(pFile);
    }

    /** Logical file size = physical size scaled back down to the logical block size - the inner VFS's
     * own `jFileSize` reports the *physical* (post-remap) byte count, which is always an exact multiple
     * of `PHYSICAL_BLOCK_SIZE` since every write here always fills whole physical blocks. */
    async jFileSize(pFile: number, pSize64: DataView): Promise<number> {
        const buf = new DataView(new ArrayBuffer(8));
        const rc = await this.#inner.jFileSize(pFile, buf);
        if (rc !== VFS.SQLITE_OK) return rc;
        const physicalSize = Number(buf.getBigInt64(0, true));
        const logicalSize = Math.floor(physicalSize / PHYSICAL_BLOCK_SIZE) * LOGICAL_BLOCK_SIZE;
        pSize64.setBigInt64(0, BigInt(logicalSize), true);
        return VFS.SQLITE_OK;
    }

    /** `iSize` is a logical byte size - truncates to the smallest whole number of *physical* blocks that
     * still covers it, so a partially-truncated trailing block is never left half-written. */
    async jTruncate(pFile: number, iSize: number): Promise<number> {
        const blocks = Math.ceil(iSize / LOGICAL_BLOCK_SIZE);
        return this.#inner.jTruncate(pFile, blocks * PHYSICAL_BLOCK_SIZE);
    }

    /**
     * Reads one physical block and decrypts it. `absent: true` means nothing has ever been written at
     * this block (the inner VFS's own read came back short) - `plaintext` is a zero-filled logical block
     * in that case, matching what SQLite expects for a region it has never written, and it is
     * deliberately never handed to `crypto.subtle.decrypt()` at all (there aren't enough physical bytes
     * present to contain a real nonce+tag).
     *
     * `absent` is determined *only* from the inner VFS's own return code, never inferred from whether the
     * decrypted plaintext happens to be all-zero - a real, fully-written SQLite page is routinely
     * all-zero (an unused/freelist page, or a page beyond a freshly created database's real content), so
     * that content shape means nothing about whether the block is actually present.
     */
    async #readBlock(pFile: number, filename: string, blockIndex: number): Promise<{ plaintext: Uint8Array; absent: boolean }> {
        const physical = new Uint8Array(PHYSICAL_BLOCK_SIZE);
        const rc = await this.#inner.jRead(pFile, physical, blockIndex * PHYSICAL_BLOCK_SIZE);
        if (rc === VFS.SQLITE_IOERR_SHORT_READ) {
            // #writeBlock() never writes fewer than PHYSICAL_BLOCK_SIZE bytes at a time, so a short read
            // here only ever means "this block was never written," not "partially written."
            return { plaintext: new Uint8Array(LOGICAL_BLOCK_SIZE), absent: true };
        }
        if (rc !== VFS.SQLITE_OK) {
            throw new PageCorruptedError(filename, blockIndex, new Error(`inner VFS read failed: rc=${rc}`));
        }
        const plaintext = await decryptBlock(this.#key!, filename, blockIndex, physical);
        return { plaintext, absent: false };
    }

    async #writeBlock(pFile: number, filename: string, blockIndex: number, plaintext: Uint8Array): Promise<number> {
        const physical = await encryptBlock(this.#key!, filename, blockIndex, plaintext);
        return this.#inner.jWrite(pFile, physical, blockIndex * PHYSICAL_BLOCK_SIZE);
    }

    async jRead(pFile: number, pData: Uint8Array, iOffset: number): Promise<number> {
        const filename = this.#filenamesByFileId.get(pFile) ?? `(unknown:${pFile})`;
        const startBlock = Math.floor(iOffset / LOGICAL_BLOCK_SIZE);
        const endBlock = Math.floor((iOffset + pData.length - 1) / LOGICAL_BLOCK_SIZE);
        let anyAbsent = false;
        for (let block = startBlock; block <= endBlock; block++) {
            const { plaintext, absent } = await this.#readBlock(pFile, filename, block);
            const blockStart = block * LOGICAL_BLOCK_SIZE;
            const copyStart = Math.max(iOffset, blockStart);
            const copyEnd = Math.min(iOffset + pData.length, blockStart + LOGICAL_BLOCK_SIZE);
            pData.set(plaintext.subarray(copyStart - blockStart, copyEnd - blockStart), copyStart - iOffset);
            // SQLITE_IOERR_SHORT_READ is how SQLite distinguishes "nothing here yet" from "here is real
            // (possibly zero-filled) data," e.g. when probing whether a file exists at all - see
            // #readBlock's own doc comment on why this is tracked explicitly, not inferred from content.
            if (absent) {
                anyAbsent = true;
            }
        }
        return anyAbsent ? VFS.SQLITE_IOERR_SHORT_READ : VFS.SQLITE_OK;
    }

    async jWrite(pFile: number, pData: Uint8Array, iOffset: number): Promise<number> {
        const filename = this.#filenamesByFileId.get(pFile) ?? `(unknown:${pFile})`;
        const startBlock = Math.floor(iOffset / LOGICAL_BLOCK_SIZE);
        const endBlock = Math.floor((iOffset + pData.length - 1) / LOGICAL_BLOCK_SIZE);
        for (let block = startBlock; block <= endBlock; block++) {
            const blockStart = block * LOGICAL_BLOCK_SIZE;
            const writeStart = Math.max(iOffset, blockStart);
            const writeEnd = Math.min(iOffset + pData.length, blockStart + LOGICAL_BLOCK_SIZE);
            // Whole-block write (the common case once SQLite's page size is fixed): no need to read the
            // old block first. Anything narrower (a sub-page write, or this block only partially
            // overlaps the requested range) needs the existing content as a base - a real
            // read-modify-write - since the physical block is re-encrypted as a single AEAD unit.
            const plaintext =
                writeStart === blockStart && writeEnd === blockStart + LOGICAL_BLOCK_SIZE
                    ? pData.subarray(writeStart - iOffset, writeEnd - iOffset)
                    : await this.#readBlock(pFile, filename, block).then(({ plaintext: existing }) => {
                          const merged = existing.slice();
                          merged.set(pData.subarray(writeStart - iOffset, writeEnd - iOffset), writeStart - blockStart);
                          return merged;
                      });
            const rc = await this.#writeBlock(pFile, filename, block, plaintext);
            if (rc !== VFS.SQLITE_OK) return rc;
        }
        return VFS.SQLITE_OK;
    }
}
