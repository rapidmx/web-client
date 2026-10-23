///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { exportKeysAsPkcs12, MIN_EXPORT_PASSPHRASE_LENGTH, NothingToExportError } from "../../../../lib/crypto/keyExport.js";
import type { Mailbox } from "../../../../lib/mail/mailApi.js";
import { ApiRequestError } from "../../../../lib/util/api.js";
import { useApiClient } from "../../../../lib/util/apiClientContext.js";
import Alert from "../../../../lib/components/feedback/Alert.js";
import Button from "../../../../lib/components/buttons/Button.js";
import { notifyApiError } from "../../notifications/apiErrors.js";
import PolicyLockedNotice from "./PolicyLockedNotice.js";

export interface KeyExportSettingProps {
    mailbox: Mailbox;
    /** The caller owns the mailbox and isn't impersonating: restapi records an export only for the owner. */
    canManage: boolean;
}

const INPUT_CLASS = "w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface";

/** Hands `bytes` to the browser as a file download. */
function saveFile(bytes: Uint8Array, filename: string): void {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/x-pkcs12" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

/**
 * "Export keys for Outlook/phone" (`lib/crypto/keyExport.ts`): a passphrase-protected `.p12` with the mailbox's zero-access
 * and end-to-end encryption keys - and its signing key, if the user ticks the box - so a mail app that isn't RapidMX can read
 * mail stored encrypted. Asks for the master password again however long the mailbox has been unlocked.
 */
export default function KeyExportSetting({ mailbox, canManage }: KeyExportSettingProps) {
    const client = useApiClient();
    const [open, setOpen] = useState(false);
    const [password, setPassword] = useState("");
    const [passphrase, setPassphrase] = useState("");
    const [confirmPassphrase, setConfirmPassphrase] = useState("");
    const [includeSigningKey, setIncludeSigningKey] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function reset() {
        setOpen(false);
        setPassword("");
        setPassphrase("");
        setConfirmPassphrase("");
        setIncludeSigningKey(false);
        setError(null);
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
            const result = await exportKeysAsPkcs12(
                {
                    mailboxUid: mailbox.uid,
                    mailboxAddress: mailbox.primarySmtpAddress,
                    mailboxKeys: mailbox.keys ?? [],
                    masterPassword: password,
                    exportPassphrase: passphrase,
                    includeSigningKey,
                },
                client,
            );
            saveFile(result.pkcs12, `${mailbox.primarySmtpAddress}-keys.p12`);
            reset();
        } catch (err) {
            if (err instanceof ApiRequestError) {
                notifyApiError(err, "Couldn't export your keys");
            } else if (err instanceof NothingToExportError || (err instanceof Error && err.message.startsWith("This mailbox has no password"))) {
                setError(err.message);
            } else {
                setError("Incorrect password.");
            }
        } finally {
            setExporting(false);
        }
    }

    return (
        <div>
            <h2 className="text-sm font-semibold mb-2">Export keys for Outlook or a phone</h2>
            <p className="text-sm text-text-muted mb-2">
                Mail apps other than RapidMX need your keys to read encrypted mail. The exported file holds your zero-access and
                end-to-end encryption keys, protected by a passphrase you choose. Anyone with the file and its passphrase can read
                all of this mailbox&rsquo;s mail, so keep it safe and delete it once it&rsquo;s installed.
            </p>
            {!canManage ? (
                <PolicyLockedNotice>Only this mailbox&rsquo;s owner, signed in as themselves, can export its keys.</PolicyLockedNotice>
            ) : !open ? (
                <Button type="button" variant="secondary" className="!w-auto" onClick={() => setOpen(true)}>
                    Export keys&hellip;
                </Button>
            ) : (
                <form onSubmit={(e) => void handleExport(e)} className="flex flex-col gap-2">
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
                        aria-label="File passphrase"
                        placeholder={`File passphrase (at least ${MIN_EXPORT_PASSPHRASE_LENGTH} characters)`}
                        className={INPUT_CLASS}
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        disabled={exporting}
                        autoComplete="new-password"
                    />
                    <input
                        type="password"
                        aria-label="Confirm file passphrase"
                        placeholder="Confirm file passphrase"
                        className={INPUT_CLASS}
                        value={confirmPassphrase}
                        onChange={(e) => setConfirmPassphrase(e.target.value)}
                        disabled={exporting}
                        autoComplete="new-password"
                    />
                    <label className="flex items-start gap-2 text-sm">
                        <input
                            type="checkbox"
                            className="mt-1"
                            checked={includeSigningKey}
                            onChange={(e) => setIncludeSigningKey(e.target.checked)}
                            disabled={exporting}
                        />
                        <span>
                            <span className="font-semibold block">Include my signing key</span>
                            <span className="text-xs text-text-muted">Only if that app will sign mail you send. Anyone with the file could sign as you.</span>
                        </span>
                    </label>
                    {error && <Alert>{error}</Alert>}
                    <div className="flex gap-2">
                        <Button type="submit" className="!w-auto" disabled={exporting || !password || !passphrase}>
                            {exporting ? "Exporting…" : "Export"}
                        </Button>
                        <Button type="button" variant="secondary" className="!w-auto" onClick={reset} disabled={exporting}>
                            Cancel
                        </Button>
                    </div>
                </form>
            )}
        </div>
    );
}
