///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { updateMailbox } from "@rapidmx/react-shared/mailApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../shared/components/settings/layout/SettingsShell.js";
import Alert from "../../../shared/components/feedback/Alert.js";
import Button from "../../../shared/components/buttons/Button.js";

export type SettingsReadReceiptsPageProps = Omit<SettingsShellProps, "active">;

export default function SettingsReadReceiptsPage(props: SettingsReadReceiptsPageProps) {
    return (
        <SettingsShell {...props} active="read-receipts">
            <ReadReceiptsContent />
        </SettingsShell>
    );
}

function ReadReceiptsContent() {
    const { mailboxUid, mailboxes } = useSettingsShell();
    // `SettingsShell` only ever renders its children once `mailboxes` has loaded and `mailboxUid` has
    // resolved to one of them — same established non-null pattern as `apps/www/settings/auto-reply/index.tsx`.
    const mailbox = mailboxes.find((mb) => mb.uid === mailboxUid)!;

    const [alwaysRequestReceiptInternal, setAlwaysRequestReceiptInternal] = useState(mailbox.alwaysRequestReceiptInternal ?? true);
    const [alwaysRequestReceiptExternal, setAlwaysRequestReceiptExternal] = useState(mailbox.alwaysRequestReceiptExternal ?? false);
    const [autoSendReceiptsInternal, setAutoSendReceiptsInternal] = useState(mailbox.autoSendReceiptsInternal ?? true);
    const [autoSendReceiptsExternal, setAutoSendReceiptsExternal] = useState(mailbox.autoSendReceiptsExternal ?? false);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);
        setSaved(false);
        setSaving(true);
        try {
            await updateMailbox({
                uid: mailbox.uid,
                version: mailbox.version,
                alwaysRequestReceiptInternal,
                alwaysRequestReceiptExternal,
                autoSendReceiptsInternal,
                autoSendReceiptsExternal,
            });
            setSaved(true);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not save read receipt settings.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-xl">
                <h1 className="text-lg font-bold tracking-tight mb-1">Read Receipts</h1>
                <p className="text-sm text-text-muted mb-4">
                    Controls when this mailbox requests a delivery/read receipt on mail it sends, and how it
                    responds to a receipt requested of it. A per-message &ldquo;Request a read receipt&rdquo;
                    checkbox in Compose always overrides the request-side settings below for that one message.
                </p>

                {error && <Alert>{error}</Alert>}
                {saved && !error && <div className="mb-4 text-sm text-success font-medium">Saved.</div>}

                <form onSubmit={handleSubmit} className="flex flex-col gap-5">
                    <fieldset className="flex flex-col gap-2">
                        <legend className="text-sm font-semibold mb-1">Request receipts when sending</legend>
                        <label className="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={alwaysRequestReceiptInternal}
                                onChange={(e) => setAlwaysRequestReceiptInternal(e.target.checked)}
                            />
                            From internal recipients (mail to this organization)
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={alwaysRequestReceiptExternal}
                                onChange={(e) => setAlwaysRequestReceiptExternal(e.target.checked)}
                            />
                            From external recipients
                        </label>
                    </fieldset>

                    <fieldset className="flex flex-col gap-2">
                        <legend className="text-sm font-semibold mb-1">Respond automatically to requests</legend>
                        <label className="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={autoSendReceiptsInternal}
                                onChange={(e) => setAutoSendReceiptsInternal(e.target.checked)}
                            />
                            From internal senders
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={autoSendReceiptsExternal}
                                onChange={(e) => setAutoSendReceiptsExternal(e.target.checked)}
                            />
                            From external senders
                        </label>
                        <p className="text-xs text-text-muted">
                            Unchecked means a request from that sender waits in your Inbox for you to send or
                            decline it explicitly.
                        </p>
                    </fieldset>

                    <div>
                        <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                            Save
                        </Button>
                    </div>
                </form>
            </div>
        </div>
    );
}
