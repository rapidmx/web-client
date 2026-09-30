///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import type { Message } from "../../../../lib/mail/mailApi.js";
import { notify } from "../../notifications/store.js";
import { notifyApiError } from "../../notifications/apiErrors.js";
import { useContactCard } from "../contacts/ContactCardProvider.js";
import { AddCardsError } from "../contacts/contactCardData.js";
import MenuButton from "./MenuButton.js";

const CHIP_CLASS = "text-xs font-medium py-1 px-2.5 rounded-pill bg-surface-alt text-text-muted hover:text-primary-dark";

/** "1 contact", "3 contacts". */
function contacts(count: number): string {
    return `${count} ${count === 1 ? "contact" : "contacts"}`;
}

/** What adding a vCard file ended with, for the pop-up that says so. */
function addedMessage(added: number, skipped: number): string {
    if (added + skipped === 0) {
        return "This file has no contacts in it.";
    }
    const already = skipped === 0 ? "" : `${added === 0 ? "" : " "}${contacts(skipped)} ${skipped === 1 ? "was" : "were"} already in your address book.`;
    return `${added === 0 ? "" : `${contacts(added)} added to your address book.`}${already}`;
}

export interface VCardAttachmentChipProps {
    /** The file's name, as the chip shows it (with the size, when known). */
    label: string;
    /** The message the file is attached to: a new contact goes to its mailbox's address book when that is the user's own. */
    message: Message;
    /** The vCard file's text. */
    loadText: () => Promise<string>;
    /** Saves the file to the device. */
    onDownload: () => void;
}

/**
 * A vCard attachment (`.vcf`, `text/vcard`) in a message's attachment list. Clicking it opens a menu - "Add to address book" (every card in the file
 * becomes a contact, except the ones already there) and "Download" - instead of downloading at once. Outside a `ContactCardProvider` there is no
 * address book to add to, and the chip is the plain download it always was.
 */
export default function VCardAttachmentChip({ label, message, loadText, onDownload }: VCardAttachmentChipProps) {
    const { addVCards, available } = useContactCard();

    async function handleAdd() {
        try {
            const { added, skipped } = await addVCards(await loadText(), message);
            notify({
                kind: added + skipped === 0 ? "warning" : "success",
                title: added + skipped === 0 ? "No contacts found" : "Address book updated",
                message: addedMessage(added, skipped),
            });
        } catch (err) {
            const stored = err instanceof AddCardsError && err.added > 0 ? ` ${contacts(err.added)} could be added before it failed.` : "";
            notifyApiError(err, `Couldn't add to your address book.${stored}`);
        }
    }

    if (!available) {
        return (
            <button type="button" onClick={onDownload} className={CHIP_CLASS}>
                {label}
            </button>
        );
    }
    return (
        <MenuButton
            label={label}
            aria-label={`${label}, contact card actions`}
            className={CHIP_CLASS}
            sections={[
                {
                    key: "vcard",
                    items: [
                        { key: "add", label: "Add to address book", onSelect: () => void handleAdd() },
                        { key: "download", label: "Download", onSelect: onDownload },
                    ],
                },
            ]}
        />
    );
}
