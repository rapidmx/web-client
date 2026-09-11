///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { DistributionList, listDistributionLists } from "@rapidmx/react-shared/distributionListsApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import Alert from "../../shared/components/feedback/Alert.js";
import Button from "../../shared/components/buttons/Button.js";

const PAGE_SIZE = 25;

export default function DistributionListsPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="distributionLists">
            <DistributionListsContent />
        </AdminShell>
    );
}

function DistributionListsContent() {
    const [page, setPage] = useState(0);
    const [lists, setLists] = useState<DistributionList[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setLoading(true);
        setError(null);
        listDistributionLists({ page, limit: PAGE_SIZE })
            .then(setLists)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load distribution lists."))
            .finally(() => setLoading(false));
    }, [page]);

    const hasNextPage = lists.length === PAGE_SIZE;

    return (
        <>
            <div className="flex items-center justify-between mb-5">
                <h1 className="text-xl font-bold uppercase tracking-wide">Distribution lists</h1>
                <a href="/admin/distribution-lists/new">
                    <Button type="button" className="!w-auto">
                        + New distribution list
                    </Button>
                </a>
            </div>

            {error && <Alert>{error}</Alert>}

            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : lists.length === 0 ? (
                <p className="text-sm text-text-muted">No distribution lists yet.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr>
                                {["Address", "Name", "Members", ""].map((h) => (
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
                            {lists.map((list) => (
                                <tr key={list.uid}>
                                    <td className="py-2.5 px-2.5 border-b border-border">{list.primarySmtpAddress}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">{list.name}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">{list.memberAddresses.length}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border text-right">
                                        <a
                                            href={`/admin/distribution-lists/${encodeURIComponent(list.uid)}`}
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
