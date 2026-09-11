///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { listTransportRules, TransportRule } from "@rapidmx/react-shared/transportRulesApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import Alert from "../../shared/components/feedback/Alert.js";
import Button from "../../shared/components/buttons/Button.js";

const PAGE_SIZE = 25;

export default function TransportRulesPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="transportRules">
            <TransportRulesContent />
        </AdminShell>
    );
}

function TransportRulesContent() {
    const [page, setPage] = useState(0);
    const [rules, setRules] = useState<TransportRule[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setLoading(true);
        setError(null);
        listTransportRules({ page, limit: PAGE_SIZE })
            .then(setRules)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load transport rules."))
            .finally(() => setLoading(false));
    }, [page]);

    const hasNextPage = rules.length === PAGE_SIZE;
    const sorted = [...rules].sort((a, b) => a.sequence - b.sequence);

    return (
        <>
            <div className="flex items-center justify-between mb-5">
                <h1 className="text-xl font-bold uppercase tracking-wide">Transport rules</h1>
                <a href="/admin/transport-rules/new">
                    <Button type="button" className="!w-auto">
                        + New transport rule
                    </Button>
                </a>
            </div>

            {error && <Alert>{error}</Alert>}

            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : sorted.length === 0 ? (
                <p className="text-sm text-text-muted">No transport rules yet.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr>
                                {["Sequence", "Name", "Enabled", "Actions", ""].map((h) => (
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
                            {sorted.map((rule) => (
                                <tr key={rule.uid}>
                                    <td className="py-2.5 px-2.5 border-b border-border">{rule.sequence}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">{rule.name}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">{rule.enabled ? "Yes" : "No"}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">{rule.actions.length}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border text-right">
                                        <a
                                            href={`/admin/transport-rules/${encodeURIComponent(rule.uid)}`}
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
