///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { toDatetimeLocal } from "@rapidmx/react-shared/dateInput.js";
import { updateMailbox } from "@rapidmx/react-shared/mailApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../shared/components/settings/layout/SettingsShell.js";
import Alert from "../../../shared/components/feedback/Alert.js";
import Button from "../../../shared/components/buttons/Button.js";

const INPUT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export type SettingsAutoReplyPageProps = Omit<SettingsShellProps, "active">;

export default function SettingsAutoReplyPage(props: SettingsAutoReplyPageProps) {
    return (
        <SettingsShell {...props} active="auto-reply">
            <AutoReplyContent />
        </SettingsShell>
    );
}

function AutoReplyContent() {
    const { mailboxUid, mailboxes } = useSettingsShell();
    // `SettingsShell` only ever renders its children once `mailboxes` has loaded and `mailboxUid` has
    // resolved to one of them (a mailbox-less caller sees `MailboxProvisioning` instead) — this lookup
    // can't miss, same established non-null pattern as `apps/www/contacts/index.tsx`'s `mailboxUid!`.
    const mailbox = mailboxes.find((mb) => mb.uid === mailboxUid)!;

    const [oofEnabled, setOofEnabled] = useState(mailbox.oofEnabled ?? false);
    const [oofMessage, setOofMessage] = useState(mailbox.oofMessage ?? "");
    const [oofStartTime, setOofStartTime] = useState(mailbox.oofStartTime ? toDatetimeLocal(mailbox.oofStartTime) : "");
    const [oofEndTime, setOofEndTime] = useState(mailbox.oofEndTime ? toDatetimeLocal(mailbox.oofEndTime) : "");
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
                oofEnabled,
                oofMessage,
                oofStartTime: oofStartTime ? new Date(oofStartTime).toISOString() : undefined,
                oofEndTime: oofEndTime ? new Date(oofEndTime).toISOString() : undefined,
            });
            setSaved(true);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not save automatic reply settings.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-xl">
                <h1 className="text-lg font-bold tracking-tight mb-1">Automatic Replies</h1>
                <p className="text-sm text-text-muted mb-4">
                    Send an automatic reply to anyone who emails {mailbox.displayName} while you&rsquo;re away. A
                    calendar event with its own automatic reply enabled takes over for its own start/end window.
                </p>

                {error && <Alert>{error}</Alert>}
                {saved && !error && <div className="mb-4 text-sm text-success font-medium">Saved.</div>}

                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <label className="flex items-center gap-2 text-sm font-medium">
                        <input type="checkbox" checked={oofEnabled} onChange={(e) => setOofEnabled(e.target.checked)} />
                        Automatic replies are on
                    </label>

                    {oofEnabled && (
                        <>
                            <label className="flex flex-col gap-1.5 text-sm">
                                <span className="font-semibold">Message</span>
                                <textarea
                                    aria-label="Automatic reply message"
                                    className={INPUT_CLASS}
                                    rows={5}
                                    value={oofMessage}
                                    onChange={(e) => setOofMessage(e.target.value)}
                                />
                            </label>

                            <div className="grid grid-cols-2 gap-3">
                                <label className="flex flex-col gap-1.5 text-sm">
                                    <span className="font-semibold">Start (optional)</span>
                                    <input
                                        type="datetime-local"
                                        aria-label="Automatic reply start"
                                        className={INPUT_CLASS}
                                        value={oofStartTime}
                                        onChange={(e) => setOofStartTime(e.target.value)}
                                    />
                                </label>
                                <label className="flex flex-col gap-1.5 text-sm">
                                    <span className="font-semibold">End (optional)</span>
                                    <input
                                        type="datetime-local"
                                        aria-label="Automatic reply end"
                                        className={INPUT_CLASS}
                                        value={oofEndTime}
                                        onChange={(e) => setOofEndTime(e.target.value)}
                                    />
                                </label>
                            </div>
                            <p className="text-xs text-text-muted -mt-2">Leave both blank to stay on indefinitely until turned off.</p>
                        </>
                    )}

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
