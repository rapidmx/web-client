///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Verification seals: a client-side record that a message's signature verified when it was first opened, so later key
 * events (a signer key replaced beyond the retained previous keys, a deleted contact, expiry, a later compromise
 * revocation) don't make it look untrusted. See `messageSecurity.ts`'s `evaluateMessageSecurityWithSeal()` for how a
 * seal is used.
 *
 * A seal is an HMAC-SHA256 over the verification result, keyed by a per-mailbox key HKDF-derived from the unlocked
 * master key - so the server, which stores it as the opaque `Message.verificationSeal` (`mailApi.ts`'s
 * `setMessageVerificationSeal()`), can't forge or alter one. The seal key is derived on each call (the same way
 * web-client's local search index key is: `hkdfDerive()` with a fixed salt and a mailbox-bound label), imported as a
 * non-extractable `CryptoKey`, its raw bytes zeroed at once, and never cached or persisted - there is nothing to destroy
 * beyond the master key `keySession.ts`'s `destroyUnlockedKeys()` already zeroes. A destroyed `UnlockedKeys` object
 * throws `KeysLockedError` (checked on entry and again after the derivation awaits).
 *
 * **Format (v1).** `v1.<base64url(JSON payload)>.<base64url(32-byte HMAC-SHA256 tag)>`, where the payload is
 * `{ "v": 1, "mb": mailboxUid, "id": messageUid, "g": masterKeyGeneration, "h": rawSha256, "fp": signerFingerprint,
 * "st": state, "t": verifiedAt }` (`h`/`fp` lowercased hex). The tag is not computed over the JSON text: it covers a canonical encoding of the fields
 * (see `canonicalBytes()`), so the JSON's own formatting carries no meaning. Every character is in restapi's allowed
 * `[A-Za-z0-9+/=_.:-]`, and a seal is at most `MAX_VERIFICATION_SEAL_LENGTH` (2048) characters.
 *
 * **Master key rotation.** A seal is bound to the vault's `masterKeyGeneration` (`keyvaultApi.ts`'s
 * `KeyVault.masterKeyGeneration`): the generation is MAC-covered, and `openVerificationSeal()` refuses a seal for a
 * generation other than the expected one. Seals are deliberately not carried across a `rekey()`: a seal from an older
 * generation never opens under the new master key (its MAC fails too), so a rotation after a suspected compromise can't
 * bless seals that someone holding the old master key could have written. Such a message shows its live result until its
 * next successful live verification, when `evaluateMessageSecurityWithSeal()` re-seals it lazily under the current
 * generation (the server replaces a stored seal only for a newer, current generation).
 */
import { fromBase64Url, toBase64Url } from "./encoding.js";
import { KeysLockedError, hkdfDerive } from "./masterKey.js";
import { binaryStringToBytes } from "./mime.js";

/** The longest seal restapi stores (`Message.verificationSeal`). */
export const MAX_VERIFICATION_SEAL_LENGTH = 2048;

/** The characters restapi allows in a seal. */
export const VERIFICATION_SEAL_CHARSET = /^[A-Za-z0-9+/=_.:-]*$/;

/** The HKDF label the seal key is derived under (suffixed with `:<mailboxUid>`). */
export const VERIFICATION_SEAL_HKDF_LABEL = "rapidmx:verification-seal:v1";

/** Fixed, non-secret HKDF salt: the master key is already uniformly random (see web-client's `localIndexKey.ts`). */
const FIXED_SALT = new TextEncoder().encode("rapidmx-verification-seal-v1");

const SEAL_VERSION = "v1";
const TAG_LENGTH_BYTES = 32;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The verified states a seal can record. */
export type SealedVerificationState = "signed_verified" | "encrypted_verified";

const SEALED_STATES: readonly string[] = ["signed_verified", "encrypted_verified"];

/** What `buildVerificationSeal()` seals. */
export interface VerificationSealInput {
    messageUid: string;
    /** SHA-256 (hex) of the message's raw MIME - `rawMimeSha256()`. */
    rawSha256: string;
    /** The live signer certificate fingerprint (`MessageSecurityResult.signerFingerprint`). */
    signerFingerprint: string;
    state: SealedVerificationState;
    /** UTC timestamp (epoch ms) at which the signature verified. */
    verifiedAt: number;
    /** The vault's `masterKeyGeneration` the seal is written under (`0` when the vault reports none). */
    masterKeyGeneration: number;
}

/** What `openVerificationSeal()` recovers from a valid seal. */
export interface OpenedVerificationSeal {
    /** Lowercased hex. */
    signerFingerprint: string;
    state: SealedVerificationState;
    verifiedAt: number;
    masterKeyGeneration: number;
}

/** The part of `keySession.ts`'s `UnlockedKeys` a seal needs. */
export interface SealKeyMaterial {
    masterKey: Uint8Array;
    destroyed?: boolean;
}

/** SHA-256 (lowercase hex) of a message's raw MIME, as `evaluateMessageSecurity()` receives it: a binary string
 * (`mailApi.ts`'s `getMessageRawContent()`, one code unit per byte) or the bytes themselves. A string that can't be a
 * binary string (a code unit above 0xFF) is hashed as its UTF-8 encoding, like `mime.ts`'s `binaryStringToBytes()`. */
export async function rawMimeSha256(raw: string | Uint8Array): Promise<string> {
    const bytes = typeof raw === "string" ? binaryStringToBytes(raw) : raw;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertNotDestroyed(unlocked: SealKeyMaterial): void {
    if (unlocked.destroyed) {
        throw new KeysLockedError();
    }
}

/** Derives the mailbox's seal key and imports it as a non-extractable HMAC key, zeroing the raw bytes. Throws
 * `KeysLockedError` for destroyed or zeroed key material. */
async function importSealKey(mailboxUid: string, unlocked: SealKeyMaterial): Promise<CryptoKey> {
    assertNotDestroyed(unlocked);
    const raw = await hkdfDerive(unlocked.masterKey, FIXED_SALT, `${VERIFICATION_SEAL_HKDF_LABEL}:${mailboxUid}`);
    try {
        const key = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        // Locked while deriving: the derivation may have copied the master key before it was zeroed.
        assertNotDestroyed(unlocked);
        return key;
    } finally {
        raw.fill(0);
    }
}

/** Length-prefixed (4-byte big-endian) UTF-8 fields, so no two field lists encode alike. */
function canonicalBytes(fields: string[]): Uint8Array {
    const encoded = fields.map((field) => new TextEncoder().encode(field));
    const out = new Uint8Array(encoded.reduce((total, bytes) => total + 4 + bytes.length, 0));
    const view = new DataView(out.buffer);
    let offset = 0;
    for (const bytes of encoded) {
        view.setUint32(offset, bytes.length);
        out.set(bytes, offset + 4);
        offset += 4 + bytes.length;
    }
    return out;
}

interface SealFields {
    mailboxUid: string;
    messageUid: string;
    rawSha256: string;
    signerFingerprint: string;
    state: string;
    verifiedAt: number;
    masterKeyGeneration: number;
}

async function computeTag(key: CryptoKey, fields: SealFields): Promise<Uint8Array> {
    const data = canonicalBytes([
        SEAL_VERSION,
        fields.mailboxUid,
        fields.messageUid,
        String(fields.masterKeyGeneration),
        fields.rawSha256,
        fields.signerFingerprint,
        fields.state,
        String(fields.verifiedAt),
    ]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, data as BufferSource));
}

/** Compares every byte whatever the first difference (callers only pass 32-byte tags; a length difference still fails). */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    let diff = a.length ^ b.length;
    for (let i = 0; i < a.length; i++) {
        diff |= a[i] ^ b[i];
    }
    return diff === 0;
}

/** A non-negative safe integer - a `verifiedAt` or a `masterKeyGeneration`. */
function isValidTimestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Seals a verification result for `mailboxUid`'s message `input.messageUid` - see this module's doc comment for the
 * format. Throws `KeysLockedError` for destroyed keys, and a plain `Error` for input that can't be sealed: empty uids or
 * fingerprint, a `rawSha256` that isn't 64 hex digits, an unknown `state`, a `verifiedAt` or `masterKeyGeneration` that isn't a non-negative
 * integer, or a seal that would exceed `MAX_VERIFICATION_SEAL_LENGTH` (very long uids).
 */
export async function buildVerificationSeal(mailboxUid: string, unlocked: SealKeyMaterial, input: VerificationSealInput): Promise<string> {
    const fields: SealFields = {
        mailboxUid,
        messageUid: input.messageUid,
        rawSha256: typeof input.rawSha256 === "string" ? input.rawSha256.toLowerCase() : "",
        signerFingerprint: typeof input.signerFingerprint === "string" ? input.signerFingerprint.toLowerCase() : "",
        state: input.state,
        verifiedAt: input.verifiedAt,
        masterKeyGeneration: input.masterKeyGeneration,
    };
    if (!mailboxUid || !fields.messageUid || !fields.signerFingerprint) {
        throw new Error("A verification seal needs a mailbox uid, message uid and signer fingerprint.");
    }
    if (!SHA256_HEX.test(fields.rawSha256)) {
        throw new Error("A verification seal's rawSha256 must be a hex SHA-256 digest.");
    }
    if (!SEALED_STATES.includes(fields.state) || !isValidTimestamp(fields.verifiedAt) || !isValidTimestamp(fields.masterKeyGeneration)) {
        throw new Error("A verification seal needs a verified state and non-negative integer verifiedAt and masterKeyGeneration.");
    }
    const key = await importSealKey(mailboxUid, unlocked);
    const payload = { v: 1, mb: fields.mailboxUid, id: fields.messageUid, g: fields.masterKeyGeneration, h: fields.rawSha256, fp: fields.signerFingerprint, st: fields.state, t: fields.verifiedAt };
    const payloadText = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    const seal = `${SEAL_VERSION}.${payloadText}.${toBase64Url(await computeTag(key, fields))}`;
    if (seal.length > MAX_VERIFICATION_SEAL_LENGTH) {
        throw new Error(`A verification seal can't exceed ${MAX_VERIFICATION_SEAL_LENGTH} characters.`);
    }
    return seal;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Splits and decodes a v1 seal, or `undefined` for anything malformed. Never throws. */
function parseSeal(seal: unknown): { fields: SealFields; tag: Uint8Array } | undefined {
    if (typeof seal !== "string" || seal.length > MAX_VERIFICATION_SEAL_LENGTH || !VERIFICATION_SEAL_CHARSET.test(seal)) {
        return undefined;
    }
    const parts = seal.split(".");
    if (parts.length !== 3 || parts[0] !== SEAL_VERSION || !BASE64URL.test(parts[1]) || !BASE64URL.test(parts[2])) {
        return undefined;
    }
    try {
        const tag = fromBase64Url(parts[2]);
        const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(parts[1])));
        if (tag.length !== TAG_LENGTH_BYTES || typeof payload !== "object" || payload === null) {
            return undefined;
        }
        const { v, mb, id, g, h, fp, st, t } = payload as Record<string, unknown>;
        if (
            v !== 1 ||
            typeof mb !== "string" ||
            typeof id !== "string" ||
            !isValidTimestamp(g) ||
            typeof h !== "string" ||
            !SHA256_HEX.test(h) ||
            typeof fp !== "string" ||
            !fp ||
            typeof st !== "string" ||
            !SEALED_STATES.includes(st) ||
            !isValidTimestamp(t)
        ) {
            return undefined;
        }
        return { fields: { mailboxUid: mb, messageUid: id, rawSha256: h, signerFingerprint: fp, state: st, verifiedAt: t, masterKeyGeneration: g }, tag };
    } catch {
        // Invalid base64 or UTF-8, or JSON that won't parse.
        return undefined;
    }
}

/**
 * Opens a seal written by `buildVerificationSeal()`. Resolves `{ signerFingerprint, state, verifiedAt, masterKeyGeneration }`
 * only when the version is known, the tag verifies (constant-time comparison) under this mailbox's seal key, the sealed mailbox and
 * message uids equal `mailboxUid`/`messageUid`, and the sealed hash equals `rawSha256` (the current raw MIME's
 * `rawMimeSha256()`), and - when `expectedMasterKeyGeneration` is given - the sealed generation equals it (the vault's
 * current `masterKeyGeneration`; a seal from another generation wouldn't open under that master key anyway, but this
 * checks it explicitly). Anything else - a malformed, truncated, tampered, foreign or oversized seal, or a seal sealed
 * under a different master key - resolves `undefined`; this never throws for the seal's content. Throws
 * `KeysLockedError` for destroyed keys, whatever the seal.
 */
export async function openVerificationSeal(
    mailboxUid: string,
    unlocked: SealKeyMaterial,
    messageUid: string,
    seal: string | undefined,
    rawSha256: string,
    expectedMasterKeyGeneration?: number,
): Promise<OpenedVerificationSeal | undefined> {
    assertNotDestroyed(unlocked);
    const parsed = parseSeal(seal);
    if (!parsed) {
        return undefined;
    }
    const key = await importSealKey(mailboxUid, unlocked);
    // The tag is computed over the values the caller expects, so a seal for another mailbox or message fails the MAC as
    // well as the explicit comparison below.
    const expected = await computeTag(key, { ...parsed.fields, mailboxUid, messageUid });
    const { fields } = parsed;
    const tagMatches = constantTimeEqual(expected, parsed.tag);
    if (
        !tagMatches ||
        fields.mailboxUid !== mailboxUid ||
        fields.messageUid !== messageUid ||
        fields.rawSha256 !== String(rawSha256).toLowerCase() ||
        (expectedMasterKeyGeneration !== undefined && fields.masterKeyGeneration !== expectedMasterKeyGeneration)
    ) {
        return undefined;
    }
    return {
        signerFingerprint: fields.signerFingerprint,
        state: fields.state as SealedVerificationState,
        verifiedAt: fields.verifiedAt,
        masterKeyGeneration: fields.masterKeyGeneration,
    };
}
