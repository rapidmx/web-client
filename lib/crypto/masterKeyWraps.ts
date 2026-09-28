///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Builds a fresh `MasterKeyWrap` for the password and recovery-code unlock methods, given an
 * already-generated (or already-unwrapped) master key (MK). Extracted from `web-client`'s
 * `KeyEnrollmentGate.tsx` (first-sign-in provisioning) so its Settings page's "add a password
 * method"/"regenerate recovery codes" actions - which wrap the *same* MK a second time, not a freshly
 * generated one - can reuse the exact same wrap-construction logic rather than a second, potentially
 * drifting copy of it.
 *
 * Every builder throws `KeysLockedError` (`masterKey.ts`) when `mk` is a destroyed (all-zero) master key -
 * wrapping one would upload a wrap that "unlocks" to a useless key.
 */
import { toBase64 } from "./encoding.js";
import { KeysLockedError, assertKeyMaterialUsable, buildAad, sealWithKey } from "./masterKey.js";
import { MASTER_KEY_AAD_PURPOSE, type UnlockedKeys } from "./keySession.js";
import { type KeyVault, type MasterKeyWrap, addMasterKeyWrap, getKeyVault, removeMasterKeyWrap } from "./keyvaultApi.js";
import { Argon2idParams, DEFAULT_ARGON2ID_PARAMS, argon2idKdfLabel, deriveFromPassword, generateSalt } from "./passwordUnlock.js";
import { RECOVERY_KDF_LABEL, deriveFromRecoveryCode, generateRecoveryCode } from "./recoveryCode.js";

export { RECOVERY_KDF_LABEL };
export const WRAP_SCHEME_VERSION = 1;
export const RECOVERY_CODE_COUNT = 8;

/** Wraps `mk` under `password` (fresh Argon2id salt every time, even when replacing an existing
 * password wrap). `params` defaults to this module's own recommended parameters - overridable only so
 * tests can substitute cheaper ones; production callers should omit it and let the default (which can
 * be raised over time, per `passwordUnlock.ts`'s own doc comment on why each wrap stores the exact
 * parameters it was created with) apply. */
export async function buildPasswordWrap(
    mailboxUid: string,
    mk: Uint8Array,
    password: string,
    params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS,
): Promise<MasterKeyWrap> {
    assertKeyMaterialUsable(mk);
    const salt = generateSalt();
    const { wrappingKey } = await deriveFromPassword(password, salt, params);
    const sealed = await sealWithKey(wrappingKey, mk, buildAad(mailboxUid, MASTER_KEY_AAD_PURPOSE));
    return {
        method: "password",
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        salt: toBase64(salt),
        kdf: argon2idKdfLabel(params),
        schemeVersion: WRAP_SCHEME_VERSION,
        createdAt: Date.now(),
    };
}

/** Generates `count` fresh recovery codes and wraps `mk` under each, returning both the wraps (to
 * upload) and the plaintext codes (to show the user exactly once - callers must never persist these
 * themselves). Each wrap's `methodId` is a sequence label, deliberately not derived from the code
 * itself - that would let anyone who saw a wrap's `methodId` narrow down which physical code it
 * corresponds to. */
export async function buildRecoveryWraps(
    mailboxUid: string,
    mk: Uint8Array,
    count: number = RECOVERY_CODE_COUNT,
): Promise<{ wraps: MasterKeyWrap[]; codes: string[] }> {
    assertKeyMaterialUsable(mk);
    const aad = buildAad(mailboxUid, MASTER_KEY_AAD_PURPOSE);
    const codes: string[] = [];
    const wraps: MasterKeyWrap[] = [];
    for (let i = 0; i < count; i++) {
        const code = generateRecoveryCode();
        const salt = generateSalt();
        const wrappingKey = await deriveFromRecoveryCode(code, salt);
        const sealed = await sealWithKey(wrappingKey, mk, aad);
        codes.push(code);
        wraps.push({
            method: "recovery",
            methodId: `recovery-${i + 1}`,
            ciphertext: sealed.ciphertext,
            nonce: sealed.nonce,
            salt: toBase64(salt),
            kdf: RECOVERY_KDF_LABEL,
            schemeVersion: WRAP_SCHEME_VERSION,
            createdAt: Date.now(),
        });
    }
    return { wraps, codes };
}

/** `nonce`/`salt` labels for an escrow wrap - see `buildEscrowWrap()`'s own doc comment for why these
 * are fixed placeholders rather than freshly generated values, unlike every other wrap method.
 * Deliberately NOT valid base64 (`fromBase64("n/a")` decodes to 2 arbitrary bytes rather than throwing,
 * since only a length of `4n+1` makes `atob()` reject its input) - any future generic
 * `fromBase64(wrap.salt)`/`fromBase64(wrap.nonce)` refactor across every wrap method MUST special-case
 * (or simply skip) `method === "escrow"` first, or it will silently "succeed" with garbage bytes instead
 * of failing loudly. Nothing in this codebase does that generically today (`keySession.ts` only ever
 * reads `.salt`/`.nonce` after already filtering to `method === "password"` or `method === "recovery"`), but it's exactly the kind
 * of innocent-looking refactor that would reintroduce this as a real bug. */
export const ESCROW_KDF_LABEL = "cms-enveloped-data";
const ESCROW_NONCE_PLACEHOLDER = "n/a";
const ESCROW_SALT_PLACEHOLDER = "n/a";

/**
 * Wraps `mk` for the `escrow` unlock method: encrypts it as a CMS `EnvelopedData` structure to the
 * escrow scope's own X.509 public-key certificate (`keyvaultApi.ts`'s `getEscrowInfo()` return value) -
 * the exact same "encrypt to a recipient's certificate" operation `smime.ts`'s `encryptForRecipients()`
 * already implements for message bodies, just applied to MK instead. Matches
 * `specs/end-to-end_encryption.md`'s `wrap_escrow = AEAD(escrow scope public key, MK)` pseudocode.
 *
 * Unlike `buildPasswordWrap()`/`buildRecoveryWraps()`, there is no separately-generated salt or nonce
 * here - CMS `EnvelopedData` already embeds everything a holder's own offline tooling needs to unwrap
 * (the content-encryption algorithm, its IV, and the ECDH key-agreement material) inside the ciphertext
 * itself. `nonce`/`salt` are still populated with a fixed, documented placeholder rather than left empty
 * because restapi's own `validateMasterKeyWrap()` requires every `MasterKeyWrap` field to be a non-empty
 * string regardless of method - they carry no cryptographic meaning for this method and a holder's
 * unwrap tooling must never read them.
 *
 * This client never has (and this function never touches) the scope's *private* key - only a holder's
 * own external tooling can ever unwrap the result. `escrowScopeId` is required so `resolveAllowEscrow()`
 * (server-side) can confirm it matches the mailbox's actually-assigned scope before persisting.
 */
export async function buildEscrowWrap(mk: Uint8Array, escrowScopeId: string, scopePublicKeyCertDer: Uint8Array): Promise<MasterKeyWrap> {
    assertKeyMaterialUsable(mk);
    // Loaded here, the one place it is used: `smime.ts` carries PKI.js and the ASN.1/X.509 libraries (over half a megabyte),
    // and this module is imported by every shell that can unlock keys.
    const { encryptForRecipients } = await import("./smime.js");
    const envelopedDer = await encryptForRecipients(mk, [scopePublicKeyCertDer]);
    return {
        method: "escrow",
        escrowScopeId,
        ciphertext: toBase64(envelopedDer),
        nonce: ESCROW_NONCE_PLACEHOLDER,
        salt: ESCROW_SALT_PLACEHOLDER,
        kdf: ESCROW_KDF_LABEL,
        schemeVersion: WRAP_SCHEME_VERSION,
        createdAt: Date.now(),
    };
}

/**
 * Removes the recovery wrap a recovery code just opened (`unlockWithRecoveryCode()`'s `recoveryMethodId`) - recovery
 * codes are single-use. A thin, intention-revealing wrapper over `removeMasterKeyWrap(mailboxUid, "recovery",
 * methodId)`; `methodId` is required, so a missing id can never make the server pick "the" recovery wrap itself.
 *
 * restapi (`BaseKeyVaultRoute.removeMasterKeyWrap()`) refuses with `409` when this wrap is the vault's last non-escrow
 * wrap (the owner's last own unlock method) - e.g. the last recovery code of a vault whose password wrap is gone. A
 * caller replacing a forgotten password should therefore call `replacePasswordWrap()` *before* this, never after:
 * while the code's wrap still exists it is the other unlock method that makes replacing the password safe. A `404`
 * means the wrap is already gone (e.g. consumed from another tab) and is safe to treat as done.
 */
export function consumeRecoveryCode(mailboxUid: string, methodId: string): Promise<KeyVault> {
    if (!methodId) {
        return Promise.reject(new Error("A recovery wrap's methodId is required to consume it."));
    }
    return removeMasterKeyWrap(mailboxUid, "recovery", methodId);
}

/** Why `replacePasswordWrap()` failed - see that function. */
export type PasswordWrapReplaceFailure = "master_key_rotated" | "multiple_password_wraps" | "no_other_unlock_method" | "add_failed";

/**
 * Thrown by `replacePasswordWrap()`. For every `reason` except `"add_failed"` nothing was written. `"add_failed"` means
 * the old password wrap was removed but the new one couldn't be added: `restored` says whether the old wrap was put
 * back (the vault is then as it was), and `cause` holds the add's own error (e.g. an `ApiRequestError` `409` for a
 * master key rotated in the meantime). Either way the mailbox still has the other unlock method checked beforehand.
 */
export class PasswordWrapReplaceError extends Error {
    public readonly reason: PasswordWrapReplaceFailure;
    public readonly restored?: boolean;
    public readonly cause?: unknown;

    constructor(reason: PasswordWrapReplaceFailure, message: string, options: { restored?: boolean; cause?: unknown } = {}) {
        super(message);
        this.name = "PasswordWrapReplaceError";
        this.reason = reason;
        this.restored = options.restored;
        this.cause = options.cause;
    }
}

/** Copies only `MasterKeyWrap`'s own fields, so a wrap read back from the server can be re-posted as-is. */
function wireWrap(wrap: MasterKeyWrap): MasterKeyWrap {
    const { method, methodId, escrowScopeId, ciphertext, nonce, salt, kdf, schemeVersion, createdAt } = wrap;
    return {
        method,
        ...(methodId !== undefined ? { methodId } : {}),
        ...(escrowScopeId !== undefined ? { escrowScopeId } : {}),
        ciphertext,
        nonce,
        salt,
        kdf,
        schemeVersion,
        createdAt,
    };
}

/**
 * Replaces the mailbox's password wrap with one for `newPassword`, wrapping the session's master key
 * (`unlocked.masterKey`, e.g. after `unlockWithRecoveryCode()` for a forgotten password). Resolves with the vault after
 * the new wrap was added.
 *
 * Why remove-then-add: `unlockWithPassword()` only ever tries the first password wrap, and password wraps carry no
 * `methodId`, so restapi can't remove one of two (a `DELETE .../wraps/password` without `methodId` matching two wraps is
 * a `400`). Adding first would leave an unremovable, unused second wrap. The safest order is therefore:
 *
 * 1. Build the new wrap (Argon2id) - fails, e.g. with `KeysLockedError` for destroyed keys, before any request.
 * 2. Read the vault and refuse, writing nothing, with `PasswordWrapReplaceError` when: `expectedMasterKeyGeneration` was
 * given and isn't the vault's (`"master_key_rotated"` - the remove endpoint doesn't check it, so it is checked here);
 * the vault holds more than one password wrap (`"multiple_password_wraps"`); or removing the password wrap would
 * leave no other own unlock wrap, i.e. no non-escrow, non-password wrap (`"no_other_unlock_method"` - restapi's
 * remove endpoint refuses that with `409` too, since it counts only non-escrow wraps as the owner's own; checking
 * here first gives a typed reason without a write attempt).
 * 3. Remove the old password wrap (skipped when there is none: the new wrap is simply added). A failure here is
 * rethrown as-is; nothing changed.
 * 4. Add the new wrap, sending `expectedMasterKeyGeneration` when given (restapi answers `409` if the master key was
 * rotated since). If this fails, the removed wrap is re-added (with the generation read in step 2) and
 * `PasswordWrapReplaceError` `"add_failed"` is thrown with `restored`. If even that fails the mailbox has no password
 * wrap, but step 2 guaranteed another own unlock method remains - the user can unlock with it and retry.
 *
 * Because step 2 needs another own unlock method, a caller replacing a password after a recovery-code unlock must call
 * this *before* `consumeRecoveryCode()`: the not-yet-consumed code's wrap is that other method.
 */
export async function replacePasswordWrap(
    mailboxUid: string,
    unlocked: Pick<UnlockedKeys, "masterKey" | "destroyed">,
    newPassword: string,
    expectedMasterKeyGeneration?: number,
    params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS,
): Promise<KeyVault> {
    if (unlocked.destroyed) {
        throw new KeysLockedError();
    }
    const newWrap = await buildPasswordWrap(mailboxUid, unlocked.masterKey, newPassword, params);
    const vault = await getKeyVault(mailboxUid);

    if (expectedMasterKeyGeneration !== undefined && (vault.masterKeyGeneration ?? 0) !== expectedMasterKeyGeneration) {
        throw new PasswordWrapReplaceError(
            "master_key_rotated",
            "This mailbox's master key was rotated since it was unlocked - unlock it again before changing the password.",
        );
    }
    const passwordWraps = vault.masterKeyWraps.filter((w) => w.method === "password");
    if (passwordWraps.length > 1) {
        throw new PasswordWrapReplaceError("multiple_password_wraps", "This mailbox has more than one password wrap, so the old one can't be removed safely.");
    }
    const oldWrap = passwordWraps[0];
    if (oldWrap && !vault.masterKeyWraps.some((w) => w.method !== "password" && w.method !== "escrow")) {
        throw new PasswordWrapReplaceError(
            "no_other_unlock_method",
            "The password is this mailbox's only unlock method - add another one (e.g. recovery codes) before replacing it.",
        );
    }
    if (unlocked.destroyed) {
        throw new KeysLockedError();
    }

    if (oldWrap) {
        await removeMasterKeyWrap(mailboxUid, "password");
    }
    try {
        return await addMasterKeyWrap(mailboxUid, newWrap, expectedMasterKeyGeneration);
    } catch (err) {
        if (!oldWrap) {
            throw err;
        }
        const restored = await addMasterKeyWrap(mailboxUid, wireWrap(oldWrap), vault.masterKeyGeneration).then(
            () => true,
            () => false,
        );
        throw new PasswordWrapReplaceError("add_failed", "The new password couldn't be saved.", { restored, cause: err });
    }
}
