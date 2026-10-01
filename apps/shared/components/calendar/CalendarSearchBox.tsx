///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { HiOutlineChevronDown, HiOutlineChevronUp, HiOutlineMagnifyingGlass, HiOutlineXMark } from "react-icons/hi2";

export interface CalendarSearchBoxProps {
    value: string;
    onChange: (value: string) => void;
    /** Enter: run the search now rather than after the typing pause (and, when it has already run, step on to the next result). */
    onSubmit: (backwards: boolean) => void;
    /** The clear button or Escape: leave search mode. */
    onClear: () => void;
    onPrevious: () => void;
    onNext: () => void;
    /** Whether a search is running (its query is not blank); the result count and stepping buttons show only then. */
    active: boolean;
    /** How many occurrences match. */
    count: number;
    /** The current result's place in the list (0-based), `-1` when none is current. */
    position: number;
    inputRef?: React.Ref<HTMLInputElement>;
}

/** The text announced (and, compactly, shown) for a search's results. */
export function searchStatusText(count: number, position: number): string {
    if (count === 0) {
        return "No matches";
    }
    return position >= 0 ? `${position + 1} of ${count}` : `${count} ${count === 1 ? "result" : "results"}`;
}

/** The calendar toolbar's search: a magnifier, the query, a clear button and - while searching - the match count with Previous/Next match buttons. */
export default function CalendarSearchBox({ value, onChange, onSubmit, onClear, onPrevious, onNext, active, count, position, inputRef }: CalendarSearchBoxProps) {
    const status = searchStatusText(count, position);
    const stepClass = "w-6 h-6 flex items-center justify-center rounded-sm text-text-muted hover:bg-surface-alt hover:text-text disabled:opacity-40 disabled:hover:bg-transparent";
    return (
        <div role="search" className="ml-auto flex items-center gap-1 h-8 px-2 min-w-0 flex-1 md:flex-none md:w-80 rounded-sm border border-border bg-surface focus-within:border-primary">
            <HiOutlineMagnifyingGlass size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
            <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        onSubmit(e.shiftKey);
                    } else if (e.key === "Escape") {
                        e.preventDefault();
                        onClear();
                    }
                }}
                placeholder="Search events"
                aria-label="Search events"
                autoComplete="off"
                className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-text-muted"
            />
            {active && (
                <>
                    <span aria-hidden="true" className="shrink-0 text-xs text-text-muted whitespace-nowrap">
                        {status}
                    </span>
                    <button type="button" className={stepClass} aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={count === 0} onClick={onPrevious}>
                        <HiOutlineChevronUp size={16} aria-hidden="true" />
                    </button>
                    <button type="button" className={stepClass} aria-label="Next match" title="Next match (Enter)" disabled={count === 0} onClick={onNext}>
                        <HiOutlineChevronDown size={16} aria-hidden="true" />
                    </button>
                </>
            )}
            {value !== "" && (
                <button type="button" className={stepClass} aria-label="Clear search" title="Clear search (Esc)" onClick={onClear}>
                    <HiOutlineXMark size={16} aria-hidden="true" />
                </button>
            )}
            <span role="status" aria-live="polite" className="sr-only">
                {active ? status : ""}
            </span>
        </div>
    );
}
