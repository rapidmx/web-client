///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Unlocking with a recovery code, and what has to happen after it. A recovery code is single-use: once it has opened
 * the keys, the user may set a new encryption password (`replacePasswordWrap()`), and then the used code is removed
 * (`consumeRecoveryCode()`). The order matters - react-shared's `replacePasswordWrap()` refuses unless another own
 * unlock method remains, and the not-yet-consumed code is that method.
 *
 * `UnlockPromptProvider` and `KeyEnrollmentGate` both unlock with `startRecoveryUnlock()`, settle whatever was waiting
 * on the unlock straight away, and then show `RecoveryFollowUpModal` for the follow-up steps.
 */
import React, { FormEvent, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { getUnlockedKeys, unlockWithRecoveryCode } from "@rapidmx/react-shared/crypto/keySession.js";
import { getKeyVault, type PublicKey } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { KeysLockedError } from "@rapidmx/react-shared/crypto/masterKey.js";
import {
    PasswordWrapReplaceError,
    consumeRecoveryCode,
    replacePasswordWrap,
} from "@rapidmx/react-shared/crypto/masterKeyWraps.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";

/** The same minimum every other "set an encryption password" form in this app uses. */
export const MIN_PASSWORD_LENGTH = 8;

/** Where recovery codes are regenerated. */
export const ENCRYPTION_SETTINGS_HREF = "/settings/encryption";

/** Deliberately generic: a wrong code and a vault with no recovery codes fail the same way. */
export const RECOVERY_CODE_ERROR = "That recovery code didn't work.";

export const REPLACE_ROTATED_MESSAGE =
    "Your encryption keys were changed on another device after you unlocked, so your password wasn't changed and your recovery code wasn't used. Reload the page and unlock again.";
export const REPLACE_MULTIPLE_PASSWORDS_MESSAGE =
    "This mailbox has more than one encryption password, so it can't be replaced here. Nothing was changed. Remove the extra password in Settings > Encryption first.";
export const REPLACE_NO_OTHER_METHOD_MESSAGE =
    "Your password wasn't changed, because this mailbox would be left with no other way to unlock. Your recovery code may already have been used in another window. Nothing was changed.";
export const REPLACE_ADD_FAILED_RESTORED_MESSAGE =
    "Your new password couldn't be saved, so your old password still works. Nothing was changed. Try again.";
export const REPLACE_ADD_FAILED_NOT_RESTORED_MESSAGE =
    "Your new password couldn't be saved, and your old password couldn't be put back, so this mailbox has no password right now. Your recovery code still works. Try again, or keep the code for now.";
export const REPLACE_LOCKED_MESSAGE =
    "Your encryption keys were locked before your new password could be set, so nothing was changed and your recovery code still works. Unlock with it again to set a new password.";
export const REPLACE_GENERIC_MESSAGE = "Your new password couldn't be saved. Nothing was changed. Try again.";
export const CONSUME_FAILED_MESSAGE =
    "The recovery code you used couldn't be removed, so it may still work. Regenerate your recovery codes in Settings > Encryption to make sure it can't be used again.";

/** What a successful recovery-code unlock hands to `RecoveryFollowUpModal`. */
export interface RecoveryFollowUp {
    mailboxUid: string;
    recoveryMethodId?: string;
    /** The codes left once the used one is consumed. */
    remainingRecoveryCodes: number;
    /** The vault's generation read *before* the unlock - see `startRecoveryUnlock()`. */
    expectedMasterKeyGeneration?: number;
    unopenableKeys: string[];
}

/**
 * Unlocks `mailboxUid` with a recovery code (normalized by react-shared, so spacing and case don't matter). The
 * vault's `masterKeyGeneration` is read first: if another device rotates the master key at any point after that read,
 * the generation passed to `replacePasswordWrap()` later is stale and the replacement is refused, never written with
 * a dead master key. A failed read just means no generation check. Rejects exactly as `unlockWithRecoveryCode()` does.
 */
export async function startRecoveryUnlock(mailboxUid: string, mailboxKeys: PublicKey[], code: string): Promise<RecoveryFollowUp> {
    const expectedMasterKeyGeneration = await getKeyVault(mailboxUid).then(
        (vault) => vault.masterKeyGeneration,
        () => undefined,
    );
    const result = await unlockWithRecoveryCode(mailboxUid, mailboxKeys, code);
    return {
        mailboxUid,
        recoveryMethodId: result.recoveryMethodId,
        remainingRecoveryCodes: result.remainingRecoveryCodes,
        expectedMasterKeyGeneration,
        unopenableKeys: result.unopenableKeys,
    };
}

/** A "use a recovery code instead" / "use your password instead" switch for an unlock form. */
export function UnlockModeToggle({
    mode,
    disabled,
    onChange,
}: {
    mode: "password" | "recovery";
    disabled: boolean;
    onChange: (mode: "password" | "recovery") => void;
}) {
    return (
        <Button
            type="button"
            variant="text"
            className="!w-auto"
            disabled={disabled}
            onClick={() => onChange(mode === "password" ? "recovery" : "password")}
        >
            {mode === "password" ? "Use a recovery code instead" : "Use your password instead"}
        </Button>
    );
}

type Step = "password" | "done";

/** Why the new-password form is no longer offered, with the message to show. `reload` adds a Reload button. */
interface Blocked {
    message: string;
    reload?: boolean;
    /** The secondary Skip / Keep action is still offered (e.g. two password wraps - nothing else is wrong). */
    allowSecondary?: boolean;
}

function replaceFailure(err: unknown): { message: string; blocked?: Blocked } {
    if (err instanceof PasswordWrapReplaceError) {
        switch (err.reason) {
            case "master_key_rotated":
                return { message: REPLACE_ROTATED_MESSAGE, blocked: { message: REPLACE_ROTATED_MESSAGE, reload: true } };
            case "multiple_password_wraps":
                return {
                    message: REPLACE_MULTIPLE_PASSWORDS_MESSAGE,
                    blocked: { message: REPLACE_MULTIPLE_PASSWORDS_MESSAGE, allowSecondary: true },
                };
            case "no_other_unlock_method":
                return { message: REPLACE_NO_OTHER_METHOD_MESSAGE, blocked: { message: REPLACE_NO_OTHER_METHOD_MESSAGE } };
            default:
                return { message: err.restored ? REPLACE_ADD_FAILED_RESTORED_MESSAGE : REPLACE_ADD_FAILED_NOT_RESTORED_MESSAGE };
        }
    }
    if (err instanceof KeysLockedError) {
        return { message: REPLACE_LOCKED_MESSAGE, blocked: { message: REPLACE_LOCKED_MESSAGE } };
    }
    return { message: err instanceof ApiRequestError ? `${REPLACE_GENERIC_MESSAGE} (${err.message})` : REPLACE_GENERIC_MESSAGE };
}

export interface RecoveryFollowUpModalProps {
    followUp: RecoveryFollowUp;
    /** `false` hides the dialog without losing its progress (e.g. while another unlock dialog is on top). */
    open?: boolean;
    onDone: () => void;
}

/**
 * The steps after a recovery-code unlock, shown once the keys are already open:
 *
 * 1. Offer a new encryption password. Optional ("Skip") - unless this was the last code, where it's required before the
 * code is used up (otherwise only a forgotten password would remain); then "Keep this code for now" closes without
 * consuming anything.
 * 2. Remove the used code. A failure is reported but never blocks anything - the keys are already open.
 * 3. Say how many codes are left, nudging towards regenerating them at two or fewer.
 *
 * Mount it with a `key` per follow-up so each unlock starts from step 1.
 */
export function RecoveryFollowUpModal({ followUp, open = true, onDone }: RecoveryFollowUpModalProps) {
    const { mailboxUid, recoveryMethodId, remainingRecoveryCodes, expectedMasterKeyGeneration } = followUp;
    const required = remainingRecoveryCodes === 0;
    const [step, setStep] = useState<Step>("password");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [blocked, setBlocked] = useState<Blocked | null>(null);
    const [busy, setBusy] = useState(false);
    const [passwordSet, setPasswordSet] = useState(false);
    const [consumeFailed, setConsumeFailed] = useState(false);

    async function consume() {
        let failed = !recoveryMethodId;
        if (recoveryMethodId) {
            try {
                await consumeRecoveryCode(mailboxUid, recoveryMethodId);
            } catch (err) {
                // 404: already gone (e.g. consumed from another tab) - that's the outcome wanted.
                failed = !(err instanceof ApiRequestError && err.status === 404);
            }
        }
        setConsumeFailed(failed);
        setStep("done");
    }

    async function handleSetPassword(e: FormEvent) {
        e.preventDefault();
        if (newPassword.length < MIN_PASSWORD_LENGTH) {
            setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
            return;
        }
        if (newPassword !== confirmPassword) {
            setError("Passwords do not match.");
            return;
        }
        setError(null);
        setBusy(true);
        try {
            // Read now, not at unlock time: an idle timeout or a lock elsewhere may have destroyed the keys since.
            const unlocked = getUnlockedKeys(mailboxUid);
            if (!unlocked || unlocked.destroyed) {
                throw new KeysLockedError();
            }
            // Before consuming - the unused code is the other unlock method that makes replacing safe.
            await replacePasswordWrap(mailboxUid, unlocked, newPassword, expectedMasterKeyGeneration);
        } catch (err) {
            const failure = replaceFailure(err);
            setBlocked(failure.blocked ?? null);
            setError(failure.blocked ? null : failure.message);
            setBusy(false);
            return;
        }
        setNewPassword("");
        setConfirmPassword("");
        setPasswordSet(true);
        await consume();
        setBusy(false);
    }

    async function handleSkip() {
        setError(null);
        setBusy(true);
        await consume();
        setBusy(false);
    }

    const title = step === "done" ? "Recovery code used" : "Set a new encryption password";
    const secondary = !blocked || !!blocked.allowSecondary;

    function handleClose() {
        if (busy) {
            return;
        }
        // Closing the password step means the same as its secondary action - never a silent password change, and the
        // last code is never consumed without a new password.
        if (step === "password" && !required && secondary) {
            void handleSkip();
            return;
        }
        onDone();
    }

    return (
        <Modal open={open} onClose={handleClose} title={title}>
            {step === "password" ? (
                <>
                    {required ? (
                        <p className="text-sm text-text-muted mb-4">
                            That was your last recovery code. Set a new encryption password before it&rsquo;s used up -
                            otherwise a password you&rsquo;ve forgotten would be the only way left to unlock this mailbox.
                        </p>
                    ) : (
                        <p className="text-sm text-text-muted mb-4">
                            Your mailbox is unlocked. If you&rsquo;ve forgotten your encryption password, set a new one now.
                            The recovery code you used will then be used up.
                        </p>
                    )}
                    {blocked ? (
                        <>
                            <Alert>{blocked.message}</Alert>
                            <div className="flex gap-2">
                                {blocked.reload && (
                                    <Button type="button" className="!w-auto" onClick={() => window.location.reload()}>
                                        Reload page
                                    </Button>
                                )}
                                {!secondary && (
                                    <Button type="button" variant="secondary" className="!w-auto" onClick={onDone}>
                                        Close
                                    </Button>
                                )}
                            </div>
                        </>
                    ) : (
                        <form onSubmit={handleSetPassword}>
                            {error && <Alert>{error}</Alert>}
                            <FormField label="New encryption password" htmlFor="recovery-new-password">
                                <input
                                    id="recovery-new-password"
                                    type="password"
                                    className="w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                    disabled={busy}
                                    autoComplete="new-password"
                                    autoFocus
                                />
                            </FormField>
                            <FormField label="Confirm new password" htmlFor="recovery-new-password-confirm">
                                <input
                                    id="recovery-new-password-confirm"
                                    type="password"
                                    className="w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                    disabled={busy}
                                    autoComplete="new-password"
                                />
                            </FormField>
                            <Button type="submit" className="!w-auto" loading={busy} disabled={busy}>
                                Set password
                            </Button>
                        </form>
                    )}
                    {secondary && (
                        <div className="mt-2">
                            {required ? (
                                <Button type="button" variant="text" className="!w-auto" disabled={busy} onClick={onDone}>
                                    Keep this code for now
                                </Button>
                            ) : (
                                <Button type="button" variant="text" className="!w-auto" disabled={busy} onClick={handleSkip}>
                                    Skip
                                </Button>
                            )}
                        </div>
                    )}
                </>
            ) : (
                <>
                    {passwordSet && <p className="text-sm mb-3">Your new encryption password is set.</p>}
                    {consumeFailed ? (
                        <p role="status" className="mb-3 py-2 px-3 rounded-sm text-sm bg-warning/15 text-text">
                            {CONSUME_FAILED_MESSAGE}
                        </p>
                    ) : (
                        <p className="text-sm mb-3">The recovery code you used has been used up and won&rsquo;t work again.</p>
                    )}
                    <p className="text-sm mb-3">
                        {remainingRecoveryCodes === 0
                            ? "You have no recovery codes left."
                            : `You have ${remainingRecoveryCodes} recovery ${remainingRecoveryCodes === 1 ? "code" : "codes"} left.`}
                        {remainingRecoveryCodes <= 2 && (
                            <>
                                {" "}
                                Generate a new set in{" "}
                                <a href={ENCRYPTION_SETTINGS_HREF} className="text-primary-dark hover:underline">
                                    Settings &gt; Encryption
                                </a>{" "}
                                with Regenerate recovery codes.
                            </>
                        )}
                    </p>
                    <Button type="button" className="!w-auto" onClick={onDone}>
                        Done
                    </Button>
                </>
            )}
        </Modal>
    );
}
