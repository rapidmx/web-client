///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { DnsProvider, listDnsProviders } from "../../../../../lib/admin/dnsProvidersApi.js";
import { assignDnsProvider, Domain } from "../../../../../lib/admin/domainsApi.js";
import Button from "../../../../../lib/components/buttons/Button.js";
import FormField from "../../../../../lib/components/forms/FormField.js";
import Alert from "../ActionAlert.js";
import { actionErrorMessage } from "../elevation.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary disabled:opacity-55";

/** The length of the longest zone of `provider` that covers `name` (the name itself or a name under it), 0 when none does. */
function coveringZoneLength(name: string, provider: DnsProvider): number {
    return Math.max(0, ...provider.zones.filter((zone) => name === zone || name.endsWith(`.${zone}`)).map((zone) => zone.length));
}

/** The providers the select offers: only the one whose zone covers the domain most specifically, since the server accepts no other (another config's
 * zone nested under the parent's is left out of the parent's external-dns instance), and the one assigned now, whatever it covers. */
function offeredProviders(domain: Domain, providers: DnsProvider[]): DnsProvider[] {
    const lengths = providers.map((provider) => coveringZoneLength(domain.name, provider));
    const longest = Math.max(0, ...lengths);
    return providers.filter((provider, i) => (longest > 0 && lengths[i] === longest) || provider.uid === domain.dnsProviderUid);
}

export interface DomainDnsProviderProps {
    domain: Domain;
    /** Called after the assignment was saved, so the page can load the domain and its checklist again. */
    onChanged: () => void;
}

/**
 * The domain's DNS provider: "Manual", where the administrator adds the records by hand, or the provider config whose external-dns instance publishes
 * them. Nothing is shown on a server without DNS providers.
 */
export default function DomainDnsProvider({ domain, onChanged }: DomainDnsProviderProps) {
    // `undefined` while loading, `null` where the server has no DNS providers (an older server): then there is nothing to choose.
    const [providers, setProviders] = useState<DnsProvider[] | null | undefined>(undefined);
    const [selected, setSelected] = useState(domain.dnsProviderUid ?? "");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        listDnsProviders()
            .then(setProviders)
            .catch(() => setProviders(null));
    }, [domain.uid]);

    useEffect(() => {
        setSelected(domain.dnsProviderUid ?? "");
    }, [domain.dnsProviderUid]);

    if (!providers) {
        return null;
    }

    async function handleSave() {
        setSaving(true);
        setError(null);
        setSaved(false);
        try {
            await assignDnsProvider(domain.uid, selected || null);
            setSaved(true);
            onChanged();
        } catch (err) {
            setError(actionErrorMessage(err, "Could not change the DNS provider."));
        } finally {
            setSaving(false);
        }
    }

    const assigned = domain.dnsProviderUid ?? "";
    const offered = offeredProviders(domain, providers);
    const locked = !!domain.apexTxt?.managed;

    return (
        <div className="bg-surface border border-border rounded-md p-6">
            <h2 className="text-sm font-bold uppercase tracking-wide mb-3">DNS provider</h2>
            {offered.length === 0 && !assigned ? (
                <p className="text-sm text-text-muted">
                    No DNS provider covers {domain.name}. To have its DNS records published automatically, add one under{" "}
                    <a href="/admin/integrations/dns-providers" className="text-primary-dark hover:underline">
                        DNS providers
                    </a>{" "}
                    with a zone that includes it. Until then, add the records below at your DNS host.
                </p>
            ) : (
                <>
                    <p className="text-sm text-text-muted mb-3">
                        Choose the DNS provider that publishes this domain's records, or add them yourself at your DNS host.
                    </p>
                    {error && <Alert>{error}</Alert>}
                    <FormField label="DNS provider" htmlFor="dnsProviderUid">
                        <select
                            id="dnsProviderUid"
                            className={INPUT_CLASS}
                            value={selected}
                            disabled={locked}
                            onChange={(e) => {
                                setSelected(e.target.value);
                                setSaved(false);
                            }}
                        >
                            <option value="">Manual: I publish the records myself</option>
                            {offered.map((provider) => (
                                <option key={provider.uid} value={provider.uid}>
                                    {provider.name + (provider.enabled ? "" : " (disabled)")}
                                </option>
                            ))}
                            {assigned && !providers.some((provider) => provider.uid === assigned) && (
                                <option value={assigned}>{assigned} (no longer exists)</option>
                            )}
                        </select>
                    </FormField>
                    {locked && (
                        <p className="text-sm text-text-muted mb-3">
                            RapidMX manages this domain's root TXT records through its provider. Stop managing the root TXT records first, then change the provider.
                        </p>
                    )}
                    {assigned && selected !== assigned && (
                        <p className="text-sm text-text-muted mb-3">
                            Saving removes the records the current provider published for this domain from your DNS, until the new provider has published them
                            (or you have added them yourself).
                        </p>
                    )}
                    <div className="flex items-center gap-3">
                        <Button
                            type="button"
                            className="!w-auto"
                            aria-label="Save DNS provider"
                            loading={saving}
                            disabled={saving || locked || selected === assigned}
                            onClick={handleSave}
                        >
                            Save
                        </Button>
                        {saved && <span className="text-sm text-text-muted">Saved.</span>}
                    </div>
                </>
            )}
        </div>
    );
}
