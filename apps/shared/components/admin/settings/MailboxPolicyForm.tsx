///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { MailboxPolicy, updateMailboxPolicy } from "@rapidmx/react-shared/admin/mailboxPolicyApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

const INPUT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

const GB = 1_000_000_000;

/** Unrounded, so a quota that isn't a whole number of hundredths of a GB (say 4 MB) is shown as it is. */
function toGb(bytes: number): string {
    return String(bytes / GB);
}

/** The form's values as they were loaded or last saved. */
interface Baseline {
    defaultQuotaGb: string;
    autoProvisionEnabled: boolean;
    autoProvisionQuotaGb: string;
}

export interface MailboxPolicyFormProps {
    policy: MailboxPolicy;
    onChange: (policy: MailboxPolicy) => void;
    /** Told whether the form has edits that haven't been saved. */
    onDirtyChange?: (dirty: boolean) => void;
    /** Set when shown as one section of a page with its own heading (the setup wizard), so the title is a smaller,
     * lower-level heading. */
    embedded?: boolean;
}

/** The mailbox defaults editor, shared by the Mailbox Policy page and the setup wizard. */
export default function MailboxPolicyForm({ policy, onChange, onDirtyChange, embedded = false }: MailboxPolicyFormProps) {
    const [defaultQuotaGb, setDefaultQuotaGb] = useState(toGb(policy.defaultQuotaBytes));
    const [autoProvisionEnabled, setAutoProvisionEnabled] = useState(policy.autoProvisionEnabled);
    const [autoProvisionQuotaGb, setAutoProvisionQuotaGb] = useState(toGb(policy.autoProvisionQuotaBytes));
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    // Edits are unsaved until they match what was loaded or last saved.
    const [baseline, setBaseline] = useState<Baseline>({ defaultQuotaGb, autoProvisionEnabled, autoProvisionQuotaGb });
    const dirty: boolean =
        defaultQuotaGb !== baseline.defaultQuotaGb ||
        autoProvisionEnabled !== baseline.autoProvisionEnabled ||
        autoProvisionQuotaGb !== baseline.autoProvisionQuotaGb;
    useEffect(() => onDirtyChange?.(dirty), [dirty]);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);
        setSaved(false);
        // Only fields the administrator changed are sent, so a quota left alone keeps its exact stored bytes.
        const patch: Partial<MailboxPolicy> = {};
        for (const [field, text, base] of [
            ["defaultQuotaBytes", defaultQuotaGb, baseline.defaultQuotaGb],
            ["autoProvisionQuotaBytes", autoProvisionQuotaGb, baseline.autoProvisionQuotaGb],
        ] as const) {
            if (text === base) {
                continue;
            }
            const bytes: number = Math.round(Number(text) * GB);
            if (!(bytes >= 1)) {
                setError("Quotas must be more than 0 GB.");
                return;
            }
            patch[field] = bytes;
        }
        if (autoProvisionEnabled !== baseline.autoProvisionEnabled) {
            patch.autoProvisionEnabled = autoProvisionEnabled;
        }
        const current: Baseline = { defaultQuotaGb, autoProvisionEnabled, autoProvisionQuotaGb };
        if (Object.keys(patch).length === 0) {
            setSaved(true);
            return;
        }
        setSaving(true);
        try {
            const updated = await updateMailboxPolicy(patch);
            onChange(updated);
            setBaseline(current);
            setSaved(true);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not save the mailbox policy.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="max-w-xl">
            {embedded ? (
                <h3 className="text-base font-bold uppercase tracking-wide mb-1">Mailboxes</h3>
            ) : (
                <h2 className="text-lg font-bold uppercase tracking-wide mb-1">Mailboxes</h2>
            )}
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
