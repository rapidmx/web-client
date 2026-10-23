///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { EncryptionPolicy, PolicyState, updateEncryptionPolicy } from "../../../../../lib/crypto/keyvaultApi.js";
import Alert from "../ActionAlert.js";
import Button from "../../../../../lib/components/buttons/Button.js";
import Modal from "../../../../../lib/components/overlays/Modal.js";
import { actionErrorMessage } from "../elevation.js";

const SELECT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

type TierKey = "encryptSameOrg" | "encryptFederated" | "encryptExternal";

const TIERS: { key: TierKey; label: string; help: string }[] = [
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
    // A server without zero-access encryption sends no `allowZeroAccess`; the checkbox is then not shown at all.
    const zeroAccessSupported: boolean = policy.allowZeroAccess !== undefined;
    const dirty: boolean =
        TIERS.some((tier) => values[tier.key] !== savedValues[tier.key]) || (zeroAccessSupported && values.allowZeroAccess !== savedValues.allowZeroAccess);
    useEffect(() => onDirtyChange?.(dirty), [dirty]);

    // Tiers this save would newly set to "Never encrypt", which switches encryption off for everyone's mail of that kind: confirmed first.
    const [confirmingProhibit, setConfirmingProhibit] = useState<string[] | null>(null);
    // Turning zero-access encryption off makes new mail readable by this server again for every mailbox: confirmed first.
    const [confirmingZeroAccessOff, setConfirmingZeroAccessOff] = useState(false);

    function handleSubmit(e: FormEvent) {
        e.preventDefault();
        const newlyProhibited = TIERS.filter((tier) => values[tier.key] === "prohibited" && savedValues[tier.key] !== "prohibited");
        if (newlyProhibited.length > 0) {
            setConfirmingProhibit(newlyProhibited.map((tier) => tier.label));
            return;
        }
        confirmZeroAccessThenSave();
    }

    function confirmZeroAccessThenSave() {
        setConfirmingProhibit(null);
        if (zeroAccessSupported && values.allowZeroAccess === false && savedValues.allowZeroAccess !== false) {
            setConfirmingZeroAccessOff(true);
            return;
        }
        void save();
    }

    async function save() {
        setConfirmingProhibit(null);
        setConfirmingZeroAccessOff(false);
        setError(null);
        setSaved(false);
        setSaving(true);
        try {
            const updated = await updateEncryptionPolicy(values);
            onChange(updated);
            setSavedValues(values);
            setSaved(true);
        } catch (err) {
            setError(actionErrorMessage(err, "Could not save the encryption policy."));
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
                {zeroAccessSupported && (
                    <div className="mt-2 pt-4 border-t border-border">
                        <span className="font-semibold text-sm block mb-1">Zero-access encryption</span>
                        <label className="flex items-start gap-2 text-sm">
                            <input
                                type="checkbox"
                                className="mt-1"
                                checked={values.allowZeroAccess !== false}
                                onChange={(e) => {
                                    setSaved(false);
                                    setValues({ ...values, allowZeroAccess: e.target.checked });
                                }}
                            />
                            <span>
                                <span className="font-semibold block">Allow zero-access encryption</span>
                                <span className="text-xs text-text-muted">
                                    Mail that arrives unencrypted is encrypted the moment it is received, to a key only the mailbox&rsquo;s
                                    owner can unlock, and this server keeps no readable copy - administrators can&rsquo;t read it either,
                                    except through an escrow scope. People can still turn it off for their own mailbox. Search of message
                                    contents then happens in the app instead of on the server.
                                </span>
                            </span>
                        </label>
                    </div>
                )}
                <div>
                    <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                        Save
                    </Button>
                </div>
            </form>

            <Modal open={confirmingProhibit !== null} onClose={() => setConfirmingProhibit(null)} title="Turn off encryption?">
                <p className="text-sm mb-3">
                    Saving sets <strong>{confirmingProhibit?.join(", ")}</strong> to Never encrypt. Nobody on this server can then encrypt
                    that mail end to end, whatever they have chosen for themselves, until an administrator allows it again.
                </p>
                <div className="flex gap-3 justify-end">
                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => setConfirmingProhibit(null)}>
                        Cancel
                    </Button>
                    <Button type="button" className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger" onClick={confirmZeroAccessThenSave}>
                        Save and turn off encryption
                    </Button>
                </div>
            </Modal>

            <Modal open={confirmingZeroAccessOff} onClose={() => setConfirmingZeroAccessOff(false)} title="Turn off zero-access encryption?">
                <p className="text-sm mb-3">
                    Mail that arrives from now on will be stored in a form this server can read, for every mailbox. Mail that is already
                    encrypted stays encrypted - this server can&rsquo;t decrypt it. Everyone sees in their settings that an administrator
                    turned it off.
                </p>
                <div className="flex gap-3 justify-end">
                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => setConfirmingZeroAccessOff(false)}>
                        Cancel
                    </Button>
                    <Button type="button" className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger" onClick={() => void save()}>
                        Save and turn off zero-access encryption
                    </Button>
                </div>
            </Modal>
        </div>
    );
}
