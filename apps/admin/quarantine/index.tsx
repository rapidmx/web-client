///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { listQuarantine, QuarantineEntry, releaseQuarantineEntry } from "@rapidmx/react-shared/mailApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import Alert from "../../shared/components/feedback/Alert.js";
import Button from "../../shared/components/buttons/Button.js";

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
    const [releasing, setReleasing] = useState<string | null>(null);

    useEffect(() => {
        setMailboxUid(readMailboxUid());
    }, []);

    function reload(uid: string) {
        setLoading(true);
        setError(null);
        listQuarantine(uid, { page, limit: PAGE_SIZE })
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

    // Only ever invoked from the "Release" button below, which itself only renders once `mailboxUid` is
    // known and `AdminShell` has already confirmed `userUid` (children only render once authorized) — both
    // non-null assertions reflect that real invariant, not an unchecked assumption.
    async function handleRelease(entry: QuarantineEntry) {
        setReleasing(entry.uid);
        setError(null);
        try {
            await releaseQuarantineEntry(entry.uid, entry.version, userUid!);
            reload(mailboxUid!);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not release this message.");
        } finally {
            setReleasing(null);
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
                                                loading={releasing === entry.uid}
                                                disabled={releasing === entry.uid}
                                                onClick={() => handleRelease(entry)}
                                            >
                                                Release
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
        </div>
    );
}
