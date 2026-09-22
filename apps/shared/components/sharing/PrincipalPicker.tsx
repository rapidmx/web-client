///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import {
    MailboxAccessRole,
    ResolvedPrincipal,
    resolveMailboxPrincipal,
    setMailboxAccess,
} from "@rapidmx/react-shared/mail/mailboxAccessApi.js";
import PrincipalResolver, { describePerson } from "./PrincipalResolver.js";

export { describePerson };

export interface PrincipalPickerProps {
    mailboxUid: string;
    /** What each access level is called on this page. */
    roleLabels: Record<MailboxAccessRole, string>;
    /** Text put in the box to start with - a stored entry being replaced, say. */
    initialPrincipal?: string;
    /** The access level pre-selected. */
    defaultRole?: MailboxAccessRole;
    /** What the box asks for. */
    placeholder?: string;
    /** Called once the grant is saved, with the person it went to. */
    onGranted: (person: ResolvedPrincipal, role: MailboxAccessRole) => void | Promise<void>;
    /** Shown as a Cancel button next to the box when set (replacing an entry). */
    onCancel?: () => void;
}

/**
 * "Who?" for a sharing screen - a thin wrapper around the general `PrincipalResolver`, supplying mailbox sharing's
 * own resolve call (`resolveMailboxPrincipal()`), its role selector, and its grant action (`setMailboxAccess()`).
 * What is typed - a mailbox address, an auth-server username or e-mail alias, or a user id - is RESOLVED by the
 * server before anything is saved, and the person is shown (name and address) for the caller to confirm; only then
 * is the grant made, against that person's uid. Free text is never stored: an ACL record matches a user uid and
 * nothing else, so a grant to a typed username applies to nobody.
 */
export default function PrincipalPicker({ mailboxUid, roleLabels, initialPrincipal, defaultRole = "viewer", placeholder, onGranted, onCancel }: PrincipalPickerProps) {
    const [role, setRole] = useState<MailboxAccessRole>(defaultRole);

    return (
        <PrincipalResolver
            resolve={(principal) => resolveMailboxPrincipal(mailboxUid, principal)}
            onResolved={async (person) => {
                await setMailboxAccess(mailboxUid, person.userUid, role);
                await onGranted(person, role);
            }}
            initialPrincipal={initialPrincipal}
            placeholder={placeholder ?? "Email address, username or user id"}
            ariaLabel="Who to share with"
            confirmLabel="Grant"
            confirmErrorMessage="Could not grant access."
            describeConfirm={(person) => (
                <>
                    Share with <strong className="break-all">{describePerson(person)}</strong> as <em>{roleLabels[role]}</em>?
                </>
            )}
            onCancel={onCancel}
        >
            <select
                aria-label="Access level"
                className="text-sm border border-border rounded-sm py-1.5 px-2 bg-surface text-text"
                value={role}
                onChange={(e) => setRole(e.target.value as MailboxAccessRole)}
            >
                {(Object.keys(roleLabels) as MailboxAccessRole[]).map((value) => (
                    <option key={value} value={value}>
                        {roleLabels[value]}
                    </option>
                ))}
            </select>
        </PrincipalResolver>
    );
}
