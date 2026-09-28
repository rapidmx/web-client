///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s E2E encryption endpoints (`BaseKeyVaultRoute`,
 * `BaseKeyLookupRoute`, `BaseEncryptionPolicyRoute` — mounted in `server` at `mail/mailboxes` and
 * `system/encryption-policy`, see `src/{mongo,sql}/routes/{KeyVaultRoute,KeyLookupRoute,
 * EncryptionPolicyRoute}.ts`). These calls carry only wrapped/ciphertext key material and public
 * certificates — the server never sees an unwrapped private key or master key; see `crypto/masterKey.ts`
 * and `crypto/keys.ts` for the client-side cryptography that produces the values passed here.
 */
import { ApiClient, ApiRequestError, withClient } from "../util/api.js";

/** A cryptographic public key used to sign or encrypt messages — safe to expose publicly. Mirrors
 * `@rapidmx/restapi`'s `PublicKey` type exactly. */
export interface PublicKey {
    /** Base64-encoded DER X.509 certificate. */
    publicKey: string;
    /** The key's type/format (e.g. `x509`). */
    type: string;
    useType: "sign" | "encrypt";
    /** SHA-256 fingerprint of the certificate, hex encoded. */
    fingerprint: string;
    /** UTC timestamp (epoch ms) at which this key becomes valid. */
    notBefore: number;
    /** UTC timestamp (epoch ms) at which this key expires. */
    notAfter: number;
    /** UTC timestamp (epoch ms) at which this key was revoked, if applicable. */
    revokedAt?: number;
    /** Why the key was revoked, alongside `revokedAt`: `"superseded"` for a routine rotation (the key is only retired,
     * so mail it signed stays verifiable), `"compromised"` for a key that must not be trusted. A revoked key with no
     * reason (legacy data) is treated as compromised - see `isTrustedForVerification()`. */
    revocationReason?: "superseded" | "compromised";
    /** Base64-encoded DER X.509 certificate of this key's direct issuer, when known. restapi uses it to recognize a
     * same-CA renewal (see `PreviousKey.replacement`); a UI can show it in a key-changed comparison. */
    issuerCertificate?: string;
}

/** A private key encrypted under the mailbox's master key (MK). Mirrors `@rapidmx/restapi`'s
 * `WrappedPrivateKey` exactly. */
export interface WrappedPrivateKey {
    /** Base64-encoded AEAD ciphertext of the private key. */
    ciphertext: string;
    /** Base64-encoded AEAD nonce. */
    nonce: string;
    /** AEAD algorithm identifier (e.g. `AES-256-GCM`). */
    algorithm: string;
    fingerprint: string;
    useType: "sign" | "encrypt";
}

/** One wrapped copy of the mailbox master key (MK), per unlock method. Mirrors `@rapidmx/restapi`'s
 * `MasterKeyWrap` exactly. */
export interface MasterKeyWrap {
    method: "password" | "passkey" | "recovery" | "escrow";
    /** Opaque identifier for the method instance (e.g. a WebAuthn credential ID). */
    methodId?: string;
    escrowScopeId?: string;
    /** Base64-encoded AEAD ciphertext of the master key. */
    ciphertext: string;
    /** Base64-encoded AEAD nonce. */
    nonce: string;
    /** Base64-encoded KDF salt. */
    salt: string;
    /** KDF identifier and parameters (e.g. `argon2id:m=65536,t=3,p=4`). */
    kdf: string;
    schemeVersion: number;
    createdAt: number;
}

export interface EncryptionPreference {
    lastSeen?: number;
    preferEncrypt: "mutual" | "nopreference";
}

/** A newly observed key that differs from a contact's pinned key of the same `useType` - restapi records it instead of
 * silently replacing the pin (the spec's Key Conflict Handling) until the user resolves it with `resolveKeyConflict()`.
 * A contact holds at most one per `useType`. Mirrors `@rapidmx/restapi`'s `KeyConflict`. */
export interface KeyConflict {
    useType: "sign" | "encrypt";
    /** The key that was observed, in full, so a UI can compare it with the pinned one. */
    observedKey: PublicKey;
    /** UTC timestamp (epoch ms) at which the key was observed. */
    observedAt: number;
    /** Where it was observed: an incoming message's key header, or server-side Discovery. */
    source: "header" | "discovery";
}

/** A contact key that used to be pinned and was replaced - newest first, at most 5 per `useType` on a contact.
 * `replacement` says how: `"automatic"` when restapi replaced an expired or revoked pinned key with one from the same
 * CA issuer, `"user"` when the user accepted a key conflict. Mirrors `@rapidmx/restapi`'s `PreviousKey`. */
export interface PreviousKey extends PublicKey {
    /** UTC timestamp (epoch ms) at which this key stopped being the pinned one. */
    replacedAt: number;
    replacement: "automatic" | "user";
}

/** A key the user rejected when resolving a conflict, remembered so the same key isn't raised again. Mirrors an entry
 * of `@rapidmx/restapi`'s `Contact.rejectedKeys`. */
export interface RejectedKey {
    useType: "sign" | "encrypt";
    fingerprint: string;
    /** UTC timestamp (epoch ms) at which the key was rejected. */
    rejectedAt: number;
}

/** The wire shape `GET`/`POST`/`PUT`/`DELETE` `/mail/mailboxes/:id/keyvault*` return. */
export interface KeyVault {
    wrappedKeys: WrappedPrivateKey[];
    masterKeyWraps: MasterKeyWrap[];
    /** How many times the vault's master key has been rotated (`0` for never, and for no vault yet). Send it back as
     * `expectedMasterKeyGeneration` on a write whose key material was sealed under the master key read with this vault
     * (`enrollKey()`, `startSignEnrollment()`, `addMasterKeyWrap()`, `rekey()`), so restapi refuses it with `409` if
     * another device rotated the master key meanwhile. Absent from servers that don't track it yet. */
    masterKeyGeneration?: number;
}

/** The optional optimistic check restapi applies to vault writes carrying key material sealed under the master key. */
export interface ExpectedMasterKeyGeneration {
    /** The `KeyVault.masterKeyGeneration` read alongside the master key this request's material is sealed under. When
     * given and the vault's generation has moved on, restapi answers `409` instead of installing material nobody can
     * open with the current master key. Omitted, the write is accepted as before. */
    expectedMasterKeyGeneration?: number;
}

/** `client`, given by every function below that calls the network, is an explicit `ApiClient` from `createApiClient()`
 * (e.g. one account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function getKeyVault(mailboxUid: string, client?: ApiClient): Promise<KeyVault> {
    return withClient(client, `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/keyvault`);
}

/** The most recently issued, currently-valid (non-revoked, non-expired) published key of the given use
 * type — the one that should actually be used to sign/encrypt going forward. A mailbox or contact may
 * have several of the same `useType` on file after a rotation; older ones are kept for decrypting old
 * mail, never removed, per the spec's own key-lifecycle rules. Every revoked key is skipped, whatever its
 * `revocationReason` - a superseded key may still verify old mail (`isTrustedForVerification()`) but is never used for
 * new mail. Shared by `crypto/keySession.ts` (the
 * mailbox's own keys) and `crypto/composeSecurity.ts` (a recipient's discovered keys). */
export function findActivePublicKey(keys: PublicKey[], useType: "sign" | "encrypt"): PublicKey | undefined {
    const now = Date.now();
    return keys
        .filter((k) => k.useType === useType && !k.revokedAt && k.notAfter > now)
        .sort((a, b) => b.notBefore - a.notBefore)[0];
}

/**
 * Whether `key` may still be trusted to *verify* existing signatures - never whether to sign or encrypt with it (that is
 * `findActivePublicKey()`, which skips every revoked key). Expired keys are trusted: mail signed while a key was valid
 * stays verifiable after it expires. A key revoked with `revocationReason: "superseded"` (a routine rotation) is trusted
 * for the same reason. A key revoked as `"compromised"`, or revoked with no reason (legacy data, treated as
 * compromised), is never trusted, because a message's claimed signing time can't show it was signed before the
 * compromise.
 */
export function isTrustedForVerification(key: PublicKey): boolean {
    return !key.revokedAt || key.revocationReason === "superseded";
}

/**
 * The fingerprints (lowercased, de-duplicated) of every signing key in `keys` and `previousKeys` that is still trusted
 * for verification (`isTrustedForVerification()`) - the trusted pins to pass to `messageSecurity.ts`'s
 * `evaluateMessageSecurity()` for a `Contact` (its TOFU-pinned `keys` plus its `previousKeys`, which only key
 * discovery, "trust this signer" and conflict resolution write) or a `Mailbox` (its own `keys`, so the user's own mail
 * signed before their rotation still verifies).
 *
 * Key rotation continuity: a `PreviousKey` was pinned before it was replaced - by the user accepting a conflict
 * (`replacement: "user"`) or by restapi's same-issuer renewal of an expired or revoked key (`"automatic"`, which moves
 * the superseded key here with `revocationReason: "superseded"`) - so it is trusted for verification exactly like a
 * current pin, and mail it signed before the rotation still verifies. Both replacement kinds are trusted alike, and the
 * revocation rule is the same for current and previous keys: expired and superseded keys are trusted, compromised and
 * reasonless revoked keys are not.
 */
export function signingKeyFingerprints(keys: PublicKey[] | undefined, previousKeys?: PreviousKey[]): string[] {
    const fingerprints = [...(keys ?? []), ...(previousKeys ?? [])]
        .filter((key) => key.useType === "sign" && isTrustedForVerification(key))
        .map((key) => key.fingerprint.toLowerCase());
    return [...new Set(fingerprints)];
}

export interface EnrollKeyInput extends ExpectedMasterKeyGeneration {
    useType: "sign" | "encrypt";
    /** PEM-encoded PKCS#10 CSR — required (and only meaningful) for `useType: "encrypt"`; the server
     * calls its own internal CA against this CSR. */
    csr?: string;
    /** An already-issued PEM certificate — required (and only meaningful) for `useType: "sign"`. */
    certificate?: string;
    wrappedKey: Omit<WrappedPrivateKey, "fingerprint" | "useType">;
    /** Only meaningful the very first time a mailbox enrolls a key at all (bootstraps its master key). */
    masterKeyWraps?: MasterKeyWrap[];
}

/**
 * Thrown by `enrollKey()` when `masterKeyWraps` were supplied (a first-time vault setup) but the mailbox's vault
 * already has master-key wraps - e.g. another device or tab finished setting it up first. restapi answers `409`;
 * this subclass (still an `ApiRequestError` with `status` 409) is only used once a re-read of the vault confirms it
 * really has wraps, so an unrelated `409` (a lost optimistic-lock race) isn't mistaken for it. A caller should
 * unlock the existing vault instead of enrolling a new master key.
 */
export class VaultAlreadyInitializedError extends ApiRequestError {
    constructor(message: string, code?: string) {
        super(message, 409, code);
        this.name = "VaultAlreadyInitializedError";
    }
}

/** Enrolls a new signing or encryption key. See `EnrollKeyInput`'s own doc comments for which fields
 * matter for which `useType`. Rejects with `VaultAlreadyInitializedError` when `masterKeyWraps` were supplied
 * but the vault is already set up (see that class). */
export async function enrollKey(mailboxUid: string, input: EnrollKeyInput, client?: ApiClient): Promise<KeyVault> {
    try {
        return await withClient<KeyVault>(client, `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/keyvault/keys`, {
            method: "POST",
            body: JSON.stringify(input),
        });
    } catch (err) {
        if (err instanceof ApiRequestError && err.status === 409 && input.masterKeyWraps?.length) {
            const vault = await getKeyVault(mailboxUid, client).catch(() => undefined);
            if (vault && vault.masterKeyWraps.length > 0) {
                throw new VaultAlreadyInitializedError(err.message, err.code);
            }
        }
        throw err;
    }
}

export interface SignEnrollmentRequest extends ExpectedMasterKeyGeneration {
    /** A PEM-encoded PKCS#10 CSR for the signing key pair to enroll. */
    csr: string;
    wrappedKey: Omit<WrappedPrivateKey, "fingerprint" | "useType">;
}

/** Where an automated enrollment is, in the order it normally goes. */
export type SignEnrollmentStage =
    | "submitted"
    | "awaiting-challenge"
    | "challenge-answered"
    | "validating"
    | "issuing"
    | "issued"
    | "failed";

const SIGN_ENROLLMENT_STAGES: readonly string[] = [
    "submitted",
    "awaiting-challenge",
    "challenge-answered",
    "validating",
    "issuing",
    "issued",
    "failed",
];

/** One step of the enrollment's progress, for a stepper: the server names the steps and says which one is under way. */
export interface SignEnrollmentStep {
    id: string;
    label: string;
    state: "done" | "active" | "pending" | "failed";
    /** When the step finished (or started), an ISO date. */
    at?: string;
}

/** The status of a started automated (RFC 8823 ACME) signing-certificate enrollment. Mirrors
 * `@rapidmx/restapi`'s `EnrollmentResult`; every field after `error` is optional because an older server sends only
 * `status`, `certificate` and `error` - callers must degrade to those. Everything the server sends is checked by
 * `normalizeEnrollmentResult()` before it gets here. */
export interface EnrollmentResult {
    status: "pending" | "issued" | "failed";
    /** The issued certificate, PEM-encoded — present only once `status` is `"issued"`. Not needed
     * client-side: once issued, restapi's own `AcmeEnrollmentDriverJob` auto-installs it into this
     * mailbox's `KeyVault` server-side, using the `wrappedKey` already submitted in
     * `startSignEnrollment()` — no further client action installs it. */
    certificate?: string;
    /** A human-readable reason — present only once `status` is `"failed"`. */
    error?: string;
    /** How this deployment issues the certificate: `rfc8823` is automatic (a public CA and an e-mail round trip), `manual` means an administrator uploads it. */
    provider?: "manual" | "rfc8823";
    /** The step the enrollment is at. */
    stage?: SignEnrollmentStage;
    /** All the steps, in order, each with its own state and time. */
    stages?: SignEnrollmentStep[];
    /** 0-100. */
    progress?: number;
    /** ISO dates: when the request was made, when the server last changed it, when the CA was last asked, and when it will next be. */
    requestedAt?: string;
    updatedAt?: string;
    lastCheckedAt?: string;
    nextCheckAt?: string;
    /** A short note from the server about what it is doing or waiting for. */
    note?: string;
    /** A machine-readable reason for a failure, and whether asking for a new certificate is worth trying (a CA that could not be reached is `ca-unreachable`, `retryable`, and still `pending`). */
    errorCode?: string;
    retryable?: boolean;
    /** Once issued. `installedAt` comes later: a job puts the certificate into the mailbox's key vault a few minutes after it is issued, so an
     * enrollment can be `issued` and not yet installed (no `installedAt`, and the mailbox does not list the new key). */
    issuedAt?: string;
    installedAt?: string;
    notAfter?: string;
    serialNumber?: string;
    issuer?: string;
    subject?: string;
}

/** The mailbox's current (most recent) enrollment: an `EnrollmentResult` that also says which one it is. */
export interface CurrentSignEnrollment extends EnrollmentResult {
    enrollmentId: string;
}

const ENROLLMENT_STATUSES = new Set(["pending", "issued", "failed"]);
const STEP_STATES = new Set(["done", "active", "pending", "failed"]);
const ENROLLMENT_TEXT_FIELDS = [
    "certificate",
    "error",
    "requestedAt",
    "updatedAt",
    "lastCheckedAt",
    "nextCheckAt",
    "errorCode",
    "note",
    "issuedAt",
    "installedAt",
    "notAfter",
    "serialNumber",
    "issuer",
    "subject",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads an enrollment status from the network: keeps `status` (an unknown value counts as still `pending`, the safe reading) and
 * whichever optional fields have the right type, drops the rest - an older server's answer comes through as it always did, and a
 * newer one's malformed field cannot break the page. `progress` is clamped to 0-100; a step needs an id, a label and a known state.
 */
export function normalizeEnrollmentResult(raw: unknown): EnrollmentResult {
    const source = isRecord(raw) ? raw : {};
    const result: EnrollmentResult = {
        status: ENROLLMENT_STATUSES.has(source.status as string) ? (source.status as EnrollmentResult["status"]) : "pending",
    };
    for (const field of ENROLLMENT_TEXT_FIELDS) {
        if (typeof source[field] === "string") {
            result[field] = source[field];
        }
    }
    if (source.provider === "manual" || source.provider === "rfc8823") {
        result.provider = source.provider;
    }
    if (typeof source.stage === "string" && SIGN_ENROLLMENT_STAGES.includes(source.stage)) {
        result.stage = source.stage as SignEnrollmentStage;
    }
    if (Array.isArray(source.stages)) {
        result.stages = source.stages
            .filter((step) => isRecord(step) && typeof step.id === "string" && typeof step.label === "string" && STEP_STATES.has(step.state as string))
            .map((step: Record<string, unknown>) => ({
                id: step.id as string,
                label: step.label as string,
                state: step.state as SignEnrollmentStep["state"],
                ...(typeof step.at === "string" ? { at: step.at } : {}),
            }));
    }
    if (typeof source.progress === "number" && Number.isFinite(source.progress)) {
        result.progress = Math.min(100, Math.max(0, source.progress));
    }
    if (typeof source.retryable === "boolean") {
        result.retryable = source.retryable;
    }
    return result;
}

/** Starts an automated (RFC 8823 email-reply-00 ACME) public-CA signing-certificate enrollment —
 * only meaningful when the deployment has `mail:pki:signing_enrollment:backend` set to `"rfc8823"`
 * (a `"manual"`-backend deployment's `SigningCertificateEnrollment` throws instead). Genuinely
 * asynchronous — the CA issues the certificate via a real email round-trip, likely minutes away, not
 * synchronous the way `enrollKey()`'s encryption-key path is — poll `checkSignEnrollmentStatus()`
 * rather than expecting an immediate result. `wrappedKey` is submitted upfront (this server never sees
 * an unwrapped private key) so the eventual install needs no further client action at all. */
export function startSignEnrollment(
    mailboxUid: string,
    input: SignEnrollmentRequest,
    client?: ApiClient,
): Promise<{ enrollmentId: string }> {
    return withClient(client, `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/keyvault/keys/sign-enrollment`, {
        method: "POST",
        body: JSON.stringify(input),
    });
}

/** Reports the current status of a previously started automated enrollment — see
 * `startSignEnrollment()`. Answers from what the server already knows; `checkSignEnrollmentNow()` asks the CA. */
export async function checkSignEnrollmentStatus(mailboxUid: string, enrollmentId: string, client?: ApiClient): Promise<EnrollmentResult> {
    return normalizeEnrollmentResult(
        await withClient<unknown>(
            client,
            `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/keyvault/keys/sign-enrollment/${encodeURIComponent(enrollmentId)}`,
        ),
    );
}

/** The mailbox's current (most recent) signing-certificate enrollment, or `null` when it has never had one - so a second device or
 * a fresh page learns of one started elsewhere. Needs no stored enrollment id. */
export async function getCurrentSignEnrollment(mailboxUid: string, client?: ApiClient): Promise<CurrentSignEnrollment | null> {
    let raw: unknown;
    try {
        raw = await withClient<unknown>(client, `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/keyvault/keys/sign-enrollment`);
    } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) {
            return null;
        }
        throw err;
    }
    const enrollmentId = isRecord(raw) && typeof raw.enrollmentId === "string" ? raw.enrollmentId : undefined;
    return enrollmentId ? { ...normalizeEnrollmentResult(raw), enrollmentId } : null;
}

/** How long a "check now" is refused for after a `429`, when the server doesn't say (it answers `Retry-After`, which `apiFetch()` does not surface). */
export const CHECK_NOW_DEFAULT_RETRY_SECONDS = 10;

/** How many seconds to wait before asking again after `checkSignEnrollmentNow()` was refused with `429`: the body's `retryAfter` (seconds)
 * when the server put one there, else `CHECK_NOW_DEFAULT_RETRY_SECONDS`. `undefined` for any other error. */
export function checkNowRetryAfterSeconds(err: unknown): number | undefined {
    if (!(err instanceof ApiRequestError) || err.status !== 429) {
        return undefined;
    }
    const retryAfter = isRecord(err.details) ? err.details.retryAfter : undefined;
    return typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.ceil(retryAfter)
        : CHECK_NOW_DEFAULT_RETRY_SECONDS;
}

/** Forces an immediate re-check of an enrollment with the CA (instead of waiting for the server's own schedule) and returns its
 * status. The server refuses with `429` when asked again within about ten seconds - see `checkNowRetryAfterSeconds()`. */
export async function checkSignEnrollmentNow(mailboxUid: string, enrollmentId: string, client?: ApiClient): Promise<EnrollmentResult> {
    return normalizeEnrollmentResult(
        await withClient<unknown>(
            client,
            `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/keyvault/keys/sign-enrollment/${encodeURIComponent(enrollmentId)}/check`,
            { method: "POST" },
        ),
    );
}

/** Cancels a pending automated enrollment of this mailbox, so no key is installed from it afterwards, and returns its
 * resulting status. Owner-only. `rekey()` is refused (409) while an enrollment holding a wrapped key is in flight, so
 * this is how an owner with an enrollment stuck at the CA gets to rotate their keys. */
export function cancelSignEnrollment(mailboxUid: string, enrollmentId: string, client?: ApiClient): Promise<EnrollmentResult> {
    return withClient(
        client,
        `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/keyvault/keys/sign-enrollment/${encodeURIComponent(enrollmentId)}`,
        { method: "DELETE" },
    );
}

/** An escrow scope's public key, exposed only via `getEscrowInfo()` below. Mirrors `@rapidmx/restapi`'s
 * `EscrowScopePublicKey` exactly - the same shape as `PublicKey` minus `useType` (an escrow scope's key
 * is only ever used for encryption, never signing). */
export interface EscrowScopePublicKey {
    /** Base64-encoded DER X.509 certificate. */
    publicKey: string;
    type: string;
    fingerprint: string;
    notBefore: number;
    notAfter: number;
    revokedAt?: number;
}

/** The wire shape `GET /mail/mailboxes/:id/escrow-info` returns - see that route's own doc comment
 * (`server`'s `BaseEscrowInfoRoute`) for why this exists as a `server`-only proxy rather than a restapi
 * route: `@rapidmx/restapi`'s own `GET /escrow-scopes/:id` is trusted-admin-only, with no lighter
 * alternative a mailbox owner could use to read the one scope their own mailbox is assigned to. */
export interface EscrowInfo {
    escrowScopeId: string;
    publicKey: EscrowScopePublicKey;
}

/** Fetches `{escrowScopeId, publicKey}` for the `EscrowScope` this mailbox is currently assigned to
 * (`Mailbox.escrowScopeId`, an admin-only assignment - see `EscrowInfo`'s own doc comment). 404s if the
 * mailbox has no escrow scope assigned, the scope no longer exists, or the caller can't access this
 * mailbox. Used by `crypto/masterKeyWraps.ts`'s `buildEscrowWrap()` to get the certificate MK is wrapped
 * against. */
export function getEscrowInfo(mailboxUid: string, client?: ApiClient): Promise<EscrowInfo> {
    return withClient(client, `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/escrow-info`);
}

/** Adds a wrapped copy of the master key for a new unlock method (e.g. registering a new passkey),
 * independent of key enrollment. Requires an already-initialized vault. `expectedMasterKeyGeneration`, when given, is
 * sent alongside the wrap (see `ExpectedMasterKeyGeneration`): a `409` then means the master key was rotated since. */
export function addMasterKeyWrap(
    mailboxUid: string,
    wrap: MasterKeyWrap,
    expectedMasterKeyGeneration?: number,
    client?: ApiClient,
): Promise<KeyVault> {
    const body = expectedMasterKeyGeneration === undefined ? wrap : { ...wrap, expectedMasterKeyGeneration };
    return withClient(client, `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/keyvault/wraps`, {
        method: "POST",
        body: JSON.stringify(body),
    });
}

/** Removes a wrapped copy of the master key for one unlock method. `methodId` is required whenever more
 * than one wrap could share the same `method` (e.g. multiple passkeys). This alone does NOT revoke
 * access for anyone who already captured the wrapped blob — see `rekey()`. */
export function removeMasterKeyWrap(mailboxUid: string, method: string, methodId?: string, client?: ApiClient): Promise<KeyVault> {
    const query = methodId ? `?methodId=${encodeURIComponent(methodId)}` : "";
    return withClient(client, `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/keyvault/wraps/${encodeURIComponent(method)}${query}`, {
        method: "DELETE",
    });
}

export interface RekeyInput extends ExpectedMasterKeyGeneration {
    wrappedKeys: WrappedPrivateKey[];
    /** Every wrap of the new master key. For a mailbox assigned an escrow scope, this must include a fresh escrow wrap
     * for that scope (`buildEscrowWrap()`): `rekey()` drops the old escrow wraps and refuses (409) an escrowed
     * mailbox's rekey without a replacement. */
    masterKeyWraps: MasterKeyWrap[];
    keys: PublicKey[];
}

/** Full, atomic replacement of the mailbox's key-vault contents — the only real revocation mechanism
 * for a captured wrap. Restricted server-side to the mailbox's actual owner. Refused (409) while a signing enrollment
 * holding a wrapped key is in flight (see `cancelSignEnrollment()`), or when an escrowed mailbox's request carries no
 * replacement escrow wrap. */
export function rekey(mailboxUid: string, input: RekeyInput, client?: ApiClient): Promise<KeyVault> {
    return withClient(client, `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/keyvault/rekey`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

/** The wire shape `GET /mail/mailboxes/:id/keys/lookup`, `POST .../keys/trust` and `POST .../keys/resolve` return: the
 * contact's resulting key state. */
export interface KeyLookupResult {
    keys: PublicKey[];
    encryptPreference?: EncryptionPreference;
    /** Unresolved key conflicts, at most one per `useType` - see `resolveKeyConflict()`. */
    keyConflicts?: KeyConflict[];
    /** Keys that were pinned before, newest first - see `PreviousKey`. */
    previousKeys?: PreviousKey[];
}

/** Server-side Discovery: the server itself performs the `_rapidmx` DNS lookup and remote key-endpoint
 * fetch (browsers can't do DNS TXT lookups, and a direct cross-origin fetch would hit CORS), persisting
 * the result onto a `Contact` in the caller's own address book. MUST be called lazily at compose time,
 * never on message receipt (see `specs/end-to-end_encryption.md`'s "Discovery is Server-Side"). */
export function lookupKeys(mailboxUid: string, addr: string, client?: ApiClient): Promise<KeyLookupResult> {
    const query = new URLSearchParams({ addr });
    return withClient(client, `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/keys/lookup?${query.toString()}`);
}

/** What `trustSigner()` pins: the sender's address and the certificate that signed their message. */
export interface TrustSignerInput {
    address: string;
    /** Base64 DER of the signer certificate - `MessageSecurityResult.signerCertificate`. */
    certificate: string;
}

/**
 * Thrown by `trustSigner()` when restapi answers `409`: a different signing key is already pinned for that address, so
 * trusting this one would silently replace it. Still an `ApiRequestError` (`status` 409). A UI should show this as a
 * key conflict for the user to resolve deliberately, not retry.
 */
export class SignerKeyConflictError extends ApiRequestError {
    constructor(message: string, code?: string) {
        super(message, 409, code);
        this.name = "SignerKeyConflictError";
    }
}

/**
 * "Trust this signer": pins `certificate` as `address`'s signing key on the caller's contact for that address
 * (`POST /mail/mailboxes/:id/keys/trust`), after which `evaluateMessageSecurity()` given that contact's pins reports
 * the sender's signed mail as verified. Resolves with the contact's resulting key state, the same shape as
 * `lookupKeys()`. Rejects with `SignerKeyConflictError` on `409` (a different signing key is already pinned), and a
 * plain `ApiRequestError` for `400` (an invalid certificate, or one that doesn't name `address`) and `403`/`404`.
 */
export async function trustSigner(mailboxUid: string, input: TrustSignerInput, client?: ApiClient): Promise<KeyLookupResult> {
    try {
        return await withClient<KeyLookupResult>(client, `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/keys/trust`, {
            method: "POST",
            body: JSON.stringify({ address: input.address, certificate: input.certificate }),
        });
    } catch (err) {
        if (err instanceof ApiRequestError && err.status === 409) {
            throw new SignerKeyConflictError(err.message, err.code);
        }
        throw err;
    }
}

/** What `resolveKeyConflict()` sends to `POST /mail/mailboxes/:id/keys/resolve`. */
export interface ResolveKeyConflictInput {
    /** The contact's email address. */
    address: string;
    /** Which pinned key's conflict to resolve. */
    useType: "sign" | "encrypt";
    /** `"accept"` pins the new key and moves the old one into `previousKeys` (`replacement: "user"`); `"reject"` keeps
     * the pinned key and remembers the rejected fingerprint in `Contact.rejectedKeys`. */
    action: "accept" | "reject";
    /** The fingerprint of the pinned key the user was shown. restapi refuses with `409` (`PinnedKeyChangedError`) when
     * the pinned key is no longer this one, so a decision made against a stale comparison is never applied. */
    expectedPinnedFingerprint: string;
    /** For `"accept"`: base64 DER of the certificate to pin (e.g. `MessageSecurityResult.signerCertificate` of a
     * `signer_key_changed` result). Omitted, restapi pins the recorded conflict's `observedKey`. */
    certificate?: string;
}

/** The contact's resulting key state after `resolveKeyConflict()`. */
export type ResolveKeyConflictResult = KeyLookupResult;

/**
 * Thrown by `resolveKeyConflict()` when restapi answers `409`: the contact's pinned key is no longer
 * `expectedPinnedFingerprint` (another device or an automatic renewal changed it meanwhile). Still an `ApiRequestError`
 * (`status` 409). A UI should reload the key state and ask again rather than retry.
 */
export class PinnedKeyChangedError extends ApiRequestError {
    constructor(message: string, code?: string) {
        super(message, 409, code);
        this.name = "PinnedKeyChangedError";
    }
}

/**
 * Resolves a contact's key conflict (`POST /mail/mailboxes/:id/keys/resolve`) - see `ResolveKeyConflictInput` for what
 * each action does. Resolves with the contact's resulting key state. Rejects with `PinnedKeyChangedError` on `409`, and
 * a plain `ApiRequestError` for `400` (an invalid body or certificate), `403` (no rights) and `404` (no such contact, no
 * pinned key, or no recorded conflict when one is needed).
 */
export async function resolveKeyConflict(
    mailboxUid: string,
    input: ResolveKeyConflictInput,
    client?: ApiClient,
): Promise<ResolveKeyConflictResult> {
    const body = {
        address: input.address,
        useType: input.useType,
        action: input.action,
        expectedPinnedFingerprint: input.expectedPinnedFingerprint,
        ...(input.certificate !== undefined ? { certificate: input.certificate } : {}),
    };
    try {
        return await withClient<ResolveKeyConflictResult>(client, `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/keys/resolve`, {
            method: "POST",
            body: JSON.stringify(body),
        });
    } catch (err) {
        if (err instanceof ApiRequestError && err.status === 409) {
            throw new PinnedKeyChangedError(err.message, err.code);
        }
        throw err;
    }
}

export type PolicyState ="automatic" | "optional" | "prohibited";

export interface EncryptionPolicy {
    encryptSameOrg: PolicyState;
    encryptFederated: PolicyState;
    encryptExternal: PolicyState;
}

/** The system-wide encryption policy (readable by any authenticated user, used to decide what encryption
 * controls a compose UI should offer). */
export function getEncryptionPolicy(client?: ApiClient): Promise<EncryptionPolicy> {
    return withClient(client, `/system/encryption-policy`);
}

/** Admin-only (`RequiresTrustedRole`) — updates the system-wide encryption policy. */
export function updateEncryptionPolicy(patch: Partial<EncryptionPolicy>, client?: ApiClient): Promise<EncryptionPolicy> {
    return withClient(client, `/system/encryption-policy`, {
        method: "PUT",
        body: JSON.stringify(patch),
    });
}
