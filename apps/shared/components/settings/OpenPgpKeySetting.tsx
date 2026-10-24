///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { findActivePublicKey } from "../../../../lib/crypto/keyvaultApi.js";
import { MIN_EXPORT_PASSPHRASE_LENGTH } from "../../../../lib/crypto/keyExport.js";
import { exportOpenPgpSecretKey } from "../../../../lib/crypto/openPgpKey.js";
import type { Mailbox } from "../../../../lib/mail/mailApi.js";
import { ApiRequestError } from "../../../../lib/util/api.js";
import { useApiClient } from "../../../../lib/util/apiClientContext.js";
import Alert from "../../../../lib/components/feedback/Alert.js";
import Button from "../../../../lib/components/buttons/Button.js";
import { notifyApiError } from "../../notifications/apiErrors.js";
import PolicyLockedNotice from "./PolicyLockedNotice.js";

export interface OpenPgpKeySettingProps {
    mailbox: Mailbox;
    /** The caller owns the mailbox and isn't impersonating: only the owner may export its secret key. */
    canManage: boolean;
}

const INPUT_CLASS = "w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface";

/** Hands `text` to the browser as a file download. */
function saveText(text: string, filename: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: "application/pgp-keys" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

/** A fingerprint in groups of four, for reading aloud. */
function groupFingerprint(fingerprint: string): string {
    return fingerprint.toUpperCase().replace(/(.{4})/g, "$1 ").trim();
}

/**
 * The mailbox's OpenPGP key (restapi `specs/end-to-end_encryption.md` *OpenPGP Interoperability*): what it is for, its
 * fingerprint, a download of its public key (to give a correspondent by hand), and an export of its secret key, protected by a
 * passphrase, for reading this mailbox's OpenPGP mail in another app. Shows nothing while the mailbox has no OpenPGP key.
 */
export default function OpenPgpKeySetting({ mailbox, canManage }: OpenPgpKeySettingProps) {
    const client = useApiClient();
    const [open, setOpen] = useState(false);
    const [password, setPassword] = useState("");
    const [passphrase, setPassphrase] = useState("");
    const [confirmPassphrase, setConfirmPassphrase] = useState("");
    const [exporting, setExporting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const key = findActivePublicKey(mailbox.keys ?? [], "encrypt", "openpgp");
    if (!key) {
        return null;
    }
    const address = mailbox.primarySmtpAddress;

    function reset() {
        setOpen(false);
        setPassword("");
        setPassphrase("");
        setConfirmPassphrase("");
        setError(null);
    }

    async function downloadPublicKey() {
        const { armorPublicKey, readPublicKey } = await import("../../../../lib/crypto/openpgp.js");
        const certificate = await readPublicKey(key!.publicKey);
        if (certificate) {
            saveText(armorPublicKey(certificate), `${address}-openpgp-public.asc`);
        }
    }

    async function handleExport(e: React.FormEvent) {
        e.preventDefault();
        if (passphrase.length < MIN_EXPORT_PASSPHRASE_LENGTH) {
            setError(`The file's passphrase must be at least ${MIN_EXPORT_PASSPHRASE_LENGTH} characters.`);
            return;
        }
        if (passphrase !== confirmPassphrase) {
            setError("The passphrases don't match.");
            return;
        }
        setExporting(true);
        setError(null);
        try {
            const { armored } = await exportOpenPgpSecretKey(mailbox.uid, password, passphrase, client);
            saveText(armored, `${address}-openpgp-secret.asc`);
            reset();
        } catch (err) {
            if (err instanceof ApiRequestError) {
                notifyApiError(err, "Couldn't export your OpenPGP key");
            } else {
                setError("Incorrect password.");
            }
        } finally {
            setExporting(false);
        }
    }

    return (
        <div>
            <h2 className="text-sm font-semibold mb-2">OpenPGP key</h2>
            <p className="text-sm text-text-muted mb-2">
                People who use Proton Mail, Thunderbird or another OpenPGP app can send you encrypted mail with this key, and you can
                send it to them. RapidMX publishes it for you; you can also give it to someone yourself. RapidMX uses S/MIME whenever a
                recipient can receive it.
            </p>
            <p className="text-sm mb-2">
                Fingerprint: <code className="text-xs break-all">{groupFingerprint(key.fingerprint)}</code>
            </p>
            <div className="flex flex-wrap gap-2 mb-2">
                <Button type="button" variant="secondary" className="!w-auto" onClick={() => void downloadPublicKey()}>
                    Download public key
                </Button>
                {canManage && !open && (
                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => setOpen(true)}>
                        Export secret key&hellip;
                    </Button>
                )}
            </div>
            {!canManage ? (
                <PolicyLockedNotice>Only this mailbox&rsquo;s owner, signed in as themselves, can export its secret key.</PolicyLockedNotice>
            ) : (
                open && (
                    <form onSubmit={(e) => void handleExport(e)} className="flex flex-col gap-2">
                        <p className="text-sm text-text-muted">
                            Anyone with the exported file and its passphrase can read this mailbox&rsquo;s OpenPGP mail and sign as you.
                        </p>
                        <input
                            type="password"
                            aria-label="Encryption password"
                            placeholder="Encryption password"
                            className={INPUT_CLASS}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            disabled={exporting}
                            autoComplete="current-password"
                        />
                        <input
                            type="password"
                            aria-label="Key passphrase"
                            placeholder={`Key passphrase (at least ${MIN_EXPORT_PASSPHRASE_LENGTH} characters)`}
                            className={INPUT_CLASS}
                            value={passphrase}
                            onChange={(e) => setPassphrase(e.target.value)}
                            disabled={exporting}
                            autoComplete="new-password"
                        />
                        <input
                            type="password"
                            aria-label="Confirm key passphrase"
                            placeholder="Confirm key passphrase"
                            className={INPUT_CLASS}
                            value={confirmPassphrase}
                            onChange={(e) => setConfirmPassphrase(e.target.value)}
                            disabled={exporting}
                            autoComplete="new-password"
                        />
                        {error && <Alert>{error}</Alert>}
                        <div className="flex gap-2">
                            <Button type="submit" className="!w-auto" loading={exporting} disabled={exporting || !password}>
                                Export
                            </Button>
                            <Button type="button" variant="secondary" className="!w-auto" onClick={reset} disabled={exporting}>
                                Cancel
                            </Button>
                        </div>
                    </form>
                )
            )}
        </div>
    );
}
