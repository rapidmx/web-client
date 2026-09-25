///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import type { Attendee } from "@rapidmx/react-shared/calendar/calendarApi.js";
import type { ContactSuggestionOptions, RecipientSuggestion } from "@rapidmx/react-shared/mail/directoryApi.js";
import RecipientInput from "../mail/compose/RecipientInput.js";
import { applyGuestChips, guestChip } from "./eventFormat.js";

/** Above the event dialog's own backdrop (`z-[1000]`), which the suggestions would otherwise sit under. */
const DIALOG_SUGGESTIONS_Z_INDEX = 1100;

const VARIANT_CLASS = {
    /** Reads as plain text until it is hovered or focused, as the rows of the quick-create popover do. */
    quiet: "w-full text-sm py-1 border-b border-transparent hover:border-border focus-within:border-primary",
    /** A bordered box, as the full form's fields are. */
    box: "w-full text-sm py-1.5 px-3 border border-border rounded-md bg-surface text-text focus-within:border-primary",
};

/** What a guests field holds: the guests added, what was committed but is not an address (kept in the field, flagged, until it is fixed or removed),
 * and what is still being typed. */
export interface GuestEntries {
    guests: Attendee[];
    invalid: string[];
    draft: string;
}

export interface GuestInputProps extends GuestEntries {
    /** The input's id, and the prefix of its suggestions' ids. */
    id: string;
    /** The input's accessible name. */
    label: string;
    placeholder?: string;
    variant: keyof typeof VARIANT_CLASS;
    /** The guests are listed elsewhere (rows with a role and an answer): the field draws chips only for what is not an address. */
    listedElsewhere?: boolean;
    /** Addresses that are never added - the organizer's, or the people already invited. */
    skipAddresses?: string[];
    /** The mailbox the event is on, whose contacts are suggested too. */
    mailboxUid?: string;
    onChange: (next: GuestEntries) => void;
    /** Loads suggestions; defaults to the lookup compose's recipient fields use. */
    fetchSuggestions?: (query: string, options: ContactSuggestionOptions) => Promise<RecipientSuggestion[]>;
    debounceMs?: number;
}

/** What `RecipientInput` calls `onChange` with; the entries come through `onEdit`. */
const IGNORED = () => undefined;

/**
 * The guests field of an event: compose's recipient field (`RecipientInput`) reading its chips as guests. Typing looks the name up among the
 * caller's contacts and the server's mailboxes and distribution lists; a suggestion (or an address, `Name <address>`, a comma, a semicolon,
 * Enter or leaving the field) becomes a chip, a paste of several addresses becomes several, and something that is not an address stays as
 * a flagged chip once it is committed - nothing is said while it is being typed. A distribution list is added as its own address, one guest
 * (as compose sends to one), which the mail server delivers to its members.
 *
 * The field is controlled: `guests` are the attendees, and every edit hands back the whole of the entries (see `applyGuestChips()`).
 */
export default function GuestInput({
    id,
    label,
    placeholder,
    variant,
    listedElsewhere,
    skipAddresses,
    mailboxUid,
    guests,
    invalid,
    draft,
    onChange,
    fetchSuggestions,
    debounceMs,
}: GuestInputProps) {
    const value = [...guests.map(guestChip), ...invalid, draft].filter((part) => part.length > 0).join(", ");
    const listed = new Set(listedElsewhere ? guests.map(guestChip) : []);

    return (
        <RecipientInput
            id={id}
            label={label}
            ariaLabel={label}
            listLabel="Guests"
            placeholder={placeholder}
            className={VARIANT_CLASS[variant]}
            dropdownZIndex={DIALOG_SUGGESTIONS_Z_INDEX}
            value={value}
            initialPending={draft}
            mailboxUid={mailboxUid}
            hideChip={(chip) => listed.has(chip)}
            fetchSuggestions={fetchSuggestions}
            debounceMs={debounceMs}
            onChange={IGNORED}
            onEdit={(chips, pending) => {
                const merged = applyGuestChips(guests, chips, skipAddresses);
                onChange({ guests: merged.attendees, invalid: merged.invalid, draft: pending });
            }}
        />
    );
}
