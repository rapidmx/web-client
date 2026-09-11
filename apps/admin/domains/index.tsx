///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { Domain, listDomains } from "@rapidmx/react-shared/domainsApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import Alert from "../../shared/components/feedback/Alert.js";
import Button from "../../shared/components/buttons/Button.js";

const PAGE_SIZE = 25;

export default function DomainsListPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="domains">
            <DomainsListContent />
        </AdminShell>
    );
}

function DomainsListContent() {
    const [page, setPage] = useState(0);
    const [domains, setDomains] = useState<Domain[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setLoading(true);
        setError(null);
        listDomains({ page, limit: PAGE_SIZE })
            .then(setDomains)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load domains."))
            .finally(() => setLoading(false));
    }, [page]);

    const hasNextPage = domains.length === PAGE_SIZE;

    return (
        <>
            <div className="flex items-center justify-between mb-5">
                <h1 className="text-xl font-bold uppercase tracking-wide">Domains</h1>
                <a href="/admin/domains/new">
                    <Button type="button" className="!w-auto">
                        + New domain
                    </Button>
                </a>
            </div>

            {error && <Alert>{error}</Alert>}

            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : domains.length === 0 ? (
                <p className="text-sm text-text-muted">No domains configured yet.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr>
                                {["Name", "Enabled", "Verified", ""].map((h) => (
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
                            {domains.map((domain) => (
                                <tr key={domain.uid}>
                                    <td className="py-2.5 px-2.5 border-b border-border">{domain.name}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">{domain.enabled ? "Yes" : "No"}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">
                                        {domain.verified ? (
                                            <span className="text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-success text-white">
                                                Verified
                                            </span>
                                        ) : (
                                            <span className="text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-surface-alt text-text-muted">
                                                Unverified
                                            </span>
                                        )}
                                    </td>
                                    <td className="py-2.5 px-2.5 border-b border-border text-right">
                                        <a
                                            href={`/admin/domains/${encodeURIComponent(domain.uid)}`}
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
