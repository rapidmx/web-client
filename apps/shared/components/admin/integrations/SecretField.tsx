///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import Button from "../../../../../lib/components/buttons/Button.js";

export const INPUT_CLASS = "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export interface SecretFieldProps {
    id: string;
    /** The input's label. */
    label: string;
    /** How the buttons name the field ("Replace API key"). */
    name: string;
    /** What is saved now: nothing, a value saved here, or the deployment's. */
    saved: "none" | "here" | "deployment";
    /** A new value typed, `undefined` for none: what saving sends. */
    value: string | undefined;
    onChange: (value: string | undefined) => void;
    /** A file's content rather than a token: a text area. */
    multiLine?: boolean;
    /** The saved value is set but the server can't decrypt it (its key is gone from the keyring): it must be entered again. */
    unreadable?: boolean;
}

/**
 * A write-only credential. The server never sends a saved value back, so a saved one is shown only as "Set" (or "Set by this deployment") with a
 * Replace button; typing a value is what replaces it, and an empty field sends nothing. What is typed is never shown (a password field), and is not
 * offered for the browser to remember. One the server can't decrypt is "Set, but can't be read: enter it again": it is still there, but only a new value
 * helps.
 */
export default function SecretField({ id, label, name, saved, value, onChange, multiLine = false, unreadable = false }: SecretFieldProps) {
    const [replacing, setReplacing] = useState(false);

    if (saved !== "none" && !replacing) {
        return (
            <div className="flex items-center gap-3 text-sm">
                {unreadable ? (
                    <span className="font-medium text-danger">Set, but can't be read: enter it again</span>
                ) : (
                    <span className="font-medium">{saved === "here" ? "Set" : "Set by this deployment"}</span>
                )}
                <Button type="button" variant="text" className="text-xs" aria-label={`Replace ${name}`} onClick={() => setReplacing(true)}>
                    Replace
                </Button>
            </div>
        );
    }
    const change = (text: string) => onChange(text === "" ? undefined : text);
    return (
        <div className="flex flex-col gap-1">
            {multiLine ? (
                <textarea
                    id={id}
                    aria-label={label}
                    rows={6}
                    spellCheck={false}
                    autoComplete="off"
                    className={`${INPUT_CLASS} font-mono`}
                    value={value ?? ""}
                    onChange={(e) => change(e.target.value)}
                />
            ) : (
                <input
                    id={id}
                    aria-label={label}
                    type="password"
                    autoComplete="new-password"
                    className={INPUT_CLASS}
                    value={value ?? ""}
                    onChange={(e) => change(e.target.value)}
                />
            )}
            {saved !== "none" && (
                <Button
                    type="button"
                    variant="text"
                    className="!w-auto self-start text-xs"
                    aria-label={`Keep the saved ${name}`}
                    onClick={() => {
                        setReplacing(false);
                        onChange(undefined);
                    }}
                >
                    Keep the saved value
                </Button>
            )}
        </div>
    );
}
