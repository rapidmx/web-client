///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

export interface StringListFieldProps {
    label: string;
    /** Associates the label with the add-input via `htmlFor`/`id`, same as `FormField` — required so the
     * field is reachable via `getByLabelText()` in tests and by assistive tech, not just visually. */
    id: string;
    values: string[];
    onChange: (values: string[]) => void;
    placeholder?: string;
    emptyMessage?: string;
    disabled?: boolean;
}

/**
 * A plain, controlled add/remove list-of-strings editor — the same visual add-row/per-item-remove shape
 * `MemberListCard` already established for a `DistributionList`'s `memberAddresses`, but operating on a
 * local `value`/`onChange` pair rather than persisting itself via its own API call. `MemberListCard`
 * isn't reusable here as-is: `EscrowScope.holderUserUids` (at least one required) and
 * `Matter.custodianMailboxUids` (also non-empty) are both required *at creation time*, before there's any
 * uid yet to `PUT` against — this needs to compose into an ordinary create/edit form's own local state
 * instead, same as every other field on those forms.
 */
export default function StringListField({
    label,
    id,
    values,
    onChange,
    placeholder,
    emptyMessage = "None added yet.",
    disabled,
}: StringListFieldProps) {
    const [draft, setDraft] = useState("");

    /** Accepts either the "Add" button's own form submit or the input's Enter keydown — both just need
     * `preventDefault()` (submitting would otherwise reload the page; Enter would otherwise do nothing
     * harmful here, but is prevented for consistency). */
    function handleAdd(e: { preventDefault(): void }) {
        e.preventDefault();
        const trimmed = draft.trim();
        if (!trimmed || values.includes(trimmed)) {
            return;
        }
        onChange([...values, trimmed]);
        setDraft("");
    }

    function handleRemove(value: string) {
        onChange(values.filter((v) => v !== value));
    }

    return (
        <div className="mb-4">
            <label htmlFor={id} className="block text-sm font-semibold mb-1.5 text-text">
                {label}
            </label>

            <ul className="flex flex-col gap-2 mb-2">
                {values.length === 0 && <li className="text-sm text-text-muted">{emptyMessage}</li>}
                {values.map((value) => (
                    <li
                        key={value}
                        className="flex items-center justify-between gap-3 py-2 px-3 border border-border rounded-sm"
                    >
                        <span className="text-sm font-medium break-all">{value}</span>
                        <button
                            type="button"
                            onClick={() => handleRemove(value)}
                            disabled={disabled}
                            className="text-sm text-danger hover:underline disabled:opacity-55 shrink-0"
                        >
                            Remove
                        </button>
                    </li>
                ))}
            </ul>

            <div className="flex gap-2">
                <input
                    id={id}
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            handleAdd(e);
                        }
                    }}
                    placeholder={placeholder}
                    disabled={disabled}
                    className="flex-1 text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary"
                />
                <Button type="button" variant="secondary" disabled={disabled} className="!w-auto" onClick={handleAdd}>
                    Add
                </Button>
            </div>
        </div>
    );
}
