///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { AuditLogEntry, AuditLogFilters, listAuditLog } from "@rapidmx/react-shared/auditLogApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import Alert from "../../shared/components/feedback/Alert.js";
import Button from "../../shared/components/buttons/Button.js";

const PAGE_SIZE = 25;
const FILTER_KEYS: (keyof AuditLogFilters)[] = ["mailboxUid", "actorUserUid", "action", "targetType"];

/** Seeds the filter form from the query string on first render — lets a link (e.g. a future "View audit
 * log" deep link from a mailbox's detail page) land here pre-filtered, same convention as `quarantine`'s
 * `readMailboxUid()`. Filters are also written back to the URL as they change, so the filtered view
 * itself is shareable/bookmarkable. */
export function readFiltersFromUrl(): AuditLogFilters {
    if (typeof window === "undefined") return {};
    const params = new URLSearchParams(window.location.search);
    const filters: AuditLogFilters = {};
    for (const key of FILTER_KEYS) {
        const value = params.get(key);
        if (value) filters[key] = value;
    }
    return filters;
}

const INPUT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export default function AuditLogPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="auditLog">
            <AuditLogContent />
        </AdminShell>
    );
}

function AuditLogContent() {
    const [filters, setFilters] = useState<AuditLogFilters>({});
    const [page, setPage] = useState(0);
    const [entries, setEntries] = useState<AuditLogEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setFilters(readFiltersFromUrl());
    }, []);

    useEffect(() => {
        setLoading(true);
        setError(null);
        listAuditLog(filters, { page, limit: PAGE_SIZE })
            .then(setEntries)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load the audit log."))
            .finally(() => setLoading(false));
    }, [filters, page]);

    function updateFilter(key: keyof AuditLogFilters, value: string) {
        const next: AuditLogFilters = { ...filters, [key]: value || undefined };
        setFilters(next);
        setPage(0);

        const params = new URLSearchParams();
        for (const k of FILTER_KEYS) {
            const v = next[k];
            if (v) params.set(k, v);
        }
        const query = params.toString();
        window.history.replaceState(null, "", query ? `${window.location.pathname}?${query}` : window.location.pathname);
    }

    const hasNextPage = entries.length === PAGE_SIZE;

    return (
        <>
            <h1 className="text-xl font-bold uppercase tracking-wide mb-5">Audit log</h1>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 mb-5">
                <input
                    aria-label="Mailbox uid"
                    className={INPUT_CLASS}
                    placeholder="Mailbox uid"
                    value={filters.mailboxUid ?? ""}
                    onChange={(e) => updateFilter("mailboxUid", e.target.value)}
                />
                <input
                    aria-label="Actor user uid"
                    className={INPUT_CLASS}
                    placeholder="Actor user uid"
                    value={filters.actorUserUid ?? ""}
                    onChange={(e) => updateFilter("actorUserUid", e.target.value)}
                />
                <input
                    aria-label="Action"
                    className={INPUT_CLASS}
                    placeholder="Action (e.g. domain.create)"
                    value={filters.action ?? ""}
                    onChange={(e) => updateFilter("action", e.target.value)}
                />
                <input
                    aria-label="Target type"
                    className={INPUT_CLASS}
                    placeholder="Target type (e.g. Domain)"
                    value={filters.targetType ?? ""}
                    onChange={(e) => updateFilter("targetType", e.target.value)}
                />
            </div>

            {error && <Alert>{error}</Alert>}

            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : entries.length === 0 ? (
                <p className="text-sm text-text-muted">No matching audit log entries.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr>
                                {["When", "Actor", "Action", "Target", "Mailbox", ""].map((h) => (
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
                                    <td className="py-2.5 px-2.5 border-b border-border">
                                        {new Date(entry.dateCreated).toLocaleString()}
                                    </td>
                                    <td className="py-2.5 px-2.5 border-b border-border">{entry.actorUserUid ?? "System"}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">{entry.action}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">
                                        {entry.targetType} &middot; {entry.targetUid}
                                    </td>
                                    <td className="py-2.5 px-2.5 border-b border-border">{entry.mailboxUid ?? "—"}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">
                                        {entry.details && (
                                            <details>
                                                <summary className="text-primary-dark hover:underline cursor-pointer">
                                                    Details
                                                </summary>
                                                <pre className="text-xs bg-surface-alt border border-border rounded-sm p-2 mt-2 overflow-x-auto">
                                                    {JSON.stringify(entry.details, null, 2)}
                                                </pre>
                                            </details>
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
        </>
    );
}
