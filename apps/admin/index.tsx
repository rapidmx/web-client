///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { listMailboxes, Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import { reopenSetup } from "@rapidmx/react-shared/admin/setupApi.js";
import AdminShell, { AdminShellProps } from "../shared/components/admin/layout/AdminShell.js";
import LeftoverMailboxesSection from "../shared/components/admin/mailboxes/LeftoverMailboxesSection.js";
import MailboxTable from "../shared/components/admin/mailboxes/MailboxTable.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

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
        // The administration scope: every mailbox as administrative metadata - the console never shows anybody's mail.
        listMailboxes({ page, limit: PAGE_SIZE, scope: "admin" })
            .then(setMailboxes)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load mailboxes."))
            .finally(() => setLoading(false));
    }, [page]);

    const hasNextPage = mailboxes.length === PAGE_SIZE;
    const [reopening, setReopening] = useState(false);
    const [confirmingSetup, setConfirmingSetup] = useState(false);

    async function handleRunSetup() {
        setReopening(true);
        try {
            await reopenSetup();
            window.location.href = "/admin/setup";
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not reopen setup.");
            setReopening(false);
            setConfirmingSetup(false);
        }
    }

    return (
        <>
            <div className="flex items-center justify-between mb-5">
                <h1 className="text-xl font-bold uppercase tracking-wide">Mailboxes</h1>
                <div className="flex gap-2">
                    <Button type="button" variant="secondary" className="!w-auto" disabled={reopening} onClick={() => setConfirmingSetup(true)}>
                        Run setup again
                    </Button>
                    <a href="/admin/mailboxes/new">
                        <Button type="button" className="!w-auto">
                            + New mailbox
                        </Button>
                    </a>
                </div>
            </div>

            <p className="text-sm text-text-muted mb-4">
                Administrative details only (addresses, owners, quota). The console never shows a mailbox&rsquo;s mail:
                to see someone&rsquo;s account, impersonate them from their mailbox page.
            </p>

            {error && <Alert>{error}</Alert>}

            <Modal open={confirmingSetup} onClose={() => setConfirmingSetup(false)} title="Run setup again?">
                <p className="text-sm mb-4">
                    Setup starts again from its first step, and the admin console sends administrators to it until
                    it&apos;s finished. Your existing settings, domains and mailboxes are kept.
                </p>
                <div className="flex gap-2 justify-end">
                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => setConfirmingSetup(false)}>
                        Cancel
                    </Button>
                    <Button type="button" className="!w-auto" loading={reopening} disabled={reopening} onClick={() => void handleRunSetup()}>
                        Run setup
                    </Button>
                </div>
            </Modal>

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

            <LeftoverMailboxesSection />
        </>
    );
}
