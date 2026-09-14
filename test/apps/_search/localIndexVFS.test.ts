// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Drives `EncryptingVFS`'s own j* methods directly against a small in-memory stand-in for the OPFS-backed
// `AccessHandlePoolVFS` (browser-only), with real WebCrypto - covers the edge cases SQLite itself rarely
// or never issues through `localIndexWorker.test.ts`'s end-to-end harness: sub-block writes, inner-VFS
// failure codes, a thrown inner write, and I/O on a file id that was never opened.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as VFS from "@journeyapps/wa-sqlite/src/VFS.js";
import { LOGICAL_BLOCK_SIZE, PHYSICAL_BLOCK_SIZE } from "../../../apps/shared/search/localIndexBlockCipher.js";

const { FakeInnerVFS, created } = vi.hoisted(() => {
    class FakeInnerVFS {
        files = new Map<number, Uint8Array>();
        readRc: number | undefined;
        writeRc: number | undefined;
        fileSizeRc: number | undefined;
        throwOnWrite = false;
        calls: string[] = [];

        close() {
            this.calls.push("close");
        }
        jOpen() {
            return 0;
        }
        jClose() {
            return 0;
        }
        jDelete(filename: string) {
            this.calls.push(`delete:${filename}`);
            return 0;
        }
        jAccess(filename: string) {
            this.calls.push(`access:${filename}`);
            return 0;
        }
        jFullPathname(filename: string) {
            this.calls.push(`fullPathname:${filename}`);
            return 0;
        }
        jSync(pFile: number) {
            this.calls.push(`sync:${pFile}`);
            return 0;
        }
        jDeviceCharacteristics() {
            return 1234;
        }
        jTruncate(pFile: number, size: number) {
            this.calls.push(`truncate:${pFile}:${size}`);
            return 0;
        }
        jFileSize(pFile: number, out: DataView) {
            if (this.fileSizeRc !== undefined) return this.fileSizeRc;
            out.setBigInt64(0, BigInt(this.files.get(pFile)?.length ?? 0), true);
            return 0;
        }
        jRead(pFile: number, buffer: Uint8Array, offset: number) {
            if (this.readRc !== undefined) return this.readRc;
            const file = this.files.get(pFile) ?? new Uint8Array(0);
            const available = file.subarray(offset, offset + buffer.length);
            buffer.set(available);
            // SQLITE_IOERR_SHORT_READ
            return available.length < buffer.length ? 522 : 0;
        }
        jWrite(pFile: number, data: Uint8Array, offset: number) {
            if (this.throwOnWrite) throw new Error("disk gone");
            if (this.writeRc !== undefined) return this.writeRc;
            const file = this.files.get(pFile) ?? new Uint8Array(0);
            const grown = new Uint8Array(Math.max(file.length, offset + data.length));
            grown.set(file);
            grown.set(data, offset);
            this.files.set(pFile, grown);
            return 0;
        }
    }
    return { FakeInnerVFS, created: [] as FakeInnerVFS[] };
});

vi.mock("@journeyapps/wa-sqlite/src/examples/AccessHandlePoolVFS.js", () => ({
    AccessHandlePoolVFS: {
        create: async () => {
            const inner = new FakeInnerVFS();
            created.push(inner);
            return inner;
        },
    },
}));

import { EncryptingVFS } from "../../../apps/shared/search/localIndexVFS.js";

const KEY = new Uint8Array(32).fill(7);

async function openVfs() {
    const vfs = await EncryptingVFS.create("pool", {}, KEY);
    return { vfs, inner: created[created.length - 1] };
}

function bytes(length: number, fill: number): Uint8Array {
    return new Uint8Array(length).fill(fill);
}

beforeEach(() => {
    created.length = 0;
});

describe("EncryptingVFS", () => {
    it("passes every non-I/O method straight through to the inner VFS", async () => {
        const { vfs, inner } = await openVfs();
        const view = new DataView(new ArrayBuffer(8));

        expect(vfs.jDelete("index.db", 0)).toBe(0);
        expect(vfs.jAccess("index.db", 0, view)).toBe(0);
        expect(vfs.jFullPathname("index.db", new Uint8Array(8))).toBe(0);
        expect(vfs.jSync(1, 0)).toBe(0);
        expect(vfs.jDeviceCharacteristics(1)).toBe(1234);
        expect(vfs.jSectorSize(1)).toBe(LOGICAL_BLOCK_SIZE);
        await expect(vfs.jTruncate(1, LOGICAL_BLOCK_SIZE + 1)).resolves.toBe(0);
        await vfs.close();

        expect(inner.calls).toEqual([
            "delete:index.db",
            "access:index.db",
            "fullPathname:index.db",
            "sync:1",
            `truncate:1:${2 * PHYSICAL_BLOCK_SIZE}`,
            "close",
        ]);
    });

    it("round-trips sub-block and block-spanning writes through a read-modify-write, including on an anonymous file", async () => {
        const { vfs } = await openVfs();
        await vfs.jOpen(null, 1, 0, new DataView(new ArrayBuffer(4)));

        await expect(vfs.jWrite(1, bytes(100, 0xaa), 10)).resolves.toBe(VFS.SQLITE_OK);
        await expect(vfs.jWrite(1, bytes(200, 0xbb), LOGICAL_BLOCK_SIZE - 50)).resolves.toBe(VFS.SQLITE_OK);

        const readBack = new Uint8Array(2 * LOGICAL_BLOCK_SIZE);
        await expect(vfs.jRead(1, readBack, 0)).resolves.toBe(VFS.SQLITE_OK);
        expect(readBack.subarray(0, 10).every((b) => b === 0)).toBe(true);
        expect(readBack.subarray(10, 110).every((b) => b === 0xaa)).toBe(true);
        expect(readBack.subarray(LOGICAL_BLOCK_SIZE - 50, LOGICAL_BLOCK_SIZE + 150).every((b) => b === 0xbb)).toBe(true);
        expect(vfs.corruptionDetected).toBe(false);

        const size = new DataView(new ArrayBuffer(8));
        await expect(vfs.jFileSize(1, size)).resolves.toBe(VFS.SQLITE_OK);
        expect(Number(size.getBigInt64(0, true))).toBe(2 * LOGICAL_BLOCK_SIZE);
    });

    it("reads and writes a file id that was never opened under a stable fallback name", async () => {
        const { vfs } = await openVfs();
        await expect(vfs.jWrite(99, bytes(LOGICAL_BLOCK_SIZE, 0x11), 0)).resolves.toBe(VFS.SQLITE_OK);
        const readBack = new Uint8Array(LOGICAL_BLOCK_SIZE);
        await expect(vfs.jRead(99, readBack, 0)).resolves.toBe(VFS.SQLITE_OK);
        expect(readBack.every((b) => b === 0x11)).toBe(true);
    });

    it("returns the inner VFS's own error code from jFileSize", async () => {
        const { vfs, inner } = await openVfs();
        inner.fileSizeRc = VFS.SQLITE_IOERR;
        await expect(vfs.jFileSize(1, new DataView(new ArrayBuffer(8)))).resolves.toBe(VFS.SQLITE_IOERR);
    });

    it("flags corruption and returns SQLITE_IOERR_READ when the inner read fails outright", async () => {
        const { vfs, inner } = await openVfs();
        await vfs.jOpen("index.db", 1, 0, new DataView(new ArrayBuffer(4)));
        inner.readRc = VFS.SQLITE_IOERR;
        await expect(vfs.jRead(1, new Uint8Array(LOGICAL_BLOCK_SIZE), 0)).resolves.toBe(VFS.SQLITE_IOERR_READ);
        expect(vfs.corruptionDetected).toBe(true);
    });

    it("returns the inner VFS's own write error code without flagging corruption", async () => {
        const { vfs, inner } = await openVfs();
        await vfs.jOpen("index.db", 1, 0, new DataView(new ArrayBuffer(4)));
        inner.writeRc = VFS.SQLITE_FULL;
        await expect(vfs.jWrite(1, bytes(LOGICAL_BLOCK_SIZE, 1), 0)).resolves.toBe(VFS.SQLITE_FULL);
        expect(vfs.corruptionDetected).toBe(false);
    });

    it("flags corruption and returns SQLITE_IOERR_WRITE when the inner write throws", async () => {
        const { vfs, inner } = await openVfs();
        await vfs.jOpen("index.db", 1, 0, new DataView(new ArrayBuffer(4)));
        inner.throwOnWrite = true;
        await expect(vfs.jWrite(1, bytes(LOGICAL_BLOCK_SIZE, 1), 0)).resolves.toBe(VFS.SQLITE_IOERR_WRITE);
        expect(vfs.corruptionDetected).toBe(true);
    });
});
