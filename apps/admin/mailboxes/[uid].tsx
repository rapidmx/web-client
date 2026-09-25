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
            <MailboxDetailContent uid={props.params.uid} impersonationBaseUrl={props.impersonationBaseUrl} currentUserUid={props.userUid} />
        </AdminShell>
    );
}

function MailboxDetailContent({
    uid,
    impersonationBaseUrl,
    currentUserUid,
}: { uid: string; currentUserUid?: string } & Pick<AdminShellProps, "impersonationBaseUrl">) {
    const [mailbox, setMailbox] = useState<Mailbox | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [confirmingAccess, setConfirmingAccess] = useState(false);
    const [impersonating, setImpersonating] = useState(false);
    const [accessError, setAccessError] = useState<string | null>(null);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    // Deleting keeps the mailbox's data; this also erases it in the same step, after the address is typed to confirm.
    const [eraseData, setEraseData] = useState(false);
    const [typedAddress, setTypedAddress] = useState("");

    // Ignored while the action is under way (Escape/Close; Cancel is disabled then too), so its result or error
    // can't land on a modal reopened afterwards.
    function closeAccessModal() {
        if (impersonating) return;
        setConfirmingAccess(false);
        setAccessError(null);
    }

    // Only ever invoked from the impersonation-confirmation modal below, which only renders for a loaded mailbox that has
    // an owner. A failure stays in the modal rather than replacing the whole page.
    async function handleAccessMailbox() {
        setImpersonating(true);
        setAccessError(null);
        try {
            await impersonateUser(impersonationBaseUrl ?? "", mailbox!.ownerUserUid!);
            window.location.href = "/";
        } catch (err) {
            setAccessError(err instanceof ApiRequestError ? err.message : "Could not impersonate this user.");
            setImpersonating(false);
        }
    }

    function closeDeleteModal() {
        if (deleting) return;
        setConfirmingDelete(false);
        setEraseData(false);
        setTypedAddress("");
        setDeleteError(null);
    }

    // Only ever invoked from the delete-confirmation modal below, which itself only renders once
    // `mailbox` is resolved (the `error || !mailbox` branch below returns before this content mounts).
    async function handleDelete() {
        setDeleting(true);
        setDeleteError(null);
        try {
            await deleteMailbox(mailbox!.uid, mailbox!.version, { erase: eraseData });
            // The Mailboxes page it goes to lists what a delete without `erase` kept, and how far an erasure has got.
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
        // The administration scope: administrative metadata only - the console never shows a mailbox's mail or settings.
        getMailbox(uid, { scope: "admin" })
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
                            Impersonate this user
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

            <p className="text-sm text-text-muted">
                The console shows administrative details only - never a mailbox&rsquo;s mail or settings.
                {mailbox.ownerUserUid
                    ? " To see this mailbox as its owner sees it, impersonate them: that is recorded, and you can stop at any time."
                    : " This shared mailbox has no owner: add yourself under Shared access to open it in the mail client."}
            </p>

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

            <ShareAccessCard mailboxUid={mailbox.uid} ownerUserUid={mailbox.ownerUserUid} currentUserUid={currentUserUid} />

            <EscrowScopeCard mailbox={mailbox} onUpdate={setMailbox} />

            {mailbox.isResource && <ResourceSettingsCard mailbox={mailbox} onUpdate={setMailbox} />}

            <Modal open={confirmingAccess} onClose={closeAccessModal} title="Impersonate this user">
                <p className="text-sm mb-3">
                    You&rsquo;ll be signed in as <strong className="break-all">{mailbox.ownerUserUid}</strong>, the owner
                    of <strong className="break-all">{mailbox.primarySmtpAddress}</strong>, and see everything they can -
                    and act as them, until you stop impersonating. This is the only way an administrator sees another
                    user&rsquo;s mail.
                </p>
                {accessError && <Alert>{accessError}</Alert>}
                <div className="flex gap-3 justify-end mt-5">
                    <Button type="button" variant="secondary" className="!w-auto" disabled={impersonating} onClick={closeAccessModal}>
                        Cancel
                    </Button>
                    <Button type="button" className="!w-auto" loading={impersonating} disabled={impersonating} onClick={handleAccessMailbox}>
                        Impersonate
                    </Button>
                </div>
            </Modal>

            <Modal open={confirmingDelete} onClose={closeDeleteModal} title="Delete mailbox">
                <p className="text-sm mb-3">
                    Are you sure you want to delete <strong className="break-all">{mailbox.primarySmtpAddress}</strong>?
                    This cannot be undone. It fails if this mailbox is a custodian on an active legal hold.
                </p>
                <p className="text-sm mb-3">
                    Deleting removes the mailbox itself. Its mail, contacts, calendars and everything else in it are{" "}
                    <strong>kept</strong> until they are erased, and until then the address can&rsquo;t be used for a new
                    mailbox. You can erase them later from the Mailboxes page.
                </p>
                <label className="flex items-start gap-2 text-sm mb-3">
                    <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={eraseData}
                        disabled={deleting}
                        onChange={(e) => {
                            setEraseData(e.target.checked);
                            setTypedAddress("");
                        }}
                    />
                    <span>Also erase all of its data now (permanent)</span>
                </label>
                {eraseData && (
                    <div className="mb-3">
                        <p className="text-sm font-semibold text-danger mb-2">
                            Everything in this mailbox will be permanently erased, and this cannot be undone.
                        </p>
                        <label className="flex flex-col gap-1.5 text-sm">
                            <span className="font-semibold">
                                Type <span className="break-all">{mailbox.primarySmtpAddress}</span> to confirm
                            </span>
                            <input
                                aria-label="Type the address to confirm"
                                className="w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary"
                                value={typedAddress}
                                disabled={deleting}
                                autoComplete="off"
                                spellCheck={false}
                                onChange={(e) => setTypedAddress(e.target.value)}
                            />
                        </label>
                    </div>
                )}
                {deleteError && <Alert>{deleteError}</Alert>}
                <div className="flex gap-3 justify-end mt-5">
                    <Button type="button" variant="secondary" className="!w-auto" disabled={deleting} onClick={closeDeleteModal}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger"
                        loading={deleting}
                        disabled={deleting || (eraseData && typedAddress.trim().toLowerCase() !== mailbox.primarySmtpAddress.trim().toLowerCase())}
                        onClick={handleDelete}
                    >
                        {eraseData ? "Delete and erase all its data" : "Delete"}
                    </Button>
                </div>
            </Modal>
        </div>
    );
}
