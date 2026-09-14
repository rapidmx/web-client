///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { deleteDomain, Domain } from "@rapidmx/react-shared/admin/domainsApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import DomainDnsSetup from "../../shared/components/admin/settings/DomainDnsSetup.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

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

            <DomainDnsSetup uid={uid} onLoaded={setDomain} />

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
