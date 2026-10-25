///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The temporary per-meeting key of a meeting with external guests (meet-plugin `specs/meeting_privacy.md` §3-4): a P-256 keypair made
 * in the browser of whoever creates the meeting, with a self-signed certificate so the CMS code in `smime.ts` seals to it and opens with
 * it unchanged. Every participant receives the private key in their link's `#k=` part; the organizer also keeps it sealed to their own
 * zero-access certificate. A live AES-256-GCM key derived from it encrypts the meeting's signaling and relayed media. Shared by the
 * organizer's calendar editor, meet-plugin and booking-plugin.
 *
 * Nothing here talks to the server: the private key never leaves the browser except inside a link or a CMS wrap.
 */
import { fromBase64Url, toBase64Url } from "./encoding.js";
import type { DecryptionKey } from "./smime.js";

/** The `#` parameter of a link that carries a meeting key. */
export const MEETING_KEY_FRAGMENT_PARAM = "k";

/** HKDF `info` of the live key (`specs/meeting_privacy.md` §3). */
const LIVE_KEY_INFO = "rapidmx-meeting-live-v1";

const EC_PARAMS: EcKeyImportParams = { name: "ECDH", namedCurve: "P-256" };

/** A meeting key as its creator holds it. */
export interface GeneratedMeetingKey {
    /** PKCS#8 DER of the private key - what a link carries and a wrap seals. */
    pkcs8: Uint8Array;
    /** The self-signed certificate's DER - what the server stores and data is sealed to. */
    certificateDer: Uint8Array;
    /** SHA-256 of `certificateDer`, lowercase hex. */
    fingerprint: string;
}

async function loadX509(): Promise<typeof import("@peculiar/x509")> {
    await import("reflect-metadata");
    const x509 = await import("@peculiar/x509");
    x509.cryptoProvider.set(crypto);
    return x509;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A new meeting key valid until `expiresAt` (its certificate's `notAfter`). */
export async function generateMeetingKey(expiresAt: Date): Promise<GeneratedMeetingKey> {
    const x509 = await loadX509();
    // ECDSA to self-sign the certificate; the same P-256 key is re-imported as ECDH to open what is sealed to it (`importMeetingKey()`).
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]));
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: toHex(crypto.getRandomValues(new Uint8Array(16))),
        name: "CN=meeting",
        notBefore: new Date(Date.now() - 60_000),
        notAfter: expiresAt,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys,
    });
    const certificateDer = new Uint8Array(cert.rawData);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
    return { pkcs8, certificateDer, fingerprint: await sha256Hex(certificateDer) };
}

function toHex(bytes: Uint8Array): string {
    // A positive serial: the top bit clear.
    const copy = Uint8Array.from(bytes);
    copy[0] &= 0x7f;
    return Array.from(copy, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The `#` part a guest's link carries for `pkcs8`: `k=<base64url>`. */
export function meetingKeyFragment(pkcs8: Uint8Array): string {
    return `${MEETING_KEY_FRAGMENT_PARAM}=${toBase64Url(pkcs8)}`;
}

/** The meeting key in `hash` (a `location.hash`, with or without its `#`), or `undefined` when it carries none or it is malformed. */
export function readMeetingKeyFragment(hash: string): Uint8Array | undefined {
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const value = params.get(MEETING_KEY_FRAGMENT_PARAM);
    if (!value || !/^[A-Za-z0-9_-]{16,1024}$/.test(value)) {
        return undefined;
    }
    try {
        return fromBase64Url(value);
    } catch {
        return undefined;
    }
}

/** The meeting key `pkcs8` as the CMS code opens with it, and its live key for meeting `meetingUid`. Rejects a key that isn't P-256. */
export async function importMeetingKey(
    pkcs8: Uint8Array,
    certificateDer: Uint8Array,
    meetingUid: string,
): Promise<{ decryptionKey: DecryptionKey; liveKey: CryptoKey }> {
    // Extractable once, only to read its scalar for the live key; the key kept for CMS isn't.
    const readable = await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, EC_PARAMS, true, ["deriveBits"]);
    const jwk = await crypto.subtle.exportKey("jwk", readable);
    /* v8 ignore next 3 -- an imported PKCS#8 private key always exports its scalar */
    if (!jwk.d) {
        throw new Error("This is not a meeting key.");
    }
    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, EC_PARAMS, false, ["deriveBits"]);
    return { decryptionKey: { certDer: certificateDer, privateKey }, liveKey: await deriveLiveKey(fromBase64Url(jwk.d), meetingUid) };
}

/** The AES-256-GCM live key of meeting `meetingUid` from `ikm`, the meeting key's private scalar. Non-extractable. */
export async function deriveLiveKey(ikm: Uint8Array, meetingUid: string): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(meetingUid), info: new TextEncoder().encode(LIVE_KEY_INFO) },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
}
