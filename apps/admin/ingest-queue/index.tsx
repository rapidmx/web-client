///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { IngestQueueEntry, listIngestQueue } from "@rapidmx/react-shared/mailApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import Alert from "../../shared/components/feedback/Alert.js";

export function readMailboxUid(): string | null {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("mailboxUid");
}

const STATUS_STYLES: Record<IngestQueueEntry["status"], string> = {
    pending: "bg-surface-alt text-text-muted",
    scanning: "bg-surface-alt text-text-muted",
    delivered: "bg-success text-white",
    failed: "bg-danger text-white",
};

export default function IngestQueuePage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="ingestQueue">
            <IngestQueueContent />
        </AdminShell>
    );
}

function IngestQueueContent() {
    const [mailboxUid, setMailboxUid] = useState<string | null>(null);
    const [entries, setEntries] = useState<IngestQueueEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setMailboxUid(readMailboxUid());
    }, []);

    useEffect(() => {
        if (!mailboxUid) {
            return;
        }
        setLoading(true);
        setError(null);
        listIngestQueue(mailboxUid)
            .then(setEntries)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load the ingest queue."))
            .finally(() => setLoading(false));
    }, [mailboxUid]);

    if (!mailboxUid) {
        return <Alert>No mailbox specified. Open a mailbox's detail page and choose "View ingest queue".</Alert>;
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
                <h1 className="text-xl font-bold uppercase tracking-wide mt-1">Ingest queue</h1>
            </div>

            {error && <Alert>{error}</Alert>}

            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : entries.length === 0 ? (
                <p className="text-sm text-text-muted">Nothing pending or failed for this mailbox.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr>
                                {["From", "To", "Received", "Status", "Error"].map((h) => (
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
                                    <td className="py-2.5 px-2.5 border-b border-border">{entry.envelopeFrom}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">{entry.envelopeTo.join(", ")}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">
                                        {new Date(entry.dateCreated).toLocaleString()}
                                    </td>
                                    <td className="py-2.5 px-2.5 border-b border-border">
                                        <span
                                            className={`inline-block text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill ${STATUS_STYLES[entry.status]}`}
                                        >
                                            {entry.status}
                                        </span>
                                    </td>
                                    <td className="py-2.5 px-2.5 border-b border-border text-text-muted">
                                        {entry.errorMessage ?? ""}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
