///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { DnsResolverMode, IntegrationSettings } from "../../../../../lib/admin/integrationsApi.js";
import IntegrationSectionForm, { SectionField } from "./IntegrationSectionForm.js";
import { INPUT_CLASS } from "./SecretField.js";

const MODES: Record<DnsResolverMode, string> = {
    node: "The system resolver",
    "doh-dnssec": "DNS over HTTPS, with DNSSEC validation",
};

const FIELDS: Record<string, SectionField> = {
    mode: { name: "resolver", describe: (mode: DnsResolverMode) => MODES[mode] },
    dohEndpoint: { name: "DoH endpoint", describe: (url: string) => url },
};

/** The DNS resolver section: how this server looks up DNS records. */
export default function DnsResolverForm({ settings, onChange }: { settings: IntegrationSettings; onChange: (settings: IntegrationSettings) => void }) {
    return (
        <IntegrationSectionForm
            section="dnsResolver"
            title="DNS resolver"
            description="How this server looks up DNS records: for domain checks and verification, key discovery and mail delivery decisions."
            consequence="Every DNS check, domain verification and key discovery uses the new resolver as soon as it is saved, and answers already looked up are dropped."
            fields={FIELDS}
            settings={settings}
            onChange={onChange}
        >
            {(form) => (
                <>
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-semibold">Resolver</span>
                        <select aria-label="Resolver" className={INPUT_CLASS} value={form.value("mode")} onChange={(e) => form.set("mode", e.target.value)}>
                            {Object.entries(MODES).map(([mode, label]) => (
                                <option key={mode} value={mode}>
                                    {label}
                                </option>
                            ))}
                        </select>
                    </label>
                    {form.footer("mode")}
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-semibold">DoH endpoint</span>
                        <input
                            aria-label="DoH endpoint"
                            type="url"
                            className={INPUT_CLASS}
                            value={form.value("dohEndpoint")}
                            onChange={(e) => form.set("dohEndpoint", e.target.value)}
                        />
                        <span className="text-xs text-text-muted">The DNS over HTTPS service queried, https:// only. Used with DNS over HTTPS.</span>
                    </label>
                    {form.footer("dohEndpoint")}
                </>
            )}
        </IntegrationSectionForm>
    );
}
