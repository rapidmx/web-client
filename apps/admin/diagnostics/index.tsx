///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import DiagnosticsManager from "../../shared/components/admin/diagnostics/DiagnosticsManager.js";

export default function DiagnosticsPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="diagnostics">
            <DiagnosticsManager />
        </AdminShell>
    );
}
