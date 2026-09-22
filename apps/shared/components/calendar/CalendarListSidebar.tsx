///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useState } from "react";
import { CALENDAR_COLOR_PALETTE, accentColorForMailbox, colorForFolder } from "@rapidmx/react-shared/calendar/calendarColors.js";
import { Folder, Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import { notifyApiError } from "../../notifications/apiErrors.js";

export interface CalendarListSidebarMailbox {
    mailbox: Mailbox;
    calendarFolders: Folder[];
    error?: string;
}

export interface CalendarListSidebarProps {
    /** Every accessible mailbox's `calendar`-type folders, grouped per mailbox (see `CalendarShell`). */
    mailboxCalendars: CalendarListSidebarMailbox[];
    checkedFolderUids: Set<string>;
    onToggle: (folderUid: string) => void;
    onAddCalendar: (mailboxUid: string, name: string, color: string) => Promise<void>;
    /** A calendar's display color - defaults to its own `color` (see `CalendarShell`'s `colorFor`). */
    colorFor?: (folder: Folder) => string;
}

/**
 * Calendar's left-sidebar checklist of calendars — one row per `calendar`-type folder, a color swatch,
 * and a checkbox controlling whether that calendar's events are currently shown (the checked set is owned
 * by `apps/www/calendar/index.tsx`, since it drives which folders get fanned out to on every reload).
 * With one mailbox this is a single "My calendars" list, as before; with several, each mailbox gets its
 * own section (a shared mailbox labeled as such, with a color-dot accent) and its own "+ Add calendar",
 * which creates the calendar in that mailbox. "+ Add calendar" is a real `createFolder({type: "calendar",
 * ...})` call — folder creation has no type restriction server-side, so this needed no new backend route.
 */
export default function CalendarListSidebar({
    mailboxCalendars,
    checkedFolderUids,
    onToggle,
    onAddCalendar,
    colorFor = (folder) => colorForFolder(folder),
}: CalendarListSidebarProps) {
    const [addingFor, setAddingFor] = useState<string | null>(null);
    const [name, setName] = useState("");
    const [color, setColor] = useState(CALENDAR_COLOR_PALETTE[0]);
    const [saving, setSaving] = useState(false);
    const multiple = mailboxCalendars.length > 1;

    function startAdding(mailboxUid: string) {
        setAddingFor(mailboxUid);
        setName("");
        setColor(CALENDAR_COLOR_PALETTE[0]);
    }

    async function handleAdd(e: FormEvent) {
        e.preventDefault();
        if (!name.trim() || !addingFor) {
            return;
        }
        setSaving(true);
        try {
            await onAddCalendar(addingFor, name.trim(), color);
            setName("");
            setColor(CALENDAR_COLOR_PALETTE[0]);
            setAddingFor(null);
        } catch (err) {
            // A pop-up; the form stays open, with what was typed, for another try.
            notifyApiError(err, "Couldn't create the calendar");
        } finally {
            setSaving(false);
        }
    }

    const addForm = (
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
                <button type="button" onClick={() => setAddingFor(null)} className="text-xs text-text-muted">
                    Cancel
                </button>
            </div>
        </form>
    );

    return (
        <nav aria-label="My calendars" className="p-3 border-t border-border flex flex-col gap-3">
            {mailboxCalendars.map(({ mailbox, calendarFolders, error: mailboxError }) => {
                const title = multiple ? `${mailbox.displayName}${mailbox.ownerUserUid ? "" : " (shared)"}` : "My calendars";
                return (
                    <div key={mailbox.uid}>
                        <div className="flex items-center justify-between mb-1 gap-2">
                            <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-text-muted min-w-0">
                                {multiple && (
                                    <span
                                        aria-hidden="true"
                                        className="w-2 h-2 rounded-full shrink-0"
                                        style={{ backgroundColor: accentColorForMailbox(mailbox.uid) }}
                                    />
                                )}
                                <span className="truncate">{title}</span>
                            </h2>
                            <button
                                type="button"
                                onClick={() => startAdding(mailbox.uid)}
                                aria-label={multiple ? `Add calendar to ${mailbox.displayName}` : "Add calendar"}
                                className="text-xs font-bold text-primary-dark hover:underline shrink-0"
                            >
                                +
                            </button>
                        </div>
                        {mailboxError && (
                            <div className="mb-1">
                                <Alert>{mailboxError}</Alert>
                            </div>
                        )}
                        <div className="flex flex-col gap-0.5">
                            {calendarFolders.map((folder) => (
                                <label
                                    key={folder.uid}
                                    className="flex items-center gap-2 text-sm px-1 py-1 rounded-sm hover:bg-surface-alt cursor-pointer"
                                >
                                    <input
                                        type="checkbox"
                                        checked={checkedFolderUids.has(folder.uid)}
                                        onChange={() => onToggle(folder.uid)}
                                        style={{ accentColor: colorFor(folder) }}
                                    />
                                    <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colorFor(folder) }} />
                                    <span className="truncate">{folder.name}</span>
                                </label>
                            ))}
                        </div>
                        {addingFor === mailbox.uid && addForm}
                    </div>
                );
            })}
        </nav>
    );
}
