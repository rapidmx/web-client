///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { Branding, getBranding } from "../../../lib/branding/brandingApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import BrandingForm from "../../shared/components/admin/settings/BrandingForm.js";
import Alert from "../../shared/components/admin/ActionAlert.js";
import { actionErrorMessage } from "../../shared/components/admin/elevation.js";

export default function BrandingPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="branding">
            <BrandingContent />
        </AdminShell>
    );
}

function BrandingContent() {
    const [branding, setBranding] = useState<Branding | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        getBranding()
            .then(setBranding)
            .catch((err) => setLoadError(actionErrorMessage(err, "Could not load branding.")))
            .finally(() => setLoading(false));
    }, []);

    if (loading) {
        return <p className="text-sm text-text-muted">Loading&hellip;</p>;
    }
    if (loadError || !branding) {
        return <Alert>{loadError}</Alert>;
    }
    return <BrandingForm branding={branding} onChange={setBranding} />;
}
