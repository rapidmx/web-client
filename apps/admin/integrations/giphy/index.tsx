///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { AdminShellProps } from "../../../shared/components/admin/layout/AdminShell.js";
import GiphyForm from "../../../shared/components/admin/integrations/GiphyForm.js";
import IntegrationSectionPage from "../../../shared/components/admin/integrations/IntegrationSectionPage.js";

export default function GiphyPage(props: Omit<AdminShellProps, "active">) {
    return (
        <IntegrationSectionPage {...props} area="giphy">
            {(settings, onChange) => <GiphyForm settings={settings} onChange={onChange} />}
        </IntegrationSectionPage>
    );
}
