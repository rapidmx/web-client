///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    EnrollmentResult,
    KeyVault,
    MasterKeyWrap,
    PublicKey,
    WrappedPrivateKey,
    addMasterKeyWrap,
    cancelSignEnrollment,
    checkSignEnrollmentStatus,
    findActivePublicKey,
    getEscrowInfo,
    getKeyVault,
    rekey,
    removeMasterKeyWrap,
    startSignEnrollment,
} from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import {
    ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE,
    SIGNING_PRIVATE_KEY_AAD_PURPOSE,
    UnlockedKeys,
    destroyUnlockedKeys,
    getUnlockedKeys,
    unlockWithPassword,
} from "@rapidmx/react-shared/crypto/keySession.js";
import { IDLE_TIMEOUT_OPTIONS_MINUTES, getIdleTimeoutMinutes, setIdleTimeoutMinutes } from "@rapidmx/react-shared/crypto/idleTimeout.js";
import {
    LOCAL_INDEX_SIZE_OPTIONS,
    getDefaultLocalIndexByteBudget,
    getLocalIndexByteBudget,
    setLocalIndexByteBudget,
} from "../../../shared/search/localIndexSizePreference.js";
import { fromBase64 } from "@rapidmx/react-shared/crypto/encoding.js";
import { KeysLockedError, buildAad, generateMasterKey, openWithKey, sealWithKey } from "@rapidmx/react-shared/crypto/masterKey.js";
import { buildEscrowWrap, buildPasswordWrap, buildRecoveryWraps } from "@rapidmx/react-shared/crypto/masterKeyWraps.js";
import { exportPrivateKeyPkcs8, generateKeyPairWithCsr } from "@rapidmx/react-shared/crypto/keys.js";
import { getMailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../shared/components/settings/layout/SettingsShell.js";
import KeyEnrollmentGate from "../../../shared/components/layout/KeyEnrollmentGate.js";
import { useUnlockPrompt } from "../../../shared/components/layout/UnlockPromptProvider.js";
import { destroyLocalIndex } from "../../../shared/search/localIndexRpcClient.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

const MIN_PASSWORD_LENGTH = 8;

/** Mirrors restapi's `BaseKeyVaultRoute` `MAX_MASTER_KEY_WRAPS` - `addMasterKeyWrap()` refuses a vault
 * already holding this many wraps (escrow included). */
export const MAX_MASTER_KEY_WRAPS = 20;

const KEYS_LOCKED_MESSAGE = "Your encryption keys were locked before this could finish. Unlock them and try again.";

/** Thrown inside `handleRotateKeys()` when the escrow wrap of the new master key can't be built - the rotation is
 * then abandoned before `rekey()`. */
class EscrowWrapUnavailableError extends Error {
    constructor(readonly cause: unknown) {
        super("Could not prepare escrow protection for the new master key.");
    }
}

/** Thrown by `rewrapVaultPrivateKeys()` when a vault entry can't be opened with the current master key. */
class UncoveredVaultKeysError extends Error {
    constructor(readonly fingerprints: string[]) {
        super(`Could not open ${fingerprints.length} wrapped private key(s).`);
    }
}

/** Thrown when this session's master key no longer opens the vault - another device rotated the keys since this
 * session unlocked. Anything wrapped or sealed under it would be unusable (and a signing key sealed under it would
 * be installed at the vault's current generation, blocking rotation), so nothing is written. */
class StaleSessionKeysError extends Error {
    constructor() {
        super("This session's master key no longer opens the key vault.");
    }
}

const STALE_KEYS_MESSAGE =
    "Your encryption keys were changed on another device (for example, rotated), so the copy unlocked in this session no longer works. Nothing was changed. Unlock again with your current password, then try again.";

function wrappedKeyAad(mailboxUid: string, entry: WrappedPrivateKey): Uint8Array {
    return buildAad(mailboxUid, entry.useType === "sign" ? SIGNING_PRIVATE_KEY_AAD_PURPOSE : ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE);
}

/**
 * Whether `masterKey` opens at least one of `vault`'s wrapped private keys - i.e. it is still the vault's current
 * master key. A vault with no wrapped keys has nothing to check against and passes. The opened key bytes are zeroed
 * straight away. `KeysLockedError` (a destroyed master key) propagates.
 */
async function masterKeyOpensVault(mailboxUid: string, masterKey: Uint8Array, vault: KeyVault): Promise<boolean> {
    if (vault.wrappedKeys.length === 0) {
        return true;
    }
    for (const entry of vault.wrappedKeys) {
        try {
            const raw = await openWithKey(masterKey, entry, wrappedKeyAad(mailboxUid, entry));
            raw.fill(0);
            return true;
        } catch (err) {
            if (err instanceof KeysLockedError) {
                throw err;
            }
        }
    }
    return false;
}

/**
 * Re-seals EVERY private key in the vault (not just the ones this session imported - an inactive or
 * newly issued key would otherwise be silently dropped by `rekey()`, which replaces `wrappedKeys`
 * wholesale) under a brand new master key. Opens each entry with `currentMasterKey` first and refuses
 * (`UncoveredVaultKeysError`) if any can't be opened, before generating anything. Plaintext key bytes
 * are zeroed as soon as they've been re-sealed. `KeysLockedError` (a destroyed master key) propagates.
 */
async function rewrapVaultPrivateKeys(
    mailboxUid: string,
    currentMasterKey: Uint8Array,
    wrappedKeys: WrappedPrivateKey[],
): Promise<{ mk: Uint8Array; wrappedKeys: WrappedPrivateKey[] }> {
    const aadFor = (entry: WrappedPrivateKey) => wrappedKeyAad(mailboxUid, entry);
    const opened: { entry: WrappedPrivateKey; raw: Uint8Array }[] = [];
    try {
        const failed: string[] = [];
        for (const entry of wrappedKeys) {
            try {
                opened.push({ entry, raw: await openWithKey(currentMasterKey, entry, aadFor(entry)) });
            } catch (err) {
                if (err instanceof KeysLockedError) {
                    throw err;
                }
                failed.push(entry.fingerprint);
            }
        }
        if (failed.length > 0) {
            throw new UncoveredVaultKeysError(failed);
        }
        const mk = generateMasterKey();
        const rewrapped: WrappedPrivateKey[] = [];
        for (const { entry, raw } of opened) {
            const sealed = await sealWithKey(mk, raw, aadFor(entry));
            rewrapped.push({
                ciphertext: sealed.ciphertext,
                nonce: sealed.nonce,
                algorithm: "AES-256-GCM",
                fingerprint: entry.fingerprint,
                useType: entry.useType,
            });
        }
        return { mk, wrappedKeys: rewrapped };
    } finally {
        for (const { raw } of opened) {
            raw.fill(0);
        }
    }
}

// RFC 8823 ACME issuance is a real email round-trip with a public CA - "likely minutes," not seconds -
// so this polls infrequently rather than hammering the endpoint.
const SIGNING_ENROLLMENT_POLL_INTERVAL_MS = 15_000;

/**
 * A started signing enrollment's id, per mailbox. Kept only so a reload can ask the server
 * (`checkSignEnrollmentStatus()`) whether that enrollment is still pending: a rotation while it is pending
 * would strand the enrollment's already-submitted private key under a master key that no longer exists. The
 * stored id is never trusted on its own - the server's answer decides the state, and restapi's own `rekey()`
 * refuses (409) a rotation during an enrollment this browser never saw (e.g. one started on another device).
 */
const SIGN_ENROLLMENT_STORAGE_PREFIX = "rapidmx.signEnrollment.";

function readStoredSignEnrollment(mailboxUid: string): string | null {
    try {
        return localStorage.getItem(SIGN_ENROLLMENT_STORAGE_PREFIX + mailboxUid);
    } catch {
        return null;
    }
}

function storeSignEnrollment(mailboxUid: string, enrollmentId: string | null): void {
    try {
        if (enrollmentId) {
            localStorage.setItem(SIGN_ENROLLMENT_STORAGE_PREFIX + mailboxUid, enrollmentId);
        } else {
            localStorage.removeItem(SIGN_ENROLLMENT_STORAGE_PREFIX + mailboxUid);
        }
    } catch {
        // Storage blocked - restapi's own 409 on rekey still guards a rotation.
    }
}

const ROTATION_CONFLICT_MESSAGE =
    "Your keys were not rotated because the server reported a conflicting change. If a signing certificate enrollment is still in progress for this mailbox (it may have been started on another device), wait for it to finish, then try again. If this mailbox is under escrow, its escrow protection may have changed meanwhile - reload this page and try again. Nothing was changed.";

const METHOD_LABELS: Record<string, string> = {
    password: "Password",
    passkey: "Passkey",
    recovery: "Recovery code",
    escrow: "Escrow (managed by your organization)",
};

function idleTimeoutLabel(minutes: number): string {
    if (minutes === 0) {
        return "Never";
    }
    if (minutes === 60) {
        return "1 hour";
    }
    return `${minutes} minutes`;
}

export type SettingsEncryptionPageProps = Omit<SettingsShellProps, "active">;

export default function SettingsEncryptionPage(props: SettingsEncryptionPageProps) {
    return (
        <SettingsShell {...props} active="encryption">
            <EncryptionGate userUid={props.userUid} impersonating={props.impersonating} />
        </SettingsShell>
    );
}

/**
 * Unlike `MailShell`, `SettingsShell` doesn't already gate its children behind `KeyEnrollmentGate` (a
 * user can reach Settings without ever having opened Mail this session) - wrapped here instead, so
 * `EncryptionContent` below can always assume `getUnlockedKeys()` has something for this mailbox before
 * it renders. See `KeyEnrollmentGate`'s own doc comment for why it's safe to mount more than once (it
 * short-circuits to `children` immediately for a mailbox already unlocked elsewhere this session).
 */
function EncryptionGate({ userUid, impersonating }: { userUid?: string; impersonating?: boolean }) {
    const { mailboxUid, mailboxes } = useSettingsShell();
    const mailbox = mailboxes.find((mb) => mb.uid === mailboxUid)!;
    // restapi only lets the mailbox's actual owner write its key vault (`requireMailboxOwner()`), so a
    // delegate (or an admin impersonating the owner) never provisions keys here, and sees no write actions.
    const isOwner = mailbox.ownerUserUid !== undefined && mailbox.ownerUserUid === userUid && !impersonating;
    return (
        <KeyEnrollmentGate
            mailboxUid={mailboxUid}
            mailboxAddress={mailbox.primarySmtpAddress}
            mailboxKeys={mailbox.keys}
            canProvision={isOwner}
        >
            <EncryptionContent canManageKeys={isOwner} />
        </KeyEnrollmentGate>
    );
}

function EncryptionContent({ canManageKeys }: { canManageKeys: boolean }) {
    const { mailboxUid, mailboxes } = useSettingsShell();
    const mailbox = mailboxes.find((mb) => mb.uid === mailboxUid)!;
    const { requestUnlock } = useUnlockPrompt();

    const [vault, setVault] = useState<KeyVault | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [removingMethod, setRemovingMethod] = useState<string | null>(null);
    const [pendingRemoval, setPendingRemoval] = useState<MasterKeyWrap | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    const [newPassword, setNewPassword] = useState("");
    const [confirmNewPassword, setConfirmNewPassword] = useState("");
    const [addingPassword, setAddingPassword] = useState(false);

    const [regenerating, setRegenerating] = useState(false);
    const [newRecoveryCodes, setNewRecoveryCodes] = useState<string[] | null>(null);
    // Distinguishes the "Save your new recovery codes" screen's copy for the two different actions that
    // land on it - a plain regeneration only invalidates old recovery codes, while a rotation also
    // invalidates every other unlock method, which the copy needs to say plainly.
    const [recoveryCodesReason, setRecoveryCodesReason] = useState<"regenerate" | "rotate">("regenerate");
    const [codesSaved, setCodesSaved] = useState(false);
    const [codesCopied, setCodesCopied] = useState(false);
    // Shown on the "Save your new recovery codes" screen itself - a regeneration or rotation that only
    // partly finished (e.g. some new codes saved but not all, or old codes that couldn't be removed) still
    // lands there, since whatever codes did save must be shown now or never.
    const [codesWarning, setCodesWarning] = useState<string | null>(null);
    // Set when a rotation succeeded but this session couldn't re-unlock under the new master key - the
    // stale keys are destroyed, and the "keys removed" screen explains why.
    const [rotationRelockReason, setRotationRelockReason] = useState<string | null>(null);

    const [rotationPassword, setRotationPassword] = useState("");
    const [rotationConfirmPassword, setRotationConfirmPassword] = useState("");
    const [rotating, setRotating] = useState(false);

    const [destroyed, setDestroyed] = useState(false);
    const [idleTimeoutMinutes, setIdleTimeoutMinutesState] = useState(() => getIdleTimeoutMinutes());
    const [localIndexByteBudget, setLocalIndexByteBudgetState] = useState(() => getLocalIndexByteBudget());
    // Both possible defaults (web and Electron) are themselves entries in `LOCAL_INDEX_SIZE_OPTIONS`.
    const localIndexDefaultByteBudgetLabel = LOCAL_INDEX_SIZE_OPTIONS.find((option) => option.bytes === getDefaultLocalIndexByteBudget())!.label;

    // `mailbox.keys` comes from `SettingsShell`'s one-time `listMailboxes()` fetch - once an ACME
    // enrollment issues, the server has installed a new signing key that fetch never saw. Only this
    // page refetches (via `getMailbox()`) to notice; `null` means "no fresher data yet, use mailbox.keys".
    const [refreshedKeys, setRefreshedKeys] = useState<PublicKey[] | null>(null);
    const displayedKeys = refreshedKeys ?? mailbox.keys ?? [];
    const activeSigningKey = findActivePublicKey(displayedKeys, "sign");

    // "checking" = a stored enrollment id is being confirmed with the server. Rotation stays disabled unless
    // this is "idle".
    const [signingStatus, setSigningStatus] = useState<"checking" | "idle" | "enrolling" | "pending">(() =>
        readStoredSignEnrollment(mailboxUid!) ? "checking" : "idle",
    );
    const [signingEnrollmentId, setSigningEnrollmentId] = useState<string | null>(null);
    const [signingError, setSigningError] = useState<string | null>(null);
    const rotationBlockedBySigning = signingStatus !== "idle";

    const [cancelingEnrollment, setCancelingEnrollment] = useState(false);
    const [cancelEnrollmentError, setCancelEnrollmentError] = useState<string | null>(null);

    // restapi's rekey() drops every old escrow wrap and requires a fresh one for the new master key (see
    // handleRotateKeys), so an escrow wrap in the vault always covers the current master key.
    const hasEscrowWrap = vault?.masterKeyWraps.some((w) => w.method === "escrow") ?? false;
    const [wrappingEscrow, setWrappingEscrow] = useState(false);
    const [escrowError, setEscrowError] = useState<string | null>(null);

    /**
     * This mailbox's unlocked keys *right now* - never a copy read at render time, which a lock (idle
     * timeout, another tab's sign-out) may since have destroyed. Prompts for the password when locked;
     * rejects if the prompt is dismissed.
     */
    async function currentUnlockedKeys(): Promise<UnlockedKeys> {
        const current = getUnlockedKeys(mailboxUid!);
        if (current && !current.destroyed) {
            return current;
        }
        return requestUnlock(mailboxUid!, displayedKeys);
    }

    /**
     * `currentUnlockedKeys()`, checked against a freshly fetched vault before anything is wrapped or sealed under its
     * master key: after a rotation on another device the session's master key is dead, and every write built from
     * it would be too. Rejects with `StaleSessionKeysError` then. Resolves to the keys and that fresh vault.
     */
    async function verifiedUnlockedKeys(): Promise<{ current: UnlockedKeys; freshVault: KeyVault }> {
        const current = await currentUnlockedKeys();
        const freshVault = await getKeyVault(mailboxUid!);
        if (!(await masterKeyOpensVault(mailboxUid!, current.masterKey, freshVault))) {
            throw new StaleSessionKeysError();
        }
        return { current, freshVault };
    }

    /** Drops this session's out-of-date keys (and, as with every key destruction, the local index) and asks for the
     * current password, so the next attempt works with the vault's real master key. */
    function relockStaleKeys() {
        destroyUnlockedKeys(mailboxUid);
        void destroyLocalIndex(mailboxUid!);
        requestUnlock(mailboxUid!, displayedKeys).catch(() => undefined);
    }

    function errorMessage(err: unknown, fallback: string): string {
        if (err instanceof KeysLockedError) {
            return KEYS_LOCKED_MESSAGE;
        }
        if (err instanceof StaleSessionKeysError) {
            relockStaleKeys();
            return STALE_KEYS_MESSAGE;
        }
        return err instanceof ApiRequestError ? err.message : fallback;
    }

    async function handleWrapEscrow() {
        setEscrowError(null);
        setWrappingEscrow(true);
        try {
            // Only reachable when mailbox.escrowScopeId is set (see the render guard below).
            const { current } = await verifiedUnlockedKeys();
            const escrowInfo = await getEscrowInfo(mailboxUid!);
            const wrap = await buildEscrowWrap(current.masterKey, escrowInfo.escrowScopeId, fromBase64(escrowInfo.publicKey.publicKey));
            await addMasterKeyWrap(mailboxUid!, wrap);
            await loadVault();
        } catch (err) {
            setEscrowError(errorMessage(err, "Could not add escrow protection for this mailbox."));
        } finally {
            setWrappingEscrow(false);
        }
    }

    /** Applies a server-reported enrollment status - shared by the reload check and the poll below. */
    async function applyEnrollmentResult(enrollmentId: string, result: EnrollmentResult, isCancelled: () => boolean) {
        if (result.status === "pending") {
            setSigningEnrollmentId(enrollmentId);
            setSigningStatus("pending");
            return;
        }
        storeSignEnrollment(mailboxUid!, null);
        setSigningStatus("idle");
        setSigningEnrollmentId(null);
        if (result.status === "failed") {
            setSigningError(result.error ?? "Signing certificate enrollment failed.");
            return;
        }
        try {
            const refreshed = await getMailbox(mailboxUid!);
            if (!isCancelled()) {
                setRefreshedKeys(refreshed.keys ?? []);
            }
        } catch {
            // The new key shows on the next load - the enrollment itself is finished either way.
        }
    }

    // Confirms an enrollment started before a reload with the server before rotation is offered again.
    useEffect(() => {
        const storedId = readStoredSignEnrollment(mailboxUid!);
        if (!storedId) {
            return;
        }
        let cancelled = false;
        setSigningStatus("checking");
        checkSignEnrollmentStatus(mailboxUid!, storedId)
            .then((result) => (cancelled ? undefined : applyEnrollmentResult(storedId, result, () => cancelled)))
            .catch((err) => {
                if (cancelled) {
                    return;
                }
                if (err instanceof ApiRequestError && err.status === 404) {
                    // The server no longer knows this enrollment, so nothing is pending.
                    storeSignEnrollment(mailboxUid!, null);
                    setSigningStatus("idle");
                    return;
                }
                // Unknown (e.g. a network error): assume it is still pending, and let polling keep asking.
                setSigningEnrollmentId(storedId);
                setSigningStatus("pending");
            });
        return () => {
            cancelled = true;
        };
    }, [mailboxUid]);

    useEffect(() => {
        if (signingStatus !== "pending" || !signingEnrollmentId) {
            return;
        }
        let cancelled = false;
        const interval = setInterval(async () => {
            try {
                const result = await checkSignEnrollmentStatus(mailboxUid!, signingEnrollmentId);
                if (!cancelled) {
                    await applyEnrollmentResult(signingEnrollmentId, result, () => cancelled);
                }
            } catch {
                // Transient network error - keep polling rather than surfacing a one-off failure.
            }
        }, SIGNING_ENROLLMENT_POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [signingStatus, signingEnrollmentId, mailboxUid]);

    /** Cancels the pending enrollment (restapi's owner-only DELETE), which is what lets rotation run again. */
    async function handleCancelEnrollment(enrollmentId: string) {
        setCancelEnrollmentError(null);
        setCancelingEnrollment(true);
        try {
            const result = await cancelSignEnrollment(mailboxUid!, enrollmentId);
            if (result.status === "pending") {
                setCancelEnrollmentError("The enrollment couldn't be cancelled yet. Try again.");
            } else if (result.status === "failed") {
                // Cancelled - the "failure" is the cancellation itself, not something to report.
                storeSignEnrollment(mailboxUid!, null);
                setSigningStatus("idle");
                setSigningEnrollmentId(null);
            } else {
                // Issued before the cancel landed: it finishes like any other issued enrollment.
                await applyEnrollmentResult(enrollmentId, result, () => false);
            }
        } catch (err) {
            if (err instanceof ApiRequestError && err.status === 404) {
                // The server no longer knows this enrollment, so nothing is pending.
                storeSignEnrollment(mailboxUid!, null);
                setSigningStatus("idle");
                setSigningEnrollmentId(null);
            } else {
                setCancelEnrollmentError(errorMessage(err, "Could not cancel the signing certificate enrollment."));
            }
        } finally {
            setCancelingEnrollment(false);
        }
    }

    async function handleEnrollSigning() {
        setSigningError(null);
        setSigningStatus("enrolling");
        try {
            const { current } = await verifiedUnlockedKeys();
            const { keyPair, csrPem } = await generateKeyPairWithCsr(mailbox.primarySmtpAddress, "sign");
            const privateKeyRaw = await exportPrivateKeyPkcs8(keyPair.privateKey);
            const wrappedKeySealed = await sealWithKey(
                current.masterKey,
                privateKeyRaw,
                buildAad(mailboxUid!, SIGNING_PRIVATE_KEY_AAD_PURPOSE),
            );
            const { enrollmentId } = await startSignEnrollment(mailboxUid!, {
                csr: csrPem,
                wrappedKey: { ciphertext: wrappedKeySealed.ciphertext, nonce: wrappedKeySealed.nonce, algorithm: "AES-256-GCM" },
            });
            storeSignEnrollment(mailboxUid!, enrollmentId);
            setSigningEnrollmentId(enrollmentId);
            setSigningStatus("pending");
        } catch (err) {
            setSigningError(errorMessage(err, "Could not start signing certificate enrollment."));
            setSigningStatus("idle");
        }
    }

    function handleIdleTimeoutChange(e: React.ChangeEvent<HTMLSelectElement>) {
        const minutes = Number(e.target.value);
        setIdleTimeoutMinutes(minutes);
        setIdleTimeoutMinutesState(minutes);
    }

    function handleLocalIndexByteBudgetChange(e: React.ChangeEvent<HTMLSelectElement>) {
        const bytes = Number(e.target.value);
        setLocalIndexByteBudget(bytes);
        setLocalIndexByteBudgetState(bytes);
    }

    function loadVault() {
        return getKeyVault(mailboxUid!)
            .then(setVault)
            .catch((err) => setLoadError(err instanceof ApiRequestError ? err.message : "Could not load your key vault."));
    }

    useEffect(() => {
        void loadVault();
    }, [mailboxUid]);

    const passwordWraps = vault?.masterKeyWraps.filter((w) => w.method === "password") ?? [];
    const recoveryWraps = vault?.masterKeyWraps.filter((w) => w.method === "recovery") ?? [];
    const otherWraps = vault?.masterKeyWraps.filter((w) => w.method !== "password" && w.method !== "recovery") ?? [];

    // The owner's own unlock methods are every non-escrow wrap - restapi refuses (409) to remove the last
    // one. But the app can only actually *unlock* with a password today (react-shared's
    // `unlockWithPassword()` - recovery codes and passkeys have no unlock path yet), so the last password
    // wrap is never offered for removal either: without it the mailbox would be locked for good in practice.
    const ownUnlockWrapCount = vault?.masterKeyWraps.filter((w) => w.method !== "escrow").length ?? 0;
    function canRemoveWrap(wrap: MasterKeyWrap): boolean {
        return wrap.method === "password" ? passwordWraps.length > 1 : ownUnlockWrapCount > 1;
    }

    async function handleRemove(wrap: MasterKeyWrap) {
        setPendingRemoval(null);
        const key = `${wrap.method}:${wrap.methodId ?? ""}`;
        setRemovingMethod(key);
        setActionError(null);
        try {
            await removeMasterKeyWrap(mailboxUid!, wrap.method, wrap.methodId);
            await loadVault();
        } catch (err) {
            setActionError(err instanceof ApiRequestError ? err.message : "Could not remove this unlock method.");
        } finally {
            setRemovingMethod(null);
        }
    }

    /** Only offered while the vault has no password wrap at all - `unlockWithPassword()` only ever tries
     * the first one, so a second password would be accepted here but never unlock anything. */
    async function handleAddPassword(e: FormEvent) {
        e.preventDefault();
        if (newPassword.length < MIN_PASSWORD_LENGTH) {
            setActionError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
            return;
        }
        if (newPassword !== confirmNewPassword) {
            setActionError("Passwords do not match.");
            return;
        }
        setActionError(null);
        setAddingPassword(true);
        try {
            const { current } = await verifiedUnlockedKeys();
            const wrap = await buildPasswordWrap(mailboxUid!, current.masterKey, newPassword);
            await addMasterKeyWrap(mailboxUid!, wrap);
            setNewPassword("");
            setConfirmNewPassword("");
            await loadVault();
        } catch (err) {
            setActionError(errorMessage(err, "Could not add this password."));
        } finally {
            setAddingPassword(false);
        }
    }

    /**
     * Adds the new recovery wraps *before* removing any old one, so a failure part-way through can never
     * leave the mailbox with fewer working recovery codes than it started with. `buildRecoveryWraps()`
     * labels its wraps `recovery-1..N` - the same labels the old set most likely has, and restapi's
     * `removeMasterKeyWrap()` removes every wrap matching a `methodId` - so each new wrap gets a
     * batch-unique label first, letting the old ones be removed by their own `methodId` without touching
     * the new ones.
     *
     * The vault holds at most `MAX_MASTER_KEY_WRAPS` wraps. Checked against a fresh copy of the vault before
     * anything is written: when the new set only fits once old recovery codes are gone, an old code is
     * removed just before each new one that has no room yet (the working-code count never drops below the
     * original set's), and when it can't fit even then, nothing is written and the user is told how many
     * other methods to remove.
     */
    async function handleRegenerateRecoveryCodes() {
        // Only reachable once the vault has loaded (the button is disabled until then).
        setActionError(null);
        setRegenerating(true);
        let built: { wraps: MasterKeyWrap[]; codes: string[] };
        let oldRecoveryWraps: MasterKeyWrap[];
        let free: number;
        try {
            const { current, freshVault } = await verifiedUnlockedKeys();
            oldRecoveryWraps = freshVault.masterKeyWraps.filter((w) => w.method === "recovery");
            free = MAX_MASTER_KEY_WRAPS - freshVault.masterKeyWraps.length;
            built = await buildRecoveryWraps(mailboxUid!, current.masterKey);
            const shortfall = built.wraps.length - (free + oldRecoveryWraps.length);
            if (shortfall > 0) {
                setVault(freshVault);
                setActionError(
                    `Your key vault can hold at most ${MAX_MASTER_KEY_WRAPS} unlock methods and already has ${freshVault.masterKeyWraps.length}. ` +
                        `Regenerating needs room for ${built.wraps.length} new recovery codes, so remove ${shortfall} other unlock ` +
                        `method${shortfall === 1 ? "" : "s"} (such as an extra password or passkey) below first.`,
                );
                setRegenerating(false);
                return;
            }
        } catch (err) {
            setActionError(errorMessage(err, "Could not regenerate recovery codes."));
            setRegenerating(false);
            return;
        }
        const batch = Date.now().toString(36);
        const pendingOld = [...oldRecoveryWraps];
        let removedEarly = 0;
        const savedCodes: string[] = [];
        let addError: unknown = null;
        for (let i = 0; i < built.wraps.length; i++) {
            // The old wrap removed to make room for this new one, if any - put back if the add then fails, so a
            // failed add never costs a working code.
            let removedForThis: MasterKeyWrap | null = null;
            try {
                if (free <= 0) {
                    // Guaranteed non-empty by the shortfall check above.
                    const old = pendingOld.shift()!;
                    await removeMasterKeyWrap(mailboxUid!, "recovery", old.methodId);
                    removedForThis = old;
                    removedEarly++;
                    free++;
                }
                await addMasterKeyWrap(mailboxUid!, { ...built.wraps[i], methodId: `recovery-${batch}-${i + 1}` });
                free--;
                savedCodes.push(built.codes[i]);
            } catch (err) {
                addError = err;
                if (removedForThis) {
                    try {
                        await addMasterKeyWrap(mailboxUid!, removedForThis);
                        removedEarly--;
                    } catch {
                        // Still counted in removedEarly, which the messages below report.
                    }
                }
                break;
            }
        }

        const removedEarlyNote =
            removedEarly > 0
                ? `${removedEarly} of your old recovery codes had to be removed to make room; the rest were kept and still work`
                : "Your old recovery codes were kept and still work";

        if (savedCodes.length === 0) {
            const message = addError instanceof ApiRequestError ? addError.message : "Could not regenerate recovery codes.";
            setActionError(removedEarly > 0 ? `${message} ${removedEarlyNote}.` : message);
            setRegenerating(false);
            await loadVault();
            return;
        }

        let warning: string | null = null;
        if (savedCodes.length < built.wraps.length) {
            // Remaining old codes are deliberately left in place - the new set is incomplete, so the old one
            // is still part of the user's recovery safety net.
            warning = `Only ${savedCodes.length} of ${built.wraps.length} new recovery codes could be saved${
                addError instanceof ApiRequestError ? ` (${addError.message})` : ""
            }. ${removedEarlyNote} - save the codes below, then try regenerating again.`;
        } else {
            let notRemoved = 0;
            for (const wrap of pendingOld) {
                try {
                    await removeMasterKeyWrap(mailboxUid!, "recovery", wrap.methodId);
                } catch {
                    notRemoved++;
                }
            }
            if (notRemoved > 0) {
                warning = `${notRemoved} of your old recovery codes could not be removed and still work. Remove them from the unlock methods list, or regenerate again.`;
            }
        }

        setRecoveryCodesReason("regenerate");
        setCodesWarning(warning);
        setNewRecoveryCodes(savedCodes);
        setCodesSaved(false);
        setRegenerating(false);
        await loadVault();
    }

    async function handleCopyCodes() {
        try {
            // Only reachable via the button below, which never renders while newRecoveryCodes is null.
            await navigator.clipboard.writeText(newRecoveryCodes!.join("\n"));
            setCodesCopied(true);
            setTimeout(() => setCodesCopied(false), 2000);
        } catch {
            // Clipboard access can be denied by the browser - the codes are still selectable/copyable by
            // hand from the list below.
        }
    }

    /**
     * Real revocation for a captured wrap (`keyvaultApi.ts`'s `rekey()` - see that function's own doc
     * comment): re-wraps every private key in a freshly fetched vault under a brand new master key
     * (`rewrapVaultPrivateKeys()` - all of them, active or not, since `rekey()` replaces `wrappedKeys`
     * wholesale), wraps that new MK under a freshly entered password and a fresh set of recovery codes,
     * and atomically replaces the vault - the enrolled keypair/certificate itself is unchanged (restapi's
     * own `rekey()` rejects anything else, so `keys` is a fresh copy of the mailbox's, not this page's
     * possibly stale list), only how it's protected. Every *other* unlock method this mailbox had stops
     * working the instant this succeeds, since `rekey()` replaces `masterKeyWraps` wholesale - the whole
     * point, for a captured-wrap scenario where it's unclear which method was compromised.
     */
    async function handleRotateKeys(e: FormEvent) {
        e.preventDefault();
        if (rotationBlockedBySigning) {
            // The form's controls are disabled in this state too; this also covers an implicit submit.
            return;
        }
        if (rotationPassword.length < MIN_PASSWORD_LENGTH) {
            setActionError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
            return;
        }
        if (rotationPassword !== rotationConfirmPassword) {
            setActionError("Passwords do not match.");
            return;
        }
        setActionError(null);
        setEscrowError(null);
        setRotating(true);
        let keys: PublicKey[];
        let codes: string[];
        try {
            const current = await currentUnlockedKeys();
            const [freshVault, freshMailbox] = await Promise.all([getKeyVault(mailboxUid!), getMailbox(mailboxUid!)]);
            keys = freshMailbox.keys ?? [];
            // A session key that opens nothing is stale (rotated elsewhere) rather than missing some keys.
            if (!(await masterKeyOpensVault(mailboxUid!, current.masterKey, freshVault))) {
                throw new StaleSessionKeysError();
            }
            const rewrapped = await rewrapVaultPrivateKeys(mailboxUid!, current.masterKey, freshVault.wrappedKeys);
            const mk = rewrapped.mk;
            const passwordWrap = await buildPasswordWrap(mailboxUid!, mk, rotationPassword);
            const recovery = await buildRecoveryWraps(mailboxUid!, mk);
            codes = recovery.codes;
            const masterKeyWraps = [passwordWrap, ...recovery.wraps];
            // restapi's rekey() drops the old escrow wraps, and requires a replacement escrow wrap only when the vault
            // already holds one and the mailbox's escrow scope still exists - so one is carried over exactly then, in
            // the same request. A mailbox assigned a scope but never escrowed isn't silently escrowed by a rotation,
            // and a deleted scope (escrow-info 404s) needs nothing. Any other failure to build it aborts the rotation -
            // rotating without it would end escrow coverage. restapi's own 409 stays the final word.
            if (freshVault.masterKeyWraps.some((w) => w.method === "escrow")) {
                try {
                    const escrowInfo = await getEscrowInfo(mailboxUid!);
                    masterKeyWraps.push(await buildEscrowWrap(mk, escrowInfo.escrowScopeId, fromBase64(escrowInfo.publicKey.publicKey)));
                } catch (err) {
                    if (!(err instanceof ApiRequestError && err.status === 404)) {
                        throw new EscrowWrapUnavailableError(err);
                    }
                }
            }
            await rekey(mailboxUid!, { wrappedKeys: rewrapped.wrappedKeys, masterKeyWraps, keys });
        } catch (err) {
            if (err instanceof UncoveredVaultKeysError) {
                setActionError(
                    `Your key vault holds ${err.fingerprints.length === 1 ? "a private key" : `${err.fingerprints.length} private keys`} this session can't open (${err.fingerprints.join(", ")}), so rotating now would lose ${err.fingerprints.length === 1 ? "it" : "them"}. Nothing was changed.`,
                );
            } else if (err instanceof EscrowWrapUnavailableError) {
                const reason = err.cause instanceof ApiRequestError ? ` (${err.cause.message})` : "";
                setActionError(
                    `Your keys were not rotated: this mailbox is under escrow, and escrow protection for the new keys couldn't be prepared${reason}. Nothing was changed.`,
                );
            } else if (err instanceof ApiRequestError && err.status === 409) {
                setActionError(ROTATION_CONFLICT_MESSAGE);
            } else {
                setActionError(errorMessage(err, "Could not rotate your encryption keys."));
            }
            setRotating(false);
            return;
        }

        // The rotation is committed - every old unlock method is already dead, so these codes must be on
        // screen right now, before anything below that could fail or hang.
        const newPassword = rotationPassword;
        setRotationPassword("");
        setRotationConfirmPassword("");
        setRecoveryCodesReason("rotate");
        setCodesWarning(null);
        setNewRecoveryCodes(codes);
        setCodesSaved(false);
        setRefreshedKeys(keys);
        try {
            // Refreshes this session's own cached keys against the new MK, via the password we just set -
            // the underlying private key material didn't change, but the stale MK in memory would silently
            // build wrong future wraps if left as-is. If that fails, the stale keys are destroyed instead.
            try {
                await unlockWithPassword(mailboxUid!, keys, newPassword);
            } catch {
                destroyUnlockedKeys(mailboxUid);
                void destroyLocalIndex(mailboxUid!);
                setRotationRelockReason(
                    "Your keys were rotated, but this session couldn't unlock them again with your new password. Reload the page and unlock with your new password.",
                );
                setDestroyed(true);
            }
            await loadVault();
        } finally {
            setRotating(false);
        }
    }

    function handleDestroyKeysNow() {
        destroyUnlockedKeys(mailboxUid);
        // Spec §11: the Tier 2 local index MUST be destroyed on the same events that destroy unlocked
        // keys. Not awaited - this page's own "keys removed" confirmation shouldn't wait on it, and
        // destroyLocalIndex() never throws either way. Reached directly here (rather than relying on
        // LocalIndexLifecycle.tsx's polling, which only runs while Mail's own MailShell is mounted) since
        // this button lives on the Settings page, which never mounts that component.
        void destroyLocalIndex(mailboxUid!);
        setDestroyed(true);
    }

    // Checked before `destroyed` - a rotation whose re-unlock failed destroys this session's keys, but its
    // new recovery codes still have to be seen (and acknowledged) first.
    if (newRecoveryCodes) {
        return (
            <div className="flex-1 min-w-0 overflow-y-auto p-6">
                <div className="max-w-xl">
                    <h1 className="text-lg font-bold tracking-tight mb-1">Save your new recovery codes</h1>
                    {codesWarning && <Alert>{codesWarning}</Alert>}
                    <p className="text-sm text-text-muted mb-4">
                        {recoveryCodesReason === "rotate"
                            ? "Your keys have been rotated - every previous unlock method (password, recovery codes, or anything else on file) has stopped working. "
                            : codesWarning
                              ? ""
                              : "Your old recovery codes no longer work. "}
                        If you lose your password, these new codes are the only way to recover your encrypted mail.
                        Each code can be used once. Store them somewhere safe — they will not be shown again.
                    </p>
                    <ul className="grid grid-cols-2 gap-2 mb-3 font-mono text-sm">
                        {newRecoveryCodes.map((code) => (
                            <li key={code} className="bg-surface-alt rounded-sm py-1.5 px-2 text-center">
                                {code}
                            </li>
                        ))}
                    </ul>
                    <Button type="button" variant="secondary" className="!w-auto mb-5" onClick={handleCopyCodes}>
                        {codesCopied ? "Copied" : "Copy codes to clipboard"}
                    </Button>
                    <label className="flex items-center gap-2 text-sm mb-4">
                        <input type="checkbox" checked={codesSaved} onChange={(e) => setCodesSaved(e.target.checked)} />
                        I have saved these recovery codes in a safe place.
                    </label>
                    <Button type="button" disabled={!codesSaved} onClick={() => setNewRecoveryCodes(null)} className="!w-auto">
                        Done
                    </Button>
                </div>
            </div>
        );
    }

    if (destroyed) {
        return (
            <div className="flex-1 min-w-0 overflow-y-auto p-6">
                <div className="max-w-xl">
                    <Alert>
                        {rotationRelockReason ??
                            "Your encryption keys have been removed from this session. Reload the page (or open Mail again) to unlock them when you need to read or send encrypted mail."}
                    </Alert>
                </div>
            </div>
        );
    }

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-xl flex flex-col gap-6">
                <div>
                    <h1 className="text-lg font-bold tracking-tight mb-1">Encryption</h1>
                    <p className="text-sm text-text-muted">
                        Manage how {mailbox.displayName} unlocks its encryption keys on this and other devices.
                    </p>
                </div>

                {loadError && <Alert>{loadError}</Alert>}
                {actionError && <Alert>{actionError}</Alert>}
                {!canManageKeys && (
                    <p className="text-sm text-text-muted">
                        Only this mailbox&rsquo;s owner, signed in as themselves, can change its encryption keys and
                        unlock methods.
                    </p>
                )}

                <div>
                    <h2 className="text-sm font-semibold mb-2">Encryption keys</h2>
                    {displayedKeys.length > 0 ? (
                        <ul className="flex flex-col gap-1 text-sm">
                            {displayedKeys.map((key) => (
                                <li key={key.fingerprint} className="font-mono text-xs">
                                    {key.useType === "sign" ? "Signing" : "Encryption"} key: {key.fingerprint}
                                    {key.revokedAt && <span className="text-danger"> (revoked)</span>}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-text-muted">No keys enrolled yet.</p>
                    )}
                </div>

                <div>
                    <h2 className="text-sm font-semibold mb-2">Digital signatures</h2>
                    {activeSigningKey ? (
                        <p className="text-sm text-text-muted">
                            Enabled — outgoing mail from this mailbox is signed with a publicly-trusted
                            certificate.
                        </p>
                    ) : signingStatus === "pending" ? (
                        <p className="text-sm text-text-muted">
                            Requested — a public certificate authority issues this via an automated email
                            exchange, which can take a few minutes. You can leave this page; it finishes in
                            the background and takes effect automatically once issued.
                        </p>
                    ) : !canManageKeys ? (
                        <p className="text-sm text-text-muted">Not enabled.</p>
                    ) : (
                        <div className="flex flex-col gap-2">
                            <p className="text-xs text-text-muted">
                                Lets recipients verify that mail from this mailbox is genuinely from you.
                                Optional — encryption already works without it.
                            </p>
                            {signingError && <Alert>{signingError}</Alert>}
                            <Button
                                type="button"
                                variant="secondary"
                                className="!w-auto"
                                loading={signingStatus === "enrolling"}
                                disabled={signingStatus !== "idle"}
                                onClick={handleEnrollSigning}
                            >
                                Enable digital signatures
                            </Button>
                        </div>
                    )}
                </div>

                {mailbox.escrowScopeId && (
                    <div>
                        <h2 className="text-sm font-semibold mb-2">Escrow</h2>
                        {escrowError && <Alert>{escrowError}</Alert>}
                        {hasEscrowWrap ? (
                            <p className="text-sm text-text-muted">
                                This mailbox is under legal/compliance escrow — an authorized holder in your
                                organization can recover its encrypted mail if needed. This does not weaken
                                protection against anyone else.
                            </p>
                        ) : (
                            <div className="flex flex-col gap-2">
                                <p className="text-xs text-text-muted">
                                    Your organization has assigned this mailbox to an escrow scope, but nothing has been
                                    protected yet — an authorized holder cannot recover this mailbox&rsquo;s encrypted mail
                                    until you complete this step.{" "}
                                    This does not weaken protection against anyone else.
                                </p>
                                {canManageKeys && (
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        className="!w-auto"
                                        loading={wrappingEscrow}
                                        disabled={wrappingEscrow}
                                        onClick={handleWrapEscrow}
                                    >
                                        Add escrow protection
                                    </Button>
                                )}
                            </div>
                        )}
                    </div>
                )}

                <div>
                    <h2 className="text-sm font-semibold mb-2">Unlock methods</h2>
                    <p className="text-xs text-text-muted mb-3">
                        Removing a method here stops it from being usable to unlock this mailbox going forward,
                        but it is <strong>not</strong> full revocation — anyone who already captured a wrapped
                        copy and knows its secret could still use it. For real revocation (e.g. after a lost
                        device), rotate your keys entirely below instead.
                    </p>
                    {vault && vault.masterKeyWraps.length > 0 ? (
                        <ul className="flex flex-col gap-2">
                            {[...passwordWraps, ...recoveryWraps, ...otherWraps].map((wrap) => {
                                const key = `${wrap.method}:${wrap.methodId ?? ""}`;
                                return (
                                    <li key={key} className="flex items-center justify-between gap-3 text-sm py-1.5 px-3 bg-surface-alt rounded-sm">
                                        <span>{METHOD_LABELS[wrap.method] ?? wrap.method}</span>
                                        {wrap.method !== "escrow" &&
                                            canManageKeys &&
                                            (canRemoveWrap(wrap) ? (
                                                <Button
                                                    type="button"
                                                    variant="text"
                                                    className="!w-auto text-danger"
                                                    loading={removingMethod === key}
                                                    disabled={removingMethod !== null}
                                                    onClick={() => setPendingRemoval(wrap)}
                                                >
                                                    Remove
                                                </Button>
                                            ) : (
                                                <span className="text-xs text-text-muted">
                                                    {ownUnlockWrapCount > 1 ? "Needed to unlock" : "Your only unlock method"}
                                                </span>
                                            ))}
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <p className="text-sm text-text-muted">No unlock methods on file.</p>
                    )}
                    <Modal open={pendingRemoval !== null} onClose={() => setPendingRemoval(null)} title="Remove unlock method">
                        <p className="text-sm mb-5">
                            Remove this unlock method? It will no longer unlock this mailbox&rsquo;s encrypted mail on any device.
                        </p>
                        <div className="flex gap-3 justify-end">
                            <Button type="button" variant="secondary" className="!w-auto" onClick={() => setPendingRemoval(null)}>
                                Cancel
                            </Button>
                            <Button
                                type="button"
                                className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger"
                                onClick={() => handleRemove(pendingRemoval!)}
                            >
                                Remove method
                            </Button>
                        </div>
                    </Modal>
                </div>

                {canManageKeys && (
                    <>
                        {passwordWraps.length === 0 ? (
                            vault && (
                                <form onSubmit={handleAddPassword} className="flex flex-col gap-2">
                                    <h2 className="text-sm font-semibold">Add a password</h2>
                                    <input
                                        type="password"
                                        aria-label="New password"
                                        placeholder="New password"
                                        className="w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                                        value={newPassword}
                                        onChange={(e) => setNewPassword(e.target.value)}
                                        disabled={addingPassword}
                                        autoComplete="new-password"
                                    />
                                    <input
                                        type="password"
                                        aria-label="Confirm new password"
                                        placeholder="Confirm new password"
                                        className="w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                                        value={confirmNewPassword}
                                        onChange={(e) => setConfirmNewPassword(e.target.value)}
                                        disabled={addingPassword}
                                        autoComplete="new-password"
                                    />
                                    <div>
                                        <Button type="submit" loading={addingPassword} disabled={addingPassword} className="!w-auto">
                                            Add password
                                        </Button>
                                    </div>
                                </form>
                            )
                        ) : (
                            <div>
                                <h2 className="text-sm font-semibold mb-2">Changing your password</h2>
                                <p className="text-xs text-text-muted">
                                    Only one password can unlock this mailbox. To change it, rotate your keys below
                                    - that sets a new password and replaces every other unlock method.
                                </p>
                            </div>
                        )}
                        <div>
                            <h2 className="text-sm font-semibold mb-2">Recovery codes</h2>
                            <p className="text-xs text-text-muted mb-3">
                                Regenerating replaces all of your existing recovery codes — old ones stop working
                                immediately.
                            </p>
                            <Button
                                type="button"
                                variant="secondary"
                                loading={regenerating}
                                disabled={regenerating || !vault}
                                onClick={handleRegenerateRecoveryCodes}
                                className="!w-auto"
                            >
                                Regenerate recovery codes
                            </Button>
                        </div>

                        <form onSubmit={handleRotateKeys} className="flex flex-col gap-2 border-t border-border pt-6">
                            <h2 className="text-sm font-semibold">Rotate keys</h2>
                            <p className="text-xs text-text-muted mb-1">
                                Real revocation, for when a device or an unlock method may have been compromised.
                                Re-protects your existing encryption key under a brand new master key - your signing/
                                encryption keypair itself doesn&rsquo;t change, so mail you&rsquo;ve already sent or
                                received still decrypts normally. Every current unlock method (password, recovery codes,
                                and anything else on file) stops working immediately; you&rsquo;ll set a new password and
                                get new recovery codes below.
                            </p>
                            {rotationBlockedBySigning && (
                                <p className="text-xs text-text-muted">
                                    {signingStatus === "checking"
                                        ? "Checking whether a signing certificate enrollment is still in progress..."
                                        : "Rotation is unavailable while a signing certificate enrollment is in progress - rotating now would lose the key being enrolled. Try again once it finishes, or cancel the enrollment."}
                                </p>
                            )}
                            {signingStatus === "pending" && signingEnrollmentId && (
                                <div className="flex flex-col gap-2">
                                    {cancelEnrollmentError && <Alert>{cancelEnrollmentError}</Alert>}
                                    <div>
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            className="!w-auto"
                                            loading={cancelingEnrollment}
                                            disabled={cancelingEnrollment}
                                            onClick={() => handleCancelEnrollment(signingEnrollmentId)}
                                        >
                                            Cancel enrollment
                                        </Button>
                                    </div>
                                </div>
                            )}
                            <input
                                type="password"
                                aria-label="New password for rotated keys"
                                placeholder="New password"
                                className="w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                                value={rotationPassword}
                                onChange={(e) => setRotationPassword(e.target.value)}
                                disabled={rotating || rotationBlockedBySigning}
                                autoComplete="new-password"
                            />
                            <input
                                type="password"
                                aria-label="Confirm new password for rotated keys"
                                placeholder="Confirm new password"
                                className="w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                                value={rotationConfirmPassword}
                                onChange={(e) => setRotationConfirmPassword(e.target.value)}
                                disabled={rotating || rotationBlockedBySigning}
                                autoComplete="new-password"
                            />
                            <div>
                                <Button
                                    type="submit"
                                    variant="secondary"
                                    className="!w-auto text-danger"
                                    loading={rotating}
                                    disabled={rotating || rotationBlockedBySigning}
                                >
                                    Rotate keys now
                                </Button>
                            </div>
                        </form>
                    </>
                )}

                <div>
                    <h2 className="text-sm font-semibold mb-2">Session timeout</h2>
                    <p className="text-xs text-text-muted mb-3">
                        Automatically destroys your unlocked keys on this device after this much time with no
                        activity anywhere in the app - not just Mail or Settings. Applies the next time you open
                        or reload the app.
                    </p>
                    <select
                        aria-label="Session timeout"
                        className="text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                        value={idleTimeoutMinutes}
                        onChange={handleIdleTimeoutChange}
                    >
                        {IDLE_TIMEOUT_OPTIONS_MINUTES.map((minutes) => (
                            <option key={minutes} value={minutes}>
                                {idleTimeoutLabel(minutes)}
                            </option>
                        ))}
                    </select>
                </div>

                <div>
                    <h2 className="text-sm font-semibold mb-2">Local search index size</h2>
                    <p className="text-xs text-text-muted mb-3">
                        How much decrypted mail this device keeps in a local encrypted search index, so recent
                        search results and inbox previews work instantly without contacting the server every
                        time. Defaults to {localIndexDefaultByteBudgetLabel} on this device. Applies the next
                        time this mailbox&rsquo;s index rebuilds (e.g. the next time you unlock it) — lowering
                        it doesn&rsquo;t delete anything already indexed elsewhere, it just narrows what this
                        device keeps a local copy of.
                    </p>
                    <select
                        aria-label="Local search index size"
                        className="text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                        value={localIndexByteBudget}
                        onChange={handleLocalIndexByteBudgetChange}
                    >
                        {LOCAL_INDEX_SIZE_OPTIONS.map((option) => (
                            <option key={option.bytes} value={option.bytes}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </div>

                <div>
                    <h2 className="text-sm font-semibold mb-2">This session</h2>
                    <p className="text-xs text-text-muted mb-3">
                        Removes your unlocked keys from this browser tab&rsquo;s memory right now, without
                        affecting any other device. You&rsquo;ll be asked to unlock again the next time you read
                        or send encrypted mail here.
                    </p>
                    <Button type="button" variant="secondary" className="!w-auto text-danger" onClick={handleDestroyKeysNow}>
                        Destroy keys on this device now
                    </Button>
                </div>
            </div>
        </div>
    );
}
