///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { toDatetimeLocal } from "@rapidmx/react-shared/util/dateInput.js";
import {
    deleteEscrowScope,
    EscrowScope,
    getEscrowScope,
    updateEscrowScope,
} from "@rapidmx/react-shared/admin/escrowScopesApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import EscrowScopeKeyAndHoldersFields, {
    EscrowScopeKeyAndHoldersValue,
    selfAsHolderError,
} from "../../shared/components/admin/escrowScopes/EscrowScopeKeyAndHoldersFields.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

function toFieldsValue(scope: EscrowScope): EscrowScopeKeyAndHoldersValue {
    return {
        publicKey: scope.publicKey.publicKey,
        keyType: scope.publicKey.type,
        fingerprint: scope.publicKey.fingerprint,
        notBefore: toDatetimeLocal(new Date(scope.publicKey.notBefore).toISOString()),
        notAfter: toDatetimeLocal(new Date(scope.publicKey.notAfter).toISOString()),
        holderUserUids: scope.holderUserUids,
        requiredHolders: scope.requiredHolders,
        notifySubjectOnAccess: scope.notifySubjectOnAccess,
    };
}

/**
 * Describes every change to the security-relevant parts of a scope - who holds it, how many holders must approve,
 * and its public key - so the administrator confirms exactly what they're changing before it's saved.
 */
export function describeSecurityChanges(original: EscrowScope, next: EscrowScopeKeyAndHoldersValue): string[] {
    const changes: string[] = [];
    const added = next.holderUserUids.filter((holder) => !original.holderUserUids.includes(holder));
    const removed = original.holderUserUids.filter((holder) => !next.holderUserUids.includes(holder));
    if (added.length > 0) {
        changes.push(`Add holders: ${added.join(", ")}`);
    }
    if (removed.length > 0) {
        changes.push(`Remove holders: ${removed.join(", ")}`);
    }
    if (next.requiredHolders !== original.requiredHolders) {
        changes.push(`Required approvals: ${original.requiredHolders} → ${next.requiredHolders}`);
    }
    const originalKey = toFieldsValue(original);
    if (next.publicKey.trim() !== originalKey.publicKey || next.keyType.trim() !== originalKey.keyType) {
        changes.push("Replace the public key");
    }
    if (next.fingerprint.trim() !== originalKey.fingerprint) {
        changes.push(`Fingerprint: ${originalKey.fingerprint} → ${next.fingerprint.trim()}`);
    }
    if (next.notBefore !== originalKey.notBefore || next.notAfter !== originalKey.notAfter) {
        changes.push(`Key validity: ${originalKey.notBefore} – ${originalKey.notAfter} → ${next.notBefore} – ${next.notAfter}`);
    }
    return changes;
}

export default function EscrowScopeDetailPage(props: Omit<AdminShellProps, "active"> & { params: { uid: string } }) {
    return (
        <AdminShell {...props} active="escrowScopes">
            <EscrowScopeDetailContent uid={props.params.uid} adminUid={props.userUid} />
        </AdminShell>
    );
}

function EscrowScopeDetailContent({ uid, adminUid }: { uid: string; adminUid?: string }) {
    const [original, setOriginal] = useState<EscrowScope | null>(null);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [fields, setFields] = useState<EscrowScopeKeyAndHoldersValue | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [pendingChanges, setPendingChanges] = useState<string[] | null>(null);

    useEffect(() => {
        setLoading(true);
        setError(null);
        getEscrowScope(uid)
            .then((loaded) => {
                setOriginal(loaded);
                if (loaded) {
                    setName(loaded.name);
                    setDescription(loaded.description ?? "");
                    setFields(toFieldsValue(loaded));
                }
            })
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load this escrow scope."))
            .finally(() => setLoading(false));
    }, [uid]);

    // Only ever invoked from the form below, which itself only renders once `original`/`fields` are
    // loaded (the early returns further down cover every other state) — the non-null assertions reflect
    // that real invariant, not an unchecked assumption. Matches `TransportRuleDetailContent.handleSubmit`'s
    // identical pattern.
    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);

        if (!name.trim()) {
            setError("A name is required.");
            return;
        }
        if (!fields!.publicKey.trim() || !fields!.keyType.trim() || !fields!.fingerprint.trim()) {
            setError("The public key, its type, and its fingerprint are all required.");
            return;
        }
        if (fields!.holderUserUids.length === 0) {
            setError("At least one holder is required.");
            return;
        }
        if (fields!.requiredHolders < 1 || fields!.requiredHolders > fields!.holderUserUids.length) {
            setError("Required holders must be between 1 and the number of holders.");
            return;
        }
        const selfError = selfAsHolderError(fields!.holderUserUids, adminUid, original!.holderUserUids);
        if (selfError) {
            setError(selfError);
            return;
        }

        const changes = describeSecurityChanges(original!, fields!);
        if (changes.length > 0) {
            setPendingChanges(changes);
            return;
        }
        await save();
    }

    async function save() {
        setPendingChanges(null);
        setSaving(true);
        setSaved(false);
        try {
            const updated = await updateEscrowScope({
                uid: original!.uid,
                version: original!.version,
                name: name.trim(),
                description: description.trim() || undefined,
                publicKey: {
                    publicKey: fields!.publicKey.trim(),
                    type: fields!.keyType.trim(),
                    fingerprint: fields!.fingerprint.trim(),
                    notBefore: new Date(fields!.notBefore).getTime(),
                    notAfter: new Date(fields!.notAfter).getTime(),
                },
                holderUserUids: fields!.holderUserUids,
                requiredHolders: fields!.requiredHolders,
                notifySubjectOnAccess: fields!.notifySubjectOnAccess,
            });
            setOriginal(updated);
            setFields(toFieldsValue(updated));
            setSaved(true);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not save this escrow scope.");
        } finally {
            setSaving(false);
        }
    }

    function closeDeleteModal() {
        setConfirmingDelete(false);
    }

    // Only ever invoked from the delete-confirmation modal below, which itself only renders once
    // `original` is resolved — same non-null-assertion precedent as `handleSubmit` above.
    async function handleDelete() {
        setDeleting(true);
        setDeleteError(null);
        try {
            await deleteEscrowScope(original!.uid, original!.version);
            window.location.href = "/admin/escrow-scopes";
        } catch (err) {
            // Most commonly a 409 ("referenced by an existing Matter") — see `deleteEscrowScope()`'s own
            // doc comment - surfaced as-is rather than special-cased.
            setDeleteError(err instanceof ApiRequestError ? err.message : "Could not delete this escrow scope.");
            setDeleting(false);
        }
    }

    if (loading) {
        return <p className="text-sm text-text-muted">Loading&hellip;</p>;
    }
    if (error && !original) {
        return <Alert>{error}</Alert>;
    }
    if (!original || !fields) {
        return <Alert>Escrow scope not found.</Alert>;
    }

    return (
        <div className="max-w-3xl">
            <div className="flex items-start justify-between gap-4 mb-1">
                <div>
                    <a href="/admin/escrow-scopes" className="text-sm text-primary-dark hover:underline">
                        &larr; All escrow scopes
                    </a>
                    <h1 className="text-xl font-bold tracking-tight mt-1">{original.name}</h1>
                </div>
                <Button
                    type="button"
                    variant="secondary"
                    className="!w-auto shrink-0 !border-danger !text-danger hover:!border-danger hover:!text-danger"
                    onClick={() => setConfirmingDelete(true)}
                >
                    Delete scope
                </Button>
            </div>

            {error && <Alert>{error}</Alert>}
            {saved && !error && <div className="mb-4 text-sm text-success font-medium">Saved.</div>}

            <form onSubmit={handleSubmit} className="flex flex-col gap-5 mt-4">
                <div className="bg-surface border border-border rounded-md p-6">
                    <FormField label="Name" htmlFor="name">
                        <input
                            id="name"
                            type="text"
                            className={INPUT_CLASS}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
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

                <EscrowScopeKeyAndHoldersFields value={fields} onChange={setFields} />

                <div>
                    <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                        Save changes
                    </Button>
                </div>
            </form>

            <Modal open={pendingChanges !== null} onClose={() => setPendingChanges(null)} title="Confirm escrow scope changes">
                <p className="text-sm mb-3">
                    These changes decide who can recover escrowed mail under <strong>{original.name}</strong>:
                </p>
                <ul className="list-disc pl-5 text-sm flex flex-col gap-1 mb-3">
                    {pendingChanges?.map((change) => (
                        <li key={change} className="break-all">
                            {change}
                        </li>
                    ))}
                </ul>
                <p className="text-xs text-text-muted">
                    The server refuses changes while an access request under this scope is still awaiting approval.
                </p>
                <div className="flex gap-3 justify-end mt-5">
                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => setPendingChanges(null)}>
                        Cancel
                    </Button>
                    <Button type="button" className="!w-auto" onClick={() => void save()}>
                        Confirm and save
                    </Button>
                </div>
            </Modal>

            <Modal open={confirmingDelete} onClose={closeDeleteModal} title="Delete escrow scope">
                <p className="text-sm mb-5">
                    Are you sure you want to delete <strong>{original.name}</strong>? This cannot be undone, and fails
                    if any Matter still references this scope.
                </p>
                {deleteError && <Alert>{deleteError}</Alert>}
                <div className="flex gap-3 justify-end mt-5">
                    <Button type="button" variant="secondary" className="!w-auto" disabled={deleting} onClick={closeDeleteModal}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger"
                        loading={deleting}
                        disabled={deleting}
                        onClick={handleDelete}
                    >
                        Delete
                    </Button>
                </div>
            </Modal>
        </div>
    );
}
