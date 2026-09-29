///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { parseTimeInput } from "./timePicker.js";

export interface TimeOption {
    value: string;
    label: string;
    /** Said after the label, muted: the length of the event an end time makes. */
    hint?: string;
}

export interface TimeComboBoxProps {
    "aria-label": string;
    /** The time being shown, as it reads in the field. */
    display: string;
    /** The `value` of the option that is the current one, if any of them is. */
    current?: string;
    options: TimeOption[];
    /** An option was picked. */
    onSelect: (value: string) => void;
    /** A time was typed (`HH:mm`, already understood). */
    onType: (time: string) => void;
    className?: string;
}

/**
 * A time field that is a text box and a menu at once: focusing it opens a list of times to pick from, and whatever is typed instead - "3:45pm", "1530" -
 * is understood when the field is left or Enter is pressed (and put back as it was when it isn't a time, or on Escape). The list follows the arrow keys.
 */
export default function TimeComboBox({ "aria-label": label, display, current, options, onSelect, onType, className }: TimeComboBoxProps) {
    const listId = useId();
    const [draft, setDraft] = useState<string | null>(null);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(-1);
    const selectedRef = useRef<HTMLLIElement>(null);

    // Opening puts the current time in view, as the middle of the list.
    useEffect(() => {
        if (open) {
            selectedRef.current?.scrollIntoView?.({ block: "center" });
        }
    }, [open]);

    function close() {
        setOpen(false);
        setActive(-1);
        setDraft(null);
    }

    function commitDraft() {
        const time = draft === null ? null : parseTimeInput(draft);
        if (time !== null) {
            onType(time);
        }
        close();
    }

    function pick(value: string) {
        onSelect(value);
        close();
    }

    function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            setActive((index) => {
                const from = index < 0 ? options.findIndex((option) => option.value === current) : index;
                return Math.min(Math.max(from + (event.key === "ArrowDown" ? 1 : -1), 0), options.length - 1);
            });
        } else if (event.key === "Enter") {
            // Never the form's own submit: Enter here settles the time.
            event.preventDefault();
            if (open && active >= 0) {
                pick(options[active].value);
            } else {
                commitDraft();
            }
        } else if (event.key === "Escape" && open) {
            event.stopPropagation();
            close();
        }
    }

    return (
        <div className="relative">
            <input
                type="text"
                role="combobox"
                aria-label={label}
                aria-expanded={open}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
                autoComplete="off"
                className={className}
                value={draft ?? display}
                onClick={() => setOpen(true)}
                onFocus={(event) => {
                    event.currentTarget.select();
                    setOpen(true);
                }}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitDraft}
                onKeyDown={handleKeyDown}
            />
            {open && (
                <ul
                    id={listId}
                    role="listbox"
                    aria-label={`${label} options`}
                    className="absolute left-0 top-full z-30 mt-1 max-h-56 w-44 overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-lg"
                >
                    {options.map((option, index) => (
                        <li
                            key={option.value}
                            id={`${listId}-${index}`}
                            ref={option.value === current ? selectedRef : undefined}
                            role="option"
                            aria-selected={option.value === current}
                            // Before the field's own blur, which would otherwise close the list and swallow the click.
                            onMouseDown={(event) => {
                                event.preventDefault();
                                pick(option.value);
                            }}
                            className={[
                                "flex cursor-pointer items-baseline gap-1.5 px-3 py-1.5 text-sm hover:bg-surface-alt",
                                option.value === current ? "font-semibold text-primary-dark" : "",
                                index === active ? "bg-surface-alt" : "",
                            ].join(" ")}
                        >
                            {option.label}
                            {option.hint && <span className="text-xs font-normal text-text-muted">{option.hint}</span>}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
