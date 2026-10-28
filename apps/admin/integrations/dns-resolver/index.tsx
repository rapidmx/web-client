///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { AdminShellProps } from "../../../shared/components/admin/layout/AdminShell.js";
import DnsResolverForm from "../../../shared/components/admin/integrations/DnsResolverForm.js";
import IntegrationSectionPage from "../../../shared/components/admin/integrations/IntegrationSectionPage.js";

export default function DnsResolverPage(props: Omit<AdminShellProps, "active">) {
    return (
        <IntegrationSectionPage {...props} area="dnsResolver">
            {(settings, onChange) => <DnsResolverForm settings={settings} onChange={onChange} />}
        </IntegrationSectionPage>
    );
}
