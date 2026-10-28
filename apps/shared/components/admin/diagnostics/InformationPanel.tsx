///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import Alert from "../ActionAlert.js";
import type { ConfigKeys } from "../../../../../lib/admin/configKeysApi.js";
import type { DiagnosticsInformation, DiagnosticsVersions } from "./diagnosticsApi.js";
import type { DiagnosticsResource } from "./useDiagnosticsResource.js";
import ComponentsTable from "./ComponentsTable.js";
import InstalledPlugins, { InstalledPluginsData } from "./InstalledPlugins.js";
import KeyringCard from "./KeyringCard.js";
import PackagesTable from "./PackagesTable.js";
import ServerVersionCard from "./ServerVersionCard.js";
import SettingsTable from "./SettingsTable.js";

export interface InformationPanelProps {
    versions: DiagnosticsResource<DiagnosticsVersions>;
    plugins: DiagnosticsResource<InstalledPluginsData>;
    information: DiagnosticsResource<DiagnosticsInformation>;
    /** `null` when the server has no keyring route. */
    keyring: DiagnosticsResource<ConfigKeys | null>;
}

/**
 * The Information tab: the server, the install's other containers (DNS publishing's among them), the installed plugins, the server's environment
 * variables and configuration (secrets withheld by the server), what the Integrations pages saved as a source of its own, the configuration keyring and
 * every installed package. The environment and configuration come from their own request, and so does the keyring, so a server that predates them
 * leaves the rest of the tab working and says so in their place.
 */
export default function InformationPanel({ versions, plugins, information, keyring }: InformationPanelProps) {
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
                                description="The server process's environment. Every variable shows its value except those on the server's list of hidden settings, whose value is withheld by the server and never sent."
                                settings={information.data.environment ?? []}
                            />
                            <SettingsTable
                                id="diagnostics-configuration"
                                title="Configuration"
                                description="The effective settings the server runs with: the environment, saved plugin settings, what the Integrations pages saved and defaults combined. Settings on the server's list of hidden settings, such as passwords, tokens and keys, are withheld by the server and never sent, and so are the credentials in URLs."
                                settings={information.data.configuration ?? []}
                            />
                            {information.data.integrations && (
                                <SettingsTable
                                    id="diagnostics-integrations"
                                    title="Integrations"
                                    description="Saved in the Integrations pages of the admin console and applied without a restart. Each of these overrides the deployment's own value of the same name above. A secret shows only that it is set."
                                    settings={information.data.integrations}
                                    secrets="set"
                                    emptyText="Nothing is saved in the Integrations pages."
                                />
                            )}
                        </>
                    )}
                </>
            )}
            {/* Its own request, so it shows (or says why it can't) whether or not the versions could be read. */}
            <KeyringCard keyring={keyring} />
            {data && <PackagesTable packages={data.packages ?? []} />}
        </div>
    );
}
