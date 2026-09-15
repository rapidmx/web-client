///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ChangeEvent, KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HiOutlineXMark } from "react-icons/hi2";
import {
    fetchRecipientSuggestions,
    RECIPIENT_SUGGESTION_MIN_QUERY_LENGTH,
    type ContactSuggestionOptions,
    type RecipientSuggestion,
    type RecipientSuggestionKind,
} from "@rapidmx/react-shared/mail/directoryApi.js";
import { formatRecipient, isValidRecipientAddress, parseRecipient, splitRecipientList, splitTypedRecipients } from "./recipients.js";

/** How long typing must pause before suggestions are requested. */
export const RECIPIENT_SUGGESTION_DEBOUNCE_MS = 150;

const KIND_LABELS: Record<RecipientSuggestionKind, string> = {
    contact: "Contact",
    user: "Person",
    shared: "Shared mailbox",
    room: "Room",
    equipment: "Equipment",
    list: "Group",
};

export interface RecipientInputProps {
    /** The input's id, which the field's `<label htmlFor>` names. Also prefixes the listbox and option ids. */
    id: string;
    /** The field's name ("To", "Cc", "Bcc"), used in the recipient list's and suggestions' accessible names. */
    label: string;
    /** The field's text: recipients separated by commas, as `parseRecipientList()` reads it. */
    value: string;
    onChange: (value: string) => void;
    /** Called with the field's text when focus leaves the input. */
    onBlur?: (value: string) => void;
    /** Called with the field's text after a suggestion is picked (focus stays in the input). */
    onCommit?: (value: string) => void;
    /** The mailbox being composed from, whose contacts are suggested too. */
    mailboxUid?: string;
    /** Loads suggestions; defaults to react-shared's `fetchRecipientSuggestions()`. */
    fetchSuggestions?: (query: string, options: ContactSuggestionOptions) => Promise<RecipientSuggestion[]>;
    debounceMs?: number;
    disabled?: boolean;
}

interface DropdownPosition {
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
}

/** Where the suggestions go: under the field (or above it when there's much more room there), as wide as the field. */
function dropdownPosition(anchor: HTMLElement): DropdownPosition {
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(Math.max(rect.width, 260), window.innerWidth - margin * 2);
    const left = Math.min(Math.max(rect.left, margin), window.innerWidth - width - margin);
    const below = window.innerHeight - rect.bottom - margin;
    const above = rect.top - margin;
    if (below < 160 && above > below) {
        return { left, width, bottom: window.innerHeight - rect.top + 2, maxHeight: Math.min(320, above) };
    }
    return { left, width, top: rect.bottom + 2, maxHeight: Math.max(120, Math.min(320, below)) };
}

/**
 * A To/Cc/Bcc field: committed recipients as removable chips, and a WAI-ARIA combobox for the one being typed that
 * suggests the caller's contacts and the server directory (contacts first, one entry per address). The field's value is
 * still plain text (recipients separated by commas), so drafts, autosave and sending read it as before.
 *
 * Typing a comma or semicolon (outside a quoted name or angle brackets), pressing Enter, or leaving the field turns the
 * typed text into a chip; pasted lists split the same way. Suggestions load `debounceMs` after typing pauses, for at
 * least two characters, and a newer query aborts an older request. Arrow keys move through them, Enter or Tab picks
 * one (as `Name <address>`), Escape closes them, and Backspace in an empty input removes the last chip.
 */
export default function RecipientInput({
    id,
    label,
    value,
    onChange,
    onBlur,
    onCommit,
    mailboxUid,
    fetchSuggestions = fetchRecipientSuggestions,
    debounceMs = RECIPIENT_SUGGESTION_DEBOUNCE_MS,
    disabled,
}: RecipientInputProps) {
    const [pending, setPending] = useState("");
    const [suggestions, setSuggestions] = useState<RecipientSuggestion[]>([]);
    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const [position, setPosition] = useState<DropdownPosition | null>(null);
    const anchorRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const fetchRef = useRef(fetchSuggestions);
    fetchRef.current = fetchSuggestions;

    const tokens = splitRecipientList(value);
    const pendingText = pending.trim();
    // The typed text is the value's last recipient; a value changed from outside that doesn't end with it drops it.
    const pendingActive = pendingText !== "" && tokens[tokens.length - 1] === pendingText;
    const chips = pendingActive ? tokens.slice(0, -1) : tokens;
    const inputValue = pendingActive ? pending : "";
    const query = pendingActive ? pendingText : "";
    const listboxId = `${id}-suggestions`;
    const optionId = (index: number) => `${id}-suggestion-${index}`;

    useEffect(() => {
        if (pending !== "" && !pendingActive) {
            setPending("");
        }
    }, [pending, pendingActive]);

    const committedAddresses = new Set(chips.map((chip) => parseRecipient(chip).address.toLowerCase()));
    const visible = suggestions.filter((suggestion) => !committedAddresses.has(suggestion.address.toLowerCase()));
    const expanded = open && visible.length > 0 && query.length >= RECIPIENT_SUGGESTION_MIN_QUERY_LENGTH;
    const active = Math.min(activeIndex, visible.length - 1);

    useEffect(() => {
        if (query.length < RECIPIENT_SUGGESTION_MIN_QUERY_LENGTH) {
            setSuggestions([]);
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => {
            fetchRef.current(query, { mailboxUid, signal: controller.signal }).then(
                (result) => {
                    if (!controller.signal.aborted) {
                        setSuggestions(result);
                        setActiveIndex(0);
                    }
                },
                () => {
                    if (!controller.signal.aborted) {
                        setSuggestions([]);
                    }
                },
            );
        }, debounceMs);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [query, mailboxUid, debounceMs]);

    useLayoutEffect(() => {
        if (!expanded) {
            return;
        }
        const anchor = anchorRef.current!;
        const update = () => setPosition(dropdownPosition(anchor));
        update();
        window.addEventListener("resize", update);
        window.addEventListener("scroll", update, true);
        return () => {
            window.removeEventListener("resize", update);
            window.removeEventListener("scroll", update, true);
        };
    }, [expanded]);

    useEffect(() => {
        if (expanded) {
            document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
        }
    });

    function emit(nextChips: string[], nextPending: string) {
        onChange([...nextChips, nextPending.trim()].filter((part) => part.length > 0).join(", "));
    }

    function handleInputChange(e: ChangeEvent<HTMLInputElement>) {
        const { finished, rest } = splitTypedRecipients(e.target.value);
        const nextPending = rest.replace(/^\s+/, "");
        setPending(nextPending);
        setOpen(true);
        emit([...chips, ...finished], nextPending);
    }

    function commitPending(): string {
        const next = [...chips, pendingText].filter((part) => part.length > 0).join(", ");
        setPending("");
        setOpen(false);
        return next;
    }

    function select(suggestion: RecipientSuggestion) {
        const next = [...chips, formatRecipient({ address: suggestion.address, displayName: suggestion.displayName || undefined })].join(", ");
        setPending("");
        setOpen(false);
        setSuggestions([]);
        onChange(next);
        onCommit?.(next);
    }

    function removeChip(index: number) {
        emit(
            chips.filter((_, i) => i !== index),
            inputValue,
        );
        inputRef.current?.focus();
    }

    function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
        switch (e.key) {
            case "ArrowDown":
            case "ArrowUp": {
                if (visible.length === 0) {
                    return;
                }
                e.preventDefault();
                if (!expanded) {
                    setOpen(true);
                    setActiveIndex(e.key === "ArrowDown" ? 0 : visible.length - 1);
                    return;
                }
                const step = e.key === "ArrowDown" ? 1 : -1;
                setActiveIndex((active + step + visible.length) % visible.length);
                return;
            }
            case "Enter":
                if (expanded) {
                    e.preventDefault();
                    select(visible[active]);
                } else if (pendingText) {
                    e.preventDefault();
                    const next = commitPending();
                    onCommit?.(next);
                }
                return;
            case "Tab":
                if (expanded && !e.shiftKey) {
                    e.preventDefault();
                    select(visible[active]);
                }
                return;
            case "Escape":
                if (expanded) {
                    e.preventDefault();
                    e.stopPropagation();
                    setOpen(false);
                }
                return;
            case "Backspace":
                if (inputValue === "" && chips.length > 0) {
                    e.preventDefault();
                    emit(chips.slice(0, -1), "");
                }
                return;
        }
    }

    function handleBlur() {
        const next = commitPending();
        onBlur?.(next);
    }

    return (
        <div ref={anchorRef} className="flex-1 min-w-0 flex flex-wrap items-center gap-1">
            {chips.length > 0 && (
                <ul role="list" aria-label={`${label} recipients`} className="contents">
                    {chips.map((chip, index) => {
                        const recipient = parseRecipient(chip);
                        const valid = isValidRecipientAddress(recipient.address);
                        const name = recipient.displayName || recipient.address;
                        return (
                            <li
                                key={`${index}-${chip}`}
                                title={chip}
                                className={`flex items-center gap-1 max-w-full min-w-0 rounded-pill border pl-2 pr-0.5 py-px text-xs ${
                                    valid ? "bg-surface-alt border-border text-text" : "bg-danger-bg border-danger text-danger"
                                }`}
                            >
                                <span className="truncate">{name}</span>
                                {!valid && <span className="sr-only"> (not a valid email address)</span>}
                                <button
                                    type="button"
                                    tabIndex={-1}
                                    aria-label={`Remove ${recipient.address}`}
                                    disabled={disabled}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => removeChip(index)}
                                    className="shrink-0 w-4 h-4 flex items-center justify-center rounded-pill text-text-muted hover:bg-border hover:text-text"
                                >
                                    <HiOutlineXMark size={10} />
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
            <input
                ref={inputRef}
                id={id}
                type="text"
                role="combobox"
                autoComplete="off"
                aria-autocomplete="list"
                aria-expanded={expanded}
                aria-controls={listboxId}
                aria-activedescendant={expanded ? optionId(active) : undefined}
                disabled={disabled}
                className="flex-1 min-w-[6rem] text-sm bg-transparent outline-none py-0.5"
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
            />
            <span className="sr-only" aria-live="polite">
                {expanded ? `${visible.length} ${visible.length === 1 ? "suggestion" : "suggestions"}` : ""}
            </span>
            {expanded &&
                position &&
                createPortal(
                    <ul
                        id={listboxId}
                        role="listbox"
                        aria-label={`${label} suggestions`}
                        onMouseDown={(e) => e.preventDefault()}
                        style={{ position: "fixed", left: position.left, width: position.width, top: position.top, bottom: position.bottom, maxHeight: position.maxHeight }}
                        className="z-[60] overflow-y-auto bg-surface border border-border rounded-md shadow-modal py-1"
                    >
                        {visible.map((suggestion, index) => (
                            <li
                                key={`${index}-${suggestion.address}`}
                                id={optionId(index)}
                                role="option"
                                aria-selected={index === active}
                                onMouseDown={(e) => e.preventDefault()}
                                onMouseEnter={() => setActiveIndex(index)}
                                onClick={() => select(suggestion)}
                                className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer ${index === active ? "bg-primary/10" : ""}`}
                            >
                                <span className="flex-1 min-w-0">
                                    <span className="block truncate text-sm text-text">{suggestion.displayName || suggestion.address}</span>
                                    {suggestion.displayName && <span className="block truncate text-xs text-text-muted">{suggestion.address}</span>}
                                </span>
                                <span className="shrink-0 text-[11px] leading-4 px-1.5 rounded-pill bg-surface-alt text-text-muted">
                                    {KIND_LABELS[suggestion.kind] ?? "Directory"}
                                </span>
                            </li>
                        ))}
                    </ul>,
                    document.body,
                )}
        </div>
    );
}
