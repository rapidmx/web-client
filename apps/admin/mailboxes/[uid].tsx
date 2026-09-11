///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { getMailbox, impersonateUser, Mailbox } from "@rapidmx/react-shared/mailApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import ShareAccessCard from "../../shared/components/admin/mailboxes/ShareAccessCard.js";
import ResourceSettingsCard from "../../shared/components/admin/mailboxes/ResourceSettingsCard.js";
import Alert from "../../shared/components/feedback/Alert.js";
import Button from "../../shared/components/buttons/Button.js";

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
    const [impersonating, setImpersonating] = useState(false);

    async function handleAccessMailbox(ownerUserUid: string) {
        setImpersonating(true);
        try {
            await impersonateUser(impersonationBaseUrl ?? "", ownerUserUid);
            window.location.href = "/";
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not access this mailbox.");
            setImpersonating(false);
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
                {mailbox.ownerUserUid && (
                    <Button
                        type="button"
                        variant="secondary"
                        className="!w-auto shrink-0"
                        loading={impersonating}
                        disabled={impersonating}
                        onClick={() => handleAccessMailbox(mailbox.ownerUserUid as string)}
                    >
                        Access this mailbox
                    </Button>
                )}
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

            <ShareAccessCard mailboxUid={mailbox.uid} />

            {mailbox.isResource && <ResourceSettingsCard mailbox={mailbox} onUpdate={setMailbox} />}
        </div>
    );
}
