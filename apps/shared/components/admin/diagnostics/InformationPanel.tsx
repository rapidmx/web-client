///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import Alert from "../../../../../lib/components/feedback/Alert.js";
import type { DiagnosticsInformation, DiagnosticsVersions } from "./diagnosticsApi.js";
import type { DiagnosticsResource } from "./useDiagnosticsResource.js";
import ComponentsTable from "./ComponentsTable.js";
import InstalledPlugins, { InstalledPluginsData } from "./InstalledPlugins.js";
import PackagesTable from "./PackagesTable.js";
import ServerVersionCard from "./ServerVersionCard.js";
import SettingsTable from "./SettingsTable.js";

export interface InformationPanelProps {
    versions: DiagnosticsResource<DiagnosticsVersions>;
    plugins: DiagnosticsResource<InstalledPluginsData>;
    information: DiagnosticsResource<DiagnosticsInformation>;
}

/**
 * The Information tab: the server, the install's other containers, the installed plugins, the server's environment variables and
 * configuration (secrets withheld by the server), and every installed package. The environment and configuration come from their
 * own request, so a server that predates them leaves the rest of the tab working and says so in their place.
 */
export default function InformationPanel({ versions, plugins, information }: InformationPanelProps) {
    const { data, error, loading } = versions;
    return (
        <div className="space-y-6">
            {error && <Alert>{error}</Alert>}
            {!data && loading && <p className="text-sm text-text-muted">Loading&hellip;</p>}
            {data && (
                <>
                    <ServerVersionCard server={data.server} />
                    <ComponentsTable components={data.components ?? []} kubernetes={data.kubernetes ?? { available: false }} />
                    <InstalledPlugins data={plugins.data} error={plugins.error} loading={plugins.loading} />
                    {information.error && <Alert>{information.error}</Alert>}
                    {!information.data && information.loading && <p className="text-sm text-text-muted">Loading the environment&hellip;</p>}
                    {information.data && (
                        <>
                            <SettingsTable
                                id="diagnostics-environment"
                                title="Environment variables"
                                description="The server process's environment. Only variables known to be harmless show their value; the value of a secret, or of anything unrecognized, is withheld by the server and never sent."
                                settings={information.data.environment ?? []}
                            />
                            <SettingsTable
                                id="diagnostics-configuration"
                                title="Configuration"
                                description="The effective settings the server runs with: the environment, saved plugin settings and defaults combined. Passwords, tokens, keys, certificates and the credentials in URLs are withheld by the server and never sent."
                                settings={information.data.configuration ?? []}
                            />
                        </>
                    )}
                    <PackagesTable packages={data.packages ?? []} />
                </>
            )}
        </div>
    );
}
