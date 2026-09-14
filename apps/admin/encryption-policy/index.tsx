///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { getEncryptionPolicy } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import EncryptionPolicyForm from "../../shared/components/admin/settings/EncryptionPolicyForm.js";
import LoadedSettingsForm from "../../shared/components/admin/settings/LoadedSettingsForm.js";

export default function EncryptionPolicyPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="encryptionPolicy">
            <LoadedSettingsForm load={getEncryptionPolicy} loadErrorMessage="Could not load the encryption policy.">
                {(policy, onChange) => <EncryptionPolicyForm policy={policy} onChange={onChange} />}
            </LoadedSettingsForm>
        </AdminShell>
    );
}
