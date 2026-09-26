///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import type { DiagnosticsVersions } from "./diagnosticsApi.js";
import type { DiagnosticsResource } from "./useDiagnosticsResource.js";
import ComponentsTable from "./ComponentsTable.js";
import InstalledPlugins, { InstalledPluginsData } from "./InstalledPlugins.js";
import PackagesTable from "./PackagesTable.js";
import ServerVersionCard from "./ServerVersionCard.js";

export interface VersionsPanelProps {
    versions: DiagnosticsResource<DiagnosticsVersions>;
    plugins: DiagnosticsResource<InstalledPluginsData>;
}

/** The Versions tab: the server, its packages, the installed plugins and the install's other containers. */
export default function VersionsPanel({ versions, plugins }: VersionsPanelProps) {
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
                    <PackagesTable packages={data.packages ?? []} />
                </>
            )}
        </div>
    );
}
