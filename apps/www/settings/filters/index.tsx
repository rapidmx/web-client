///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { MailFilterRule, listMailFilterRules } from "@rapidmx/react-shared/mailFilterRulesApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../shared/components/settings/layout/SettingsShell.js";
import Alert from "../../../shared/components/feedback/Alert.js";
import Button from "../../../shared/components/buttons/Button.js";

export type SettingsFiltersPageProps = Omit<SettingsShellProps, "active">;

export default function SettingsFiltersPage(props: SettingsFiltersPageProps) {
    return (
        <SettingsShell {...props} active="filters">
            <FiltersContent />
        </SettingsShell>
    );
}

function FiltersContent() {
    const { mailboxUid } = useSettingsShell();
    const [rules, setRules] = useState<MailFilterRule[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // `SettingsShell` only ever renders its children once `mailboxUid` has resolved — same established
    // non-null pattern as `apps/www/settings/auto-reply/index.tsx`.
    useEffect(() => {
        listMailFilterRules(mailboxUid!)
            .then(setRules)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load mail filters."))
            .finally(() => setLoading(false));
    }, [mailboxUid]);

    const sorted = [...rules].sort((a, b) => a.sequence - b.sequence);

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-3xl">
                <div className="flex items-center justify-between mb-5">
                    <h1 className="text-lg font-bold tracking-tight">Mail Filters</h1>
                    <a href={`/settings/filters/new?mailboxUid=${encodeURIComponent(mailboxUid!)}`}>
                        <Button type="button" className="!w-auto">
                            + New filter
                        </Button>
                    </a>
                </div>
                <p className="text-sm text-text-muted mb-4">
                    Applied in order once a message is verdicted safe to deliver, before it reaches your Inbox.
                </p>

                {error && <Alert>{error}</Alert>}

                {loading ? (
                    <p className="text-sm text-text-muted">Loading&hellip;</p>
                ) : sorted.length === 0 ? (
                    <p className="text-sm text-text-muted">No mail filters yet.</p>
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
                                                href={`/settings/filters/${encodeURIComponent(rule.uid)}?mailboxUid=${encodeURIComponent(mailboxUid!)}`}
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
            </div>
        </div>
    );
}
