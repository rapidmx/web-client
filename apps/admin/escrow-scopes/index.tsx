///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { EscrowScope, listEscrowScopes } from "@rapidmx/react-shared/admin/escrowScopesApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

const PAGE_SIZE = 25;

export default function EscrowScopesPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="escrowScopes">
            <EscrowScopesContent />
        </AdminShell>
    );
}

function EscrowScopesContent() {
    const [page, setPage] = useState(0);
    const [scopes, setScopes] = useState<EscrowScope[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setLoading(true);
        setError(null);
        listEscrowScopes({ page, limit: PAGE_SIZE })
            .then(setScopes)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load escrow scopes."))
            .finally(() => setLoading(false));
    }, [page]);

    const hasNextPage = scopes.length === PAGE_SIZE;

    return (
        <>
            <div className="flex items-center justify-between mb-5">
                <h1 className="text-xl font-bold uppercase tracking-wide">Escrow scopes</h1>
                <a href="/admin/escrow-scopes/new">
                    <Button type="button" className="!w-auto">
                        + New escrow scope
                    </Button>
                </a>
            </div>

            <p className="text-sm text-text-muted mb-5">
                Configuring who counts as a holder, the dual-control threshold, and a scope's own public key is an
                administrative act, separate from actually holding the eDiscovery/compliance role — this page never
                grants you access to any mailbox's escrowed key material.
            </p>

            {error && <Alert>{error}</Alert>}

            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : scopes.length === 0 ? (
                <p className="text-sm text-text-muted">No escrow scopes yet.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr>
                                {["Name", "Holders", "Required holders", "Notify subject", ""].map((h) => (
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
                            {scopes.map((scope) => (
                                <tr key={scope.uid}>
                                    <td className="py-2.5 px-2.5 border-b border-border">{scope.name}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">{scope.holderUserUids.length}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">{scope.requiredHolders}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">
                                        {scope.notifySubjectOnAccess ? "Yes" : "No"}
                                    </td>
                                    <td className="py-2.5 px-2.5 border-b border-border text-right">
                                        <a
                                            href={`/admin/escrow-scopes/${encodeURIComponent(scope.uid)}`}
                                            className="text-primary-dark hover:underline font-medium"
                                        >
                                            View
                                        </a>
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
        </>
    );
}
