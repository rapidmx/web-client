///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import IntegrationsLayout, { INTEGRATION_AREAS } from "../../shared/components/admin/integrations/IntegrationsLayout.js";

/** The Integrations overview: each third-party service this deployment can use, with what it is for. */
export default function IntegrationsPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="integrations">
            <IntegrationsLayout>
                <p className="text-sm text-text-muted mb-5 max-w-2xl">
                    The services this server works with. A setting saved here takes effect at once and overrides the deployment&rsquo;s configuration until it
                    is reset.
                </p>
                <ul aria-label="Integration areas" className="grid gap-3 sm:grid-cols-2">
                    {INTEGRATION_AREAS.map((area) => (
                        <li key={area.id}>
                            <a href={area.href} className="block h-full border border-border rounded-sm bg-surface p-4 hover:border-primary">
                                <span className="block font-semibold text-primary-dark">{area.label}</span>
                                <span className="block text-sm text-text-muted mt-1">{area.description}</span>
                            </a>
                        </li>
                    ))}
                </ul>
            </IntegrationsLayout>
        </AdminShell>
    );
}
