///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";
import { enrollKey, getKeyVault, PublicKey, VaultAlreadyInitializedError } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { UnopenableKeysNotice, unlockErrorMessage } from "./UnlockPromptProvider.js";
import { FrameTakeover } from "../../navigation/frameContext.js";
import { RecoveryFollowUp, RecoveryFollowUpModal, UnlockModeToggle, startRecoveryUnlock } from "./RecoveryCodeUnlock.js";
import {
    ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE,
    getUnlockedKeys,
    unlockWithPassword,
    type UnlockResult,
} from "@rapidmx/react-shared/crypto/keySession.js";
import { buildAad, generateMasterKey, sealWithKey } from "@rapidmx/react-shared/crypto/masterKey.js";
import { buildPasswordWrap, buildRecoveryWraps } from "@rapidmx/react-shared/crypto/masterKeyWraps.js";
import { exportPrivateKeyPkcs8, generateKeyPairWithCsr } from "@rapidmx/react-shared/crypto/keys.js";

type Status = "checking" | "setup_password" | "enrolling" | "already_set_up" | "show_recovery_codes" | "unlock" | "unlocking" | "ready";

const MIN_PASSWORD_LENGTH = 8;

async function provisionEncryptionKey(
    mailboxUid: string,
    mailboxAddress: string,
    password: string,
): Promise<{ recoveryCodes: string[] }> {
    const mk = generateMasterKey();
    const passwordWrap = await buildPasswordWrap(mailboxUid, mk, password);
    const { wraps: recoveryWraps, codes: recoveryCodes } = await buildRecoveryWraps(mailboxUid, mk);

    // Only the encryption key is provisioned here. The signing key's spec-required public-CA enrolment
    // (RFC 8823 ACME automation) is a real but genuinely asynchronous flow (a live email round-trip with
    // a public CA, likely minutes) - it's a deliberate opt-in action in Settings > Encryption
    // ("Enable digital signatures"), not something to block first-sign-in mailbox setup on.
    const { keyPair, csrPem } = await generateKeyPairWithCsr(mailboxAddress, "encrypt");
    const privateKeyRaw = await exportPrivateKeyPkcs8(keyPair.privateKey);
    const wrappedKeySealed = await sealWithKey(mk, privateKeyRaw, buildAad(mailboxUid, ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE));

    await enrollKey(mailboxUid, {
        useType: "encrypt",
        csr: csrPem,
        wrappedKey: { ciphertext: wrappedKeySealed.ciphertext, nonce: wrappedKeySealed.nonce, algorithm: "AES-256-GCM" },
        masterKeyWraps: [passwordWrap, ...recoveryWraps],
    });

    return { recoveryCodes };
}

export interface KeyEnrollmentGateProps {
    /** Undefined while the caller's mailbox hasn't resolved yet (or has none) - renders `children`
     * unchanged in that case, so this component can be mounted unconditionally at a stable tree
     * position (see this component's own doc comment for why that matters). */
    mailboxUid?: string;
    mailboxAddress?: string;
    /** The mailbox's currently-published public keys (`Mailbox.keys`) - needed to unlock an
     * already-enrolled vault (see `unlockWithPassword()`'s own signature), not just to provision a new
     * one. Treated as empty when undefined - a mailbox with no public keys published yet has nothing to
     * unlock, so this only affects the already-enrolled path. */
    mailboxKeys?: PublicKey[];
    /**
     * `true` (default) preserves this component's original behavior: a mailbox with an existing vault
     * but no unlocked session blocks `children` behind a full-page unlock form. Set to `false` for a
     * mount point that shouldn't block merely because a mailbox resolved - `MailShell` does this, since
     * unlocking is only actually required to sign/encrypt a compose, read an already-encrypted message,
     * or change encryption settings (see `UnlockPromptProvider.tsx`'s `useUnlockPrompt()`, which those
     * specific call sites use instead). Has no effect on first-time provisioning
     * (`setup_password`/`enrolling`/`show_recovery_codes`), which still always blocks regardless - that
     * only ever happens once per mailbox and is a genuine prerequisite, not the source of "unlock keeps
     * popping up" friction this prop exists to avoid.
     */
    blocking?: boolean;
    /**
     * `true` when the caller may provision this mailbox's first encryption key - i.e. they own it and aren't
     * an administrator impersonating them. `false` (default, so a caller that forgets it never provisions) for
     * a shared/delegated mailbox the caller doesn't own, or an impersonated session: a mailbox with no vault yet then
     * renders `children` instead of the "Protect your mailbox" setup, so a delegate never enrolls keys
     * (and recovery codes) for someone else's mailbox. Unlocking an existing vault is unaffected.
     */
    canProvision?: boolean;
    children: React.ReactNode;
}

/**
 * Gates a mailbox's normal content behind one-time E2E encryption key setup, per
 * `specs/end-to-end_encryption.md`'s "Generate signing and encryption keypairs on the client's device on
 * first sign-in." Rendered by `MailShell` wrapping its own returned content unconditionally, not only
 * once a mailbox is resolved — mounting this component at a *different* tree position depending on
 * `mailboxUid`'s readiness (e.g. only wrapping once ready, rendering bare content beforehand) would make
 * `children` (real `AppShell` chrome) itself remount the moment `mailboxUid` resolves, tearing down any
 * state/effects it had already started. Always wrapping keeps `AppShell` mounted continuously across
 * that transition; this component simply passes `children` through untouched while `mailboxUid` is
 * still unresolved, and only starts its own check once a real `mailboxUid` is supplied.
 *
 * A `getKeyVault()` failure (network error, server not yet wired up to serve this endpoint) also renders
 * `children` unchanged rather than blocking mail entirely - encryption is optional and gradual by design
 * (the spec's own "near zero frictionless experience" goal), not a hard prerequisite for reading mail.
 */
export default function KeyEnrollmentGate({
    mailboxUid,
    mailboxAddress,
    mailboxKeys,
    blocking = true,
    canProvision = false,
    children,
}: KeyEnrollmentGateProps) {
    const [status, setStatus] = useState<Status>(mailboxUid ? "checking" : "ready");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
    const [codesSaved, setCodesSaved] = useState(false);
    const [codesCopied, setCodesCopied] = useState(false);
    const [unopenableKeys, setUnopenableKeys] = useState<string[] | null>(null);
    const [unlockMode, setUnlockMode] = useState<"password" | "recovery">("password");
    const [recoveryCode, setRecoveryCode] = useState("");
    // Set after a recovery-code unlock: `children` render at once, with the follow-up steps in a dialog on top.
    const [followUp, setFollowUp] = useState<RecoveryFollowUp | null>(null);

    useEffect(() => {
        if (!mailboxUid) {
            return;
        }
        // A remount within the same browser session (e.g. navigating between pages) shouldn't re-prompt
        // for a password the in-memory session store (`keySession.ts`) already has unwrapped - only a
        // fresh session (reload, new tab, post-logout) has nothing there.
        if (getUnlockedKeys(mailboxUid)) {
            setStatus("ready");
            return;
        }
        let cancelled = false;
        getKeyVault(mailboxUid)
            .then((vault) => {
                if (!cancelled) {
                    setStatus(vault.wrappedKeys.length > 0 ? "unlock" : canProvision ? "setup_password" : "ready");
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setStatus("ready");
                }
            });
        return () => {
            cancelled = true;
        };
    }, [mailboxUid, canProvision]);

    async function handleUnlock(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setStatus("unlocking");
        try {
            // Only reachable via "unlock", which the effect above only ever sets once mailboxUid was
            // defined.
            const result: UnlockResult | RecoveryFollowUp = await (unlockMode === "recovery"
                ? startRecoveryUnlock(mailboxUid!, mailboxKeys ?? [], recoveryCode)
                : unlockWithPassword(mailboxUid!, mailboxKeys ?? [], password));
            const recovery = unlockMode === "recovery" ? (result as RecoveryFollowUp) : null;
            if (result.unopenableKeys.length > 0) {
                setUnopenableKeys(result.unopenableKeys);
            }
            setRecoveryCode("");
            setFollowUp(recovery);
            setStatus("ready");
        } catch (err) {
            // "Incorrect password." (or "That recovery code didn't work.") unless the secret was right but the
            // encryption key won't open - see `unlockErrorMessage()`.
            setError(unlockErrorMessage(err, unlockMode));
            setStatus("unlock");
        }
    }

    async function handleSetPassword(e: React.FormEvent) {
        e.preventDefault();
        if (password.length < MIN_PASSWORD_LENGTH) {
            setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
            return;
        }
        if (password !== confirmPassword) {
            setError("Passwords do not match.");
            return;
        }
        setError(null);
        setStatus("enrolling");
        try {
            // The vault was only checked on mount - another tab or device may have set encryption up since.
            // Provisioning now would publish a second master key, orphaning whichever setup lost the race, so
            // re-check right before generating anything. restapi's enrollKey() also refuses (409) wraps for a
            // vault that already has them, for a race inside this window.
            // Only reachable via "setup_password", which the effect above only ever sets once mailboxUid
            // was defined (and mailboxAddress necessarily came with it - see KeyEnrollmentGateProps).
            const fresh = await getKeyVault(mailboxUid!);
            if (fresh.wrappedKeys.length > 0 || fresh.masterKeyWraps.length > 0) {
                setStatus("already_set_up");
                return;
            }
            const { recoveryCodes: codes } = await provisionEncryptionKey(mailboxUid!, mailboxAddress!, password);
            setRecoveryCodes(codes);
            setStatus("show_recovery_codes");
        } catch (err) {
            // Only a 409 that is really "the vault already has wraps" - an unrelated lost optimistic-lock race is shown
            // as an ordinary error.
            if (err instanceof VaultAlreadyInitializedError) {
                setStatus("already_set_up");
                return;
            }
            setError(err instanceof ApiRequestError ? err.message : "Could not set up encryption for this mailbox.");
            setStatus("setup_password");
        }
    }

    async function handleCopyCodes() {
        try {
            await navigator.clipboard.writeText(recoveryCodes.join("\n"));
            setCodesCopied(true);
            setTimeout(() => setCodesCopied(false), 2000);
        } catch {
            // Clipboard access can be denied by the browser - the codes are still selectable/copyable by
            // hand from the list below.
        }
    }

    if (status === "checking") {
        return null;
    }

    if ((status === "unlock" || status === "unlocking") && blocking) {
        const unlocking = status === "unlocking";
        return (
            <FrameTakeover>
            <div className="min-h-screen flex items-center justify-center p-8 bg-surface-alt">
                <div className="w-full max-w-md bg-surface border border-border rounded-md p-8">
                    <h1 className="text-lg font-bold mb-2">Unlock your mailbox</h1>
                    <p className="text-sm text-text-muted mb-5">
                        {unlockMode === "password"
                            ? "Enter your encryption password to unlock signing and reading protected mail this session."
                            : "Enter one of your recovery codes to unlock signing and reading protected mail this session. Each code works once."}
                    </p>
                    {error && <Alert>{error}</Alert>}
                    <form onSubmit={handleUnlock}>
                        {unlockMode === "password" ? (
                            <FormField label="Encryption password" htmlFor="key-unlock-password">
                                <input
                                    id="key-unlock-password"
                                    type="password"
                                    className="w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    disabled={unlocking}
                                    autoComplete="current-password"
                                />
                            </FormField>
                        ) : (
                            <FormField label="Recovery code" htmlFor="key-unlock-recovery-code">
                                <input
                                    id="key-unlock-recovery-code"
                                    type="text"
                                    className="w-full text-sm font-mono border border-border rounded-sm py-1.5 px-2 bg-surface"
                                    value={recoveryCode}
                                    onChange={(e) => setRecoveryCode(e.target.value)}
                                    disabled={unlocking}
                                    autoComplete="off"
                                    autoCapitalize="characters"
                                    spellCheck={false}
                                />
                            </FormField>
                        )}
                        <Button type="submit" loading={unlocking} disabled={unlocking}>
                            Unlock
                        </Button>
                    </form>
                    <div className="mt-3">
                        <UnlockModeToggle
                            mode={unlockMode}
                            disabled={unlocking}
                            onChange={(next) => {
                                setUnlockMode(next);
                                setError(null);
                            }}
                        />
                    </div>
                </div>
            </div>
            </FrameTakeover>
        );
    }

    if (status === "setup_password" || status === "enrolling") {
        const enrolling = status === "enrolling";
        return (
            <FrameTakeover>
            <div className="min-h-screen flex items-center justify-center p-8 bg-surface-alt">
                <div className="w-full max-w-md bg-surface border border-border rounded-md p-8">
                    <h1 className="text-lg font-bold mb-2">Protect your mailbox</h1>
                    <p className="text-sm text-text-muted mb-5">
                        Choose a password to protect your encryption keys. This is separate from your sign-in
                        password and is never sent to the server.
                    </p>
                    {error && <Alert>{error}</Alert>}
                    <form onSubmit={handleSetPassword}>
                        <FormField label="Encryption password" htmlFor="key-enrollment-password">
                            <input
                                id="key-enrollment-password"
                                type="password"
                                className="w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                disabled={enrolling}
                                autoComplete="new-password"
                            />
                        </FormField>
                        <FormField label="Confirm password" htmlFor="key-enrollment-password-confirm">
                            <input
                                id="key-enrollment-password-confirm"
                                type="password"
                                className="w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                disabled={enrolling}
                                autoComplete="new-password"
                            />
                        </FormField>
                        <Button type="submit" loading={enrolling} disabled={enrolling}>
                            Continue
                        </Button>
                    </form>
                </div>
            </div>
            </FrameTakeover>
        );
    }

    if (status === "already_set_up") {
        return (
            <FrameTakeover>
            <div className="min-h-screen flex items-center justify-center p-8 bg-surface-alt">
                <div className="w-full max-w-md bg-surface border border-border rounded-md p-8">
                    <h1 className="text-lg font-bold mb-2">Encryption is already set up</h1>
                    <p className="text-sm text-text-muted mb-5">
                        This mailbox&rsquo;s encryption was set up in another tab or on another device while this
                        page was open, so nothing was changed here. Reload the page and unlock with the password
                        chosen there.
                    </p>
                    <Button type="button" onClick={() => window.location.reload()}>
                        Reload
                    </Button>
                </div>
            </div>
            </FrameTakeover>
        );
    }

    if (status === "show_recovery_codes") {
        return (
            <FrameTakeover>
            <div className="min-h-screen flex items-center justify-center p-8 bg-surface-alt">
                <div className="w-full max-w-md bg-surface border border-border rounded-md p-8">
                    <h1 className="text-lg font-bold mb-2">Save your recovery codes</h1>
                    <p className="text-sm text-text-muted mb-5">
                        If you lose your password, these codes are the only way to recover your encrypted mail.
                        Each code can be used once. Store them somewhere safe — they will not be shown again.
                    </p>
                    <ul className="grid grid-cols-2 gap-2 mb-3 font-mono text-sm">
                        {recoveryCodes.map((code) => (
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
                    <Button type="button" disabled={!codesSaved} onClick={() => setStatus("ready")}>
                        Continue
                    </Button>
                </div>
            </div>
            </FrameTakeover>
        );
    }

    return (
        <>
            {children}
            {unopenableKeys && <UnopenableKeysNotice fingerprints={unopenableKeys} onDismiss={() => setUnopenableKeys(null)} />}
            {followUp && <RecoveryFollowUpModal followUp={followUp} onDone={() => setFollowUp(null)} />}
        </>
    );
}
