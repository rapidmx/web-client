///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { listMatters, Matter } from "@rapidmx/react-shared/admin/mattersApi.js";
import EscrowShell, { EscrowShellProps } from "../shared/components/escrow/layout/EscrowShell.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

const PAGE_SIZE = 25;

export default function MattersPage(props: Omit<EscrowShellProps, "active">) {
    return (
        <EscrowShell {...props} active="matters">
            <MattersContent />
        </EscrowShell>
    );
}

function MattersContent() {
    const [page, setPage] = useState(0);
    const [matters, setMatters] = useState<Matter[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setLoading(true);
        setError(null);
        listMatters({ page, limit: PAGE_SIZE })
            .then(setMatters)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load matters."))
            .finally(() => setLoading(false));
    }, [page]);

    const hasNextPage = matters.length === PAGE_SIZE;

    return (
        <>
            <div className="flex items-center justify-between mb-5">
                <h1 className="text-xl font-bold uppercase tracking-wide">Matters</h1>
                <a href="/escrow/matters/new">
                    <Button type="button" className="!w-auto">
                        + New matter
                    </Button>
                </a>
            </div>

            <p className="text-sm text-text-muted mb-5">
                Only matters under an escrow scope you hold are ever shown here — this list is already scoped to
                you server-side.
            </p>

            {error && <Alert>{error}</Alert>}

            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : matters.length === 0 ? (
                <p className="text-sm text-text-muted">
                    No matters yet — either none exist under a scope you hold, or you don't currently hold any
                    escrow scope.
                </p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr>
                                {["Name", "Custodians", "Date range", "Status", ""].map((h) => (
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
                            {matters.map((matter) => (
                                <tr key={matter.uid}>
                                    <td className="py-2.5 px-2.5 border-b border-border">{matter.name}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">
                                        {matter.custodianMailboxUids.length}
                                    </td>
                                    <td className="py-2.5 px-2.5 border-b border-border">
                                        {new Date(matter.dateRangeStart).toLocaleDateString()} &ndash;{" "}
                                        {new Date(matter.dateRangeEnd).toLocaleDateString()}
                                    </td>
                                    <td className="py-2.5 px-2.5 border-b border-border">
                                        {matter.closedAt ? (
                                            <span className="text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-surface-alt text-text-muted">
                                                Closed
                                            </span>
                                        ) : (
                                            <span className="text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-success text-white">
                                                Open
                                            </span>
                                        )}
                                    </td>
                                    <td className="py-2.5 px-2.5 border-b border-border text-right">
                                        <a
                                            href={`/escrow/matters/${encodeURIComponent(matter.uid)}`}
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
