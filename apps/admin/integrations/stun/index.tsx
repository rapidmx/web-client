///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { AdminShellProps } from "../../../shared/components/admin/layout/AdminShell.js";
import StunForm from "../../../shared/components/admin/integrations/StunForm.js";
import IntegrationSectionPage from "../../../shared/components/admin/integrations/IntegrationSectionPage.js";

export default function StunPage(props: Omit<AdminShellProps, "active">) {
    return (
        <IntegrationSectionPage {...props} area="stun">
            {(settings, onChange) => <StunForm settings={settings} onChange={onChange} />}
        </IntegrationSectionPage>
    );
}
