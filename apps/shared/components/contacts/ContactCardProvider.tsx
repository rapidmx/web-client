///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { PropsWithChildren, createContext, useCallback, useContext, useMemo, useState } from "react";
import { parseVCards } from "../../../../lib/contacts/vcard.js";
import { type Message, listMailboxes } from "../../../../lib/mail/mailApi.js";
import { useApiClient } from "../../../../lib/util/apiClientContext.js";
import { MAILBOX_LIST_LIMIT, MailConnectionContext } from "../../mail/useMailConnection.js";
import { clearPinnedSignerCache } from "../mail/pinnedSigners.js";
import ContactCard from "./ContactCard.js";
import { type AddCardsResult, type ContactCardContext, addCardsToAddressBook, contactScope, loadFolders, scopeMailboxes } from "./contactCardData.js";
import type { Participant } from "./participantDetails.js";

export interface ContactCardValue {
    /** Opens the contact card of `participant`; `context` is the message they were met in, when there is one (its vCard attachments and mailbox). */
    show: (participant: Participant, context?: ContactCardContext) => void;
    /**
     * Adds every card of a vCard file's `text` to the user's address book - in the default contacts folder of `message`'s mailbox when it is one of
     * theirs, else of their primary mailbox - skipping the ones whose email is already a contact's. Rejects if a card cannot be stored (an
     * `AddCardsError`) or the folders cannot be read. Does nothing useful outside a provider (`available` is `false`).
     */
    addVCards: (text: string, message?: Message) => Promise<AddCardsResult>;
    /** `false` outside a `ContactCardProvider`, where `show()` does nothing: a caller then draws plain text instead of a button. */
    available: boolean;
}

const CardContext = createContext<ContactCardValue>({ show: () => undefined, addVCards: () => Promise.resolve({ added: 0, skipped: 0 }), available: false });

/** Shows a person's contact card from anywhere inside `AppShell` - see `ContactCard`. */
export function useContactCard(): ContactCardValue {
    return useContext(CardContext);
}

interface Shown {
    participant: Participant;
    context?: ContactCardContext;
    /** A new card each time, so what one card loaded is never shown for the next. */
    id: number;
}

/**
 * Owns the one contact card that can be open. Mounted once in `AppShell` (inside the compose provider, whose windows the card's "Email" opens), so
 * a participant is clickable in every app. The card is a modal: focus goes into it, and back to the participant that was clicked when it closes.
 */
export default function ContactCardProvider({ children, userUid }: PropsWithChildren<{ userUid?: string }>) {
    const client = useApiClient();
    const connection = useContext(MailConnectionContext);
    const [shown, setShown] = useState<Shown | null>(null);
    const show = useCallback<ContactCardValue["show"]>((participant, context) => {
        setShown((previous) => ({ participant, context, id: (previous?.id ?? 0) + 1 }));
    }, []);
    const addVCards = useCallback<ContactCardValue["addVCards"]>(
        async (text, message) => {
            const cards = parseVCards(text);
            // The frame's mailboxes when it has them; a page rendered outside it asks.
            const mailboxes = connection?.status === "ready" ? connection.mailboxes : await listMailboxes({ limit: MAILBOX_LIST_LIMIT }, client);
            const folders = await loadFolders(scopeMailboxes(mailboxes, userUid, message), client);
            const result = await addCardsToAddressBook(cards, contactScope(mailboxes, folders, userUid, message), client);
            clearPinnedSignerCache();
            return result;
        },
        [connection, client, userUid],
    );
    const value = useMemo(() => ({ show, addVCards, available: true }), [show, addVCards]);
    return (
        <CardContext.Provider value={value}>
            {children}
            {shown && <ContactCard key={shown.id} participant={shown.participant} context={shown.context} userUid={userUid} onClose={() => setShown(null)} />}
        </CardContext.Provider>
    );
}
