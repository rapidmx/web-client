///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "@rapidrest/react/client";
import {
    deleteDnsProvider,
    DnsProvider,
    DnsProviderInput,
    DnsProviderTypeInfo,
    getDnsProvider,
    listDnsProviderTypes,
    updateDnsProvider,
} from "../../../../lib/admin/dnsProvidersApi.js";
import Button from "../../../../lib/components/buttons/Button.js";
import { ApiRequestError } from "../../../../lib/util/api.js";
import Modal from "../../../../lib/components/overlays/Modal.js";
import AdminShell, { AdminShellProps } from "../../../shared/components/admin/layout/AdminShell.js";
import DnsProviderForm from "../../../shared/components/admin/integrations/DnsProviderForm.js";
import DnsProviderHosts from "../../../shared/components/admin/integrations/DnsProviderHosts.js";
import DnsProviderOperations from "../../../shared/components/admin/integrations/DnsProviderOperations.js";
import IntegrationsLayout from "../../../shared/components/admin/integrations/IntegrationsLayout.js";
import { Badge, dnsProviderStatus, domainsText, formatTime } from "../../../shared/components/admin/integrations/dnsProviderParts.js";
import Alert from "../../../shared/components/admin/ActionAlert.js";
import { actionErrorMessage } from "../../../shared/components/admin/elevation.js";

const LIST_HREF = "/admin/integrations/dns-providers";

/** What of a config an administrator can change, as the server shows it: the controller's status reports move the row's version without touching any of it. */
function configOf(provider: DnsProvider): string {
    const { name, zones, options, credentials, enabled, allowTakeover } = provider;
    return JSON.stringify({ name, zones, options, credentials, enabled, allowTakeover });
}

export default function DnsProviderPage(props: Omit<AdminShellProps, "active"> & { params: { uid: string } }) {
    return (
        <AdminShell {...props} active="integrations">
            <IntegrationsLayout active="dnsProviders">
                <DnsProviderDetail uid={props.params.uid} />
            </IntegrationsLayout>
        </AdminShell>
    );
}

function DnsProviderDetail({ uid }: { uid: string }) {
    const { navigate } = useRouter();
    const [provider, setProvider] = useState<DnsProvider | null>(null);
    // The version a save is made against: the one shown, or a newer one found after a refusal (the form isn't reset to show it).
    const version = useRef(0);
    const [types, setTypes] = useState<DnsProviderTypeInfo[]>([]);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    useEffect(() => {
        Promise.all([getDnsProvider(uid), listDnsProviderTypes()])
            .then(([loaded, loadedTypes]) => {
                setProvider(loaded);
                version.current = loaded.version;
                setTypes(loadedTypes);
            })
            .catch((err) => setLoadError(actionErrorMessage(err, "Could not load the DNS provider.")));
    }, [uid]);

    if (loadError) {
        return <Alert>{loadError}</Alert>;
    }
    if (!provider) {
        return <p className="text-sm text-text-muted">Loading&hellip;</p>;
    }
    const spec: DnsProviderTypeInfo | undefined = types.find((candidate) => candidate.type === provider.type);
    const status = dnsProviderStatus(provider);

    function accept(saved: DnsProvider) {
        version.current = saved.version;
        setProvider(saved);
    }

    // Made against the version shown, so a change someone else saved meanwhile is refused (409) rather than overwritten. The DNS controller moves the
    // version too (every status report that changes, and at least every few minutes), so a refusal reads the config again: when nothing an administrator
    // sets differs, only the status moved and the save is made again against the new version; otherwise the entries stay in the form, the new version is
    // kept, and saving once more replaces the other change.
    async function handleSave(input: DnsProviderInput) {
        const sent: number = version.current;
        try {
            accept(await updateDnsProvider(uid, { ...input, version: sent }));
        } catch (err) {
            if (!(err instanceof ApiRequestError) || err.status !== 409) {
                throw err;
            }
            let latest: DnsProvider;
            try {
                latest = await getDnsProvider(uid);
            } catch {
                throw err;
            }
            if (latest.version === sent) {
                // Refused for another reason than a newer version.
                throw err;
            }
            version.current = latest.version;
            if (configOf(latest) !== configOf(provider!)) {
                throw new ApiRequestError(
                    "This DNS provider was changed by someone else. Your entries are kept; save again to replace their change, or reload the page to see it.",
                    409
                );
            }
            accept(await updateDnsProvider(uid, { ...input, version: latest.version }));
        }
    }

    async function handleDelete() {
        setDeleting(true);
        setDeleteError(null);
        try {
            await deleteDnsProvider(provider!.uid);
            void navigate(LIST_HREF);
        } catch (err) {
            setDeleteError(actionErrorMessage(err, "Could not delete the DNS provider."));
            setDeleting(false);
        }
    }

    return (
        <>
            <a href={LIST_HREF} className="text-sm text-primary-dark hover:underline">
                &larr; DNS providers
            </a>
            <h2 className="text-lg font-bold uppercase tracking-wide mt-2 mb-1">
                {provider.name}
                {provider.origin === "installer" && <Badge>Added by the installer</Badge>}
            </h2>
            <div className="flex items-center text-sm text-text-muted mb-4">
                <p>Type: {spec?.label ?? provider.type}</p>
                {spec && !spec.tested && <Badge>Not yet live-tested</Badge>}
            </div>

            <div className="border border-border rounded-sm bg-surface p-4 mb-6 max-w-xl text-sm flex flex-col gap-1">
                <p className="font-semibold">Status: {status.label}</p>
                {status.error && <p className="text-danger">{status.error}</p>}
                <p className="text-text-muted">
                    {provider.domainCount === 0 ? "No domains are published through it yet." : `Publishing ${domainsText(provider.domainCount)}.`}
                </p>
                {provider.status?.lastSyncAt && <p className="text-text-muted">Last synchronized {formatTime(provider.status.lastSyncAt)}.</p>}
            </div>

            {spec ? (
                <DnsProviderForm types={types} provider={provider} submitLabel="Save" onSave={handleSave} />
            ) : (
                <p className="text-sm text-text-muted max-w-xl">
                    This console doesn&rsquo;t know this type, so its settings can&rsquo;t be edited here. A newer admin console can edit it.
                </p>
            )}

            <DnsProviderHosts uid={provider.uid} />

            <DnsProviderOperations uid={provider.uid} />

            <div className="mt-8">
                <Button type="button" variant="secondary" className="!w-auto" onClick={() => setConfirmingDelete(true)}>
                    Delete DNS provider
                </Button>
            </div>

            <Modal open={confirmingDelete} onClose={() => setConfirmingDelete(false)} title="Delete DNS provider?">
                <div className="flex flex-col gap-3 text-sm">
                    {deleteError && <Alert>{deleteError}</Alert>}
                    {provider.domainCount > 0 && (
                        <p>
                            The server refuses while domains are assigned to it ({domainsText(provider.domainCount)}): assign them to another provider, or to
                            manual publishing, first.
                        </p>
                    )}
                    <p>
                        The records it publishes for this server&rsquo;s own host names are removed from your DNS host, then its external-dns instance and its
                        credentials are deleted.
                    </p>
                    <div className="flex gap-3 justify-end">
                        <Button type="button" variant="secondary" className="!w-auto" onClick={() => setConfirmingDelete(false)}>
                            Cancel
                        </Button>
                        <Button type="button" className="!w-auto" loading={deleting} disabled={deleting} onClick={handleDelete}>
                            Delete
                        </Button>
                    </div>
                </div>
            </Modal>
        </>
    );
}
