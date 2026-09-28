///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Plain base64/base64url <-> `Uint8Array` conversions shared by every `crypto/*` module. Deliberately
 * `Buffer`-free — this code runs in a browser tab and an Electron renderer alike, and `Buffer` is not
 * guaranteed to exist in either without a bundler polyfill.
 */

export function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

export function fromBase64(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
    return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(base64url: string): Uint8Array {
    const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
    const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    return fromBase64(padded + padding);
}
