///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useState } from "react";
import { useRouter } from "@rapidrest/react/client";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { createEscrowScope } from "@rapidmx/react-shared/admin/escrowScopesApi.js";
import AdminShell, { AdminShellProps } from "../../../shared/components/admin/layout/AdminShell.js";
import EscrowScopeKeyAndHoldersFields, {
    emptyEscrowScopeKeyAndHoldersValue,
    selfAsHolderError,
} from "../../../shared/components/admin/escrowScopes/EscrowScopeKeyAndHoldersFields.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export default function NewEscrowScopePage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="escrowScopes">
            <NewEscrowScopeForm adminUid={props.userUid} />
        </AdminShell>
    );
}

function NewEscrowScopeForm({ adminUid }: { adminUid?: string }) {
    const { navigate } = useRouter();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [keyAndHolders, setKeyAndHolders] = useState(emptyEscrowScopeKeyAndHoldersValue());
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);

        if (!name.trim()) {
            setError("A name is required.");
            return;
        }
        if (!keyAndHolders.publicKey.trim() || !keyAndHolders.keyType.trim() || !keyAndHolders.fingerprint.trim()) {
            setError("The public key, its type, and its fingerprint are all required.");
            return;
        }
        if (keyAndHolders.holderUserUids.length === 0) {
            setError("At least one holder is required.");
            return;
        }
        if (keyAndHolders.requiredHolders < 1 || keyAndHolders.requiredHolders > keyAndHolders.holderUserUids.length) {
            setError("Required holders must be between 1 and the number of holders.");
            return;
        }
        const selfError = selfAsHolderError(keyAndHolders.holderUserUids, adminUid);
        if (selfError) {
            setError(selfError);
            return;
        }

        setSaving(true);
        try {
            const created = await createEscrowScope({
                name: name.trim(),
                description: description.trim() || undefined,
                publicKey: {
                    publicKey: keyAndHolders.publicKey.trim(),
                    type: keyAndHolders.keyType.trim(),
                    fingerprint: keyAndHolders.fingerprint.trim(),
                    notBefore: new Date(keyAndHolders.notBefore).getTime(),
                    notAfter: new Date(keyAndHolders.notAfter).getTime(),
                },
                holderUserUids: keyAndHolders.holderUserUids,
                requiredHolders: keyAndHolders.requiredHolders,
                notifySubjectOnAccess: keyAndHolders.notifySubjectOnAccess,
            });
            void navigate(`/admin/escrow-scopes/${encodeURIComponent(created.uid)}`);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not create the escrow scope.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="max-w-3xl">
            <h1 className="text-xl font-bold uppercase tracking-wide mb-1">New escrow scope</h1>
            <p className="text-sm text-text-muted mb-5">
                Configuring who counts as a holder is an administrative act, deliberately separate from actually
                holding the eDiscovery/compliance role.
            </p>

            {error && <Alert>{error}</Alert>}

            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
                <div className="bg-surface border border-border rounded-md p-6">
                    <FormField label="Name" htmlFor="name">
                        <input
                            id="name"
                            type="text"
                            className={INPUT_CLASS}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Legal Hold Q1"
                        />
                    </FormField>

                    <FormField label="Description (optional)" htmlFor="description">
                        <input
                            id="description"
                            type="text"
                            className={INPUT_CLASS}
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                        />
                    </FormField>
                </div>

                <EscrowScopeKeyAndHoldersFields value={keyAndHolders} onChange={setKeyAndHolders} />

                <div className="flex gap-3">
                    <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                        Create escrow scope
                    </Button>
                    <a href="/admin/escrow-scopes">
                        <Button type="button" variant="secondary" className="!w-auto">
                            Cancel
                        </Button>
                    </a>
                </div>
            </form>
        </div>
    );
}
