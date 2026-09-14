///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { listTransportRules, TransportRule } from "@rapidmx/react-shared/admin/transportRulesApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

const PAGE_SIZE = 25;

/** The server's largest page (`limit` is capped at 1000). */
const FETCH_PAGE_SIZE = 1000;

/**
 * Every transport rule, in evaluation order. `listTransportRules()` can't ask the server to sort, and sorting one
 * server page at a time would order rules only within that page - so every page is fetched and sorted here (an
 * organisation has few transport rules). Ties keep a stable order by name.
 */
async function listAllTransportRules(): Promise<TransportRule[]> {
    const all: TransportRule[] = [];
    for (let page = 0; ; page++) {
        const batch = await listTransportRules({ page, limit: FETCH_PAGE_SIZE });
        all.push(...batch);
        if (batch.length < FETCH_PAGE_SIZE) {
            break;
        }
    }
    return all.sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name));
}

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
        listAllTransportRules()
            .then(setRules)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load transport rules."))
            .finally(() => setLoading(false));
    }, []);

    const hasNextPage = (page + 1) * PAGE_SIZE < rules.length;
    const sorted = rules.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

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
