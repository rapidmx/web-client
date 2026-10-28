///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import ConfigKeysManager from "../../shared/components/admin/configEncryption/ConfigKeysManager.js";

/** The configuration keyring: the keys that encrypt the credentials saved in the console, and their rotation. */
export default function ConfigurationEncryptionPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="configurationEncryption">
            <h1 className="text-xl font-bold uppercase tracking-wide mb-3">Configuration encryption</h1>
            <ConfigKeysManager />
        </AdminShell>
    );
}
