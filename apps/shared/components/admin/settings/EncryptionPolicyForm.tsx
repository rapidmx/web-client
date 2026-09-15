///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { EncryptionPolicy, PolicyState, updateEncryptionPolicy } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

const SELECT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

const TIERS: { key: keyof EncryptionPolicy; label: string; help: string }[] = [
    { key: "encryptSameOrg", label: "Mail within this server", help: "Messages between mailboxes hosted on this server." },
    {
        key: "encryptFederated",
        label: "Mail to other RapidMX servers",
        help: "Messages to people on another RapidMX server that publishes its encryption keys.",
    },
    { key: "encryptExternal", label: "Mail to everyone else", help: "Messages to any other email provider, using S/MIME." },
];

const STATES: { value: PolicyState; label: string }[] = [
    { value: "automatic", label: "Always encrypt when possible" },
    { value: "optional", label: "Let people choose" },
    { value: "prohibited", label: "Never encrypt" },
];

/** Whether end-to-end encryption can be used at all under `policy` - i.e. any tier allows it. */
export function isEncryptionEnabled(policy: EncryptionPolicy): boolean {
    return TIERS.some((tier) => policy[tier.key] !== "prohibited");
}

export interface EncryptionPolicyFormProps {
    policy: EncryptionPolicy;
    onChange: (policy: EncryptionPolicy) => void;
    /** Told whether the form has edits that haven't been saved. */
    onDirtyChange?: (dirty: boolean) => void;
    /** Set when shown as one section of a page with its own heading (the setup wizard), so the title is a smaller,
     * lower-level heading. */
    embedded?: boolean;
}

/** The end-to-end encryption policy editor, shared by the Encryption Policy page and the setup wizard. */
export default function EncryptionPolicyForm({ policy, onChange, onDirtyChange, embedded = false }: EncryptionPolicyFormProps) {
    const [values, setValues] = useState<EncryptionPolicy>(policy);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    // Edits are unsaved until they match what was loaded or last saved.
    const [savedValues, setSavedValues] = useState<EncryptionPolicy>(policy);
    const dirty: boolean = TIERS.some((tier) => values[tier.key] !== savedValues[tier.key]);
    useEffect(() => onDirtyChange?.(dirty), [dirty]);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);
        setSaved(false);
        setSaving(true);
        try {
            const updated = await updateEncryptionPolicy(values);
            onChange(updated);
            setSavedValues(values);
            setSaved(true);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not save the encryption policy.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="max-w-xl">
            {embedded ? (
                <h3 className="text-base font-bold uppercase tracking-wide mb-1">End-to-end encryption</h3>
            ) : (
                <h2 className="text-lg font-bold uppercase tracking-wide mb-1">End-to-end encryption</h2>
            )}
            <p className="text-sm text-text-muted mb-5">
                Encrypted messages can only be read by their senders and recipients - not by this server or its
                administrators. Choose how encryption applies to each kind of mail.
            </p>

            {error && <Alert>{error}</Alert>}
            {saved && !error && <div className="mb-4 text-sm text-success font-medium">Saved.</div>}

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                {TIERS.map((tier) => (
                    <label key={tier.key} className="flex flex-col gap-1.5 text-sm">
                        <span className="font-semibold">{tier.label}</span>
                        <select
                            aria-label={tier.label}
                            className={SELECT_CLASS}
                            value={values[tier.key]}
                            onChange={(e) => {
                                setSaved(false);
                                setValues({ ...values, [tier.key]: e.target.value as PolicyState });
                            }}
                        >
                            {STATES.map((state) => (
                                <option key={state.value} value={state.value}>
                                    {state.label}
                                </option>
                            ))}
                        </select>
                        <span className="text-xs text-text-muted">{tier.help}</span>
                    </label>
                ))}
                <div>
                    <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                        Save
                    </Button>
                </div>
            </form>
        </div>
    );
}
