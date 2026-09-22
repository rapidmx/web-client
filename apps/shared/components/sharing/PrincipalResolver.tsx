///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { KeyboardEvent, ReactNode, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { ResolvedPrincipal } from "@rapidmx/react-shared/mail/mailboxAccessApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

export interface PrincipalResolverProps {
    /** Resolves what was typed - a mailbox address, an auth-server username or e-mail alias, or a user uid - to
     * the one person it names, exact match only. Rejects (typically with an `ApiRequestError`) for nobody. */
    resolve: (principal: string) => Promise<ResolvedPrincipal>;
    /** Called once the caller confirms the resolved person is the right one. The box is cleared once this
     * resolves - throw (or reject) to keep the person on screen and show an error instead. */
    onResolved: (person: ResolvedPrincipal) => void | Promise<void>;
    /** Text put in the box to start with - a stored entry being replaced, say - looked up automatically on mount. */
    initialPrincipal?: string;
    /** What the box asks for. */
    placeholder: string;
    /** The box's accessible name. */
    ariaLabel: string;
    /** Extra controls rendered between the text box and the Find button (e.g. a role selector). */
    children?: ReactNode;
    /** The confirm button's label (e.g. "Grant", "Use this owner"). */
    confirmLabel: string;
    /** What the confirmation row says once a person is found - e.g. "Share with X as Y?". */
    describeConfirm: (person: ResolvedPrincipal) => ReactNode;
    /** Shown if `onResolved` rejects, unless it was an `ApiRequestError` (then its own message is shown). */
    confirmErrorMessage: string;
    /** Shown as a Cancel button next to the box when set (replacing an entry). */
    onCancel?: () => void;
}

/** Who a resolved person is, for a person to check before confirming: their name and address, else their uid. */
export function describePerson(person: ResolvedPrincipal): string {
    if (person.displayName && person.address) return `${person.displayName} <${person.address}>`;
    return person.displayName ?? person.address ?? `user ${person.userUid}`;
}

/**
 * "Who?" - anywhere a person is assigned by typed identifier rather than picked from an already-loaded list. What
 * is typed is RESOLVED by the server (`resolve`) to the person it names before anything is saved, and the person is
 * shown (name and address) for the caller to confirm; only `onResolved` ever sees the resolved, verified person -
 * never the free text. This is deliberately exact-match, type-then-confirm - never a live/fuzzy search-as-you-type
 * autocomplete, which would let anyone with access to the field enumerate the user directory by partial name.
 *
 * Parameterized entirely by `resolve`/`onResolved` (and the wording props) so every caller - mailbox sharing
 * (`PrincipalPicker`, a thin wrapper around this component), mailbox ownership, escrow-scope holders, ... - reuses
 * the same resolve-then-confirm UX and privacy posture rather than each reimplementing it.
 *
 * Deliberately renders no `<form>` of its own (Enter-to-find is wired up by hand instead, see `handleKeyDown()`) -
 * some callers (`MailboxCreateForm`) use this as one field of their own, larger `<form>`, and a nested `<form>` is
 * invalid HTML that real browsers mis-handle (an inner Enter keypress can submit the wrong one).
 */
export default function PrincipalResolver({
    resolve,
    onResolved,
    initialPrincipal,
    placeholder,
    ariaLabel,
    children,
    confirmLabel,
    describeConfirm,
    confirmErrorMessage,
    onCancel,
}: PrincipalResolverProps) {
    const [typed, setTyped] = useState(initialPrincipal ?? "");
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
            setPerson(await resolve(principal));
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not look that person up.");
        } finally {
            setBusy(false);
        }
    }

    function submitFind() {
        const principal = typed.trim();
        if (principal) {
            void find(principal);
        }
    }

    /** Enter in the text box finds, same as clicking the button - handled here (not a native `<form>` submit,
     * see this component's own doc comment on why) so it works whether or not a caller nests this inside one of
     * their own forms (`MailboxCreateForm` does). */
    function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
        if (e.key === "Enter") {
            // Stops the keystroke from also submitting an ANCESTOR `<form>` this component happens to be nested in.
            e.preventDefault();
            submitFind();
        }
    }

    // Only reachable from the confirm button, which only renders once `person` is set.
    async function handleConfirm() {
        setBusy(true);
        setError(null);
        try {
            await onResolved(person!);
            setTyped("");
            setPerson(null);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : confirmErrorMessage);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex flex-col gap-2">
            {error && <Alert>{error}</Alert>}
            <div className="flex gap-2">
                <input
                    type="text"
                    aria-label={ariaLabel}
                    placeholder={placeholder}
                    className="flex-1 text-sm border border-border rounded-sm py-1.5 px-2 bg-surface text-text"
                    value={typed}
                    onChange={(e) => {
                        setTyped(e.target.value);
                        setPerson(null);
                    }}
                    onKeyDown={handleKeyDown}
                    disabled={busy}
                />
                {children}
                <Button type="button" variant="secondary" loading={busy && !person} disabled={busy} className="!w-auto" onClick={submitFind}>
                    Find
                </Button>
                {onCancel && (
                    <Button type="button" variant="text" className="!w-auto" onClick={onCancel}>
                        Cancel
                    </Button>
                )}
            </div>
            {person && (
                <div className="flex items-center justify-between gap-3 text-sm py-2 px-3 border border-border rounded-sm">
                    <span>{describeConfirm(person)}</span>
                    <Button type="button" loading={busy} disabled={busy} className="!w-auto" onClick={() => void handleConfirm()}>
                        {confirmLabel}
                    </Button>
                </div>
            )}
        </div>
    );
}
