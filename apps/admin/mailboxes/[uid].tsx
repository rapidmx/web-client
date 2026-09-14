///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { deleteMailbox, getMailbox, impersonateUser, Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import ShareAccessCard from "../../shared/components/admin/mailboxes/ShareAccessCard.js";
import ResourceSettingsCard from "../../shared/components/admin/mailboxes/ResourceSettingsCard.js";
import EscrowScopeCard from "../../shared/components/admin/mailboxes/EscrowScopeCard.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

function formatBytes(bytes: number): string {
    if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
    return `${bytes} B`;
}

export default function MailboxDetailPage(props: Omit<AdminShellProps, "active"> & { params: { uid: string } }) {
    return (
        <AdminShell {...props} active="mailboxes">
            <MailboxDetailContent uid={props.params.uid} impersonationBaseUrl={props.impersonationBaseUrl} />
        </AdminShell>
    );
}

function MailboxDetailContent({ uid, impersonationBaseUrl }: { uid: string } & Pick<AdminShellProps, "impersonationBaseUrl">) {
    const [mailbox, setMailbox] = useState<Mailbox | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [confirmingAccess, setConfirmingAccess] = useState(false);
    const [impersonating, setImpersonating] = useState(false);
    const [accessError, setAccessError] = useState<string | null>(null);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    function closeAccessModal() {
        setConfirmingAccess(false);
        setAccessError(null);
    }

    // Only ever invoked from the access-confirmation modal below, which only renders for a loaded mailbox that has
    // an owner. A failure stays in the modal rather than replacing the whole page.
    async function handleAccessMailbox() {
        setImpersonating(true);
        setAccessError(null);
        try {
            await impersonateUser(impersonationBaseUrl ?? "", mailbox!.ownerUserUid!);
            window.location.href = "/";
        } catch (err) {
            setAccessError(err instanceof ApiRequestError ? err.message : "Could not access this mailbox.");
            setImpersonating(false);
        }
    }

    function closeDeleteModal() {
        setConfirmingDelete(false);
    }

    // Only ever invoked from the delete-confirmation modal below, which itself only renders once
    // `mailbox` is resolved (the `error || !mailbox` branch below returns before this content mounts).
    async function handleDelete() {
        setDeleting(true);
        setDeleteError(null);
        try {
            await deleteMailbox(mailbox!.uid, mailbox!.version);
            window.location.href = "/admin";
        } catch (err) {
            // Most commonly a 409 if this mailbox is a custodian on an open legal hold (restapi's own
            // `assertNotOnLegalHold()`, naming the blocking Matter uid(s)) - surfaced as-is, same as
            // every other destructive-action error in this codebase, rather than special-cased here.
            setDeleteError(err instanceof ApiRequestError ? err.message : "Could not delete this mailbox.");
            setDeleting(false);
        }
    }

    useEffect(() => {
        setLoading(true);
        setError(null);
        getMailbox(uid)
            .then(setMailbox)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load this mailbox."))
            .finally(() => setLoading(false));
    }, [uid]);

    if (loading) {
        return <p className="text-sm text-text-muted">Loading&hellip;</p>;
    }
    if (error || !mailbox) {
        return <Alert>{error ?? "Mailbox not found."}</Alert>;
    }

    const quarantineHref = `/admin/quarantine?mailboxUid=${encodeURIComponent(mailbox.uid)}`;
    const ingestQueueHref = `/admin/ingest-queue?mailboxUid=${encodeURIComponent(mailbox.uid)}`;

    return (
        <div className="max-w-3xl flex flex-col gap-5">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <a href="/admin" className="text-sm text-primary-dark hover:underline">
                        &larr; All mailboxes
                    </a>
                    <h1 className="text-xl font-bold tracking-tight mt-1">{mailbox.primarySmtpAddress}</h1>
                </div>
                <div className="flex gap-3 shrink-0">
                    {mailbox.ownerUserUid && (
                        <Button type="button" variant="secondary" className="!w-auto" onClick={() => setConfirmingAccess(true)}>
                            Access this mailbox
                        </Button>
                    )}
                    <Button
                        type="button"
                        variant="secondary"
                        className="!w-auto !border-danger !text-danger hover:!border-danger hover:!text-danger"
                        onClick={() => setConfirmingDelete(true)}
                    >
                        Delete mailbox
                    </Button>
                </div>
            </div>

            <div className="bg-surface border border-border rounded-md p-6">
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                    <dt className="text-text-muted">Display name</dt>
                    <dd>{mailbox.displayName}</dd>
                    <dt className="text-text-muted">Owner</dt>
                    <dd>{mailbox.ownerUserUid ?? "None (shared mailbox)"}</dd>
                    <dt className="text-text-muted">Timezone</dt>
                    <dd>{mailbox.timezone}</dd>
                    <dt className="text-text-muted">Quota</dt>
                    <dd>
                        {formatBytes(mailbox.usedBytes)} / {formatBytes(mailbox.quotaBytes)}
                    </dd>
                    <dt className="text-text-muted">Alias addresses</dt>
                    <dd>{mailbox.aliasAddresses.length > 0 ? mailbox.aliasAddresses.join(", ") : "None"}</dd>
                    {mailbox.isResource && (
                        <>
                            <dt className="text-text-muted">Resource type</dt>
                            <dd className="capitalize">{mailbox.resourceType ?? "room"}</dd>
                        </>
                    )}
                    <dt className="text-text-muted">Created</dt>
                    <dd>{new Date(mailbox.dateCreated).toLocaleString()}</dd>
                </dl>
                <div className="flex gap-4 mt-5 pt-5 border-t border-border text-sm font-medium">
                    <a href={quarantineHref} className="text-primary-dark hover:underline">
                        View quarantine
                    </a>
                    <a href={ingestQueueHref} className="text-primary-dark hover:underline">
                        View ingest queue
                    </a>
                </div>
            </div>

            <ShareAccessCard mailboxUid={mailbox.uid} ownerUserUid={mailbox.ownerUserUid} />

            <EscrowScopeCard mailbox={mailbox} onUpdate={setMailbox} />

            {mailbox.isResource && <ResourceSettingsCard mailbox={mailbox} onUpdate={setMailbox} />}

            <Modal open={confirmingAccess} onClose={closeAccessModal} title="Access this mailbox">
                <p className="text-sm mb-3">
                    You&rsquo;ll be signed in as <strong className="break-all">{mailbox.ownerUserUid}</strong>, the owner
                    of <strong className="break-all">{mailbox.primarySmtpAddress}</strong>, and see everything they can -
                    and act as them, until you stop impersonating.
                </p>
                {accessError && <Alert>{accessError}</Alert>}
                <div className="flex gap-3 justify-end mt-5">
                    <Button type="button" variant="secondary" className="!w-auto" disabled={impersonating} onClick={closeAccessModal}>
                        Cancel
                    </Button>
                    <Button type="button" className="!w-auto" loading={impersonating} disabled={impersonating} onClick={handleAccessMailbox}>
                        Access mailbox
                    </Button>
                </div>
            </Modal>

            <Modal open={confirmingDelete} onClose={closeDeleteModal} title="Delete mailbox">
                <p className="text-sm mb-5">
                    Are you sure you want to delete <strong>{mailbox.primarySmtpAddress}</strong>? This permanently
                    deletes the mailbox and everything in it, and cannot be undone. It fails if this mailbox is a
                    custodian on an active legal hold.
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
