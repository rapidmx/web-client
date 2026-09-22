///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { listQuarantine, QuarantineEntry, releaseQuarantineEntry } from "@rapidmx/react-shared/mail/mailApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

const PAGE_SIZE = 25;

export function readMailboxUid(): string | null {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("mailboxUid");
}

export default function QuarantinePage(props: Omit<AdminShellProps, "active"> & { userUid?: string }) {
    return (
        <AdminShell {...props} active="quarantine">
            <QuarantineContent userUid={props.userUid} />
        </AdminShell>
    );
}

function QuarantineContent({ userUid }: { userUid?: string }) {
    const [mailboxUid, setMailboxUid] = useState<string | null>(null);
    const [page, setPage] = useState(0);
    const [entries, setEntries] = useState<QuarantineEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [releaseTarget, setReleaseTarget] = useState<QuarantineEntry | null>(null);
    const [releasing, setReleasing] = useState(false);
    const [releaseError, setReleaseError] = useState<string | null>(null);

    useEffect(() => {
        setMailboxUid(readMailboxUid());
    }, []);

    function reload(uid: string) {
        setLoading(true);
        setError(null);
        // The administration scope: any mailbox's held mail, recorded in the audit log.
        listQuarantine(uid, { page, limit: PAGE_SIZE, scope: "admin" })
            .then(setEntries)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load quarantine."))
            .finally(() => setLoading(false));
    }

    useEffect(() => {
        if (mailboxUid) {
            reload(mailboxUid);
        }
    }, [mailboxUid, page]);

    const hasNextPage = entries.length === PAGE_SIZE;

    function closeReleaseModal() {
        setReleaseTarget(null);
        setReleaseError(null);
    }

    // Only ever invoked from the confirmation modal below, which only renders once `releaseTarget` is set, once
    // `mailboxUid` is known, and once `AdminShell` has confirmed `userUid` (children only render once authorized).
    // `releaseQuarantineEntry()` still sends its own `releasedAt`/`releasedByUserUid`; the server now stamps both
    // itself and ignores the client's values, so what's displayed afterwards comes from the reloaded list.
    async function handleRelease() {
        setReleasing(true);
        setReleaseError(null);
        try {
            await releaseQuarantineEntry(releaseTarget!.uid, releaseTarget!.version, userUid!);
            closeReleaseModal();
            reload(mailboxUid!);
        } catch (err) {
            setReleaseError(err instanceof ApiRequestError ? err.message : "Could not mark this message released.");
        } finally {
            setReleasing(false);
        }
    }

    if (!mailboxUid) {
        return <Alert>No mailbox specified. Open a mailbox's detail page and choose "View quarantine".</Alert>;
    }

    return (
        <div className="max-w-4xl flex flex-col gap-4">
            <div>
                <a
                    href={`/admin/mailboxes/${encodeURIComponent(mailboxUid)}`}
                    className="text-sm text-primary-dark hover:underline"
                >
                    &larr; Back to mailbox
                </a>
                <h1 className="text-xl font-bold uppercase tracking-wide mt-1">Quarantine</h1>
            </div>

            {error && <Alert>{error}</Alert>}

            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : entries.length === 0 ? (
                <p className="text-sm text-text-muted">Nothing quarantined for this mailbox.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr>
                                {["Reason", "Quarantined", "Status", ""].map((h) => (
                                    <th
                                        key={h}
                                        className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border"
                                    >
                                        {h}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {entries.map((entry) => (
                                <tr key={entry.uid}>
                                    <td className="py-2.5 px-2.5 border-b border-border">{entry.reason}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">
                                        {new Date(entry.dateCreated).toLocaleString()}
                                    </td>
                                    <td className="py-2.5 px-2.5 border-b border-border">
                                        {entry.releasedAt ? (
                                            <span className="text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-success text-white">
                                                Released
                                            </span>
                                        ) : (
                                            <span className="text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-surface-alt text-text-muted">
                                                Held
                                            </span>
                                        )}
                                    </td>
                                    <td className="py-2.5 px-2.5 border-b border-border text-right">
                                        {!entry.releasedAt && (
                                            <Button
                                                type="button"
                                                variant="secondary"
                                                className="!w-auto"
                                                onClick={() => setReleaseTarget(entry)}
                                            >
                                                Mark released
                                            </Button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <div className="flex gap-3 items-center mt-4">
                <Button
                    variant="secondary"
                    type="button"
                    className="!w-auto"
                    disabled={page === 0 || loading}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                    Previous
                </Button>
                <span className="text-sm text-text-muted">Page {page + 1}</span>
                <Button
                    variant="secondary"
                    type="button"
                    className="!w-auto"
                    disabled={!hasNextPage || loading}
                    onClick={() => setPage((p) => p + 1)}
                >
                    Next
                </Button>
            </div>

            <Modal open={releaseTarget !== null} onClose={closeReleaseModal} title="Mark message released">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm mb-4">
                    <dt className="text-text-muted">Reason</dt>
                    <dd>{releaseTarget?.reason}</dd>
                    <dt className="text-text-muted">Quarantined</dt>
                    <dd>{releaseTarget && new Date(releaseTarget.dateCreated).toLocaleString()}</dd>
                    <dt className="text-text-muted">Message</dt>
                    <dd className="break-all">{releaseTarget?.originalMessageUid ?? "Not delivered to the mailbox"}</dd>
                </dl>
                <p className="text-sm mb-4">
                    This only records the entry as released (with you as the releaser). It does not deliver the
                    message - if it&rsquo;s infected or unwanted, leave it held.
                </p>
                {releaseError && <Alert>{releaseError}</Alert>}
                <div className="flex gap-3 justify-end">
                    <Button type="button" variant="secondary" className="!w-auto" disabled={releasing} onClick={closeReleaseModal}>
                        Cancel
                    </Button>
                    <Button type="button" className="!w-auto" loading={releasing} disabled={releasing} onClick={handleRelease}>
                        Mark released
                    </Button>
                </div>
            </Modal>
        </div>
    );
}
