///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { DistributionList, updateDistributionList } from "@rapidmx/react-shared/distributionListsApi.js";
import Alert from "../../feedback/Alert.js";
import Button from "../../buttons/Button.js";

export interface MemberListCardProps {
    list: DistributionList;
    /** Called with the freshly-saved list (new `version`, updated `memberAddresses`) after a successful
     * add/remove, so the parent detail page can keep its own copy of the list in sync — mirrors
     * `ShareAccessCard`'s `reload()` pattern, just pushed up rather than re-fetched, since the caller
     * already has everything the response would return. */
    onUpdate: (list: DistributionList) => void;
}

/**
 * Lets an admin view and edit a distribution list's members — same load/inline-add-row/per-row-remove
 * interaction shape as `ShareAccessCard`, but against a plain `memberAddresses: string[]` field on the
 * `DistributionList` itself via read-modify-write `PUT`, not a separate ACL endpoint (a distribution
 * list has no per-record ACL to speak of — see `BaseDistributionListRoute`'s own doc comment).
 */
export default function MemberListCard({ list, onUpdate }: MemberListCardProps) {
    const [newAddress, setNewAddress] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleAdd(e: FormEvent) {
        e.preventDefault();
        const address = newAddress.trim();
        if (!address || list.memberAddresses.includes(address)) {
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const updated = await updateDistributionList({
                uid: list.uid,
                version: list.version,
                memberAddresses: [...list.memberAddresses, address],
            });
            setNewAddress("");
            onUpdate(updated);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not add this member.");
        } finally {
            setSaving(false);
        }
    }

    async function handleRemove(address: string) {
        setSaving(true);
        setError(null);
        try {
            const updated = await updateDistributionList({
                uid: list.uid,
                version: list.version,
                memberAddresses: list.memberAddresses.filter((a) => a !== address),
            });
            onUpdate(updated);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not remove this member.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="bg-surface border border-border rounded-md p-6">
            <h2 className="text-base font-bold uppercase tracking-wide mb-1">Members</h2>
            <p className="text-sm text-text-muted mb-4">
                Each address may resolve to an internal mailbox, a nested distribution list, or a genuinely
                external address relayed out.
            </p>

            {error && <Alert>{error}</Alert>}

            <ul className="flex flex-col gap-2 mb-4">
                {list.memberAddresses.length === 0 && (
                    <li className="text-sm text-text-muted">No members yet.</li>
                )}
                {list.memberAddresses.map((address) => (
                    <li
                        key={address}
                        className="flex items-center justify-between gap-3 py-2 px-3 border border-border rounded-sm"
                    >
                        <div className="text-sm font-medium">{address}</div>
                        <button
                            type="button"
                            onClick={() => handleRemove(address)}
                            disabled={saving}
                            className="text-sm text-danger hover:underline disabled:opacity-55"
                        >
                            Remove
                        </button>
                    </li>
                ))}
            </ul>

            <form onSubmit={handleAdd} className="flex gap-2">
                <input
                    type="text"
                    value={newAddress}
                    onChange={(e) => setNewAddress(e.target.value)}
                    placeholder="Member address to add"
                    className="flex-1 text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary"
                />
                <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                    Add
                </Button>
            </form>
        </div>
    );
}
