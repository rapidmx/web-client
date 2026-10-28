///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { AdminShellProps } from "../../../shared/components/admin/layout/AdminShell.js";
import SigningCaForm from "../../../shared/components/admin/integrations/SigningCaForm.js";
import IntegrationSectionPage from "../../../shared/components/admin/integrations/IntegrationSectionPage.js";

export default function SigningCaPage(props: Omit<AdminShellProps, "active">) {
    return (
        <IntegrationSectionPage {...props} area="signingCa">
            {(settings, onChange) => <SigningCaForm settings={settings} onChange={onChange} />}
        </IntegrationSectionPage>
    );
}
