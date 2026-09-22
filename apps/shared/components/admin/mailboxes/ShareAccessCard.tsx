///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    listMailboxAccess,
    MailboxAccessMember,
    MailboxAccessRole,
    removeMailboxAccess,
    setMailboxAccess,
} from "@rapidmx/react-shared/mail/mailboxAccessApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import PrincipalPicker from "../../sharing/PrincipalPicker.js";

const ROLE_LABELS: Record<MailboxAccessRole, string> = { viewer: "Read only", manager: "Full access" };

export interface ShareAccessCardProps {
    mailboxUid: string;
    /** The mailbox's owner: with one, only the owner can grant access to it. Without, the mailbox is shared and an
     * administrator grants access here - to themselves included. */
    ownerUserUid?: string;
    /** The signed-in administrator, for "Add me" on a shared mailbox. */
    currentUserUid?: string;
}

function roleLabel(member: MailboxAccessMember): string {
    if (member.role === "viewer") return ROLE_LABELS.viewer;
    if (member.role === "manager") return ROLE_LABELS.manager;
    return (member.actions ?? []).join(", ");
}

/**
 * A mailbox's members - the mechanism behind Exchange-style shared mailboxes - through the Sharing endpoints
 * (`/mail/mailboxes/:id/access`), the audited way an administrator reaches a mailbox they hold no grant on. An
 * administrator can review any mailbox's members and revoke any of them; they can grant access only on a shared
 * (ownerless) mailbox - themselves included, which is how it appears in their own mail client. A personal mailbox is
 * shared by its owner (or by an administrator impersonating them).
 */
export default function ShareAccessCard({ mailboxUid, ownerUserUid, currentUserUid }: ShareAccessCardProps) {
    const [members, setMembers] = useState<MailboxAccessMember[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
    // An entry that is not a user uid, being replaced with the user it was meant for.
    const [replacing, setReplacing] = useState<MailboxAccessMember | null>(null);

    function reload() {
        setLoading(true);
        setError(null);
        listMailboxAccess(mailboxUid)
            .then(setMembers)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load share settings."))
            .finally(() => setLoading(false));
    }

    useEffect(reload, [mailboxUid]);

    async function addMe(userUid: string) {
        setSaving(true);
        setError(null);
        try {
            await setMailboxAccess(mailboxUid, userUid, "manager");
            reload();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not grant access.");
        } finally {
            setSaving(false);
        }
    }

    // Once the person is granted, the entry they replace (if any) is removed: the string it named never matched anyone.
    async function handleGranted() {
        const stale = replacing;
        setReplacing(null);
        let failure: string | null = null;
        if (stale) {
            try {
                await removeMailboxAccess(mailboxUid, stale.userOrRoleId);
            } catch (err) {
                failure = err instanceof ApiRequestError ? err.message : "Could not remove the old entry.";
            }
        }
        reload();
        // After the reload, which clears the error it started with.
        if (failure) {
            setError(failure);
        }
    }

    // Only ever invoked from the revoke-confirmation modal below, which only renders once `revokeTarget` is set.
    async function handleRevoke() {
        const userOrRoleId = revokeTarget!;
        setRevokeTarget(null);
        setSaving(true);
        setError(null);
        try {
            await removeMailboxAccess(mailboxUid, userOrRoleId);
            reload();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not revoke access.");
        } finally {
            setSaving(false);
        }
    }

    const shared = !ownerUserUid;
    const isMember = members.some((member) => member.userOrRoleId === currentUserUid);

    return (
        <div className="bg-surface border border-border rounded-md p-6">
            <h2 className="text-base font-bold uppercase tracking-wide mb-1">Shared access</h2>
            <p className="text-sm text-text-muted mb-4">
                {shared
                    ? "Who has access to this shared mailbox. Adding yourself is how it appears in your own mail client; every change is recorded in the audit log."
                    : "Who the owner has shared this mailbox with. You can review and revoke access; only the owner can grant it (impersonate them to do so)."}
            </p>

            {error && <Alert>{error}</Alert>}

            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : (
                <ul className="flex flex-col gap-2 mb-4">
                    {members.length === 0 && <li className="text-sm text-text-muted">No grants on this mailbox yet.</li>}
                    {members.map((member) => (
                        <li
                            key={member.userOrRoleId}
                            className="flex items-center justify-between gap-3 py-2 px-3 border border-border rounded-sm"
                        >
                            <div>
                                <div className="text-sm font-medium">{member.userOrRoleId}</div>
                                <div className="text-xs text-text-muted">{roleLabel(member)}</div>
                                {member.noEffect && (
                                    <div className="text-xs text-danger mt-0.5">
                                        Not a user - this entry has no effect
                                        {shared ? " - replace it with the user it was meant for or remove it." : " - remove it."}
                                    </div>
                                )}
                            </div>
                            <span className="flex items-center gap-3 shrink-0">
                                {member.noEffect && shared && (
                                    <button
                                        type="button"
                                        onClick={() => setReplacing(member)}
                                        disabled={saving}
                                        className="text-sm text-primary-dark hover:underline disabled:opacity-55"
                                    >
                                        Replace with a user
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={() => setRevokeTarget(member.userOrRoleId)}
                                    disabled={saving}
                                    className="text-sm text-danger hover:underline disabled:opacity-55"
                                >
                                    Revoke
                                </button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            {shared && (
                <>
                    {currentUserUid && !isMember && !loading && (
                        <Button
                            type="button"
                            variant="secondary"
                            className="!w-auto mb-3"
                            disabled={saving}
                            onClick={() => void addMe(currentUserUid)}
                        >
                            Add me
                        </Button>
                    )}
                    <PrincipalPicker
                        key={replacing?.userOrRoleId ?? "new"}
                        mailboxUid={mailboxUid}
                        roleLabels={ROLE_LABELS}
                        initialPrincipal={replacing?.userOrRoleId}
                        defaultRole={replacing?.role === "manager" ? "manager" : "viewer"}
                        onGranted={handleGranted}
                        onCancel={replacing ? () => setReplacing(null) : undefined}
                    />
                </>
            )}

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
