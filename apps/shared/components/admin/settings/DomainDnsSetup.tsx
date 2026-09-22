///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { DnsRecordCheck, Domain, getDnsSetup, getDomain, verifyDomain } from "@rapidmx/react-shared/admin/domainsApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import CopyButton from "@rapidmx/react-shared/components/buttons/CopyButton.js";

const RECORD_TYPE_LABELS: Record<DnsRecordCheck["type"], string> = {
    ownership: "Ownership (TXT)",
    mx: "MX",
    spf: "SPF",
    dkim: "DKIM",
    dmarc: "DMARC",
    autodiscover_cname: "Autodiscover (CNAME)",
    autodiscover_srv: "Autodiscover (SRV)",
};

/** How each record is named in a Copy button's accessible name ("Copy value for the SPF record"). */
const RECORD_TYPE_NAMES: Record<DnsRecordCheck["type"], string> = {
    ownership: "ownership TXT",
    mx: "MX",
    spf: "SPF",
    dkim: "DKIM",
    dmarc: "DMARC",
    autodiscover_cname: "Autodiscover CNAME",
    autodiscover_srv: "Autodiscover SRV",
};

/** A one-line "why this matters", shown under a checklist row's label - only for record types unfamiliar
 * enough to need one; the well-known mail records (ownership/MX/SPF/DKIM/DMARC) don't. */
const RECORD_TYPE_HELP: Partial<Record<DnsRecordCheck["type"], string>> = {
    autodiscover_cname:
        "So EAS and Outlook clients can find this server automatically from just an email address. This hostname also needs to be covered by this server's TLS certificate.",
    autodiscover_srv:
        "Same purpose as the CNAME above, for clients that check DNS SRV instead - and, unlike the CNAME, needs no extra TLS certificate, since it points at a hostname already covered. Prefer this one when a second certificate is hard to obtain.",
};

/** An MX record's recommended value is `"<priority> <mail server>"` - two separate fields in a DNS provider's form. */
function splitMxValue(value: string): { priority: string; server: string } | null {
    const match = /^(\d+)\s+(\S+)$/.exec(value.trim());
    return match ? { priority: match[1], server: match[2] } : null;
}

/** A SRV record's recommended value is `"<priority> <weight> <port> <target>"` - four separate fields in a DNS provider's form. */
function splitSrvValue(value: string): { priority: string; weight: string; port: string; target: string } | null {
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/.exec(value.trim());
    return match ? { priority: match[1], weight: match[2], port: match[3], target: match[4] } : null;
}

/** A value to type into a DNS provider's form, shown in full (long DKIM keys wrap) with a Copy button beside it. */
function CopyableValue({ value, copyLabel }: { value: string; copyLabel: string }) {
    return (
        <div className="flex items-start gap-2">
            <code className="flex-1 min-w-0 text-xs break-all">{value}</code>
            <CopyButton value={value} label={copyLabel} />
        </div>
    );
}

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

    if (loading) {
        return <p className="text-sm text-text-muted">Loading&hellip;</p>;
    }
    if (error || !domain) {
        return <Alert>{error ?? "Domain not found."}</Alert>;
    }

    const ownership = dnsSetup.find((c) => c.type === "ownership");
    const ownershipValue = ownership?.recommendedValue ?? `rapidmx-domain-verification=${domain.verificationToken}`;
    const ownershipName = ownership?.recordName || domain.name;

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
                        <dl className="grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-2 text-sm">
                            <dt className="text-text-muted py-2">Type</dt>
                            <dd className="py-2">TXT</dd>
                            <dt className="text-text-muted py-2">Name / host</dt>
                            <dd className="bg-surface-alt border border-border rounded-sm py-1.5 px-3">
                                <CopyableValue value={ownershipName} copyLabel="Copy name for the ownership TXT record" />
                            </dd>
                            <dt className="text-text-muted py-2">Value</dt>
                            <dd className="bg-surface-alt border border-border rounded-sm py-1.5 px-3">
                                <CopyableValue value={ownershipValue} copyLabel="Copy value for the ownership TXT record" />
                            </dd>
                        </dl>
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
                                    {["Record", "Status", "Name / host", "Recommended value"].map((h) => (
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
                                        <td className="py-2.5 px-2.5 border-b border-border">
                                            {RECORD_TYPE_LABELS[check.type]}
                                            <div className="text-xs text-text-muted">Type: {check.recordKind}</div>
                                            {RECORD_TYPE_HELP[check.type] && (
                                                <div className="text-xs text-text-muted mt-1 max-w-xs">{RECORD_TYPE_HELP[check.type]}</div>
                                            )}
                                        </td>
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
                                        {/* A floor on the name column: beside a long DKIM key (which breaks anywhere) the table gave it a few characters, and a name wrapped one letter to a line. */}
                                        <td className="py-2.5 px-2.5 border-b border-border text-text-muted min-w-[10rem]">
                                            {check.recordName ? (
                                                <CopyableValue
                                                    value={check.recordName}
                                                    copyLabel={`Copy name for the ${RECORD_TYPE_NAMES[check.type]} record`}
                                                />
                                            ) : (
                                                <code className="text-xs">—</code>
                                            )}
                                        </td>
                                        <td className="py-2.5 px-2.5 border-b border-border text-text-muted">
                                            {check.recommendedValue ? (
                                                <DnsRecordValue check={check} value={check.recommendedValue} />
                                            ) : (
                                                <code className="text-xs">—</code>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p className="text-xs text-text-muted mt-3">
                        Some DNS providers want the name relative to the domain (for example <code>@</code> for the domain itself) rather
                        than the full name.
                    </p>
                </div>
            )}
        </div>
    );
}

/** The value cell of a checklist row: an MX value as its two form fields (priority and mail server), a SRV value as
 * its four form fields (priority, weight, port and target), anything else whole. */
function DnsRecordValue({ check, value }: { check: DnsRecordCheck; value: string }) {
    const recordName = RECORD_TYPE_NAMES[check.type];
    const mx = check.type === "mx" ? splitMxValue(value) : null;
    if (mx) {
        return (
            <div className="flex flex-col gap-1.5">
                <div className="flex items-start gap-2">
                    <span className="text-xs w-20 shrink-0 pt-1">Priority</span>
                    <CopyableValue value={mx.priority} copyLabel={`Copy priority for the ${recordName} record`} />
                </div>
                <div className="flex items-start gap-2">
                    <span className="text-xs w-20 shrink-0 pt-1">Mail server</span>
                    <CopyableValue value={mx.server} copyLabel={`Copy mail server for the ${recordName} record`} />
                </div>
            </div>
        );
    }
    const srv = check.type === "autodiscover_srv" ? splitSrvValue(value) : null;
    if (srv) {
        return (
            <div className="flex flex-col gap-1.5">
                <div className="flex items-start gap-2">
                    <span className="text-xs w-20 shrink-0 pt-1">Priority</span>
                    <CopyableValue value={srv.priority} copyLabel={`Copy priority for the ${recordName} record`} />
                </div>
                <div className="flex items-start gap-2">
                    <span className="text-xs w-20 shrink-0 pt-1">Weight</span>
                    <CopyableValue value={srv.weight} copyLabel={`Copy weight for the ${recordName} record`} />
                </div>
                <div className="flex items-start gap-2">
                    <span className="text-xs w-20 shrink-0 pt-1">Port</span>
                    <CopyableValue value={srv.port} copyLabel={`Copy port for the ${recordName} record`} />
                </div>
                <div className="flex items-start gap-2">
                    <span className="text-xs w-20 shrink-0 pt-1">Target</span>
                    <CopyableValue value={srv.target} copyLabel={`Copy target for the ${recordName} record`} />
                </div>
            </div>
        );
    }
    return <CopyableValue value={value} copyLabel={`Copy value for the ${recordName} record`} />;
}
