///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Whether a certificate the server lists is really the one of a private key this device opened. A zero-access key's private half comes
 * from an authenticated seal (or a member's wrap), but its certificate comes from the server as it is: what this device then encrypts
 * to that certificate - the search index segments it builds from end-to-end mail, a protected meeting's key - must not go to a key the
 * server swapped in. Plain WebCrypto and a few lines of DER, so the unlock path loads no certificate library.
 */

/** One DER element of `der` at `offset`: where its header starts, where its content starts, where it ends. */
function element(der: Uint8Array, offset: number): { tag: number; header: number; content: number; end: number } {
    const tag = der[offset];
    let length = der[offset + 1];
    let content = offset + 2;
    if (length & 0x80) {
        const bytes = length & 0x7f;
        if (bytes === 0 || bytes > 4) {
            throw new Error("Unsupported DER length.");
        }
        length = 0;
        for (let i = 0; i < bytes; i++) {
            length = length * 256 + der[content + i];
        }
        content += bytes;
    }
    const end = content + length;
    if (tag === undefined || end > der.length) {
        throw new Error("Truncated DER.");
    }
    return { tag, header: offset, content, end };
}

/** The children of the constructed element `parent`. */
function children(der: Uint8Array, parent: { content: number; end: number }): ReturnType<typeof element>[] {
    const found: ReturnType<typeof element>[] = [];
    for (let offset = parent.content; offset < parent.end; offset = found[found.length - 1].end) {
        found.push(element(der, offset));
    }
    return found;
}

/** The SubjectPublicKeyInfo of X.509 certificate `certDer` (RFC 5280: the seventh field of `tbsCertificate`, the sixth when it has no
 * explicit version). */
function subjectPublicKeyInfo(certDer: Uint8Array): Uint8Array {
    const [tbs] = children(certDer, element(certDer, 0));
    const fields = children(certDer, tbs);
    const spki = fields[fields[0].tag === 0xa0 ? 6 : 5];
    if (!spki || spki.tag !== 0x30) {
        throw new Error("No subject public key.");
    }
    return certDer.subarray(spki.header, spki.end);
}

const P256_ECDH: EcKeyImportParams = { name: "ECDH", namedCurve: "P-256" };

/** Whether `certDer` (a P-256 certificate) carries the public half of `pkcs8` (a P-256 private key). Never rejects: anything that won't
 * parse or import is `false`. */
export async function certificateHoldsKey(certDer: Uint8Array, pkcs8: Uint8Array): Promise<boolean> {
    try {
        const publicKey = await crypto.subtle.importKey("spki", subjectPublicKeyInfo(certDer) as BufferSource, P256_ECDH, true, []);
        const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, P256_ECDH, true, ["deriveBits"]);
        const [certified, held] = await Promise.all([crypto.subtle.exportKey("jwk", publicKey), crypto.subtle.exportKey("jwk", privateKey)]);
        return !!certified.x && certified.x === held.x && certified.y === held.y;
    } catch {
        return false;
    }
}
