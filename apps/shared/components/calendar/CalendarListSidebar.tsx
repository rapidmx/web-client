///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useState } from "react";
import { CALENDAR_COLOR_PALETTE, colorForFolder } from "@rapidmx/react-shared/calendarColors.js";
import { Folder } from "@rapidmx/react-shared/mailApi.js";
import Alert from "../feedback/Alert.js";

export interface CalendarListSidebarProps {
    /** Every `type === "calendar"` folder for the currently-resolved mailbox. */
    calendars: Folder[];
    checkedFolderUids: Set<string>;
    onToggle: (folderUid: string) => void;
    onAddCalendar: (name: string, color: string) => Promise<void>;
}

/**
 * Calendar's left-sidebar checklist of "My calendars" — one row per `calendar`-type folder, a color
 * swatch matching `colorForFolder`, and a checkbox controlling whether that calendar's events are
 * currently shown (the checked set is owned by `apps/www/calendar/index.tsx`, since it drives which
 * folders get fanned out to on every reload). "+ Add calendar" is a real `createFolder({type:
 * "calendar", ...})` call — see the Phase 4 plan's own note that folder creation has no type
 * restriction server-side, so this needed no new backend route.
 */
export default function CalendarListSidebar({ calendars, checkedFolderUids, onToggle, onAddCalendar }: CalendarListSidebarProps) {
    const [adding, setAdding] = useState(false);
    const [name, setName] = useState("");
    const [color, setColor] = useState(CALENDAR_COLOR_PALETTE[0]);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    async function handleAdd(e: FormEvent) {
        e.preventDefault();
        if (!name.trim()) {
            return;
        }
        setError(null);
        setSaving(true);
        try {
            await onAddCalendar(name.trim(), color);
            setName("");
            setColor(CALENDAR_COLOR_PALETTE[0]);
            setAdding(false);
        } catch {
            setError("Could not create this calendar.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <nav aria-label="My calendars" className="p-3 border-t border-border">
            <div className="flex items-center justify-between mb-1">
                <h2 className="text-xs font-bold uppercase tracking-wide text-text-muted">My calendars</h2>
                <button
                    type="button"
                    onClick={() => setAdding(true)}
                    aria-label="Add calendar"
                    className="text-xs font-bold text-primary-dark hover:underline"
                >
                    +
                </button>
            </div>
            {error && (
                <div className="mb-1">
                    <Alert>{error}</Alert>
                </div>
            )}
            <div className="flex flex-col gap-0.5">
                {calendars.map((folder) => (
                    <label key={folder.uid} className="flex items-center gap-2 text-sm px-1 py-1 rounded-sm hover:bg-surface-alt cursor-pointer">
                        <input
                            type="checkbox"
                            checked={checkedFolderUids.has(folder.uid)}
                            onChange={() => onToggle(folder.uid)}
                            style={{ accentColor: colorForFolder(folder) }}
                        />
                        <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colorForFolder(folder) }} />
                        <span className="truncate">{folder.name}</span>
                    </label>
                ))}
            </div>
            {adding && (
                <form onSubmit={handleAdd} className="flex flex-col gap-1.5 mt-2">
                    <input
                        type="text"
                        autoFocus
                        aria-label="New calendar name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="text-xs py-1 px-1.5 border border-border rounded-sm bg-surface"
                    />
                    <div className="flex items-center gap-1" role="radiogroup" aria-label="Calendar color">
                        {CALENDAR_COLOR_PALETTE.map((swatch) => (
                            <button
                                key={swatch}
                                type="button"
                                aria-label={`Color ${swatch}`}
                                aria-pressed={color === swatch}
                                onClick={() => setColor(swatch)}
                                className={["w-4 h-4 rounded-full shrink-0", color === swatch ? "ring-2 ring-offset-1 ring-text" : ""].join(" ")}
                                style={{ backgroundColor: swatch }}
                            />
                        ))}
                    </div>
                    <div className="flex items-center gap-2">
                        <button type="submit" disabled={saving} className="text-xs font-semibold text-primary-dark">
                            Add
                        </button>
                        <button type="button" onClick={() => setAdding(false)} className="text-xs text-text-muted">
                            Cancel
                        </button>
                    </div>
                </form>
            )}
        </nav>
    );
}
