///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { useRouter } from "@rapidrest/react/client";
import { createDnsProvider, DnsProviderInput, DnsProviderTypeInfo, listDnsProviderTypes } from "../../../../../lib/admin/dnsProvidersApi.js";
import AdminShell, { AdminShellProps } from "../../../../shared/components/admin/layout/AdminShell.js";
import DnsProviderForm from "../../../../shared/components/admin/integrations/DnsProviderForm.js";
import IntegrationsLayout from "../../../../shared/components/admin/integrations/IntegrationsLayout.js";
import Alert from "../../../../shared/components/admin/ActionAlert.js";
import { actionErrorMessage } from "../../../../shared/components/admin/elevation.js";

export default function NewDnsProviderPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="integrations">
            <IntegrationsLayout active="dnsProviders">
                <NewDnsProviderContent />
            </IntegrationsLayout>
        </AdminShell>
    );
}

function NewDnsProviderContent() {
    const { navigate } = useRouter();
    const [types, setTypes] = useState<DnsProviderTypeInfo[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        listDnsProviderTypes()
            .then(setTypes)
            .catch((err) => setError(actionErrorMessage(err, "Could not load the DNS provider types.")));
    }, []);

    async function handleSave(input: DnsProviderInput) {
        const created = await createDnsProvider(input);
        void navigate(`/admin/integrations/dns-providers/${encodeURIComponent(created.uid)}`);
    }

    return (
        <>
            <h2 className="text-lg font-bold uppercase tracking-wide mb-1">New DNS provider</h2>
            <p className="text-sm text-text-muted mb-5 max-w-2xl">
                A DNS hosting account this server can publish records through. Prefer credentials scoped to these zones alone.
            </p>
            {error ? (
                <Alert>{error}</Alert>
            ) : !types ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : (
                <DnsProviderForm types={types} submitLabel="Create DNS provider" onSave={handleSave} />
            )}
        </>
    );
}
