///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { deleteDomain, DnsRecordCheck, Domain, getDnsSetup, getDomain, verifyDomain } from "@rapidmx/react-shared/domainsApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import Alert from "../../shared/components/feedback/Alert.js";
import Button from "../../shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/Modal.js";

const RECORD_TYPE_LABELS: Record<DnsRecordCheck["type"], string> = {
    ownership: "Ownership (TXT)",
    mx: "MX",
    spf: "SPF",
    dkim: "DKIM",
    dmarc: "DMARC",
};

export default function DomainDetailPage(props: Omit<AdminShellProps, "active"> & { params: { uid: string } }) {
    return (
        <AdminShell {...props} active="domains">
            <DomainDetailContent uid={props.params.uid} />
        </AdminShell>
    );
}

function DomainDetailContent({ uid }: { uid: string }) {
    const [domain, setDomain] = useState<Domain | null>(null);
    const [dnsSetup, setDnsSetup] = useState<DnsRecordCheck[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [verifying, setVerifying] = useState(false);
    const [copied, setCopied] = useState(false);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    function reload(id: string) {
        setLoading(true);
        setError(null);
        Promise.all([getDomain(id), getDnsSetup(id)])
            .then(([d, checks]) => {
                setDomain(d);
                setDnsSetup(checks);
            })
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load this domain."))
            .finally(() => setLoading(false));
    }

    useEffect(() => {
        reload(uid);
    }, [uid]);

    // Only ever invoked from the "Verify now" button below, which itself only renders once `domain` is
    // resolved (children only render once loaded — see the early returns above) — the non-null assertion
    // reflects that real invariant, not an unchecked assumption. Matches `QuarantineContent.handleRelease`'s
    // identical pattern.
    async function handleVerify() {
        setVerifying(true);
        setError(null);
        try {
            await verifyDomain(domain!.uid);
            reload(domain!.uid);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not verify this domain.");
        } finally {
            setVerifying(false);
        }
    }

    // Only ever invoked from the "Delete domain" confirmation modal below, which itself only renders once
    // `domain` is resolved (children only render once loaded — see the early returns above) — the non-null
    // assertion reflects that real invariant, not an unchecked assumption. Matches `handleVerify`'s identical
    // pattern above.
    function closeDeleteModal() {
        setConfirmingDelete(false);
    }

    async function handleDelete() {
        setDeleting(true);
        setDeleteError(null);
        try {
            await deleteDomain(domain!.uid, domain!.version);
            window.location.href = "/admin/domains";
        } catch (err) {
            setDeleteError(err instanceof ApiRequestError ? err.message : "Could not delete this domain.");
            setDeleting(false);
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

    const ownershipCheck = dnsSetup.find((c) => c.type === "ownership");

    return (
        <div className="max-w-3xl flex flex-col gap-5">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <a href="/admin/domains" className="text-sm text-primary-dark hover:underline">
                        &larr; All domains
                    </a>
                    <h1 className="text-xl font-bold tracking-tight mt-1">{domain.name}</h1>
                </div>
                <Button
                    type="button"
                    variant="secondary"
                    className="!w-auto shrink-0 !border-danger !text-danger hover:!border-danger hover:!text-danger"
                    onClick={() => setConfirmingDelete(true)}
                >
                    Delete domain
                </Button>
            </div>

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
                                {ownershipCheck?.recommendedValue ?? `rapidmx-domain-verification=${domain.verificationToken}`}
                            </code>
                            <Button
                                type="button"
                                variant="secondary"
                                className="!w-auto shrink-0"
                                onClick={() =>
                                    handleCopy(
                                        ownershipCheck?.recommendedValue ?? `rapidmx-domain-verification=${domain.verificationToken}`,
                                    )
                                }
                            >
                                {copied ? "Copied" : "Copy"}
                            </Button>
                        </div>
                        <Button
                            type="button"
                            className="!w-auto mt-3"
                            loading={verifying}
                            disabled={verifying}
                            onClick={handleVerify}
                        >
                            Verify now
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

            <Modal open={confirmingDelete} onClose={closeDeleteModal} title="Delete domain">
                <p className="text-sm mb-5">
                    Are you sure you want to delete <strong>{domain.name}</strong>? This cannot be undone.
                </p>
                {deleteError && <Alert>{deleteError}</Alert>}
                <div className="flex gap-3 justify-end mt-5">
                    <Button
                        type="button"
                        variant="secondary"
                        className="!w-auto"
                        disabled={deleting}
                        onClick={closeDeleteModal}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger"
                        loading={deleting}
                        disabled={deleting}
                        onClick={handleDelete}
                    >
                        Delete
                    </Button>
                </div>
            </Modal>
        </div>
    );
}
