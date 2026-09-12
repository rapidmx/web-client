///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";
import { enrollKey, getKeyVault, PublicKey } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import {
    ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE,
    getUnlockedKeys,
    unlockWithPassword,
} from "@rapidmx/react-shared/crypto/keySession.js";
import { buildAad, generateMasterKey, sealWithKey } from "@rapidmx/react-shared/crypto/masterKey.js";
import { buildPasswordWrap, buildRecoveryWraps } from "@rapidmx/react-shared/crypto/masterKeyWraps.js";
import { exportPrivateKeyPkcs8, generateKeyPairWithCsr } from "@rapidmx/react-shared/crypto/keys.js";

type Status = "checking" | "setup_password" | "enrolling" | "show_recovery_codes" | "unlock" | "unlocking" | "ready";

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
export default function KeyEnrollmentGate({ mailboxUid, mailboxAddress, mailboxKeys, children }: KeyEnrollmentGateProps) {
    const [status, setStatus] = useState<Status>(mailboxUid ? "checking" : "ready");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
    const [codesSaved, setCodesSaved] = useState(false);

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
                    setStatus(vault.wrappedKeys.length > 0 ? "unlock" : "setup_password");
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
    }, [mailboxUid]);

    async function handleUnlock(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setStatus("unlocking");
        try {
            // Only reachable via "unlock", which the effect above only ever sets once mailboxUid was
            // defined.
            await unlockWithPassword(mailboxUid!, mailboxKeys ?? [], password);
            setStatus("ready");
        } catch {
            // Deliberately generic - see `unlockWithPassword()`'s own doc comment: it throws the same way
            // for "no password wrap enrolled" and "wrong password" today, and this UI has no way to tell
            // those apart without leaking which is which to a potential attacker guessing passwords.
            setError("Incorrect password.");
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
            // Only reachable via "setup_password", which the effect above only ever sets once mailboxUid
            // was defined (and mailboxAddress necessarily came with it - see KeyEnrollmentGateProps).
            const { recoveryCodes: codes } = await provisionEncryptionKey(mailboxUid!, mailboxAddress!, password);
            setRecoveryCodes(codes);
            setStatus("show_recovery_codes");
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not set up encryption for this mailbox.");
            setStatus("setup_password");
        }
    }

    if (status === "checking") {
        return null;
    }

    if (status === "unlock" || status === "unlocking") {
        const unlocking = status === "unlocking";
        return (
            <div className="min-h-screen flex items-center justify-center p-8 bg-surface-alt">
                <div className="w-full max-w-md bg-surface border border-border rounded-md p-8">
                    <h1 className="text-lg font-bold mb-2">Unlock your mailbox</h1>
                    <p className="text-sm text-text-muted mb-5">
                        Enter your encryption password to unlock signing and reading protected mail this session.
                    </p>
                    {error && <Alert>{error}</Alert>}
                    <form onSubmit={handleUnlock}>
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
                        <Button type="submit" loading={unlocking} disabled={unlocking}>
                            Unlock
                        </Button>
                    </form>
                </div>
            </div>
        );
    }

    if (status === "setup_password" || status === "enrolling") {
        const enrolling = status === "enrolling";
        return (
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
        );
    }

    if (status === "show_recovery_codes") {
        return (
            <div className="min-h-screen flex items-center justify-center p-8 bg-surface-alt">
                <div className="w-full max-w-md bg-surface border border-border rounded-md p-8">
                    <h1 className="text-lg font-bold mb-2">Save your recovery codes</h1>
                    <p className="text-sm text-text-muted mb-5">
                        If you lose your password, these codes are the only way to recover your encrypted mail.
                        Each code can be used once. Store them somewhere safe — they will not be shown again.
                    </p>
                    <ul className="grid grid-cols-2 gap-2 mb-5 font-mono text-sm">
                        {recoveryCodes.map((code) => (
                            <li key={code} className="bg-surface-alt rounded-sm py-1.5 px-2 text-center">
                                {code}
                            </li>
                        ))}
                    </ul>
                    <label className="flex items-center gap-2 text-sm mb-4">
                        <input type="checkbox" checked={codesSaved} onChange={(e) => setCodesSaved(e.target.checked)} />
                        I have saved these recovery codes in a safe place.
                    </label>
                    <Button type="button" disabled={!codesSaved} onClick={() => setStatus("ready")}>
                        Continue
                    </Button>
                </div>
            </div>
        );
    }

    return <>{children}</>;
}
