///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    KeyVault,
    MasterKeyWrap,
    PublicKey,
    addMasterKeyWrap,
    checkSignEnrollmentStatus,
    findActivePublicKey,
    getEscrowInfo,
    getKeyVault,
    rekey,
    removeMasterKeyWrap,
    startSignEnrollment,
} from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import {
    SIGNING_PRIVATE_KEY_AAD_PURPOSE,
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
import { buildAad, sealWithKey } from "@rapidmx/react-shared/crypto/masterKey.js";
import { buildEscrowWrap, buildPasswordWrap, buildRecoveryWraps } from "@rapidmx/react-shared/crypto/masterKeyWraps.js";
import { rewrapPrivateKeysUnderNewMasterKey } from "@rapidmx/react-shared/crypto/keyRotation.js";
import { exportPrivateKeyPkcs8, generateKeyPairWithCsr } from "@rapidmx/react-shared/crypto/keys.js";
import { getMailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../shared/components/settings/layout/SettingsShell.js";
import KeyEnrollmentGate from "../../../shared/components/layout/KeyEnrollmentGate.js";
import { destroyLocalIndex } from "../../../shared/search/localIndexRpcClient.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

const MIN_PASSWORD_LENGTH = 8;

// RFC 8823 ACME issuance is a real email round-trip with a public CA - "likely minutes," not seconds -
// so this polls infrequently rather than hammering the endpoint.
const SIGNING_ENROLLMENT_POLL_INTERVAL_MS = 15_000;

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
            <EncryptionGate />
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
function EncryptionGate() {
    const { mailboxUid, mailboxes } = useSettingsShell();
    const mailbox = mailboxes.find((mb) => mb.uid === mailboxUid)!;
    return (
        <KeyEnrollmentGate mailboxUid={mailboxUid} mailboxAddress={mailbox.primarySmtpAddress} mailboxKeys={mailbox.keys}>
            <EncryptionContent />
        </KeyEnrollmentGate>
    );
}

function EncryptionContent() {
    const { mailboxUid, mailboxes } = useSettingsShell();
    const mailbox = mailboxes.find((mb) => mb.uid === mailboxUid)!;

    const [vault, setVault] = useState<KeyVault | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [removingMethod, setRemovingMethod] = useState<string | null>(null);
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

    const [rotationPassword, setRotationPassword] = useState("");
    const [rotationConfirmPassword, setRotationConfirmPassword] = useState("");
    const [rotating, setRotating] = useState(false);

    const [destroyed, setDestroyed] = useState(false);
    const [idleTimeoutMinutes, setIdleTimeoutMinutesState] = useState(() => getIdleTimeoutMinutes());
    const [localIndexByteBudget, setLocalIndexByteBudgetState] = useState(() => getLocalIndexByteBudget());
    const localIndexDefaultByteBudgetLabel =
        LOCAL_INDEX_SIZE_OPTIONS.find((option) => option.bytes === getDefaultLocalIndexByteBudget())?.label ?? "500 MB";

    // `mailbox.keys` comes from `SettingsShell`'s one-time `listMailboxes()` fetch - once an ACME
    // enrollment issues, the server has installed a new signing key that fetch never saw. Only this
    // page refetches (via `getMailbox()`) to notice; `null` means "no fresher data yet, use mailbox.keys".
    const [refreshedKeys, setRefreshedKeys] = useState<PublicKey[] | null>(null);
    const displayedKeys = refreshedKeys ?? mailbox.keys ?? [];
    const activeSigningKey = findActivePublicKey(displayedKeys, "sign");

    const [signingStatus, setSigningStatus] = useState<"idle" | "enrolling" | "pending">("idle");
    const [signingEnrollmentId, setSigningEnrollmentId] = useState<string | null>(null);
    const [signingError, setSigningError] = useState<string | null>(null);

    const hasEscrowWrap = vault?.masterKeyWraps.some((w) => w.method === "escrow") ?? false;
    const [wrappingEscrow, setWrappingEscrow] = useState(false);
    const [escrowError, setEscrowError] = useState<string | null>(null);

    async function handleWrapEscrow() {
        setEscrowError(null);
        setWrappingEscrow(true);
        try {
            // Only reachable when mailbox.escrowScopeId is set (see the render guard below) and
            // `unlocked` is defined - see `handleAddPassword`'s identical note on the latter.
            const escrowInfo = await getEscrowInfo(mailboxUid!);
            const wrap = await buildEscrowWrap(unlocked!.masterKey, escrowInfo.escrowScopeId, fromBase64(escrowInfo.publicKey.publicKey));
            await addMasterKeyWrap(mailboxUid!, wrap);
            await loadVault();
        } catch (err) {
            setEscrowError(err instanceof ApiRequestError ? err.message : "Could not add escrow protection for this mailbox.");
        } finally {
            setWrappingEscrow(false);
        }
    }

    useEffect(() => {
        if (signingStatus !== "pending" || !signingEnrollmentId) {
            return;
        }
        let cancelled = false;
        const interval = setInterval(async () => {
            try {
                const result = await checkSignEnrollmentStatus(mailboxUid!, signingEnrollmentId);
                if (cancelled) {
                    return;
                }
                if (result.status === "issued") {
                    setSigningStatus("idle");
                    setSigningEnrollmentId(null);
                    const refreshed = await getMailbox(mailboxUid!);
                    if (!cancelled) {
                        setRefreshedKeys(refreshed.keys ?? []);
                    }
                } else if (result.status === "failed") {
                    setSigningStatus("idle");
                    setSigningEnrollmentId(null);
                    setSigningError(result.error ?? "Signing certificate enrollment failed.");
                }
                // "pending" leaves state as-is - the interval below just tries again.
            } catch {
                // Transient network error - keep polling rather than surfacing a one-off failure.
            }
        }, SIGNING_ENROLLMENT_POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [signingStatus, signingEnrollmentId, mailboxUid]);

    async function handleEnrollSigning() {
        setSigningError(null);
        setSigningStatus("enrolling");
        try {
            // Only reachable once `unlocked` is defined - see `handleAddPassword`'s identical note.
            const { keyPair, csrPem } = await generateKeyPairWithCsr(mailbox.primarySmtpAddress, "sign");
            const privateKeyRaw = await exportPrivateKeyPkcs8(keyPair.privateKey);
            const wrappedKeySealed = await sealWithKey(
                unlocked!.masterKey,
                privateKeyRaw,
                buildAad(mailboxUid!, SIGNING_PRIVATE_KEY_AAD_PURPOSE),
            );
            const { enrollmentId } = await startSignEnrollment(mailboxUid!, {
                csr: csrPem,
                wrappedKey: { ciphertext: wrappedKeySealed.ciphertext, nonce: wrappedKeySealed.nonce, algorithm: "AES-256-GCM" },
            });
            setSigningEnrollmentId(enrollmentId);
            setSigningStatus("pending");
        } catch (err) {
            setSigningError(err instanceof ApiRequestError ? err.message : "Could not start signing certificate enrollment.");
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
        loadVault();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mailboxUid]);

    const unlocked = getUnlockedKeys(mailboxUid!);
    const passwordWraps = vault?.masterKeyWraps.filter((w) => w.method === "password") ?? [];
    const recoveryWraps = vault?.masterKeyWraps.filter((w) => w.method === "recovery") ?? [];
    const otherWraps = vault?.masterKeyWraps.filter((w) => w.method !== "password" && w.method !== "recovery") ?? [];

    async function handleRemove(wrap: MasterKeyWrap) {
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
            // Only reachable once `unlocked` is defined - `EncryptionGate` guarantees this mailbox is
            // unlocked before `EncryptionContent` ever mounts.
            const wrap = await buildPasswordWrap(mailboxUid!, unlocked!.masterKey, newPassword);
            await addMasterKeyWrap(mailboxUid!, wrap);
            setNewPassword("");
            setConfirmNewPassword("");
            await loadVault();
        } catch (err) {
            setActionError(err instanceof ApiRequestError ? err.message : "Could not add this password.");
        } finally {
            setAddingPassword(false);
        }
    }

    async function handleRegenerateRecoveryCodes() {
        setActionError(null);
        setRegenerating(true);
        try {
            for (const wrap of recoveryWraps) {
                await removeMasterKeyWrap(mailboxUid!, "recovery", wrap.methodId);
            }
            const { wraps, codes } = await buildRecoveryWraps(mailboxUid!, unlocked!.masterKey);
            for (const wrap of wraps) {
                await addMasterKeyWrap(mailboxUid!, wrap);
            }
            setRecoveryCodesReason("regenerate");
            setNewRecoveryCodes(codes);
            setCodesSaved(false);
            await loadVault();
        } catch (err) {
            setActionError(err instanceof ApiRequestError ? err.message : "Could not regenerate recovery codes.");
        } finally {
            setRegenerating(false);
        }
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
     * comment): re-wraps this mailbox's already-unlocked private keys under a brand new master key
     * (`rewrapPrivateKeysUnderNewMasterKey()`), wraps that new MK under a freshly entered password and a
     * fresh set of recovery codes, and atomically replaces the vault - the enrolled keypair/certificate
     * itself is unchanged (restapi's own `rekey()` rejects anything else), only how it's protected.
     * Every *other* unlock method this mailbox had (a second password, a passkey, an old set of recovery
     * codes) stops working the instant this succeeds, since `rekey()` replaces `masterKeyWraps` wholesale
     * - the whole point, for a captured-wrap scenario where it's unclear which method was compromised.
     */
    async function handleRotateKeys(e: FormEvent) {
        e.preventDefault();
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
        try {
            // Only reachable once `unlocked` is defined - see `handleAddPassword`'s identical note.
            const { mk, wrappedKeys } = await rewrapPrivateKeysUnderNewMasterKey(mailboxUid!, unlocked!);
            const passwordWrap = await buildPasswordWrap(mailboxUid!, mk, rotationPassword);
            const { wraps: newRecoveryWraps, codes } = await buildRecoveryWraps(mailboxUid!, mk);
            await rekey(mailboxUid!, { wrappedKeys, masterKeyWraps: [passwordWrap, ...newRecoveryWraps], keys: mailbox.keys ?? [] });

            // restapi's own rekey() can never accept a fresh escrow wrap (its validateMasterKeyWrap()
            // always passes allowEscrow: false there) - it preserves this mailbox's existing escrow wrap
            // verbatim instead, which now encrypts a master key nobody has any longer. Re-wrap it
            // separately, via the same addMasterKeyWrap() path "Add escrow protection" above already
            // uses, so rotating keys for an unrelated reason (lost device, password hygiene) doesn't
            // silently drop real escrow coverage while this page keeps claiming it's still active. A
            // failure here is reported via escrowError, not as a rotation failure - the rotation itself
            // (password/recovery codes) already succeeded by this point and must not be rolled back for
            // an escrow-specific hiccup the user can retry independently.
            if (hasEscrowWrap) {
                try {
                    const escrowInfo = await getEscrowInfo(mailboxUid!);
                    const escrowWrap = await buildEscrowWrap(mk, escrowInfo.escrowScopeId, fromBase64(escrowInfo.publicKey.publicKey));
                    await addMasterKeyWrap(mailboxUid!, escrowWrap);
                } catch (err) {
                    setEscrowError(
                        err instanceof ApiRequestError
                            ? err.message
                            : 'Your keys were rotated, but escrow protection could not be re-established automatically. Use "Add escrow protection" below to restore it.',
                    );
                }
            }

            // Refreshes this session's own cached keys against the new MK, via the password we just set -
            // the underlying private key material didn't change, but the stale MK in memory would silently
            // build wrong future wraps (e.g. a second "Add a password") if left as-is.
            await unlockWithPassword(mailboxUid!, mailbox.keys ?? [], rotationPassword);
            setRotationPassword("");
            setRotationConfirmPassword("");
            setRecoveryCodesReason("rotate");
            setNewRecoveryCodes(codes);
            setCodesSaved(false);
            await loadVault();
        } catch (err) {
            setActionError(err instanceof ApiRequestError ? err.message : "Could not rotate your encryption keys.");
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

    if (destroyed) {
        return (
            <div className="flex-1 min-w-0 overflow-y-auto p-6">
                <div className="max-w-xl">
                    <Alert>
                        Your encryption keys have been removed from this session. Reload the page (or open Mail
                        again) to unlock them when you need to read or send encrypted mail.
                    </Alert>
                </div>
            </div>
        );
    }

    if (newRecoveryCodes) {
        return (
            <div className="flex-1 min-w-0 overflow-y-auto p-6">
                <div className="max-w-xl">
                    <h1 className="text-lg font-bold tracking-tight mb-1">Save your new recovery codes</h1>
                    <p className="text-sm text-text-muted mb-4">
                        {recoveryCodesReason === "rotate"
                            ? "Your keys have been rotated - every previous unlock method (password, recovery codes, or anything else on file) has stopped working. "
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
                                disabled={signingStatus === "enrolling"}
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
                        {/* Rendered regardless of hasEscrowWrap - a rotation-triggered re-wrap failure
                            (see handleRotateKeys) leaves the mailbox's old, now-stale escrow wrap in place,
                            so hasEscrowWrap alone can't be trusted to hide this. */}
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
                                    Your organization has assigned this mailbox to an escrow scope, but nothing
                                    has been protected yet — an authorized holder cannot recover this mailbox's
                                    encrypted mail until you complete this step. This does not weaken protection
                                    against anyone else.
                                </p>
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
                                        {wrap.method !== "escrow" && (
                                            <Button
                                                type="button"
                                                variant="text"
                                                className="!w-auto text-danger"
                                                loading={removingMethod === key}
                                                disabled={removingMethod !== null}
                                                onClick={() => handleRemove(wrap)}
                                            >
                                                Remove
                                            </Button>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <p className="text-sm text-text-muted">No unlock methods on file.</p>
                    )}
                </div>

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
                        disabled={regenerating}
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
                    <input
                        type="password"
                        aria-label="New password for rotated keys"
                        placeholder="New password"
                        className="w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                        value={rotationPassword}
                        onChange={(e) => setRotationPassword(e.target.value)}
                        disabled={rotating}
                        autoComplete="new-password"
                    />
                    <input
                        type="password"
                        aria-label="Confirm new password for rotated keys"
                        placeholder="Confirm new password"
                        className="w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                        value={rotationConfirmPassword}
                        onChange={(e) => setRotationConfirmPassword(e.target.value)}
                        disabled={rotating}
                        autoComplete="new-password"
                    />
                    <div>
                        <Button type="submit" variant="secondary" className="!w-auto text-danger" loading={rotating} disabled={rotating}>
                            Rotate keys now
                        </Button>
                    </div>
                </form>

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
