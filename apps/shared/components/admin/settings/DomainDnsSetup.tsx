///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { DnsRecordCheck, Domain, getDnsSetup, getDomain, verifyDomain } from "@rapidmx/react-shared/admin/domainsApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

const RECORD_TYPE_LABELS: Record<DnsRecordCheck["type"], string> = {
    ownership: "Ownership (TXT)",
    mx: "MX",
    spf: "SPF",
    dkim: "DKIM",
    dmarc: "DMARC",
};

export interface DomainDnsSetupProps {
    uid: string;
    /** Called with the domain every time it's (re)loaded - e.g. after "Verify now". */
    onLoaded?: (domain: Domain) => void;
}

/**
 * A domain's status, its ownership TXT record with "Verify now", and the DNS setup checklist - shared by the domain
 * detail page and the setup wizard.
 */
export default function DomainDnsSetup({ uid, onLoaded }: DomainDnsSetupProps) {
    const [domain, setDomain] = useState<Domain | null>(null);
    const [dnsSetup, setDnsSetup] = useState<DnsRecordCheck[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [verifying, setVerifying] = useState(false);
    const [verifyError, setVerifyError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    function reload(id: string) {
        setLoading(true);
        setError(null);
        return Promise.all([getDomain(id), getDnsSetup(id)])
            .then(([d, checks]) => {
                setDomain(d);
                setDnsSetup(checks);
                onLoaded?.(d);
            })
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load this domain."))
            .finally(() => setLoading(false));
    }

    useEffect(() => {
        void reload(uid);
    }, [uid]);

    // Only ever invoked from the "Verify now" button below, which only renders once `domain` is loaded. Any failure -
    // verifying, or refreshing afterwards - is shown next to the button with the panel kept, so it can be retried
    // (e.g. once a DNS record has propagated) instead of the whole panel being replaced by an error.
    async function handleVerify() {
        setVerifying(true);
        setVerifyError(null);
        try {
            await verifyDomain(domain!.uid);
            const [d, checks] = await Promise.all([getDomain(domain!.uid), getDnsSetup(domain!.uid)]);
            setDomain(d);
            setDnsSetup(checks);
            onLoaded?.(d);
        } catch (err) {
            setVerifyError(err instanceof ApiRequestError ? err.message : "Could not verify this domain.");
        } finally {
            setVerifying(false);
        }
    }

    async function handleCopy(value: string) {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard access can be denied by the browser — the value is still selectable/copyable by hand.
        }
    }

    if (loading) {
        return <p className="text-sm text-text-muted">Loading&hellip;</p>;
    }
    if (error || !domain) {
        return <Alert>{error ?? "Domain not found."}</Alert>;
    }

    const ownershipValue =
        dnsSetup.find((c) => c.type === "ownership")?.recommendedValue ?? `rapidmx-domain-verification=${domain.verificationToken}`;

    return (
        <div className="flex flex-col gap-5">
            <div className="bg-surface border border-border rounded-md p-6">
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                    <dt className="text-text-muted">Enabled</dt>
                    <dd>{domain.enabled ? "Yes" : "No"}</dd>
                    <dt className="text-text-muted">Verification</dt>
                    <dd>
                        {domain.verified ? (
                            <span className="text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-success text-white">
                                Verified
                            </span>
                        ) : (
                            <span className="text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-surface-alt text-text-muted">
                                Unverified
                            </span>
                        )}
                    </dd>
                    <dt className="text-text-muted">Last checked</dt>
                    <dd>{domain.lastCheckedAt ? new Date(domain.lastCheckedAt).toLocaleString() : "Never"}</dd>
                </dl>

                {!domain.verified && (
                    <div className="mt-5 pt-5 border-t border-border">
                        <p className="text-sm mb-2">
                            Add the following TXT record to <strong>{domain.name}</strong> to prove ownership, then verify:
                        </p>
                        <div className="flex items-center gap-2">
                            <code className="flex-1 text-xs bg-surface-alt border border-border rounded-sm py-2 px-3 overflow-x-auto whitespace-nowrap">
                                {ownershipValue}
                            </code>
                            <Button type="button" variant="secondary" className="!w-auto shrink-0" onClick={() => handleCopy(ownershipValue)}>
                                {copied ? "Copied" : "Copy"}
                            </Button>
                        </div>
                        {verifyError && (
                            <div className="mt-3">
                                <Alert>{verifyError}</Alert>
                            </div>
                        )}
                        <Button type="button" className="!w-auto mt-3" loading={verifying} disabled={verifying} onClick={handleVerify}>
                            {verifyError ? "Try again" : "Verify now"}
                        </Button>
                    </div>
                )}
            </div>

            {dnsSetup.length > 0 && (
                <div className="bg-surface border border-border rounded-md p-6">
                    <h2 className="text-sm font-bold uppercase tracking-wide mb-3">DNS setup checklist</h2>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm border-collapse">
                            <thead>
                                <tr>
                                    {["Record", "Status", "Recommended value"].map((h) => (
                                        <th
                                            key={h}
                                            className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border"
                                        >
                                            {h}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {dnsSetup.map((check) => (
                                    <tr key={check.type}>
                                        <td className="py-2.5 px-2.5 border-b border-border">{RECORD_TYPE_LABELS[check.type]}</td>
                                        <td className="py-2.5 px-2.5 border-b border-border">
                                            {!check.configured ? (
                                                <span className="text-xs text-text-muted">Not configured</span>
                                            ) : check.matches ? (
                                                <span className="text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-success text-white">
                                                    Live
                                                </span>
                                            ) : (
                                                <span className="text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-surface-alt text-text-muted">
                                                    Not found
                                                </span>
                                            )}
                                        </td>
                                        <td className="py-2.5 px-2.5 border-b border-border text-text-muted">
                                            <code className="text-xs">{check.recommendedValue ?? "—"}</code>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
}
