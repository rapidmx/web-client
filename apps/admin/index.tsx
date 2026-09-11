///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { listMailboxes, Mailbox } from "@rapidmx/react-shared/mailApi.js";
import AdminShell, { AdminShellProps } from "../shared/components/admin/layout/AdminShell.js";
import MailboxTable from "../shared/components/admin/mailboxes/MailboxTable.js";
import Alert from "../shared/components/feedback/Alert.js";
import Button from "../shared/components/buttons/Button.js";

const PAGE_SIZE = 25;

export default function MailboxesListPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="mailboxes">
            <MailboxesListContent />
        </AdminShell>
    );
}

function MailboxesListContent() {
    const [page, setPage] = useState(0);
    const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setLoading(true);
        setError(null);
        listMailboxes({ page, limit: PAGE_SIZE })
            .then(setMailboxes)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load mailboxes."))
            .finally(() => setLoading(false));
    }, [page]);

    const hasNextPage = mailboxes.length === PAGE_SIZE;

    return (
        <>
            <div className="flex items-center justify-between mb-5">
                <h1 className="text-xl font-bold uppercase tracking-wide">Mailboxes</h1>
                <a href="/admin/mailboxes/new">
                    <Button type="button" className="!w-auto">
                        + New mailbox
                    </Button>
                </a>
            </div>

            {error && <Alert>{error}</Alert>}

            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : (
                <MailboxTable mailboxes={mailboxes} />
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
        </>
    );
}
