///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { ResolvedPrincipal } from "@rapidmx/react-shared/mail/mailboxAccessApi.js";
import PrincipalResolver, { describePerson } from "./PrincipalResolver.js";

export interface PrincipalListFieldProps {
    label: string;
    values: string[];
    onChange: (values: string[]) => void;
    /** Exact-match resolve call for what's typed - see `PrincipalResolver`. */
    resolve: (principal: string) => Promise<ResolvedPrincipal>;
    placeholder?: string;
    emptyMessage?: string;
    disabled?: boolean;
}

/**
 * A list-of-user-uids editor - the same visual list/per-item-remove shape `StringListField` established, but a
 * uid can only be ADDED by looking it up and confirming who it is first (`PrincipalResolver`), never typed
 * directly. Unlike `StringListField`'s free-text values (a distribution list's member addresses, a legal hold's
 * custodian MAILBOX uids - values nobody needs to be "looked up" as a person for), every value here is a PERSON's
 * user uid, granted a real role purely by what gets typed here - the exact "raw uid text field with no way to see
 * whose it is" gap this app closes everywhere else a person is assigned by identifier.
 *
 * An already-added uid is still shown as plain text (same as `StringListField`, and as `ShareAccessCard`'s own
 * member list) - it was already resolved and confirmed when it was added, so there is nothing left to look up.
 */
export default function PrincipalListField({ label, values, onChange, resolve, placeholder, emptyMessage = "None added yet.", disabled }: PrincipalListFieldProps) {
    function handleRemove(uid: string) {
        onChange(values.filter((v) => v !== uid));
    }

    return (
        <div className="mb-4">
            <span className="block text-sm font-semibold mb-1.5 text-text">{label}</span>

            <ul className="flex flex-col gap-2 mb-2">
                {values.length === 0 && (
                    <li key="empty" className="text-sm text-text-muted">
                        {emptyMessage}
                    </li>
                )}
                {values.map((uid) => (
                    <li key={uid} className="flex items-center justify-between gap-3 py-2 px-3 border border-border rounded-sm">
                        <span className="text-sm font-medium break-all">{uid}</span>
                        <button
                            type="button"
                            onClick={() => handleRemove(uid)}
                            disabled={disabled}
                            className="text-sm text-danger hover:underline disabled:opacity-55 shrink-0"
                        >
                            Remove
                        </button>
                    </li>
                ))}
            </ul>

            {!disabled && (
                <PrincipalResolver
                    resolve={resolve}
                    onResolved={(person) => {
                        if (!values.includes(person.userUid)) {
                            onChange([...values, person.userUid]);
                        }
                    }}
                    placeholder={placeholder ?? "Email address, username or user id"}
                    ariaLabel={label}
                    confirmLabel="Add"
                    confirmErrorMessage="Could not add this person."
                    describeConfirm={(person) => (
                        <>
                            Add <strong className="break-all">{describePerson(person)}</strong>?
                        </>
                    )}
                />
            )}
        </div>
    );
}
