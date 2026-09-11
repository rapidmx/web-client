///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { RefObject, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { Mailbox, listResourceMailboxes } from "@rapidmx/react-shared/mailApi.js";
import PopoverPortal from "../mail/compose/PopoverPortal.js";

export interface ResourcePickerProps {
    anchorRef: RefObject<HTMLElement | null>;
    onClose: () => void;
    onSelect: (mailbox: Mailbox) => void;
    /** Addresses already added as attendees (lowercased by the caller) — excluded from the list so the
     * same room/equipment mailbox can't be picked twice. */
    excludeAddresses: string[];
}

/**
 * A searchable dropdown of bookable resource mailboxes (rooms/equipment), for adding one as a `"resource"`
 * attendee in `EventModal` without typing its raw address. Fetches the caller's full visible resource-mailbox
 * list once on open and filters it client-side by name/address as the reader types — the same
 * "fetch-flat-list, filter-client-side" contract every other list endpoint in this codebase already uses
 * (see `calendarApi.ts`'s `listCalendarEvents` doc comment), since there is no dedicated server-side search
 * endpoint for mailboxes and the resource-mailbox count in any one org is expected to be small.
 */
export default function ResourcePicker({ anchorRef, onClose, onSelect, excludeAddresses }: ResourcePickerProps) {
    const [resources, setResources] = useState<Mailbox[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState("");

    useEffect(() => {
        listResourceMailboxes({ limit: 100 })
            .then(setResources)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load resources."));
    }, []);

    const excluded = new Set(excludeAddresses);
    const filtered = (resources ?? []).filter((mailbox) => {
        if (excluded.has(mailbox.primarySmtpAddress.toLowerCase())) {
            return false;
        }
        const haystack = `${mailbox.displayName} ${mailbox.primarySmtpAddress}`.toLowerCase();
        return haystack.includes(query.trim().toLowerCase());
    });

    return (
        <PopoverPortal anchorRef={anchorRef} onClose={onClose} width={280} height={320} aria-label="Add a room or equipment resource">
            <input
                type="text"
                autoFocus
                placeholder="Search rooms & equipment…"
                className="text-sm py-2 px-3 border-b border-border bg-surface text-text focus:outline-none"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
            />
            <div className="flex-1 overflow-y-auto">
                {error && <p className="text-xs text-danger p-3">{error}</p>}
                {!error && resources === null && <p className="text-xs text-text-muted p-3">Loading&hellip;</p>}
                {!error && resources !== null && filtered.length === 0 && (
                    <p className="text-xs text-text-muted p-3">No matching resources.</p>
                )}
                {filtered.map((mailbox) => (
                    <button
                        key={mailbox.uid}
                        type="button"
                        onClick={() => onSelect(mailbox)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-surface-alt flex items-center justify-between gap-2"
                    >
                        <span className="truncate">{mailbox.displayName}</span>
                        <span className="text-xs text-text-muted shrink-0 capitalize">
                            {mailbox.resourceType ?? "room"}
                            {mailbox.resourceCapacity ? ` · ${mailbox.resourceCapacity}` : ""}
                        </span>
                    </button>
                ))}
            </div>
        </PopoverPortal>
    );
}
