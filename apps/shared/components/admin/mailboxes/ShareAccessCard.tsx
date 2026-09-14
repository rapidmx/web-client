///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { AccessControlList, getMailboxAcl, grantMailboxAccess, revokeMailboxAccess } from "@rapidmx/react-shared/mail/mailApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

const DEFAULT_DELEGATE_ACTIONS = ["read", "list", "count", "exists"];

export interface ShareAccessCardProps {
    mailboxUid: string;
    /** The mailbox's owner - their own grant is shown but can't be revoked from here. */
    ownerUserUid?: string;
}

/**
 * Lets an admin (or, eventually, the mailbox owner) view and edit a mailbox's delegate access — the
 * mechanism behind Exchange-style shared mailboxes. `records` on a mailbox's own ACL doubles as both the
 * owner's grant (if any) and every delegate's — see `BaseMailboxRoute`'s doc comment in `@rapidmx/restapi`.
 */
export default function ShareAccessCard({ mailboxUid, ownerUserUid }: ShareAccessCardProps) {
    const [acl, setAcl] = useState<AccessControlList | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [newUserUid, setNewUserUid] = useState("");
    const [saving, setSaving] = useState(false);
    const [revokeTarget, setRevokeTarget] = useState<string | null>(null);

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
        setNotice(null);
        try {
            // `grantMailboxAccess()` replaces any existing record for this uid, so granting read access to someone
            // who already has more (e.g. the owner) would silently downgrade them. Merge with their current actions.
            const current = await getMailboxAcl(mailboxUid);
            const existing = current.records.find((record) => record.userOrRoleId === userUid)?.actions ?? [];
            const missing = DEFAULT_DELEGATE_ACTIONS.filter((action) => !existing.includes(action));
            if (missing.length === 0) {
                setNotice(`${userUid} already has this access.`);
                setNewUserUid("");
                return;
            }
            await grantMailboxAccess(mailboxUid, userUid, [...existing, ...missing]);
            setNewUserUid("");
            reload();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not grant access.");
        } finally {
            setSaving(false);
        }
    }

    // Only ever invoked from the revoke-confirmation modal below, which only renders once `revokeTarget` is set.
    async function handleRevoke() {
        const userOrRoleId = revokeTarget!;
        setRevokeTarget(null);
        setSaving(true);
        setError(null);
        setNotice(null);
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
            {notice && !error && <div className="mb-4 text-sm text-text-muted">{notice}</div>}

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
                            {record.userOrRoleId === ownerUserUid ? (
                                <span className="text-xs font-bold uppercase tracking-wide text-text-muted">Owner</span>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => setRevokeTarget(record.userOrRoleId)}
                                    disabled={saving}
                                    className="text-sm text-danger hover:underline disabled:opacity-55"
                                >
                                    Revoke
                                </button>
                            )}
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

            <Modal open={revokeTarget !== null} onClose={() => setRevokeTarget(null)} title="Revoke access">
                <p className="text-sm mb-5">
                    Revoke <strong className="break-all">{revokeTarget}</strong>&rsquo;s access to this mailbox? They lose it
                    immediately.
                </p>
                <div className="flex gap-3 justify-end">
                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => setRevokeTarget(null)}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger"
                        onClick={() => void handleRevoke()}
                    >
                        Revoke
                    </Button>
                </div>
            </Modal>
        </div>
    );
}
