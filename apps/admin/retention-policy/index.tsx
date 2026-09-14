///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { RetentionPolicy, getRetentionPolicy } from "@rapidmx/react-shared/admin/retentionPolicyApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import RetentionPolicyForm from "../../shared/components/admin/settings/RetentionPolicyForm.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";

export default function RetentionPolicyPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="retentionPolicy">
            <RetentionPolicyContent />
        </AdminShell>
    );
}

function RetentionPolicyContent() {
    const [policy, setPolicy] = useState<RetentionPolicy | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        getRetentionPolicy()
            .then(setPolicy)
            .catch((err) => setLoadError(err instanceof ApiRequestError ? err.message : "Could not load the retention policy."))
            .finally(() => setLoading(false));
    }, []);

    if (loading) {
        return <p className="text-sm text-text-muted">Loading&hellip;</p>;
    }
    if (loadError || !policy) {
        return <Alert>{loadError}</Alert>;
    }
    return <RetentionPolicyForm policy={policy} onChange={setPolicy} />;
}
