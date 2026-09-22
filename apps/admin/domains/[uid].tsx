///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { deleteDomain, Domain, updateDomain } from "@rapidmx/react-shared/admin/domainsApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import DomainDnsSetup from "../../shared/components/admin/settings/DomainDnsSetup.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export default function DomainDetailPage(props: Omit<AdminShellProps, "active"> & { params: { uid: string } }) {
    return (
        <AdminShell {...props} active="domains">
            <DomainDetailContent uid={props.params.uid} />
        </AdminShell>
    );
}

function DomainDetailContent({ uid }: { uid: string }) {
    const [domain, setDomain] = useState<Domain | null>(null);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    // Not initialized from `domain.aliasOf` until it first loads (`null` means "not yet") - once set, kept as
    // the user's own edit rather than fighting later unrelated reloads (e.g. after "Verify now").
    const [aliasInput, setAliasInput] = useState<string | null>(null);
    const [savingAlias, setSavingAlias] = useState(false);
    const [aliasError, setAliasError] = useState<string | null>(null);
    const [aliasSaved, setAliasSaved] = useState(false);
    // Bumped after a successful aliasOf save to force `DomainDnsSetup` (which owns its own `domain` state,
    // fetched only on mount/uid change) to reload and reflect the new value in its own status panel.
    const [refreshCount, setRefreshCount] = useState(0);

    function closeDeleteModal() {
        setConfirmingDelete(false);
    }

    // Only ever invoked from the "Delete domain" confirmation modal, which only renders once `domain` is loaded.
    async function handleDelete() {
        setDeleting(true);
        setDeleteError(null);
        try {
            await deleteDomain(domain!.uid, domain!.version);
            window.location.href = "/admin/domains";
        } catch (err) {
            setDeleteError(err instanceof ApiRequestError ? err.message : "Could not delete this domain.");
            setDeleting(false);
        }
    }

    function handleLoaded(d: Domain) {
        setDomain(d);
        setAliasInput((current) => (current === null ? d?.aliasOf ?? "" : current));
    }

    async function handleSaveAlias() {
        setSavingAlias(true);
        setAliasError(null);
        setAliasSaved(false);
        try {
            const updated = await updateDomain({ uid: domain!.uid, version: domain!.version, aliasOf: aliasInput!.trim() || undefined });
            setDomain(updated);
            setAliasInput(updated.aliasOf ?? "");
            setAliasSaved(true);
            setRefreshCount((c) => c + 1);
        } catch (err) {
            setAliasError(err instanceof ApiRequestError ? err.message : "Could not update this domain.");
        } finally {
            setSavingAlias(false);
        }
    }

    return (
        <div className="max-w-3xl flex flex-col gap-5">
            {domain && (
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <a href="/admin/domains" className="text-sm text-primary-dark hover:underline">
                            &larr; All domains
                        </a>
                        <h1 className="text-xl font-bold tracking-tight mt-1">{domain.name}</h1>
                    </div>
                    <Button
                        type="button"
                        variant="secondary"
                        className="!w-auto shrink-0 !border-danger !text-danger hover:!border-danger hover:!text-danger"
                        onClick={() => setConfirmingDelete(true)}
                    >
                        Delete domain
                    </Button>
                </div>
            )}

            <DomainDnsSetup key={refreshCount} uid={uid} onLoaded={handleLoaded} />

            {domain && (
                <div className="bg-surface border border-border rounded-md p-6">
                    <h2 className="text-sm font-bold uppercase tracking-wide mb-3">Alias</h2>
                    <p className="text-sm text-text-muted mb-3">
                        Make this domain a pure alias of another one - it will still receive (and may send as) mail for the
                        same addresses, but have no mailboxes of its own. Leave blank for a regular domain.
                    </p>
                    {aliasError && <Alert>{aliasError}</Alert>}
                    <FormField label="Alias of" htmlFor="aliasOf">
                        <input
                            id="aliasOf"
                            type="text"
                            className={INPUT_CLASS}
                            value={aliasInput ?? ""}
                            onChange={(e) => {
                                setAliasInput(e.target.value);
                                setAliasSaved(false);
                            }}
                            placeholder="e.g. powerlevel.gg"
                        />
                    </FormField>
                    <div className="flex items-center gap-3">
                        <Button
                            type="button"
                            className="!w-auto"
                            loading={savingAlias}
                            disabled={savingAlias || (aliasInput ?? "") === (domain.aliasOf ?? "")}
                            onClick={handleSaveAlias}
                        >
                            Save
                        </Button>
                        {aliasSaved && <span className="text-sm text-text-muted">Saved.</span>}
                    </div>
                </div>
            )}

            {domain && (
                <Modal open={confirmingDelete} onClose={closeDeleteModal} title="Delete domain">
                    <p className="text-sm mb-5">
                        Are you sure you want to delete <strong>{domain.name}</strong>? This cannot be undone.
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
            )}
        </div>
    );
}
