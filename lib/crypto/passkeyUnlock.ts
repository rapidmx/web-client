///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The "passkey" unlock method from `specs/end-to-end_encryption.md`'s "Master Key Wrapping": uses the
 * WebAuthn **PRF extension** to obtain a stable per-credential secret, then HKDF-derives a wrapping key
 * from it — `wrap_passkey_N = AEAD(HKDF(WebAuthn-PRF(credential_N, salt)), MK)`. The credential's own
 * private key is non-extractable and never used directly; only the PRF extension's derived secret is.
 *
 * This deliberately talks to the raw `navigator.credentials` WebAuthn API rather than
 * `@simplewebauthn/browser` — that library's `startRegistration`/`startAuthentication` helpers expect a
 * server-generated `optionsJSON` (from `@simplewebauthn/server`'s `generateRegistrationOptions()`/
 * `generateAuthenticationOptions()`), which assumes a full relying-party ceremony with server-side
 * challenge issuance and assertion verification. There is no such flow here — this passkey is never used
 * to authenticate to `@rapidmx/restapi` or auth-server, only as a local, hardware-backed KDF input. A
 * locally-generated challenge is fine because nothing server-side ever verifies this credential's
 * attestation/assertion signature; only the PRF extension output is consumed. Identity/session auth
 * remains entirely `auth-server`'s job (see `.claude/NOTES.md` in `server`).
 *
 * **Needs real hardware/browser verification.** PRF extension behavior (in particular, whether a
 * browser returns `prf.results` on the *registration* ceremony itself vs. only on a subsequent
 * `navigator.credentials.get()`) is not exercisable in this test environment (no real authenticator) —
 * this module's tests mock `navigator.credentials` and cover this module's own request-building/
 * response-parsing logic, not real authenticator behavior end to end. Verify against real hardware
 * before shipping, the same honesty standard `@rapidmx/restapi` holds its own hard-to-verify pieces to
 * (e.g. that repo's `sameIssuingCa()` doc comment).
 */
import { fromBase64Url, toBase64Url } from "./encoding.js";
import { hkdfDerive } from "./masterKey.js";

const PRF_HKDF_INFO = "wrap";
const CHALLENGE_LENGTH_BYTES = 32;

/** Minimal shape of the WebAuthn PRF extension's client extension results this module needs — the DOM
 * lib's own `AuthenticationExtensionsClientOutputs` doesn't yet include `prf` (a newer, Level 3
 * extension), so this is declared locally rather than widening a global type. */
interface PrfClientExtensionResults {
    prf?: {
        enabled?: boolean;
        results?: { first?: ArrayBuffer };
    };
}

export interface PasskeyRegistration {
    /** Base64url-encoded credential ID — stored as `MasterKeyWrap.methodId`. */
    credentialId: string;
    /** Whether this authenticator reported PRF support at registration time. A `false`/absent value here
     * does not necessarily mean PRF evaluation will fail later on some platforms (some only report
     * support upon first `get()`), but MUST be treated as "unknown/unlikely," not "yes." */
    prfSupported: boolean;
}

/**
 * Registers a new platform/roaming passkey for use purely as a local unlock method (see this module's
 * doc comment for why no server round-trip is involved). `rpId` MUST be this deployment's own domain.
 */
export async function registerPasskeyForUnlock(rpId: string, userId: Uint8Array, userName: string): Promise<PasskeyRegistration> {
    const challenge = crypto.getRandomValues(new Uint8Array(CHALLENGE_LENGTH_BYTES));
    const credential = (await navigator.credentials.create({
        publicKey: {
            rp: { id: rpId, name: rpId },
            user: { id: userId as BufferSource, name: userName, displayName: userName },
            challenge: challenge as BufferSource,
            // ES256 - matches this system's P-256 default elsewhere (see crypto/keys.ts).
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
            extensions: { prf: {} },
        },
    })) as PublicKeyCredential;

    const results = credential.getClientExtensionResults() as PrfClientExtensionResults;
    return {
        credentialId: toBase64Url(new Uint8Array(credential.rawId)),
        prfSupported: !!results.prf?.enabled,
    };
}

/**
 * Evaluates the PRF extension for an already-registered passkey and HKDF-derives a wrapping key from the
 * result. Throws if the authenticator doesn't return a PRF output (e.g. it doesn't support the
 * extension) — callers MUST treat that as "this unlock method is unavailable here," not silently fall
 * back to a weaker derivation.
 */
export async function deriveFromPasskey(rpId: string, credentialId: string, salt: Uint8Array): Promise<Uint8Array> {
    const challenge = crypto.getRandomValues(new Uint8Array(CHALLENGE_LENGTH_BYTES));
    const assertion = (await navigator.credentials.get({
        publicKey: {
            rpId,
            challenge: challenge as BufferSource,
            allowCredentials: [{ id: fromBase64Url(credentialId) as BufferSource, type: "public-key" }],
            userVerification: "required",
            extensions: { prf: { eval: { first: salt as BufferSource } } },
        },
    })) as PublicKeyCredential;

    const results = assertion.getClientExtensionResults() as PrfClientExtensionResults;
    const prfOutput = results.prf?.results?.first;
    if (!prfOutput) {
        throw new Error("This passkey did not return a PRF result - it may not support the PRF extension.");
    }
    return hkdfDerive(new Uint8Array(prfOutput), salt, PRF_HKDF_INFO);
}
