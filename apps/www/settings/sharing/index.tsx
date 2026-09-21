///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { routedPage } from "../../_routedPage.js";
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    MailboxAccessMember,
    MailboxAccessRole,
    listMailboxAccess,
    lookupMailboxOwnerByEmail,
    removeMailboxAccess,
    setMailboxAccess,
} from "@rapidmx/react-shared/mail/mailboxAccessApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../shared/components/settings/layout/SettingsShell.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import { SkeletonList } from "@rapidmx/react-shared/components/feedback/Skeleton.js";

const ROLE_LABELS: Record<MailboxAccessRole, string> = { viewer: "Can view", manager: "Can manage" };

export type SettingsSharingPageProps = Omit<SettingsShellProps, "active">;

function SettingsSharingPage(props: SettingsSharingPageProps) {
    return (
        <SettingsShell {...props} active="sharing">
            <SharingContent />
        </SettingsShell>
    );
}

type Status = "loading" | "ready" | "forbidden" | "error";

/**
 * Manages who else can access whichever mailbox Settings is currently scoped to (the ambient mailbox from
 * `useSettingsShell()`'s own switcher, which already lists every mailbox the caller can reach, shared ones
 * included) - not just for shared/ownerless mailboxes specifically, matching every other settings page's
 * own mailbox-agnostic design. A single grant here already cascades to that mailbox's calendar/contacts/
 * tasks/mail folders (see `@rapidmx/restapi`'s `BaseMailboxAccessRoute` doc comment), so there is nothing
 * else to configure per data type.
 */
function SharingContent() {
    const { mailboxUid, mailboxes } = useSettingsShell();
    const mailbox = mailboxes.find((mb) => mb.uid === mailboxUid);

    const [members, setMembers] = useState<MailboxAccessMember[]>([]);
    const [status, setStatus] = useState<Status>("loading");
    const [error, setError] = useState<string | null>(null);

    const [emailInput, setEmailInput] = useState("");
    const [newRole, setNewRole] = useState<MailboxAccessRole>("viewer");
    const [adding, setAdding] = useState(false);
    const [addError, setAddError] = useState<string | null>(null);

    const [pendingRoleChange, setPendingRoleChange] = useState<string | null>(null);
    const [removeTarget, setRemoveTarget] = useState<MailboxAccessMember | null>(null);
    const [removing, setRemoving] = useState(false);

    // `SettingsShell` only ever renders its children once `mailboxUid` has resolved (a mailbox-less caller
    // gets `<MailboxProvisioning />` instead) - same established precedent as the Labels/Focused Inbox
    // settings pages, so none of the handlers below need their own `!mailboxUid` guard.
    function reload() {
        setStatus("loading");
        setError(null);
        listMailboxAccess(mailboxUid!)
            .then((result) => {
                setMembers(result);
                setStatus("ready");
            })
            .catch((err) => {
                // A 403 here is the live, server-verified "can this caller manage this mailbox's sharing"
                // signal - the same permission threshold (ACLAction.UPDATE) this route itself requires, so
                // no separate probe call is needed to decide which state to render.
                if (err instanceof ApiRequestError && err.status === 403) {
                    setStatus("forbidden");
                    return;
                }
                setError(err instanceof ApiRequestError ? err.message : "Could not load sharing settings.");
                setStatus("error");
            });
    }

    useEffect(reload, [mailboxUid]);

    async function handleAdd(e: FormEvent) {
        e.preventDefault();
        const email = emailInput.trim();
        if (!email) {
            return;
        }
        setAddError(null);
        setAdding(true);
        try {
            const found = await lookupMailboxOwnerByEmail(email);
            if (!found) {
                setAddError("No one found with that email on this platform.");
                return;
            }
            await setMailboxAccess(mailboxUid!, found.userUid, newRole);
            setEmailInput("");
            setNewRole("viewer");
            reload();
        } catch (err) {
            setAddError(err instanceof ApiRequestError ? err.message : "Could not grant access.");
        } finally {
            setAdding(false);
        }
    }

    async function handleRoleChange(userOrRoleId: string, role: MailboxAccessRole) {
        setPendingRoleChange(userOrRoleId);
        setError(null);
        try {
            await setMailboxAccess(mailboxUid!, userOrRoleId, role);
            reload();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not update this member's role.");
        } finally {
            setPendingRoleChange(null);
        }
    }

    function closeRemoveModal() {
        setRemoveTarget(null);
    }

    async function handleRemove() {
        // Only reachable from the confirm modal's own "Remove" button, and `Modal` renders nothing at all
        // unless `removeTarget` is set, so `removeTarget` is always non-null here.
        setRemoving(true);
        setError(null);
        try {
            await removeMailboxAccess(mailboxUid!, removeTarget!.userOrRoleId);
            setRemoveTarget(null);
            reload();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not remove this member.");
        } finally {
            setRemoving(false);
        }
    }

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-xl flex flex-col gap-6">
                <div>
                    <h1 className="text-lg font-bold tracking-tight mb-1">Sharing</h1>
                    <p className="text-sm text-text-muted">
                        Manage who else can access {mailbox?.displayName ?? "this mailbox"}&rsquo;s mail, calendar,
                        contacts, and tasks. Granting access here covers all of it at once - there&rsquo;s nothing
                        else to configure per data type.
                    </p>
                </div>

                {status === "loading" && <SkeletonList count={3} />}

                {status === "forbidden" && (
                    <Alert>You don&rsquo;t have permission to manage sharing for this mailbox.</Alert>
                )}

                {status === "error" && error && <Alert>{error}</Alert>}

                {status === "ready" && (
                    <>
                        {error && <Alert>{error}</Alert>}

                        <div>
                            <h2 className="text-sm font-semibold mb-2">People with access</h2>
                            {members.length === 0 ? (
                                <p className="text-sm text-text-muted">No one else has access to this mailbox yet.</p>
                            ) : (
                                <ul className="flex flex-col gap-2">
                                    {members.map((member) => (
                                        <li
                                            key={member.userOrRoleId}
                                            className="flex items-center justify-between gap-3 text-sm py-1.5 px-3 bg-surface-alt rounded-sm"
                                        >
                                            <span className="truncate">{member.userOrRoleId}</span>
                                            <span className="flex items-center gap-2 shrink-0">
                                                <select
                                                    aria-label={`Role for ${member.userOrRoleId}`}
                                                    className="text-sm border border-border rounded-sm py-1 px-2 bg-surface"
                                                    value={member.role}
                                                    disabled={pendingRoleChange === member.userOrRoleId}
                                                    onChange={(e) =>
                                                        handleRoleChange(member.userOrRoleId, e.target.value as MailboxAccessRole)
                                                    }
                                                >
                                                    {/* Access granted outside this page can't be set here, only replaced by a
                                                        standard role. */}
                                                    {member.role === "custom" && (
                                                        <option value="custom" disabled>
                                                            Custom access
                                                        </option>
                                                    )}
                                                    {(Object.keys(ROLE_LABELS) as MailboxAccessRole[]).map((role) => (
                                                        <option key={role} value={role}>
                                                            {ROLE_LABELS[role]}
                                                        </option>
                                                    ))}
                                                </select>
                                                <Button
                                                    type="button"
                                                    variant="text"
                                                    className="!w-auto text-danger"
                                                    onClick={() => setRemoveTarget(member)}
                                                >
                                                    Remove
                                                </Button>
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>

                        <form onSubmit={handleAdd} className="flex flex-col gap-2">
                            <h2 className="text-sm font-semibold">Add someone</h2>
                            {addError && <Alert>{addError}</Alert>}
                            <div className="flex gap-2">
                                <input
                                    type="email"
                                    aria-label="Email address"
                                    placeholder="Email address"
                                    className="flex-1 text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                                    value={emailInput}
                                    onChange={(e) => setEmailInput(e.target.value)}
                                    disabled={adding}
                                />
                                <select
                                    aria-label="Role to grant"
                                    className="text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                                    value={newRole}
                                    onChange={(e) => setNewRole(e.target.value as MailboxAccessRole)}
                                    disabled={adding}
                                >
                                    {(Object.keys(ROLE_LABELS) as MailboxAccessRole[]).map((role) => (
                                        <option key={role} value={role}>
                                            {ROLE_LABELS[role]}
                                        </option>
                                    ))}
                                </select>
                                <Button type="submit" loading={adding} disabled={adding} className="!w-auto">
                                    Add
                                </Button>
                            </div>
                        </form>
                    </>
                )}

                <Modal open={!!removeTarget} onClose={closeRemoveModal} title="Remove access">
                    <p className="text-sm mb-5">
                        {removeTarget?.userOrRoleId} will no longer be able to access {mailbox?.displayName ?? "this mailbox"}.
                    </p>
                    <div className="flex gap-3 justify-end">
                        <Button type="button" variant="secondary" className="!w-auto" disabled={removing} onClick={closeRemoveModal}>
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger"
                            loading={removing}
                            disabled={removing}
                            onClick={handleRemove}
                        >
                            Remove
                        </Button>
                    </div>
                </Modal>
            </div>
        </div>
    );
}

export default routedPage("/settings/sharing", SettingsSharingPage);
