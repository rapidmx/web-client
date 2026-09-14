///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { getMailboxPolicy } from "@rapidmx/react-shared/admin/mailboxPolicyApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import LoadedSettingsForm from "../../shared/components/admin/settings/LoadedSettingsForm.js";
import MailboxPolicyForm from "../../shared/components/admin/settings/MailboxPolicyForm.js";

export default function MailboxPolicyPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="mailboxPolicy">
            <LoadedSettingsForm load={getMailboxPolicy} loadErrorMessage="Could not load the mailbox policy.">
                {(policy, onChange) => <MailboxPolicyForm policy={policy} onChange={onChange} />}
            </LoadedSettingsForm>
        </AdminShell>
    );
}
