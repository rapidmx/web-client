///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { DistributionList, getDistributionList } from "@rapidmx/react-shared/distributionListsApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import MemberListCard from "../../shared/components/admin/distributionLists/MemberListCard.js";
import Alert from "../../shared/components/feedback/Alert.js";

export default function DistributionListDetailPage(props: Omit<AdminShellProps, "active"> & { params: { uid: string } }) {
    return (
        <AdminShell {...props} active="distributionLists">
            <DistributionListDetailContent uid={props.params.uid} />
        </AdminShell>
    );
}

function DistributionListDetailContent({ uid }: { uid: string }) {
    const [list, setList] = useState<DistributionList | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setLoading(true);
        setError(null);
        getDistributionList(uid)
            .then(setList)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load this distribution list."))
            .finally(() => setLoading(false));
    }, [uid]);

    if (loading) {
        return <p className="text-sm text-text-muted">Loading&hellip;</p>;
    }
    if (error || !list) {
        return <Alert>{error ?? "Distribution list not found."}</Alert>;
    }

    return (
        <div className="max-w-3xl flex flex-col gap-5">
            <div>
                <a href="/admin/distribution-lists" className="text-sm text-primary-dark hover:underline">
                    &larr; All distribution lists
                </a>
                <h1 className="text-xl font-bold tracking-tight mt-1">{list.primarySmtpAddress}</h1>
            </div>

            <div className="bg-surface border border-border rounded-md p-6">
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                    <dt className="text-text-muted">Name</dt>
                    <dd>{list.name}</dd>
                    <dt className="text-text-muted">Description</dt>
                    <dd>{list.description ?? "None"}</dd>
                    <dt className="text-text-muted">Owner</dt>
                    <dd>{list.ownerUserUid ?? "None"}</dd>
                    <dt className="text-text-muted">Alias addresses</dt>
                    <dd>{list.aliasAddresses && list.aliasAddresses.length > 0 ? list.aliasAddresses.join(", ") : "None"}</dd>
                    <dt className="text-text-muted">Restrict senders</dt>
                    <dd>{list.restrictSenders ? "Only members may send" : "No"}</dd>
                    <dt className="text-text-muted">Created</dt>
                    <dd>{new Date(list.dateCreated).toLocaleString()}</dd>
                </dl>
            </div>

            <MemberListCard list={list} onUpdate={setList} />
        </div>
    );
}
