///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { Mailbox } from "@rapidmx/react-shared/mailApi.js";

function formatBytes(bytes: number): string {
    if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
    return `${bytes} B`;
}

export interface MailboxTableProps {
    mailboxes: Mailbox[];
}

export default function MailboxTable({ mailboxes }: MailboxTableProps) {
    if (mailboxes.length === 0) {
        return <p className="text-sm text-text-muted">No mailboxes found.</p>;
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
                <thead>
                    <tr>
                        <th className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border">
                            Address
                        </th>
                        <th className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border">
                            Display name
                        </th>
                        <th className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border">
                            Owner
                        </th>
                        <th className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border">
                            Quota used
                        </th>
                        <th className="border-b border-border" />
                    </tr>
                </thead>
                <tbody>
                    {mailboxes.map((mailbox) => (
                        <tr key={mailbox.uid}>
                            <td className="py-2.5 px-2.5 border-b border-border align-middle">{mailbox.primarySmtpAddress}</td>
                            <td className="py-2.5 px-2.5 border-b border-border align-middle">{mailbox.displayName}</td>
                            <td className="py-2.5 px-2.5 border-b border-border align-middle">
                                {mailbox.ownerUserUid ?? (
                                    <span className="inline-block text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-surface-alt text-text-muted">
                                        Shared
                                    </span>
                                )}
                            </td>
                            <td className="py-2.5 px-2.5 border-b border-border align-middle">
                                {formatBytes(mailbox.usedBytes)} / {formatBytes(mailbox.quotaBytes)}
                            </td>
                            <td className="py-2.5 px-2.5 border-b border-border align-middle text-right">
                                <a
                                    href={`/admin/mailboxes/${encodeURIComponent(mailbox.uid)}`}
                                    className="text-primary-dark font-medium hover:underline"
                                >
                                    View
                                </a>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
