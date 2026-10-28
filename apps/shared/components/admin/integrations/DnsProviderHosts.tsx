///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { DnsHostManualReason, DnsHostPublication, listDnsHostPublications, takeoverDnsHosts } from "../../../../../lib/admin/dnsProvidersApi.js";
import Button from "../../../../../lib/components/buttons/Button.js";
import Modal from "../../../../../lib/components/overlays/Modal.js";
import { ApiRequestError } from "../../../../../lib/util/api.js";
import Alert from "../ActionAlert.js";
import { actionErrorMessage } from "../elevation.js";
import { TypeMismatchNotice } from "./dnsProviderParts.js";

const MANUAL_REASONS: Record<DnsHostManualReason, string> = {
    no_provider: "No DNS provider is assigned.",
    kind_unsupported: "The DNS provider can't hold this kind of record.",
    outside_zones: "This name is outside the zones of the DNS provider.",
    apex_txt_unmanaged: "Shares the domain's root TXT records, which are managed only on the domain's opt-in.",
    no_addresses: "The server has no public address to publish: set the public addresses, then it is published.",
    no_target: "There is no mail host to point it at.",
};

const STATE_LABELS: Record<DnsHostPublication["state"], string> = {
    published: "Published",
    pending: "Pending",
    conflict: "Conflict",
    manual: "Manual",
};

/** A host record's name once per name: an address host has an A and an AAAA record at one name. */
function uniqueNames(records: DnsHostPublication[]): string[] {
    return [...new Set(records.map((record) => record.recordName))];
}

/**
 * The deployment's own host names (mail, auth, autodiscover, openpgpkey) that this config publishes, each with how it is published, and "Take over host
 * names" for the ones another system created (a record this deployment doesn't own). A host whose records of another type stand in the way is never taken
 * over: it lists them for the administrator to delete at their DNS host. Shown only when the config publishes a host, and not at all on a server without
 * the route.
 */
export default function DnsProviderHosts({ uid }: { uid: string }) {
    const [hosts, setHosts] = useState<DnsHostPublication[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [taking, setTaking] = useState(false);
    const [takeError, setTakeError] = useState<string | null>(null);
    const [queued, setQueued] = useState(false);

    function load(isCurrent: () => boolean = () => true) {
        listDnsHostPublications()
            .then((loaded) => {
                if (!isCurrent()) return;
                setHosts(loaded.filter((host) => host.providerUid === uid));
                setError(null);
            })
            .catch((err) => {
                if (!isCurrent()) return;
                if (err instanceof ApiRequestError && err.status === 404) {
                    setHosts([]);
                    return;
                }
                setError(actionErrorMessage(err, "Could not load the host names."));
            });
    }

    useEffect(() => {
        let current = true;
        load(() => current);
        return () => {
            current = false;
        };
    }, [uid]);

    async function handleTakeOver(names: string[]) {
        setTaking(true);
        setTakeError(null);
        try {
            await takeoverDnsHosts(uid, names);
            setQueued(true);
            setConfirming(false);
        } catch (err) {
            setTakeError(actionErrorMessage(err, "Could not queue the takeover."));
        } finally {
            setTaking(false);
        }
    }

    if (error) {
        return (
            <section className="mt-8 max-w-3xl">
                <Alert>{error}</Alert>
            </section>
        );
    }
    if (!hosts || hosts.length === 0) {
        return null;
    }
    const mismatched = new Set(uniqueNames(hosts.filter((host) => host.state === "conflict" && host.conflictReason === "type_mismatch")));
    const notOwned: string[] = uniqueNames(hosts.filter((host) => host.state === "conflict" && host.conflictReason !== "type_mismatch")).filter(
        (name) => !mismatched.has(name),
    );

    return (
        <section className="mt-8 max-w-3xl">
            <h3 className="text-base font-bold uppercase tracking-wide mb-1">Host names</h3>
            <p className="text-sm text-text-muted mb-3">
                The names of this server itself that this provider publishes, such as the mail host. Records you already have at these names are shown as
                conflicts.
            </p>
            <table aria-label="Host names" className="w-full text-sm border-collapse mb-3">
                <thead>
                    <tr>
                        {["Name", "Record", "Published"].map((h) => (
                            <th key={h} className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border">
                                {h}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {hosts.map((host) => (
                        <tr key={`${host.recordName} ${host.recordKind}`}>
                            <td className="py-2 px-2.5 border-b border-border">
                                <code className="text-xs break-all">{host.recordName}</code>
                            </td>
                            <td className="py-2 px-2.5 border-b border-border text-text-muted">{host.recordKind}</td>
                            <td className="py-2 px-2.5 border-b border-border">
                                <span
                                    className={`text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill ${
                                        host.state === "published"
                                            ? "bg-success text-white"
                                            : host.state === "conflict"
                                              ? "bg-danger-bg text-danger"
                                              : "bg-surface-alt text-text-muted"
                                    }`}
                                >
                                    {STATE_LABELS[host.state]}
                                </span>
                                {host.state === "manual" && host.manualReason && (
                                    <div className="text-xs text-text-muted mt-1 max-w-xs">{MANUAL_REASONS[host.manualReason]}</div>
                                )}
                                {host.state === "conflict" && host.conflictReason === "type_mismatch" && <TypeMismatchNotice existing={host.existing} />}
                                {host.state === "conflict" && host.conflictReason !== "type_mismatch" && (
                                    <div className="text-xs mt-1 max-w-xs">A record is there that this deployment doesn&rsquo;t own.</div>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {queued && <p className="text-sm text-text-muted mb-3">Takeover queued. The DNS controller overwrites the records shortly; refresh to see the result.</p>}
            <div className="flex gap-3">
                {notOwned.length > 0 && (
                    <Button type="button" variant="secondary" className="!w-auto" disabled={queued} onClick={() => setConfirming(true)}>
                        Take over host names
                    </Button>
                )}
                <Button
                    type="button"
                    variant="secondary"
                    className="!w-auto"
                    onClick={() => {
                        setQueued(false);
                        load();
                    }}
                >
                    Refresh
                </Button>
            </div>

            <Modal open={confirming} onClose={() => setConfirming(false)} title="Take over host names">
                <div className="flex flex-col gap-3 text-sm">
                    <p>
                        Taking over overwrites the records at these names with the values this server publishes. From then on RapidMX manages them, and what was
                        there is lost.
                    </p>
                    <ul className="list-none flex flex-col gap-0.5">
                        {notOwned.map((name) => (
                            <li key={name}>
                                <code className="text-xs break-all">{name}</code>
                            </li>
                        ))}
                    </ul>
                    {takeError && <Alert>{takeError}</Alert>}
                    <div className="flex gap-3 justify-end">
                        <Button type="button" variant="secondary" className="!w-auto" disabled={taking} onClick={() => setConfirming(false)}>
                            Cancel
                        </Button>
                        <Button type="button" className="!w-auto" loading={taking} disabled={taking} onClick={() => handleTakeOver(notOwned)}>
                            Take over
                        </Button>
                    </div>
                </div>
            </Modal>
        </section>
    );
}
