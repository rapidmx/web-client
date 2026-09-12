///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    DataExportFormat,
    DataExportRequest,
    createExportRequest,
    exportRequestDownloadUrl,
    listExportRequests,
} from "@rapidmx/react-shared/mail/dataExportApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../shared/components/settings/layout/SettingsShell.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

function statusBadgeClass(status: string): string {
    if (status === "failed") return "bg-danger-bg text-danger";
    if (status === "pending" || status === "processing") return "bg-surface-alt text-text-muted";
    return "bg-success text-white";
}

export type SettingsPrivacyPageProps = Omit<SettingsShellProps, "active">;

export default function SettingsPrivacyPage(props: SettingsPrivacyPageProps) {
    return (
        <SettingsShell {...props} active="privacy">
            <PrivacyContent />
        </SettingsShell>
    );
}

function PrivacyContent() {
    const { mailboxUid } = useSettingsShell();

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-xl flex flex-col gap-8">
                <div>
                    <h1 className="text-lg font-bold tracking-tight mb-1">Privacy &amp; Data</h1>
                    <p className="text-sm text-text-muted">Export or manage the data associated with this mailbox.</p>
                </div>

                <ExportSection mailboxUid={mailboxUid} />
            </div>
        </div>
    );
}

function ExportSection({ mailboxUid }: { mailboxUid?: string }) {
    const [requests, setRequests] = useState<DataExportRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [format, setFormat] = useState<DataExportFormat>("json");
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);

    function loadRequests() {
        return listExportRequests()
            .then(setRequests)
            .catch((err) => setLoadError(err instanceof ApiRequestError ? err.message : "Could not load your export requests."));
    }

    useEffect(() => {
        loadRequests().finally(() => setLoading(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mailboxUid]);

    async function handleCreate(e: FormEvent) {
        e.preventDefault();
        setCreateError(null);
        setCreating(true);
        try {
            await createExportRequest({ format });
            await loadRequests();
        } catch (err) {
            setCreateError(err instanceof ApiRequestError ? err.message : "Could not start this export.");
        } finally {
            setCreating(false);
        }
    }

    return (
        <div>
            <h2 className="text-sm font-semibold mb-2">Export my data</h2>
            <p className="text-xs text-text-muted mb-3">
                Requests a copy of this mailbox&rsquo;s messages, contacts, calendar, tasks, and notes. This runs
                in the background and can take a few minutes — check back here for a download link once it&rsquo;s
                ready.
            </p>

            <form onSubmit={handleCreate} className="flex items-end gap-3 mb-5">
                <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-semibold">Format</span>
                    <select
                        aria-label="Export format"
                        className="text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                        value={format}
                        onChange={(e) => setFormat(e.target.value as DataExportFormat)}
                    >
                        <option value="json">JSON</option>
                        <option value="mbox">Mbox</option>
                    </select>
                </label>
                <Button type="submit" variant="secondary" className="!w-auto" loading={creating} disabled={creating}>
                    Request export
                </Button>
            </form>

            {createError && <Alert>{createError}</Alert>}
            {loadError && <Alert>{loadError}</Alert>}

            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : requests.length === 0 ? (
                <p className="text-sm text-text-muted">No export requests yet.</p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {requests.map((request) => (
                        <li
                            key={request.uid}
                            className="flex items-center justify-between gap-3 text-sm py-1.5 px-3 bg-surface-alt rounded-sm"
                        >
                            <span>
                                {request.format.toUpperCase()} &middot; {new Date(request.dateCreated).toLocaleString()}
                                {request.status === "failed" && request.errorMessage && (
                                    <span className="text-danger"> — {request.errorMessage}</span>
                                )}
                            </span>
                            <span className="flex items-center gap-3">
                                <span
                                    className={`text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill ${statusBadgeClass(request.status)}`}
                                >
                                    {request.status}
                                </span>
                                {request.status === "ready" && (
                                    <a
                                        href={exportRequestDownloadUrl(request.uid)}
                                        className="text-primary-dark hover:underline font-medium"
                                    >
                                        Download
                                    </a>
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
