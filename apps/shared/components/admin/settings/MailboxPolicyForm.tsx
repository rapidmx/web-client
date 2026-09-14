///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { MailboxPolicy, updateMailboxPolicy } from "@rapidmx/react-shared/admin/mailboxPolicyApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

const INPUT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

const GB = 1_000_000_000;

function toGb(bytes: number): string {
    return String(Math.round((bytes / GB) * 100) / 100);
}

export interface MailboxPolicyFormProps {
    policy: MailboxPolicy;
    onChange: (policy: MailboxPolicy) => void;
}

/** The mailbox defaults editor, shared by the Mailbox Policy page and the setup wizard. */
export default function MailboxPolicyForm({ policy, onChange }: MailboxPolicyFormProps) {
    const [defaultQuotaGb, setDefaultQuotaGb] = useState(toGb(policy.defaultQuotaBytes));
    const [autoProvisionEnabled, setAutoProvisionEnabled] = useState(policy.autoProvisionEnabled);
    const [autoProvisionQuotaGb, setAutoProvisionQuotaGb] = useState(toGb(policy.autoProvisionQuotaBytes));
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);
        setSaved(false);
        const defaultQuota = Number(defaultQuotaGb);
        const autoQuota = Number(autoProvisionQuotaGb);
        if (!(defaultQuota > 0) || !(autoQuota > 0)) {
            setError("Quotas must be more than 0 GB.");
            return;
        }
        setSaving(true);
        try {
            const updated = await updateMailboxPolicy({
                defaultQuotaBytes: Math.round(defaultQuota * GB),
                autoProvisionEnabled,
                autoProvisionQuotaBytes: Math.round(autoQuota * GB),
            });
            onChange(updated);
            setSaved(true);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not save the mailbox policy.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="max-w-xl">
            <h2 className="text-lg font-bold uppercase tracking-wide mb-1">Mailboxes</h2>
            <p className="text-sm text-text-muted mb-5">Defaults for new mailboxes on this server.</p>

            {error && <Alert>{error}</Alert>}
            {saved && !error && <div className="mb-4 text-sm text-success font-medium">Saved.</div>}

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-semibold">Default quota (GB)</span>
                    <input
                        aria-label="Default quota (GB)"
                        type="number"
                        min={0}
                        step="any"
                        className={INPUT_CLASS}
                        value={defaultQuotaGb}
                        onChange={(e) => setDefaultQuotaGb(e.target.value)}
                    />
                    <span className="text-xs text-text-muted">The storage a mailbox starts with when an administrator creates it.</span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                    <input
                        type="checkbox"
                        className="mt-1"
                        checked={autoProvisionEnabled}
                        onChange={(e) => setAutoProvisionEnabled(e.target.checked)}
                    />
                    <span>
                        <span className="font-semibold block">Let people create their own mailbox</span>
                        <span className="text-xs text-text-muted">
                            Someone who signs in without a mailbox can create one, using their username on one of this
                            server&rsquo;s verified domains.
                        </span>
                    </span>
                </label>
                {autoProvisionEnabled && (
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-semibold">Quota for self-created mailboxes (GB)</span>
                        <input
                            aria-label="Quota for self-created mailboxes (GB)"
                            type="number"
                            min={0}
                            step="any"
                            className={INPUT_CLASS}
                            value={autoProvisionQuotaGb}
                            onChange={(e) => setAutoProvisionQuotaGb(e.target.value)}
                        />
                    </label>
                )}
                <div>
                    <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                        Save
                    </Button>
                </div>
            </form>
        </div>
    );
}
