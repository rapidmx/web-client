///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import AdminShell, { AdminShellProps } from "../../../shared/components/admin/layout/AdminShell.js";
import MailboxCreateForm from "../../../shared/components/admin/settings/MailboxCreateForm.js";

export default function NewMailboxPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="mailboxes">
            <div className="max-w-xl">
                <h1 className="text-xl font-bold uppercase tracking-wide mb-1">New mailbox</h1>
                <p className="text-sm text-text-muted mb-5">
                    Choose "Shared mailbox" to create a true ownerless mailbox (the Exchange "shared mailbox"
                    concept) — access is then granted entirely to delegates afterward, not to a single owner. Choose
                    "Owned by a specific person" and look them up to create a mailbox for a specific user instead.
                </p>
                <MailboxCreateForm
                    cancelHref="/admin"
                    onCreated={(mailbox) => {
                        window.location.href = `/admin/mailboxes/${encodeURIComponent(mailbox.uid)}`;
                    }}
                />
            </div>
        </AdminShell>
    );
}
