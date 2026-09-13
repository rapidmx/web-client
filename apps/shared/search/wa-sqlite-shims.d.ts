///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * `@journeyapps/wa-sqlite` ships real `.d.ts` files for its top-level module and most `src/examples/*`
 * VFS implementations, but not for `src/FacadeVFS.js` (the base class for hand-written VFS
 * implementations) or `src/examples/AccessHandlePoolVFS.js` (the OPFS SAH Pool VFS this codebase's
 * `EncryptingVFS` wraps) - both used directly by `localIndexVFS.ts`. Declared here, minimally, covering
 * only the members this codebase actually calls.
 */
declare module "@journeyapps/wa-sqlite/src/FacadeVFS.js" {
    import * as VFS from "@journeyapps/wa-sqlite/src/VFS.js";

    /** Convenience base class for a JavaScript VFS - see the real source's own doc comment. Subclasses
     * override the `jXxx` methods (JS-friendly wrappers) rather than the raw `xXxx` C-callback methods. */
    export class FacadeVFS extends VFS.Base {
        constructor(name: string, module: unknown);
        hasAsyncMethod(methodName: string): boolean;
        getFilename(pFile: number): string;
        jOpen(filename: string | null, pFile: number, flags: number, pOutFlags: DataView): number | Promise<number>;
        jDelete(filename: string, syncDir: number): number | Promise<number>;
        jAccess(filename: string, flags: number, pResOut: DataView): number | Promise<number>;
        jFullPathname(filename: string, zOut: Uint8Array): number | Promise<number>;
        jClose(pFile: number): number | Promise<number>;
        jRead(pFile: number, pData: Uint8Array, iOffset: number): number | Promise<number>;
        jWrite(pFile: number, pData: Uint8Array, iOffset: number): number | Promise<number>;
        jTruncate(pFile: number, size: number): number | Promise<number>;
        jSync(pFile: number, flags: number): number | Promise<number>;
        jFileSize(pFile: number, pSize64: DataView): number | Promise<number>;
        jSectorSize(pFile: number): number;
        jDeviceCharacteristics(pFile: number): number;
    }
}

declare module "@journeyapps/wa-sqlite/src/examples/AccessHandlePoolVFS.js" {
    import { FacadeVFS } from "@journeyapps/wa-sqlite/src/FacadeVFS.js";

    /** The OPFS "SAH Pool" VFS - synchronous, works with the plain (non-Asyncify) SQLite WASM build.
     * `create()` is the intended entry point (constructs, then awaits internal readiness). */
    export class AccessHandlePoolVFS extends FacadeVFS {
        static create(name: string, module: unknown): Promise<AccessHandlePoolVFS>;
    }
}
