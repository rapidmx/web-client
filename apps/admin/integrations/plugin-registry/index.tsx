///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { AdminShellProps } from "../../../shared/components/admin/layout/AdminShell.js";
import PluginRegistryForm from "../../../shared/components/admin/integrations/PluginRegistryForm.js";
import IntegrationSectionPage from "../../../shared/components/admin/integrations/IntegrationSectionPage.js";

export default function PluginRegistryPage(props: Omit<AdminShellProps, "active">) {
    return (
        <IntegrationSectionPage {...props} area="pluginRegistry">
            {(settings, onChange) => <PluginRegistryForm settings={settings} onChange={onChange} />}
        </IntegrationSectionPage>
    );
}
