///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode } from "react";
import { getIntegrations, IntegrationSettings } from "../../../../../lib/admin/integrationsApi.js";
import { ApiRequestError } from "../../../../../lib/util/api.js";
import AdminShell, { AdminShellProps } from "../layout/AdminShell.js";
import LoadedSettingsForm from "../settings/LoadedSettingsForm.js";
import IntegrationsLayout, { IntegrationArea } from "./IntegrationsLayout.js";

/** What a server from before Integrations (no `system/integrations` route) is shown instead of a bare "Not Found". */
export const NO_INTEGRATIONS_MESSAGE = "This server doesn't offer Integrations yet. Upgrade it to manage them here.";

/** The integration settings, with a server that has none answering `NO_INTEGRATIONS_MESSAGE`. */
async function loadIntegrations(): Promise<IntegrationSettings> {
    try {
        return await getIntegrations();
    } catch (err) {
        throw err instanceof ApiRequestError && err.status === 404 ? new ApiRequestError(NO_INTEGRATIONS_MESSAGE, 404) : err;
    }
}

export interface IntegrationSectionPageProps extends Omit<AdminShellProps, "active"> {
    area: Exclude<IntegrationArea, "dnsProviders">;
    children: (settings: IntegrationSettings, onChange: (settings: IntegrationSettings) => void) => ReactNode;
}

/** One Integrations section's page: the console's frame, the Integrations navigation, and the section's form once the settings have loaded. */
export default function IntegrationSectionPage({ area, children, ...props }: IntegrationSectionPageProps) {
    return (
        <AdminShell {...props} active="integrations">
            <IntegrationsLayout active={area}>
                <LoadedSettingsForm load={loadIntegrations} loadErrorMessage="Could not load the integrations.">
                    {children}
                </LoadedSettingsForm>
            </IntegrationsLayout>
        </AdminShell>
    );
}
