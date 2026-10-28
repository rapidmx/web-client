///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import {
    DnsControllerState,
    DnsProvider,
    DnsProviderTypeInfo,
    getDnsControllerState,
    listDnsProviders,
    listDnsProviderTypes,
} from "../../../../lib/admin/dnsProvidersApi.js";
import Button from "../../../../lib/components/buttons/Button.js";
import { ApiRequestError } from "../../../../lib/util/api.js";
import AdminShell, { AdminShellProps } from "../../../shared/components/admin/layout/AdminShell.js";
import IntegrationsLayout from "../../../shared/components/admin/integrations/IntegrationsLayout.js";
import { Badge, dnsProviderStatus, formatTime, isStaleReport } from "../../../shared/components/admin/integrations/dnsProviderParts.js";
import Alert from "../../../shared/components/admin/ActionAlert.js";
import { actionErrorMessage } from "../../../shared/components/admin/elevation.js";

export default function DnsProvidersPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="integrations">
            <IntegrationsLayout active="dnsProviders">
                <DnsProvidersList />
            </IntegrationsLayout>
        </AdminShell>
    );
}

/** What the DNS controller last said about itself, in a sentence: whether it works with this server, and when it last reported (a warning when that
 * was too long ago: it may be down). */
function ControllerNotice({ state }: { state: DnsControllerState }) {
    const { handshake, lastReport } = state;
    if (handshake && !handshake.compatible) {
        return (
            <Alert>
                {`DNS controller ${handshake.controllerVersion} can't work with this server (${handshake.reason}). Nothing is published until matching versions are installed.`}
            </Alert>
        );
    }
    // The last time it was heard from at all: a handshake after a report (a restart of either side) shows it alive.
    const heard: string | undefined = [lastReport?.at, handshake?.at].reduce<string | undefined>(
        (latest, at) => (at && (!latest || Date.parse(at) > Date.parse(latest)) ? at : latest),
        undefined
    );
    if (heard && isStaleReport(heard)) {
        return (
            <Alert>
                {`The DNS controller hasn't been heard from since ${formatTime(heard)}; it may be down. Nothing is published or removed until it is back.`}
            </Alert>
        );
    }
    let text: string;
    if (lastReport) {
        text = `DNS controller ${lastReport.controllerVersion}, last report ${formatTime(lastReport.at)}.`;
    } else if (handshake) {
        text = `DNS controller ${handshake.controllerVersion} has connected and not reported yet.`;
    } else {
        text = "The DNS controller hasn’t contacted this server yet, so nothing is published automatically.";
    }
    return <p className="text-sm text-text-muted mb-4">{text}</p>;
}

function DnsProvidersList() {
    const [providers, setProviders] = useState<DnsProvider[] | null>(null);
    const [types, setTypes] = useState<DnsProviderTypeInfo[]>([]);
    const [controller, setController] = useState<DnsControllerState | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        Promise.all([listDnsProviders(), listDnsProviderTypes()])
            .then(([loaded, loadedTypes]) => {
                setProviders(loaded);
                setTypes(loadedTypes);
            })
            .catch((err) =>
                setError(
                    // A server from before DNS publishing has no such route.
                    err instanceof ApiRequestError && err.status === 404
                        ? "This server doesn't offer DNS providers yet. Upgrade it to manage them here."
                        : actionErrorMessage(err, "Could not load the DNS providers.")
                )
            );
        // The list stands without it: a server that can't say what the controller reported shows nothing about it.
        getDnsControllerState()
            .then(setController)
            .catch(() => setController(null));
    }, []);

    return (
        <>
            <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-bold uppercase tracking-wide">DNS providers</h2>
                <a href="/admin/integrations/dns-providers/new">
                    <Button type="button" className="!w-auto">
                        + New DNS provider
                    </Button>
                </a>
            </div>
            <p className="text-sm text-text-muted mb-4 max-w-2xl">
                The DNS hosting accounts this server publishes DNS records through: each domain&rsquo;s, and the server&rsquo;s own host names. A domain is
                assigned to one on its own page.
            </p>
            {controller && <ControllerNotice state={controller} />}

            {error && <Alert>{error}</Alert>}
            {!providers ? (
                !error && <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : providers.length === 0 ? (
                <p className="text-sm text-text-muted">
                    No DNS providers yet. Until one is added, every domain&rsquo;s records are published by hand, from the checklist on its page.
                </p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr>
                                {["Name", "Type", "Zones", "Status", "Domains", ""].map((h) => (
                                    <th key={h} className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border">
                                        {h}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {providers.map((provider) => {
                                const spec: DnsProviderTypeInfo | undefined = types.find((candidate) => candidate.type === provider.type);
                                const status = dnsProviderStatus(provider);
                                return (
                                    <tr key={provider.uid}>
                                        <td className="py-2.5 px-2.5 border-b border-border">
                                            {provider.name}
                                            {provider.origin === "installer" && <Badge>Added by the installer</Badge>}
                                        </td>
                                        <td className="py-2.5 px-2.5 border-b border-border">
                                            {spec?.label ?? provider.type}
                                            {spec && !spec.tested && <Badge>Not yet live-tested</Badge>}
                                        </td>
                                        <td className="py-2.5 px-2.5 border-b border-border">{provider.zones.join(", ")}</td>
                                        <td className="py-2.5 px-2.5 border-b border-border">
                                            {status.label}
                                            {status.error && <span className="block text-xs text-danger">{status.error}</span>}
                                        </td>
                                        <td className="py-2.5 px-2.5 border-b border-border">{provider.domainCount}</td>
                                        <td className="py-2.5 px-2.5 border-b border-border text-right">
                                            <a
                                                href={`/admin/integrations/dns-providers/${encodeURIComponent(provider.uid)}`}
                                                className="text-primary-dark hover:underline font-medium"
                                            >
                                                View
                                            </a>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
}
