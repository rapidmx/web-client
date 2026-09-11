///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { AccessControlList, getMailboxAcl, grantMailboxAccess, revokeMailboxAccess } from "@rapidmx/react-shared/mailApi.js";
import Alert from "../../feedback/Alert.js";
import Button from "../../buttons/Button.js";

const DEFAULT_DELEGATE_ACTIONS = ["read", "list", "count", "exists"];

export interface ShareAccessCardProps {
    mailboxUid: string;
}

/**
 * Lets an admin (or, eventually, the mailbox owner) view and edit a mailbox's delegate access — the
 * mechanism behind Exchange-style shared mailboxes. `records` on a mailbox's own ACL doubles as both the
 * owner's grant (if any) and every delegate's — see `BaseMailboxRoute`'s doc comment in `@rapidmx/restapi`.
 */
export default function ShareAccessCard({ mailboxUid }: ShareAccessCardProps) {
    const [acl, setAcl] = useState<AccessControlList | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [newUserUid, setNewUserUid] = useState("");
    const [saving, setSaving] = useState(false);

    function reload() {
        setLoading(true);
        setError(null);
        getMailboxAcl(mailboxUid)
            .then(setAcl)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load share settings."))
            .finally(() => setLoading(false));
    }

    useEffect(reload, [mailboxUid]);

    async function handleGrant(e: FormEvent) {
        e.preventDefault();
        const userUid = newUserUid.trim();
        if (!userUid) {
            return;
        }
        setSaving(true);
        setError(null);
        try {
            await grantMailboxAccess(mailboxUid, userUid, DEFAULT_DELEGATE_ACTIONS);
            setNewUserUid("");
            reload();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not grant access.");
        } finally {
            setSaving(false);
        }
    }

    async function handleRevoke(userOrRoleId: string) {
        setSaving(true);
        setError(null);
        try {
            await revokeMailboxAccess(mailboxUid, userOrRoleId);
            reload();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not revoke access.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="bg-surface border border-border rounded-md p-6">
            <h2 className="text-base font-bold uppercase tracking-wide mb-1">Shared access</h2>
            <p className="text-sm text-text-muted mb-4">
                Grants read access to this mailbox for another user, independent of ownership.
            </p>

            {error && <Alert>{error}</Alert>}

            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : (
                <ul className="flex flex-col gap-2 mb-4">
                    {(acl?.records ?? []).length === 0 && (
                        <li className="text-sm text-text-muted">No grants on this mailbox yet.</li>
                    )}
                    {acl?.records.map((record) => (
                        <li
                            key={record.userOrRoleId}
                            className="flex items-center justify-between gap-3 py-2 px-3 border border-border rounded-sm"
                        >
                            <div>
                                <div className="text-sm font-medium">{record.userOrRoleId}</div>
                                <div className="text-xs text-text-muted">{record.actions.join(", ")}</div>
                            </div>
                            <button
                                type="button"
                                onClick={() => handleRevoke(record.userOrRoleId)}
                                disabled={saving}
                                className="text-sm text-danger hover:underline disabled:opacity-55"
                            >
                                Revoke
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            <form onSubmit={handleGrant} className="flex gap-2">
                <input
                    type="text"
                    value={newUserUid}
                    onChange={(e) => setNewUserUid(e.target.value)}
                    placeholder="User uid to grant access to"
                    className="flex-1 text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary"
                />
                <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                    Grant
                </Button>
            </form>
        </div>
    );
}
