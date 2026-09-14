///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { getUnlockedKeys, unlockWithPassword, UnlockedKeys } from "@rapidmx/react-shared/crypto/keySession.js";
import type { PublicKey } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";

interface PendingUnlock {
    mailboxUid: string;
    mailboxKeys: PublicKey[];
    /** Every caller waiting on this one dialog - a second request for the same mailbox while it's open joins
     * it rather than replacing it, so no earlier caller's promise is ever left unsettled. */
    waiters: { resolve: (keys: UnlockedKeys) => void; reject: (err: Error) => void }[];
}

interface UnlockPromptContextValue {
    /**
     * Resolves immediately with this mailbox's already-unlocked keys if it has any this session -
     * showing no UI at all. Otherwise shows an unlock dialog on top of whatever the user is currently
     * doing and resolves once they enter the correct password, or rejects if they dismiss it.
     */
    requestUnlock(mailboxUid: string, mailboxKeys: PublicKey[]): Promise<UnlockedKeys>;
}

const UnlockPromptContext = createContext<UnlockPromptContextValue | null>(null);

/**
 * The on-demand counterpart to `KeyEnrollmentGate`'s blocking, first-sign-in-only provisioning flow.
 * Per `specs/end-to-end_encryption.md`, unlocking is only actually *required* to (1) sign or encrypt an
 * outgoing message, (2) read an already-encrypted message, or (3) change encryption settings that touch
 * the master key - not merely to have a mailbox with an existing vault resolve. Mounted once in
 * `AppShell.tsx` (shared by every top-level app shell: Mail, Calendar, Contacts, Tasks, Settings), so
 * any of those three call sites (`ComposeWindow`'s sign/encrypt toggles, `MessageDetailPane`'s encrypted-
 * message view, `Settings > Encryption`) can request an unlock right where it's needed via
 * `useUnlockPrompt()`, instead of the whole app being blocked behind an unlock screen the moment a
 * mailbox happens to resolve - see `KeyEnrollmentGate`'s `blocking` prop, which `MailShell` now sets to
 * `false` for exactly this reason.
 */
export function UnlockPromptProvider({ children }: { children: React.ReactNode }) {
    const [pending, setPendingState] = useState<PendingUnlock | null>(null);
    // Mirrors `pending` synchronously, so two requests issued in the same tick see each other.
    const pendingRef = useRef<PendingUnlock | null>(null);
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [unlocking, setUnlocking] = useState(false);

    function setPending(next: PendingUnlock | null) {
        pendingRef.current = next;
        setPendingState(next);
    }

    const requestUnlock = useCallback((mailboxUid: string, mailboxKeys: PublicKey[]): Promise<UnlockedKeys> => {
        const existing = getUnlockedKeys(mailboxUid);
        if (existing) {
            return Promise.resolve(existing);
        }
        return new Promise<UnlockedKeys>((resolve, reject) => {
            const current = pendingRef.current;
            if (current?.mailboxUid === mailboxUid) {
                current.waiters.push({ resolve, reject });
                return;
            }
            // A different mailbox's dialog is replacing this one - settle its callers rather than leaving
            // their promises hanging forever.
            current?.waiters.forEach((waiter) => waiter.reject(new Error("Unlock superseded by another request.")));
            setPassword("");
            setError(null);
            setPending({ mailboxUid, mailboxKeys, waiters: [{ resolve, reject }] });
        });
    }, []);

    function handleCancel() {
        pendingRef.current?.waiters.forEach((waiter) => waiter.reject(new Error("Unlock cancelled.")));
        setPending(null);
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        // Only reachable via the form below, which never renders while `pending` is null.
        const request = pending!;
        setError(null);
        setUnlocking(true);
        try {
            await unlockWithPassword(request.mailboxUid, request.mailboxKeys, password);
            // Always reachable: unlockWithPassword() just populated keySession.ts's session store for
            // this exact mailboxUid, or threw before we get here.
            const unlocked = getUnlockedKeys(request.mailboxUid)!;
            request.waiters.forEach((waiter) => waiter.resolve(unlocked));
            if (pendingRef.current === request) {
                setPending(null);
            }
        } catch {
            // Deliberately generic - see KeyEnrollmentGate's identical handleUnlock() for why.
            setError("Incorrect password.");
        } finally {
            setUnlocking(false);
        }
    }

    return (
        <UnlockPromptContext.Provider value={{ requestUnlock }}>
            {children}
            <Modal open={!!pending} onClose={handleCancel} title="Unlock your mailbox">
                <p className="text-sm text-text-muted mb-5">Enter your encryption password to continue.</p>
                {error && <Alert>{error}</Alert>}
                <form onSubmit={handleSubmit}>
                    <FormField label="Encryption password" htmlFor="unlock-prompt-password">
                        <input
                            id="unlock-prompt-password"
                            type="password"
                            className="w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            disabled={unlocking}
                            autoComplete="current-password"
                            autoFocus
                        />
                    </FormField>
                    <div className="flex gap-2">
                        <Button type="submit" loading={unlocking} disabled={unlocking}>
                            Unlock
                        </Button>
                        <Button type="button" variant="secondary" onClick={handleCancel} disabled={unlocking}>
                            Cancel
                        </Button>
                    </div>
                </form>
            </Modal>
        </UnlockPromptContext.Provider>
    );
}

/** Throws outside an `<UnlockPromptProvider>` - every app shell mounts one (see `AppShell.tsx`), so
 * reaching this from any real page is a wiring bug, not a runtime condition to degrade gracefully from. */
export function useUnlockPrompt(): UnlockPromptContextValue {
    const ctx = useContext(UnlockPromptContext);
    if (!ctx) {
        throw new Error("useUnlockPrompt() must be used within an UnlockPromptProvider (see AppShell.tsx).");
    }
    return ctx;
}
