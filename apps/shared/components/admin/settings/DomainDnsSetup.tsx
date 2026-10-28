///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { takeoverDnsRecords } from "../../../../../lib/admin/dnsProvidersApi.js";
import { DnsManualReason, DnsRecordCheck, Domain, getDnsSetup, getDomain, verifyDomain } from "../../../../../lib/admin/domainsApi.js";
import Alert from "../ActionAlert.js";
import Button from "../../../../../lib/components/buttons/Button.js";
import CopyableValue from "./CopyableValue.js";
import Modal from "../../../../../lib/components/overlays/Modal.js";
import { actionErrorMessage } from "../elevation.js";
import { TypeMismatchNotice } from "../integrations/dnsProviderParts.js";

const RECORD_TYPE_LABELS: Record<DnsRecordCheck["type"], string> = {
    ownership: "Ownership (TXT)",
    mx: "MX",
    spf: "SPF",
    dkim: "DKIM",
    dkim_next: "DKIM (new key)",
    dkim_previous: "DKIM (previous key)",
    dmarc: "DMARC",
    openpgpkey_cname: "OpenPGP keys (CNAME)",
    autodiscover_cname: "Autodiscover (CNAME)",
    autodiscover_srv: "Autodiscover (SRV)",
};

/** How each record is named in a Copy button's accessible name ("Copy value for the SPF record"). */
const RECORD_TYPE_NAMES: Record<DnsRecordCheck["type"], string> = {
    ownership: "ownership TXT",
    mx: "MX",
    spf: "SPF",
    dkim: "DKIM",
    dkim_next: "new DKIM key",
    dkim_previous: "previous DKIM key",
    dmarc: "DMARC",
    openpgpkey_cname: "OpenPGP keys CNAME",
    autodiscover_cname: "Autodiscover CNAME",
    autodiscover_srv: "Autodiscover SRV",
};

/** A one-line "why this matters", shown under a checklist row's label - only for record types unfamiliar
 * enough to need one; the well-known mail records (ownership/MX/SPF/DKIM/DMARC) don't. */
const RECORD_TYPE_HELP: Partial<Record<DnsRecordCheck["type"], string>> = {
    openpgpkey_cname:
        "So Proton Mail and other OpenPGP apps can find your users' OpenPGP keys (Web Key Directory) and send them encrypted mail. This hostname also needs to be covered by this server's TLS certificate.",
    autodiscover_cname:
        "So EAS and Outlook clients can find this server automatically from just an email address. This hostname also needs to be covered by this server's TLS certificate.",
    autodiscover_srv:
        "Same purpose as the CNAME above, for clients that check DNS SRV instead - and, unlike the CNAME, needs no extra TLS certificate, since it points at a hostname already covered. Prefer this one when a second certificate is hard to obtain.",
};

/** Why a record is added by hand, shown under "Manual" in the Published column. */
const MANUAL_REASONS: Record<DnsManualReason, string> = {
    no_provider: "No DNS provider is assigned to this domain.",
    kind_unsupported: "The DNS provider can't hold this kind of record.",
    outside_zones: "This name is outside the zones of the DNS provider.",
    apex_txt_unmanaged: "Shares the domain's root TXT records, which you opt in to manage below.",
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

export interface DomainDnsSetupProps {
    uid: string;
    /** Called with the domain and its checklist every time they are (re)loaded - e.g. after "Verify now". */
    onLoaded?: (domain: Domain, checks: DnsRecordCheck[]) => void;
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
    // The conflicting record the administrator is being asked to take over, the request in flight, why it failed, and the records whose takeover was queued.
    const [takeOver, setTakeOver] = useState<DnsRecordCheck | null>(null);
    const [takingOver, setTakingOver] = useState(false);
    const [takeOverError, setTakeOverError] = useState<string | null>(null);
    const [takeOverQueued, setTakeOverQueued] = useState<DnsRecordCheck["type"][]>([]);

    function reload(id: string) {
        setLoading(true);
        setError(null);
        return Promise.all([getDomain(id), getDnsSetup(id)])
            .then(([d, checks]) => {
                setDomain(d);
                setDnsSetup(checks);
                onLoaded?.(d, checks);
            })
            .catch((err) => setError(actionErrorMessage(err, "Could not load this domain.")))
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
            onLoaded?.(d, checks);
        } catch (err) {
            setVerifyError(actionErrorMessage(err, "Could not verify this domain."));
        } finally {
            setVerifying(false);
        }
    }

    // The record is taken over through the provider the domain is assigned to (a conflict only exists with one). Only the DNS controller applies it, so
    // the list shows the result some time later: "Check again" rather than a refresh that would still show the conflict.
    async function handleTakeOver() {
        setTakingOver(true);
        setTakeOverError(null);
        try {
            await takeoverDnsRecords(domain!.dnsProviderUid!, domain!.uid, [takeOver!.type]);
            setTakeOverQueued((queued) => [...queued, takeOver!.type]);
            setTakeOver(null);
        } catch (err) {
            setTakeOverError(actionErrorMessage(err, "Could not queue the takeover."));
        } finally {
            setTakingOver(false);
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
    // A server that doesn't publish says nothing about how a record gets published, so the column stays out.
    const showPublished = dnsSetup.some((c) => c.publication);
    const openpgpkey = dnsSetup.find((c) => c.type === "openpgpkey_cname");

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
                    {domain.aliasOf && (
                        <>
                            <dt className="text-text-muted">Alias of</dt>
                            <dd>
                                {domain.aliasOf} <span className="text-xs text-text-muted">(no mailboxes of its own)</span>
                            </dd>
                        </>
                    )}
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
                    {openpgpkey?.configured && !openpgpkey.matches && (
                        <div role="note" aria-label="OpenPGP key host warning" className="text-sm rounded-sm py-3 px-3.5 mb-3 bg-warning text-warning-contrast">
                            {openpgpkey.recordName} doesn't resolve to this deployment yet. Until it does, other people's OpenPGP apps can't find your
                            users' keys (Web Key Directory), and this server can't get a certificate for it.
                            {openpgpkey.publication === "pending" && " It is being published automatically."}
                        </div>
                    )}
                    {takeOverQueued.length > 0 && (
                        <p className="text-sm mb-3">
                            Takeover queued for the {takeOverQueued.map((type) => RECORD_TYPE_NAMES[type]).join(", ")} record. The DNS controller overwrites it
                            shortly, and it shows as published here once it is live. If it stays in conflict, the result of the takeover is under Operations on{" "}
                            <a href={`/admin/integrations/dns-providers/${encodeURIComponent(domain.dnsProviderUid!)}`} className="text-primary-dark hover:underline">
                                the DNS provider's page
                            </a>
                            .{" "}
                            <button
                                type="button"
                                className="font-semibold underline"
                                onClick={() => {
                                    setTakeOverQueued([]);
                                    void reload(uid);
                                }}
                            >
                                Check again
                            </button>
                        </p>
                    )}
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm border-collapse">
                            <thead>
                                <tr>
                                    {["Record", "Status", ...(showPublished ? ["Published"] : []), "Name / host", "Recommended value"].map((h) => (
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
                                            {check.legacyApex && (
                                                <div className="text-xs text-text-muted mt-1 max-w-xs">
                                                    Found at the domain's root (the old location). Publish it at <strong>{check.recordName}</strong>; the root
                                                    value can then be removed.
                                                </div>
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
                                        {showPublished && (
                                            <td className="py-2.5 px-2.5 border-b border-border">
                                                <PublishedCell
                                                    check={check}
                                                    queued={takeOverQueued.includes(check.type)}
                                                    onTakeOver={() => {
                                                        setTakeOverError(null);
                                                        setTakeOver(check);
                                                    }}
                                                />
                                            </td>
                                        )}
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

            <Modal open={takeOver !== null} onClose={() => setTakeOver(null)} title="Take over this record">
                {takeOver && (
                    <>
                        <p className="text-sm mb-3">
                            Taking over overwrites the record at <code className="text-xs break-all">{takeOver.recordName}</code> with the value below. From then
                            on RapidMX manages it, and whatever relied on the old value stops getting it.
                        </p>
                        <dl className="text-sm flex flex-col gap-1 mb-3">
                            <dt className="text-text-muted">Existing value</dt>
                            <dd>{takeOver.actualValue ? <code className="text-xs break-all">{takeOver.actualValue}</code> : "(none found)"}</dd>
                            <dt className="text-text-muted mt-2">New value</dt>
                            <dd>
                                <code className="text-xs break-all">{takeOver.recommendedValue}</code>
                            </dd>
                        </dl>
                        {takeOverError && <Alert>{takeOverError}</Alert>}
                        <div className="flex gap-3 justify-end mt-5">
                            <Button type="button" variant="secondary" className="!w-auto" disabled={takingOver} onClick={() => setTakeOver(null)}>
                                Cancel
                            </Button>
                            <Button type="button" className="!w-auto" loading={takingOver} disabled={takingOver} onClick={handleTakeOver}>
                                Take over
                            </Button>
                        </div>
                    </>
                )}
            </Modal>
        </div>
    );
}

/** How a record is published, for the Published column: automatically (with its state; for a conflict also the value in the way and the takeover), or
 * by hand, with the reason. */
function PublishedCell({ check, queued, onTakeOver }: { check: DnsRecordCheck; queued: boolean; onTakeOver: () => void }) {
    if (!check.publication) {
        return <span className="text-xs text-text-muted">&mdash;</span>;
    }
    if (check.publication === "manual") {
        return (
            <>
                <span className="text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-surface-alt text-text-muted">Manual</span>
                {check.manualReason && <div className="text-xs text-text-muted mt-1 max-w-xs">{MANUAL_REASONS[check.manualReason]}</div>}
            </>
        );
    }
    const state = check.publication;
    return (
        <>
            <span
                className={`text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill ${
                    state === "published" ? "bg-success text-white" : state === "conflict" ? "bg-danger-bg text-danger" : "bg-surface-alt text-text-muted"
                }`}
            >
                Automatic: {state}
            </span>
            {state === "conflict" && check.conflictReason === "type_mismatch" && <TypeMismatchNotice existing={check.existing} />}
            {state === "conflict" && check.conflictReason !== "type_mismatch" && (
                <div className="text-xs mt-1 max-w-xs">
                    {check.actualValue ? (
                        <>
                            Not published by RapidMX, and in the way: <code className="break-all">{check.actualValue}</code>
                        </>
                    ) : (
                        "A record is there that this deployment doesn't own."
                    )}
                    {/* The root TXT set is taken over only through its own opt-in. */}
                    {check.type !== "spf" && (
                        <div className="mt-1.5">
                            <Button
                                type="button"
                                variant="secondary"
                                className="!w-auto !py-1"
                                aria-label={`Take over ${RECORD_TYPE_NAMES[check.type]}`}
                                disabled={queued}
                                onClick={onTakeOver}
                            >
                                {queued ? "Queued" : "Take over"}
                            </Button>
                        </div>
                    )}
                </div>
            )}
        </>
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
