///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode } from "react";

/** The Integrations section's areas, in the order the console shows them. */
export type IntegrationArea = "dnsProviders" | "giphy" | "stun" | "signingCa" | "dnsResolver" | "pluginRegistry";

export const INTEGRATION_AREAS: readonly { id: IntegrationArea; href: string; label: string; description: string }[] = [
    {
        id: "dnsProviders",
        href: "/admin/integrations/dns-providers",
        label: "DNS providers",
        description: "The DNS hosting accounts that publish the DNS records of this server and its domains, so they don't have to be added by hand.",
    },
    {
        id: "giphy",
        href: "/admin/integrations/giphy",
        label: "Giphy",
        description: "GIF search in the message editor.",
    },
    {
        id: "stun",
        href: "/admin/integrations/stun",
        label: "STUN servers",
        description: "How video meetings find a way between participants' networks.",
    },
    {
        id: "signingCa",
        href: "/admin/integrations/signing-ca",
        label: "S/MIME signing CA",
        description: "How people get the certificates that sign their mail.",
    },
    {
        id: "dnsResolver",
        href: "/admin/integrations/dns-resolver",
        label: "DNS resolver",
        description: "How this server looks up DNS records.",
    },
    {
        id: "pluginRegistry",
        href: "/admin/integrations/plugin-registry",
        label: "Plugin registry",
        description: "Where plugins are found and installed from.",
    },
];

/** The Integrations heading and the navigation between its areas (`active` is the current one; none on the overview), above the area's page. */
export default function IntegrationsLayout({ active, children }: { active?: IntegrationArea; children: ReactNode }) {
    return (
        <>
            <h1 className="text-xl font-bold uppercase tracking-wide mb-3">Integrations</h1>
            <nav aria-label="Integrations" className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border mb-6">
                {INTEGRATION_AREAS.map((area) => (
                    <a
                        key={area.id}
                        href={area.href}
                        aria-current={area.id === active ? "page" : undefined}
                        className={[
                            "py-2 text-sm font-medium border-b-2 -mb-px",
                            area.id === active ? "border-primary text-primary-dark" : "border-transparent text-text-muted hover:text-text",
                        ].join(" ")}
                    >
                        {area.label}
                    </a>
                ))}
            </nav>
            {children}
        </>
    );
}
