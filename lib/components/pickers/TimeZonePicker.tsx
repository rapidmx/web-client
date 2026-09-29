///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { describeTimeZone, sortTimeZones } from "../../util/timeZone.js";

export interface TimeZonePickerProps {
    id?: string;
    "aria-label"?: string;
    "aria-describedby"?: string;
    /** The chosen zone (an IANA id). */
    value: string;
    /** The zones to choose between; the list orders them itself. */
    zones: string[];
    onChange: (zone: string) => void;
    /** The date each zone's offset is read on (daylight saving); now unless a date matters. */
    at?: Date;
    className?: string;
}

/**
 * A time zone chooser that lists zones as "Los Angeles, America (GMT-07:00)", west to east and then by city, and has a search box in the list: typing narrows it to the zones whose
 * name or offset contains every word typed ("berlin", "gmt+9", "america indiana"). A button showing the chosen zone opens it; the arrow keys move
 * through the list, Enter chooses, and Escape (or a click elsewhere) closes it without changing anything.
 */
export default function TimeZonePicker({ id, "aria-label": label, "aria-describedby": describedBy, value, zones, onChange, at, className }: TimeZonePickerProps) {
    const listId = useId();
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const search = useRef<HTMLInputElement>(null);
    const selected = useRef<HTMLLIElement>(null);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(-1);

    // Listed by the offsets shown (which move with daylight saving): west to east, then by city. Worked out only while the list is open - naming several
    // hundred zones is the costly part, and a closed picker (most renders) shows one - and keyed on the date's value, since a caller may hand over a new `Date` each render.
    const atTime = at?.getTime();
    const entries = useMemo(() => {
        if (!open) {
            return [];
        }
        const on = new Date(atTime ?? Date.now());
        return sortTimeZones(zones, on).map((zone) => {
            const text = describeTimeZone(zone, on);
            return { zone, text, haystack: `${text} ${zone.replace(/_/g, " ")}`.toLowerCase() };
        });
    }, [open, zones, atTime]);
    const shown = useMemo(() => {
        const words = query.toLowerCase().replace(/_/g, " ").split(/\s+/).filter(Boolean);
        return words.length === 0 ? entries : entries.filter((entry) => words.every((word) => entry.haystack.includes(word)));
    }, [entries, query]);

    useEffect(() => {
        if (!open) {
            return undefined;
        }
        search.current?.focus();
        selected.current?.scrollIntoView?.({ block: "center" });
        const outside = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) {
                close(false);
            }
        };
        document.addEventListener("pointerdown", outside);
        return () => document.removeEventListener("pointerdown", outside);
    }, [open]);

    function close(refocus: boolean) {
        setOpen(false);
        setQuery("");
        setActive(-1);
        if (refocus) {
            trigger.current?.focus();
        }
    }

    function choose(zone: string) {
        if (zone !== value) {
            onChange(zone);
        }
        close(true);
    }

    function move(step: number) {
        setActive((index) => {
            const from = index < 0 ? shown.findIndex((entry) => entry.zone === value) : index;
            return Math.min(Math.max(from + step, 0), shown.length - 1);
        });
    }

    function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            move(event.key === "ArrowDown" ? 1 : -1);
        } else if (event.key === "Enter") {
            // Never the form's own submit.
            event.preventDefault();
            const entry = shown[active >= 0 ? active : 0];
            if (entry && (active >= 0 || shown.length === 1)) {
                choose(entry.zone);
            }
        } else if (event.key === "Escape") {
            event.stopPropagation();
            close(true);
        }
    }

    return (
        <div ref={root} className="relative inline-block max-w-full">
            <button
                ref={trigger}
                id={id}
                type="button"
                role="combobox"
                aria-label={label}
                aria-describedby={describedBy}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                className={["flex items-center justify-between gap-2 text-left", className].filter(Boolean).join(" ")}
                onClick={() => setOpen((wasOpen) => !wasOpen)}
                onKeyDown={(event) => {
                    if (event.key === "ArrowDown" && !open) {
                        event.preventDefault();
                        setOpen(true);
                    }
                }}
            >
                <span className="truncate">{describeTimeZone(value, at)}</span>
                <span aria-hidden="true" className="shrink-0 text-text-muted">
                    &#9662;
                </span>
            </button>
            {open && (
                <div className="absolute left-0 top-full z-30 mt-1 w-80 max-w-[90vw] rounded-md border border-border bg-surface shadow-lg">
                    <div className="p-2">
                        <input
                            ref={search}
                            type="text"
                            role="searchbox"
                            aria-label="Search time zones"
                            aria-controls={listId}
                            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
                            autoComplete="off"
                            placeholder="Search"
                            className="w-full rounded-md border border-border bg-surface-alt px-3 py-1.5 text-sm text-text focus:border-primary focus:outline-none"
                            value={query}
                            onChange={(event) => {
                                setQuery(event.target.value);
                                setActive(-1);
                            }}
                            onKeyDown={handleSearchKeyDown}
                        />
                    </div>
                    <ul id={listId} role="listbox" aria-label="Time zones" className="max-h-60 overflow-y-auto pb-1">
                        {shown.map((entry, index) => (
                            <li
                                key={entry.zone}
                                id={`${listId}-${index}`}
                                ref={entry.zone === value ? selected : undefined}
                                role="option"
                                aria-selected={entry.zone === value}
                                // Before the search box's blur or the outside-click check, which would otherwise close the list first.
                                onMouseDown={(event) => {
                                    event.preventDefault();
                                    choose(entry.zone);
                                }}
                                className={[
                                    "cursor-pointer px-3 py-1.5 text-sm hover:bg-surface-alt",
                                    entry.zone === value ? "font-semibold text-primary-dark" : "",
                                    index === active ? "bg-surface-alt" : "",
                                ].join(" ")}
                            >
                                {entry.text}
                            </li>
                        ))}
                        {shown.length === 0 && <li className="px-3 py-1.5 text-sm text-text-muted">No time zones match.</li>}
                    </ul>
                </div>
            )}
        </div>
    );
}
