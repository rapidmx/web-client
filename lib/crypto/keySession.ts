///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The in-memory session key store `specs/end-to-end_encryption.md`'s "Keypair Generation & Storage"
 * requires: "When a user logs in ... the private keys MUST be downloaded from the server, decrypted,
 * and stored locally on the device in a secure location. When the user explicitly logs out ..., the
 * private keys MUST be destroyed." This module is that store — a plain module-level `Map`, deliberately
 * never `localStorage`/IndexedDB (a page reload or new tab correctly starts with no unlocked keys,
 * requiring the unlock credential again, matching "destroyed on explicit logout" while never
 * persisting unwrapped key material anywhere durable).
 *
 * `KeyEnrollmentGate` (in `web-client`) is what actually prompts for the unlock credential and calls
 * `unlockWithPassword()` below, once per mailbox per session, before rendering the mailbox's real
 * content — see that component's own doc comment.
 *
 * **Password and recovery code are the unlock methods implemented so far** (`unlockWithPassword()`,
 * `unlockWithRecoveryCode()`, which share one master-key-to-session step). Passkey (`passkeyUnlock.ts`)
 * derivation exists and could unwrap the same `MasterKeyWrap` shape, but nothing calls it yet — a real
 * follow-up, not a silent gap: a mailbox enrolled *only* with a passkey has no way to unlock through this
 * module today.
 */
import { type KeyVault, type PublicKey, type WrappedPrivateKey, findActivePublicKey, getKeyVault } from "./keyvaultApi.js";
import { fromBase64 } from "./encoding.js";
import { importPrivateKeyPkcs8 } from "./keys.js";
import { KeysLockedError, buildAad, openWithKey } from "./masterKey.js";
import { deriveFromPassword, parseArgon2idKdfLabel } from "./passwordUnlock.js";
import { RECOVERY_KDF_LABEL, deriveFromRecoveryCode } from "./recoveryCode.js";

/** AAD purpose labels — MUST exactly match what `KeyEnrollmentGate.tsx` used when it originally
 * sealed each of these values, or `openWithKey()` fails (GCM authenticates the AAD, not just the
 * ciphertext). Centralized here as the one place both wrapping and unwrapping refer to. */
export const MASTER_KEY_AAD_PURPOSE = "master-key";
export const SIGNING_PRIVATE_KEY_AAD_PURPOSE = "sign-private-key";
export const ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE = "encrypt-private-key";

export { KeysLockedError };

/** How many retained (non-active) encryption keys an unlock opens at most: the most recently issued ones by
 * `notBefore`. Each costs an AEAD open and a key import at unlock, and `smime.ts`'s `decryptEnvelopedDataWithKeys()`
 * considers the active key plus this many (`MAX_DECRYPTION_KEYS`). Mail encrypted to a key older than the 20 most
 * recent retained ones doesn't decrypt on this device; its wrapped key stays in the vault. */
export const MAX_RETAINED_ENCRYPTION_KEYS = 20;

/** An older encryption key an unlock opened besides the active one - see `UnlockedKeys.retainedEncryptionKeys`. */
export interface RetainedEncryptionKey {
    fingerprint: string;
    /** Base64-decoded DER certificate, from the mailbox's published `PublicKey.publicKey`. */
    certDer: Uint8Array;
    /** Non-extractable ECDH private key. */
    privateKey: CryptoKey;
}

export interface UnlockedKeys {
    /** `true` once `destroyUnlockedKeys()` has destroyed this object's keys (master key zeroed, private key
     * handles dropped). A caller holding an `UnlockedKeys` across an `await` or a user action must treat a
     * destroyed object as locked and re-read `getUnlockedKeys()` instead - `masterKey.ts`'s helpers throw
     * `KeysLockedError` when handed its zeroed master key. Never set on an object still in the store. */
    destroyed?: boolean;
    masterKey: Uint8Array;
    signingPrivateKey?: CryptoKey;
    signingCertDer?: Uint8Array;
    signingFingerprint?: string;
    encryptionPrivateKey?: CryptoKey;
    encryptionCertDer?: Uint8Array;
    encryptionFingerprint?: string;
    /** Every non-active encryption key the mailbox still has a wrapped private key for and a published `encrypt` key
     * listed in its keys - superseded, expired *and* compromised ones - newest first, at most
     * `MAX_RETAINED_ENCRYPTION_KEYS`. The spec retains an old encryption private key indefinitely on rotation, because
     * discarding it makes old mail unreadable. **Decryption only:** `evaluateMessageSecurity()` tries these after the
     * active key; nothing encrypts to or signs with them (`findActivePublicKey()` still picks the only key used for
     * that). A compromised key is kept because reading one's own mail encrypted to it is still needed. Absent when there
     * are none. */
    retainedEncryptionKeys?: RetainedEncryptionKey[];
}

const sessions = new Map<string, UnlockedKeys>();

/** The one method of `WeakRef` this module uses - typed locally because the build's `ES2020` lib predates it. */
interface WeakHandle<T> {
    deref(): T | undefined;
}

/** A weak reference to `target` where the runtime has `WeakRef` (every supported browser and Node), otherwise a
 * strong one - a missing `WeakRef` must never make a lock skip an object. */
function weakHandle<T extends object>(target: T): WeakHandle<T> {
    const WeakRefCtor = (globalThis as { WeakRef?: new (target: T) => WeakHandle<T> }).WeakRef;
    return WeakRefCtor ? new WeakRefCtor(target) : { deref: () => target };
}

/** Every `UnlockedKeys` object this store has handed out per mailbox and not yet destroyed - a re-unlock
 * replaces the store entry but leaves the previous object usable for in-flight consumers, so a lock must
 * reach all of them, not only the newest. Held *weakly*: the current object is kept alive by `sessions`, and a
 * replaced one (e.g. holding a pre-rotation master key) only for as long as some consumer still references it -
 * once nothing does, it can be collected instead of lingering until the next lock. A lock destroys every one
 * still reachable, which is every one anybody could still use. */
const issued = new Map<string, Set<WeakHandle<UnlockedKeys>>>();
/** Bumped by every `destroyUnlockedKeys()` call for that mailbox (`lockAllGeneration` for a destroy-all),
 * so an unlock still awaiting the vault/KDF when a lock happens can tell and discard what it unwrapped. */
const lockGenerations = new Map<string, number>();
let lockAllGeneration = 0;

function lockGeneration(mailboxUid: string): string {
    return `${lockAllGeneration}:${lockGenerations.get(mailboxUid) ?? 0}`;
}

/** What changed in the session store — passed to every `subscribeKeySession()` listener. */
export interface KeySessionEvent {
    mailboxUid: string;
    /** `"unlocked"` when keys were stored (a first unlock, or a re-unlock replacing existing keys, e.g.
     * after a key rotation); `"locked"` when they were destroyed. */
    state: "unlocked" | "locked";
}

export type KeySessionListener = (event: KeySessionEvent) => void;

const listeners = new Set<KeySessionListener>();

function notify(event: KeySessionEvent): void {
    // Iterate a snapshot so a listener that unsubscribes (or subscribes another) mid-dispatch can't skip
    // or double-deliver. A throwing listener must never stop the rest - especially on "locked", where a
    // later listener may be the one clearing decrypted content from the screen - so its error is
    // rethrown asynchronously instead, still surfacing as an uncaught error without aborting delivery.
    for (const listener of [...listeners]) {
        try {
            listener(event);
        } catch (err) {
            queueMicrotask(() => {
                throw err;
            });
        }
    }
}

/**
 * Subscribes to session store changes: fires once per mailbox whenever its keys are unlocked (stored)
 * or destroyed, so a UI can e.g. clear already-decrypted content the moment keys go away instead of
 * polling `getUnlockedKeys()`. A `destroyUnlockedKeys()` call that finds nothing to destroy fires
 * nothing. Returns an unsubscribe function.
 */
export function subscribeKeySession(listener: KeySessionListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Reads back a mailbox's already-unlocked keys this session, or `undefined` if it hasn't been
 * unlocked yet (or was destroyed). Never triggers an unlock itself. */
export function getUnlockedKeys(mailboxUid: string): UnlockedKeys | undefined {
    return sessions.get(mailboxUid);
}

/**
 * Destroys one mailbox's unlocked keys, or every mailbox's if called with no argument — the spec's
 * "destroyed on explicit logout" / "session revocation" / "configurable idle period" triggers.
 *
 * The master key's bytes are overwritten with zeros in place before the entry is dropped, so any
 * `UnlockedKeys` object a caller is still holding no longer carries usable key material either (and the
 * bytes don't linger until garbage collection). That object is also marked `destroyed: true` and its
 * private key `CryptoKey` handles are removed (their material is never exposed to JS, so there is nothing
 * to zero - but a stale holder must not keep signing/decrypting with them after a lock). Sealing/opening
 * with the zeroed master key throws `KeysLockedError` (see `masterKey.ts`).
 *
 * Every object handed out for the mailbox is destroyed - including ones a re-unlock already replaced in the
 * store - and an `unlockWithPassword()`/`unlockWithRecoveryCode()` still in flight for it when this runs throws `KeysLockedError`
 * instead of restoring keys after the lock.
 */
export function destroyUnlockedKeys(mailboxUid?: string): void {
    if (mailboxUid) {
        lockGenerations.set(mailboxUid, (lockGenerations.get(mailboxUid) ?? 0) + 1);
    } else {
        lockAllGeneration++;
    }
    const uids = mailboxUid ? [mailboxUid] : [...issued.keys()];
    for (const uid of uids) {
        const objects = issued.get(uid);
        if (!objects) {
            continue;
        }
        for (const handle of objects) {
            const unlocked = handle.deref();
            if (unlocked) {
                destroyObject(unlocked);
            }
        }
        issued.delete(uid);
        sessions.delete(uid);
        notify({ mailboxUid: uid, state: "locked" });
    }
}

function destroyObject(unlocked: UnlockedKeys): void {
    unlocked.masterKey.fill(0);
    unlocked.destroyed = true;
    delete unlocked.signingPrivateKey;
    delete unlocked.encryptionPrivateKey;
    if (unlocked.retainedEncryptionKeys) {
        // Emptied in place as well as removed, so a consumer that captured the array itself loses the handles too.
        unlocked.retainedEncryptionKeys.length = 0;
        delete unlocked.retainedEncryptionKeys;
    }
}

/** Finds the wrapped private key whose fingerprint matches a given published public key. */
function findWrappedPrivateKey(vault: KeyVault, fingerprint: string) {
    return vault.wrappedKeys.find((k) => k.fingerprint === fingerprint);
}

/** What `unlockWithPassword()` resolves with (and the base of `unlockWithRecoveryCode()`'s result). */
export interface UnlockResult {
    /** Fingerprints of the active *signing* key and any retained (non-active) *encryption* keys whose wrapped private
     * key couldn't be opened or imported with the (correctly unwrapped) master key - e.g. a wrap sealed under a master
     * key a later rekey replaced. The unlock still succeeds without them (no `signingPrivateKey`; the retained key is
     * left out of `retainedEncryptionKeys`), so a user isn't locked out of reading mail by a key they can't use. Empty
     * when every key opened. */
    unopenableKeys: string[];
}

/**
 * Thrown by `unlockWithPassword()` when the password was right (the master key unwrapped) but the active
 * *encryption* key's wrapped private key couldn't be opened or imported with it. Distinct from the
 * wrong-password failure (which rejects with the underlying AEAD error from opening the password wrap), so a
 * UI can say "your encryption key can't be opened" instead of "incorrect password".
 */
export class UnopenableEncryptionKeyError extends Error {
    public readonly fingerprint: string;
    /** The underlying AEAD/import failure. */
    public readonly cause: unknown;

    constructor(fingerprint: string, cause?: unknown) {
        super(`The encryption key ${fingerprint} for this mailbox couldn't be opened with its master key.`);
        this.name = "UnopenableEncryptionKeyError";
        this.fingerprint = fingerprint;
        this.cause = cause;
    }
}

/** Opens one wrapped PKCS#8 private key under `masterKey` and imports it (non-extractable by default, like
 * `importPrivateKeyPkcs8()` itself), zeroing the transient plaintext whether or not the import succeeds. */
async function openPrivateKey(
    masterKey: Uint8Array,
    wrapped: WrappedPrivateKey,
    aad: Uint8Array,
    algorithm: EcKeyImportParams,
    usages: KeyUsage[],
    extractable = false,
): Promise<CryptoKey> {
    const raw = await openWithKey(masterKey, wrapped, aad);
    try {
        return await importPrivateKeyPkcs8(raw, algorithm, usages, extractable);
    } finally {
        raw.fill(0);
    }
}

/**
 * Opens the retained encryption keys onto `unlocked.retainedEncryptionKeys`: every published `encrypt` key in
 * `mailboxKeys` other than the active one (`activeFingerprint`), whatever its revocation or expiry, that has a wrapped
 * private key in the vault - de-duplicated by fingerprint, newest `notBefore` first, at most
 * `MAX_RETAINED_ENCRYPTION_KEYS`. A key that won't open or import, or whose certificate won't decode, is skipped and
 * added to `unopenableKeys`. Retained keys are imported non-extractable. Each key is attached as it opens, so a failed
 * unlock's `destroyObject()` drops those too.
 */
async function openRetainedEncryptionKeys(
    mailboxUid: string,
    mailboxKeys: PublicKey[],
    vault: KeyVault,
    unlocked: UnlockedKeys,
    activeFingerprint: string | undefined,
    unopenableKeys: string[],
): Promise<void> {
    const seen = new Set<string>(activeFingerprint !== undefined ? [activeFingerprint] : []);
    const candidates: { publicKey: PublicKey; wrapped: WrappedPrivateKey }[] = [];
    for (const publicKey of [...mailboxKeys].sort((a, b) => b.notBefore - a.notBefore)) {
        const wrapped = publicKey.useType === "encrypt" && !seen.has(publicKey.fingerprint) ? findWrappedPrivateKey(vault, publicKey.fingerprint) : undefined;
        if (!wrapped) {
            continue;
        }
        seen.add(publicKey.fingerprint);
        candidates.push({ publicKey, wrapped });
        if (candidates.length === MAX_RETAINED_ENCRYPTION_KEYS) {
            break;
        }
    }

    const aad = buildAad(mailboxUid, ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE);
    for (const { publicKey, wrapped } of candidates) {
        try {
            const certDer = fromBase64(publicKey.publicKey);
            const privateKey = await openPrivateKey(unlocked.masterKey, wrapped, aad, { name: "ECDH", namedCurve: "P-256" }, ["deriveBits"], false);
            (unlocked.retainedEncryptionKeys ??= []).push({ fingerprint: publicKey.fingerprint, certDer, privateKey });
        } catch {
            unopenableKeys.push(publicKey.fingerprint);
        }
    }
}

/**
 * Unlocks a mailbox's key vault with its password unlock method: fetches the vault, derives the
 * wrapping key from `password` using the *exact* KDF parameters that wrap was created with, unwraps
 * the master key, then unwraps and imports whichever signing/encryption private keys the mailbox has
 * currently-active public keys for, plus the retained older encryption keys (`UnlockedKeys.retainedEncryptionKeys`).
 * Stores the result in this module's in-memory session store.
 *
 * Throws (never silently no-ops) when there's no password wrap enrolled, or when the password is
 * wrong (AEAD authentication failure opening the password wrap) — callers should present this as
 * "incorrect password," not a generic error, but this module doesn't presume a specific UI's error copy.
 * Once the master key has opened, the password is known to be right: an active signing key that then
 * won't open is skipped and listed in `UnlockResult.unopenableKeys` (so is a retained encryption key); an active
 * encryption key that won't
 * open still fails the unlock, with `UnopenableEncryptionKeyError`. Throws `KeysLockedError` when
 * `destroyUnlockedKeys()` locked this mailbox (or all mailboxes) while the unlock was in flight.
 */
export async function unlockWithPassword(mailboxUid: string, mailboxKeys: PublicKey[], password: string): Promise<UnlockResult> {
    const generation = lockGeneration(mailboxUid);
    const vault = await getKeyVault(mailboxUid);
    const passwordWrap = vault.masterKeyWraps.find((w) => w.method === "password");
    if (!passwordWrap) {
        throw new Error("This mailbox has no password unlock method enrolled.");
    }
    const kdfParams = parseArgon2idKdfLabel(passwordWrap.kdf);
    if (!kdfParams) {
        throw new Error(`Unrecognized KDF for this mailbox's password wrap: ${passwordWrap.kdf}`);
    }

    const salt = fromBase64(passwordWrap.salt);
    const { wrappingKey } = await deriveFromPassword(password, salt, kdfParams);
    const masterKey = await openWithKey(
        wrappingKey,
        { ciphertext: passwordWrap.ciphertext, nonce: passwordWrap.nonce },
        buildAad(mailboxUid, MASTER_KEY_AAD_PURPOSE),
    );

    return openSession(mailboxUid, mailboxKeys, vault, masterKey, generation);
}

/** What `unlockWithRecoveryCode()` resolves with. */
export interface RecoveryUnlockResult extends UnlockResult {
    /** The `methodId` of the recovery wrap the code opened (e.g. `"recovery-3"`). Recovery codes are single-use:
     * pass it to `masterKeyWraps.ts`'s `consumeRecoveryCode()` once the unlock flow is done. Absent only for a
     * recovery wrap stored without a `methodId`, which `buildRecoveryWraps()` never produces. */
    recoveryMethodId?: string;
    /** How many *other* recovery wraps the vault holds - the codes left once this one is consumed. */
    remainingRecoveryCodes: number;
}

/** The one rejection for a recovery code that opens nothing - a wrong code and a vault with no recovery wraps
 * alike, so a UI can say "that recovery code didn't work" without learning (or revealing) which it was. */
const RECOVERY_CODE_REJECTED = "That recovery code didn't unlock this mailbox.";

/**
 * Unlocks a mailbox's key vault with one of its recovery codes: fetches the vault, tries every `"recovery"` wrap
 * (`kdf: "hkdf-sha256"`) with `deriveFromRecoveryCode(code, salt)` until one opens the master key, then opens the
 * signing/encryption private keys and stores the session exactly as `unlockWithPassword()` does - the same
 * `unopenableKeys` handling, `UnopenableEncryptionKeyError`, `KeysLockedError` on a lock mid-unlock, and
 * `subscribeKeySession()` notification. `code` is normalized first (case, spacing, dashes, O/I/L slips).
 *
 * A wrong code and a vault with no recovery wraps both reject with the same plain `Error` (never saying which
 * wrap was tried or failed) - the recovery-code counterpart of `unlockWithPassword()`'s wrong-password rejection.
 *
 * A recovery code is single-use, but this function writes nothing: the caller removes the used wrap afterwards
 * with `consumeRecoveryCode(mailboxUid, result.recoveryMethodId)` (and may first offer a new password via
 * `replacePasswordWrap()` - see that function for why that order is the safe one).
 */
export async function unlockWithRecoveryCode(mailboxUid: string, mailboxKeys: PublicKey[], code: string): Promise<RecoveryUnlockResult> {
    const generation = lockGeneration(mailboxUid);
    const vault = await getKeyVault(mailboxUid);
    const recoveryWraps = vault.masterKeyWraps.filter((w) => w.method === "recovery");
    const aad = buildAad(mailboxUid, MASTER_KEY_AAD_PURPOSE);

    let opened: { masterKey: Uint8Array; methodId?: string } | undefined;
    for (const wrap of recoveryWraps) {
        if (wrap.kdf !== RECOVERY_KDF_LABEL) {
            continue;
        }
        let wrappingKey: Uint8Array | undefined;
        try {
            wrappingKey = await deriveFromRecoveryCode(code, fromBase64(wrap.salt));
            opened = { masterKey: await openWithKey(wrappingKey, { ciphertext: wrap.ciphertext, nonce: wrap.nonce }, aad), methodId: wrap.methodId };
        } catch {
            // Wrong code for this wrap (AEAD failure), an empty code, or a corrupt wrap - all just "not this one".
        } finally {
            wrappingKey?.fill(0);
        }
        if (opened) {
            break;
        }
    }
    if (!opened) {
        throw new Error(RECOVERY_CODE_REJECTED);
    }

    const result = await openSession(mailboxUid, mailboxKeys, vault, opened.masterKey, generation);
    return {
        ...result,
        ...(opened.methodId !== undefined ? { recoveryMethodId: opened.methodId } : {}),
        remainingRecoveryCodes: recoveryWraps.length - 1,
    };
}

/**
 * Shared tail of every unlock method once its wrap has yielded `masterKey`: opens and imports the active signing and
 * encryption private keys and the retained encryption keys (`openRetainedEncryptionKeys()`), aborts with `KeysLockedError` if the mailbox was locked since `generation` was taken, then
 * stores the result (tracked weakly in `issued`) and notifies. Zeroes `masterKey` on any failure.
 */
async function openSession(
    mailboxUid: string,
    mailboxKeys: PublicKey[],
    vault: KeyVault,
    masterKey: Uint8Array,
    generation: string,
): Promise<UnlockResult> {
    const unlocked: UnlockedKeys = { masterKey };
    const unopenableKeys: string[] = [];

    // The active private keys are imported *non-extractable*, same as the retained encryption keys below (round-5
    // review; previously imported extractable, on the reasoning that an XSS able to call `exportKey()` on these
    // handles could equally call `openWithKey()` with the in-memory master key - but that framing missed that
    // `exportKey()` yields raw bytes an attacker can copy out and keep *after* the session ends (logout, master-key
    // zeroing), whereas the master-key-access path only works while the session is live. Their one former consumer,
    // `keyRotation.ts`'s `rewrapPrivateKeysUnderNewMasterKey()`, was removed (2026-09-15; it re-wrapped only the
    // active keys, and web-client's rotation re-seals every vault wrap itself) - confirmed nothing in this package
    // or in `web-client`/`electron-client` calls `exportKey()` on a session key at all, so nothing depends on this
    // being extractable. The transient PKCS#8 plaintext buffers are zeroed as soon as WebCrypto has copied them
    // into a `CryptoKey` either way.
    try {
        const signingPublicKey = findActivePublicKey(mailboxKeys, "sign");
        const wrappedSigningKey = signingPublicKey && findWrappedPrivateKey(vault, signingPublicKey.fingerprint);
        if (signingPublicKey && wrappedSigningKey) {
            try {
                const aad = buildAad(mailboxUid, SIGNING_PRIVATE_KEY_AAD_PURPOSE);
                unlocked.signingPrivateKey = await openPrivateKey(masterKey, wrappedSigningKey, aad, { name: "ECDSA", namedCurve: "P-256" }, ["sign"]);
                unlocked.signingCertDer = fromBase64(signingPublicKey.publicKey);
                unlocked.signingFingerprint = signingPublicKey.fingerprint;
            } catch {
                unopenableKeys.push(signingPublicKey.fingerprint);
            }
        }

        const encryptionPublicKey = findActivePublicKey(mailboxKeys, "encrypt");
        const wrappedEncryptionKey = encryptionPublicKey && findWrappedPrivateKey(vault, encryptionPublicKey.fingerprint);
        if (encryptionPublicKey && wrappedEncryptionKey) {
            try {
                const aad = buildAad(mailboxUid, ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE);
                unlocked.encryptionPrivateKey = await openPrivateKey(masterKey, wrappedEncryptionKey, aad, { name: "ECDH", namedCurve: "P-256" }, ["deriveBits"]);
            } catch (err) {
                throw new UnopenableEncryptionKeyError(encryptionPublicKey.fingerprint, err);
            }
            unlocked.encryptionCertDer = fromBase64(encryptionPublicKey.publicKey);
            unlocked.encryptionFingerprint = encryptionPublicKey.fingerprint;
        }

        await openRetainedEncryptionKeys(mailboxUid, mailboxKeys, vault, unlocked, encryptionPublicKey?.fingerprint, unopenableKeys);
        if (lockGeneration(mailboxUid) !== generation) {
            // Locked (e.g. logout) while this unlock was awaiting - never restore keys after that.
            throw new KeysLockedError();
        }
    } catch (err) {
        // A failed unlock never reaches the session store, so nothing else would ever zero this.
        destroyObject(unlocked);
        throw err;
    }

    // A re-unlock replacing existing keys (e.g. `settings/encryption`'s post-rotation refresh) deliberately
    // does NOT zero the previous entry's master key: an in-flight consumer that captured the old
    // `UnlockedKeys` object (e.g. a local-index build pass) is still legitimately using it, and nothing
    // "destroyed" the session - only `destroyUnlockedKeys()` does that, and it destroys every issued object still
    // reachable. The store itself keeps the replaced object only weakly (see `issued`).
    sessions.set(mailboxUid, unlocked);
    const objects = issued.get(mailboxUid) ?? new Set<WeakHandle<UnlockedKeys>>();
    // Drop handles whose object was already collected, so repeated re-unlocks don't grow the set.
    for (const handle of objects) {
        if (!handle.deref()) {
            objects.delete(handle);
        }
    }
    objects.add(weakHandle(unlocked));
    issued.set(mailboxUid, objects);
    notify({ mailboxUid, state: "unlocked" });
    return { unopenableKeys };
}
