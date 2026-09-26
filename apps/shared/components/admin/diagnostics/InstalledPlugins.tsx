///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { HiOutlineExclamationTriangle } from "react-icons/hi2";
import { getPluginStatus, listPlugins, Plugin, PluginStatus } from "@rapidmx/react-shared/admin/pluginsApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Badge from "./Badge.js";
import { NO_VALUE } from "./format.js";

/** The installed plugins, and what each server copy reports of them (absent when the status could not be read). */
export interface InstalledPluginsData {
    plugins: Plugin[];
    status: PluginStatus | undefined;
}

/** Reads the plugins, and their load status. A status that cannot be read leaves the list without it, not without the list. */
export async function loadInstalledPlugins(): Promise<InstalledPluginsData> {
    const [plugins, status] = await Promise.all([listPlugins(), getPluginStatus().catch(() => undefined)]);
    return { plugins, status };
}

/** Which versions of `name` the server copies have loaded, and the load errors they report for it. */
export function pluginLoadState(status: PluginStatus, name: string) {
    const instances = status.instances;
    const loaded = instances.flatMap((instance) => instance.loaded.filter((item) => item.name === name));
    const errors = instances.flatMap((instance) => instance.errors.filter((item) => item.name === name));
    return {
        versions: [...new Set(loaded.map((item) => item.version))],
        loadedOn: loaded.length,
        instanceCount: instances.length,
        errors: [...new Set(errors.map((item) => item.message))],
    };
}

const HEADINGS = ["Plugin", "Configured version", "Enabled", "Loaded version", "Load errors"];

export interface InstalledPluginsProps {
    data: InstalledPluginsData | undefined;
    error: string | undefined;
    loading: boolean;
}

/**
 * Each installed plugin with the version configured for it and the version the running servers actually loaded. The two
 * differ while a change is still being applied, or when a version could not be loaded (then the load error is shown).
 */
export default function InstalledPlugins({ data, error, loading }: InstalledPluginsProps) {
    let body;
    if (error) {
        body = <Alert>{error}</Alert>;
    } else if (!data) {
        body = loading ? <p className="text-sm text-text-muted">Loading&hellip;</p> : null;
    } else if (data.plugins.length === 0) {
        body = <p className="text-sm text-text-muted">No plugins are installed.</p>;
    } else {
        body = (
            <>
                {!data.status && (
                    <p role="status" className="mb-2 text-xs text-text-muted">
                        What the servers have loaded could not be read, so only the configured versions are shown.
                    </p>
                )}
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr>
                                {HEADINGS.map((heading) => (
                                    <th
                                        key={heading}
                                        className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border"
                                    >
                                        {heading}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {data.plugins.map((plugin) => (
                                <PluginRow key={plugin.uid} plugin={plugin} status={data.status} />
                            ))}
                        </tbody>
                    </table>
                </div>
            </>
        );
    }
    return (
        <section aria-labelledby="diagnostics-plugins-heading" className="rounded-md border border-border bg-surface p-4">
            <h2 id="diagnostics-plugins-heading" className="text-base font-bold uppercase tracking-wide mb-3">
                Installed plugins
            </h2>
            {body}
        </section>
    );
}

function PluginRow({ plugin, status }: { plugin: Plugin; status: PluginStatus | undefined }) {
    const state = status ? pluginLoadState(status, plugin.name) : undefined;
    let loaded = NO_VALUE;
    if (state) {
        if (state.versions.length > 0) {
            loaded = `${state.versions.join(", ")} (on ${state.loadedOn} of ${state.instanceCount} servers)`;
        } else if (plugin.enabled) {
            loaded = "Not loaded";
        }
    }
    const differs = state !== undefined && state.versions.some((version) => version !== plugin.packageVersion);
    return (
        <tr>
            <td className="py-2 px-2.5 border-b border-border">
                <div>{plugin.manifest.displayName ?? plugin.name}</div>
                <div className="font-mono text-xs text-text-muted break-all">{plugin.name}</div>
            </td>
            <td className="py-2 px-2.5 border-b border-border font-mono">{plugin.packageVersion}</td>
            <td className="py-2 px-2.5 border-b border-border">
                <Badge tone={plugin.enabled ? "success" : "neutral"}>{plugin.enabled ? "Enabled" : "Disabled"}</Badge>
            </td>
            <td className="py-2 px-2.5 border-b border-border">
                <span className="font-mono">{loaded}</span>
                {differs && <div className="text-xs text-text-muted">Differs from the configured version</div>}
            </td>
            <td className="py-2 px-2.5 border-b border-border">
                {state && state.errors.length > 0
                    ? state.errors.map((message) => (
                          <div key={message} className="flex items-start gap-1">
                              <HiOutlineExclamationTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-danger" />
                              <span className="text-text break-words">{message}</span>
                          </div>
                      ))
                    : NO_VALUE}
            </td>
        </tr>
    );
}
