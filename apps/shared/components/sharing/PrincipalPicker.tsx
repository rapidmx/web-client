///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    MailboxAccessRole,
    ResolvedPrincipal,
    resolveMailboxPrincipal,
    setMailboxAccess,
} from "@rapidmx/react-shared/mail/mailboxAccessApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

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

/** Who a resolved person is, for a person to check before saving: their name and address, else their uid. */
export function describePerson(person: ResolvedPrincipal): string {
    if (person.displayName && person.address) return `${person.displayName} <${person.address}>`;
    return person.displayName ?? person.address ?? `user ${person.userUid}`;
}

/**
 * "Who?" for a sharing screen. What is typed - a mailbox address, an auth-server username or e-mail alias, or a user id -
 * is RESOLVED by the server (`resolveMailboxPrincipal()`) to the person it names before anything is saved, and the person
 * is shown (name and address) for the caller to confirm; only then is the grant made, against that person's uid. Free text
 * is never stored: an ACL record matches a user uid and nothing else, so a grant to a typed username applies to nobody.
 */
export default function PrincipalPicker({ mailboxUid, roleLabels, initialPrincipal, defaultRole = "viewer", placeholder, onGranted, onCancel }: PrincipalPickerProps) {
    const [typed, setTyped] = useState(initialPrincipal ?? "");
    const [role, setRole] = useState<MailboxAccessRole>(defaultRole);
    const [person, setPerson] = useState<ResolvedPrincipal | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // A stored entry being replaced is looked up straight away, so its person is shown without a click.
    useEffect(() => {
        if (initialPrincipal) {
            void find(initialPrincipal);
        }
    }, [initialPrincipal]);

    async function find(principal: string) {
        setBusy(true);
        setError(null);
        setPerson(null);
        try {
            setPerson(await resolveMailboxPrincipal(mailboxUid, principal));
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not look that person up.");
        } finally {
            setBusy(false);
        }
    }

    function handleFind(e: FormEvent) {
        e.preventDefault();
        const principal = typed.trim();
        if (principal) {
            void find(principal);
        }
    }

    // Only reachable from the confirm button, which only renders once `person` is set.
    async function handleGrant() {
        setBusy(true);
        setError(null);
        try {
            await setMailboxAccess(mailboxUid, person!.userUid, role);
            await onGranted(person!, role);
            setTyped("");
            setPerson(null);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not grant access.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex flex-col gap-2">
            {error && <Alert>{error}</Alert>}
            <form onSubmit={handleFind} className="flex gap-2">
                <input
                    type="text"
                    aria-label="Who to share with"
                    placeholder={placeholder ?? "Email address, username or user id"}
                    className="flex-1 text-sm border border-border rounded-sm py-1.5 px-2 bg-surface text-text"
                    value={typed}
                    onChange={(e) => {
                        setTyped(e.target.value);
                        setPerson(null);
                    }}
                    disabled={busy}
                />
                <select
                    aria-label="Access level"
                    className="text-sm border border-border rounded-sm py-1.5 px-2 bg-surface text-text"
                    value={role}
                    onChange={(e) => setRole(e.target.value as MailboxAccessRole)}
                    disabled={busy}
                >
                    {(Object.keys(roleLabels) as MailboxAccessRole[]).map((value) => (
                        <option key={value} value={value}>
                            {roleLabels[value]}
                        </option>
                    ))}
                </select>
                <Button type="submit" variant="secondary" loading={busy && !person} disabled={busy} className="!w-auto">
                    Find
                </Button>
                {onCancel && (
                    <Button type="button" variant="text" className="!w-auto" onClick={onCancel}>
                        Cancel
                    </Button>
                )}
            </form>
            {person && (
                <div className="flex items-center justify-between gap-3 text-sm py-2 px-3 border border-border rounded-sm">
                    <span>
                        Share with <strong className="break-all">{describePerson(person)}</strong> as <em>{roleLabels[role]}</em>?
                    </span>
                    <Button type="button" loading={busy} disabled={busy} className="!w-auto" onClick={() => void handleGrant()}>
                        Grant
                    </Button>
                </div>
            )}
        </div>
    );
}
