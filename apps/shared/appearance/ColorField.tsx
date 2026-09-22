///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { isHexColor, normalizeHex } from "./color.js";

export interface ColorFieldProps {
    /** Unique in the page: the ids of the two inputs derive from it. */
    id: string;
    label: string;
    /** One line under the label saying what the colour is used for. */
    description: string;
    /** The colour the user chose, `#rrggbb`; `undefined` while they haven't. */
    value: string | undefined;
    /** What shows while unset: the colour the app has now. */
    current: string;
    /** Called with a new `#rrggbb` as the person picks or types one - on every change, so the app follows a drag on the picker. */
    onChange: (hex: string) => void;
    /** Called for "Reset": back to the app's own colour. Absent for a field with nothing to reset to. */
    onReset?: () => void;
}

/**
 * A colour to choose: the browser's colour picker beside a hex field (`#rrggbb`, and the short `#rgb` and a missing `#` are understood),
 * and a "Reset" that goes back to the app's own colour. A full `#rrggbb` is applied as it is typed, a short one when the field is left, and
 * something that isn't a colour changes nothing - the field says so and goes back to the current colour when it is left.
 */
export default function ColorField({ id, label, description, value, current, onChange, onReset }: ColorFieldProps) {
    // What is being typed, while it is: `null` shows the colour itself (after a pick, or once the field is left).
    const [draft, setDraft] = useState<string | null>(null);
    const shown = value ?? current;
    const invalid = draft !== null && normalizeHex(draft) === undefined;

    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="min-w-0 flex-1 basis-40">
                <label htmlFor={`${id}-hex`} className="block text-sm font-semibold text-text">
                    {label}
                </label>
                <p id={`${id}-description`} className="text-xs text-text-muted">
                    {description}
                </p>
            </div>
            <input
                type="color"
                aria-label={`${label} picker`}
                value={shown}
                onChange={(event) => {
                    setDraft(null);
                    // A colour input only ever holds a `#rrggbb` (the browser sanitises anything else to black).
                    onChange(normalizeHex(event.target.value) as string);
                }}
                className="h-9 w-12 shrink-0 cursor-pointer rounded-sm border border-border bg-surface p-0.5"
            />
            <div className="w-28 shrink-0">
                <input
                    id={`${id}-hex`}
                    type="text"
                    inputMode="text"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={7}
                    value={draft ?? shown}
                    aria-invalid={invalid || undefined}
                    aria-describedby={invalid ? `${id}-error ${id}-description` : `${id}-description`}
                    onChange={(event) => {
                        setDraft(event.target.value);
                        // Only a complete `#rrggbb` (the hash is optional) is applied while typing: `#1a2` on the way to `#1a2b3c` would flash `#11aa22`.
                        const typed = event.target.value.trim();
                        if (isHexColor(typed.startsWith("#") ? typed : "#" + typed)) {
                            onChange(normalizeHex(typed) as string);
                        }
                    }}
                    onBlur={() => {
                        // Leaving the field applies a short form (`#abc`) that was typed, and drops anything that isn't a colour.
                        const hex = draft === null ? undefined : normalizeHex(draft);
                        if (hex && hex !== shown) {
                            onChange(hex);
                        }
                        setDraft(null);
                    }}
                    className="w-full rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text"
                />
            </div>
            {onReset && (
                <button
                    type="button"
                    onClick={() => {
                        setDraft(null);
                        onReset();
                    }}
                    disabled={value === undefined}
                    aria-label={`Reset ${label.toLowerCase()} to the default`}
                    className="shrink-0 rounded-sm px-2 py-1.5 text-sm font-semibold text-accent-dark hover:not-disabled:underline disabled:cursor-not-allowed disabled:opacity-50"
                >
                    Reset
                </button>
            )}
            {invalid && (
                <p id={`${id}-error`} role="alert" className="basis-full text-xs text-danger">
                    Use a colour like #1a2b3c.
                </p>
            )}
        </div>
    );
}
