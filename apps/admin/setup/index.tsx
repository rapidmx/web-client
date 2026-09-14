///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import SetupWizard from "../../shared/components/admin/setup/SetupWizard.js";

export default function SetupPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="setup">
            <SetupWizard userUid={props.userUid ?? ""} />
        </AdminShell>
    );
}
