///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * What the contact card (`ContactCard`) and the vCard attachment actions read and write: the user's contact and calendar folders, the contact
 * behind an address, the last messages to or from it, its upcoming events, and the calls that make a contact from a participant or a vCard.
 * Every function takes the `ApiClient` to use (`useApiClient()`), like the API modules under `lib/`.
 */
import { addDays } from "date-fns";
import { CalendarEvent, listCalendarEvents } from "../../../../lib/calendar/calendarApi.js";
import { type CalendarOccurrence, expandAllOccurrences } from "../../../../lib/calendar/recurrence.js";
import { type Contact, createContact, listContactsInFolders } from "../../../../lib/contacts/contactsApi.js";
import { type ParsedVCardContact, parseVCards } from "../../../../lib/contacts/vcard.js";
import {
    type Attachment,
    type Folder,
    type Mailbox,
    type Message,
    attachmentContentUrl,
    getMessage,
    listAttachments,
    listFolders,
} from "../../../../lib/mail/mailApi.js";
import { search } from "../../../../lib/search/searchApi.js";
import { ApiRequestError, type ApiClient } from "../../../../lib/util/api.js";
import { ownMailboxes, primaryMailbox } from "../../mail/primaryMailbox.js";
import {
    type Participant,
    cardForAddress,
    contactInputFor,
    contactInputFromCard,
    findContactByAddress,
    isVCardAttachment,
    normalizeAddress,
    ownContactCard,
    withoutDuplicates,
} from "./participantDetails.js";

/** What the card is opened for besides who: the message the participant was met in, and that message's attachments when the caller already has them. */
export interface ContactCardContext {
    message?: Message;
    attachments?: Attachment[];
}

/** How many recent messages and upcoming events the card lists. */
export const CARD_LIST_SIZE = 5;
/** How far ahead "upcoming" looks, in days. */
export const UPCOMING_DAYS = 60;
/** The most vCard attachments and the most bytes of one that are read to fill a contact in. */
export const MAX_VCARD_FILES = 3;
export const MAX_VCARD_BYTES = 256 * 1024;

/** The mailboxes whose data the card reads: the user's own, else the primary/first one, plus the message's mailbox when it is one they can reach. */
export function scopeMailboxes(mailboxes: readonly Mailbox[], userUid: string | undefined, message?: Message): Mailbox[] {
    const own = ownMailboxes(mailboxes, userUid);
    const scope = own.length > 0 ? own : [primaryMailbox(mailboxes, userUid)].filter((mailbox): mailbox is Mailbox => !!mailbox);
    const messageMailbox = mailboxes.find((mailbox) => mailbox.uid === message?.mailboxUid);
    return messageMailbox && !scope.includes(messageMailbox) ? [...scope, messageMailbox] : scope;
}

/** Every folder of `mailboxes`. A mailbox whose folders cannot be listed is left out rather than failing the rest. */
export async function loadFolders(mailboxes: readonly Mailbox[], client?: ApiClient): Promise<Folder[]> {
    const lists = await Promise.all(mailboxes.map((mailbox) => listFolders(mailbox.uid, client).catch(() => [] as Folder[])));
    return lists.flat();
}

/** The contact the address belongs to in `folders`' contacts folders, if any. */
export async function findContact(folders: readonly Folder[], address: string, client?: ApiClient): Promise<Contact | undefined> {
    const uids = folders.filter((folder) => folder.type === "contacts").map((folder) => folder.uid);
    return findContactByAddress(await listContactsInFolders(uids, client), address);
}

/** The last `CARD_LIST_SIZE` messages to or from `address` in `mailboxes`, newest first. */
export async function loadRecentMessages(mailboxes: readonly Mailbox[], address: string, client?: ApiClient): Promise<Message[]> {
    const pages = await Promise.all(
        mailboxes.flatMap((mailbox) =>
            (["from", "to"] as const).map((role) =>
                search("", { types: ["message"], [role]: address, limit: CARD_LIST_SIZE, mailboxUid: mailbox.uid }, client),
            ),
        ),
    );
    const uids = [...new Set(pages.flatMap((page) => page.results.map((result) => result.entityUid)))];
    // A hit can briefly outlive its message: one that no longer resolves is dropped.
    const messages = (await Promise.all(uids.map((uid) => getMessage(uid, client).catch(() => null)))).filter((message): message is Message => !!message);
    return messages.sort((a, b) => Date.parse(b.receivedDate) - Date.parse(a.receivedDate)).slice(0, CARD_LIST_SIZE);
}

/** The next `CARD_LIST_SIZE` events within `UPCOMING_DAYS` from `now` that `address` organizes or is invited to, soonest first. */
export async function loadUpcomingEvents(folders: readonly Folder[], address: string, now: Date, client?: ApiClient): Promise<CalendarOccurrence[]> {
    const wanted = normalizeAddress(address);
    const calendars = folders.filter((folder) => folder.type === "calendar");
    const lists = await Promise.all(calendars.map((folder) => listCalendarEvents(folder.uid, client)));
    const involved = lists
        .flat()
        .filter(
            (event: CalendarEvent) =>
                event.status !== "cancelled" &&
                (normalizeAddress(event.organizer.address) === wanted ||
                    (event.attendees ?? []).some((attendee) => normalizeAddress(attendee.address) === wanted)),
        );
    return expandAllOccurrences(involved, now, addDays(now, UPCOMING_DAYS))
        .sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate))
        .slice(0, CARD_LIST_SIZE);
}

/** A vCard attachment's text - through `client` (its origin and token) when given, else the cookie request it always was. */
export async function fetchVCardText(attachmentUid: string, client?: ApiClient): Promise<string> {
    if (client) {
        return (await client.fetchBlob(`/mail/attachments/${encodeURIComponent(attachmentUid)}/content`)).text();
    }
    const res = await fetch(attachmentContentUrl(attachmentUid), { credentials: "include" });
    if (!res.ok) {
        throw new ApiRequestError(res.statusText || "Could not load this contact card.", res.status);
    }
    return res.text();
}

/** The message's vCard attachments: `context.attachments` when given, else the message's own list. */
async function vCardAttachments(context: ContactCardContext, client?: ApiClient): Promise<Attachment[]> {
    const { message } = context;
    const attachments = context.attachments ?? (message?.hasAttachments ? await listAttachments(message.folderUid, message.uid, client) : []);
    return attachments.filter((attachment) => isVCardAttachment(attachment) && attachment.sizeBytes <= MAX_VCARD_BYTES).slice(0, MAX_VCARD_FILES);
}

/**
 * The vCard of the context message that describes `participant`: the first attachment holding a card with their address, else - only for the
 * message's sender, whose own vCard it presumably is - the first card there is. `undefined` when there is none, and for any failure to read one:
 * a vCard only adds detail, it is never needed.
 */
export async function loadParticipantCard(participant: Participant, context: ContactCardContext, client?: ApiClient): Promise<ParsedVCardContact | undefined> {
    try {
        const isSender = !!context.message && normalizeAddress(context.message.from.address) === normalizeAddress(participant.address);
        let fallback: ParsedVCardContact | undefined;
        for (const attachment of await vCardAttachments(context, client)) {
            const cards = parseVCards(await fetchVCardText(attachment.uid, client));
            const match = cardForAddress(cards, participant.address, false);
            if (match) {
                return match;
            }
            fallback ??= cards[0];
        }
        return isSender ? fallback : undefined;
    } catch {
        return undefined;
    }
}

/** Where a new contact goes: the message's mailbox when it is one of the user's own, else their primary mailbox - in that mailbox's contacts folder. */
export function contactScope(mailboxes: readonly Mailbox[], folders: readonly Folder[], userUid: string | undefined, message?: Message): { mailboxUid: string; folderUid: string } {
    const own = ownMailboxes(mailboxes, userUid);
    const mailbox = own.find((candidate) => candidate.uid === message?.mailboxUid) ?? primaryMailbox(mailboxes, userUid);
    const folder = folders.find((candidate) => candidate.mailboxUid === mailbox?.uid && candidate.type === "contacts");
    if (!mailbox || !folder) {
        throw new Error("There is no contacts folder to add this contact to.");
    }
    return { mailboxUid: mailbox.uid, folderUid: folder.uid };
}

/** Stores a contact for `participant` with everything known - the name, the address and whatever `card` says. */
export function createContactFor(
    participant: Participant,
    card: ParsedVCardContact | undefined,
    scope: { mailboxUid: string; folderUid: string },
    client?: ApiClient,
): Promise<Contact> {
    return createContact(contactInputFor(participant, card, scope), client);
}

/**
 * The sender's own contact card as a file to attach, `<display name>.vcf`: the mailbox being sent from (its name and primary address) with the phones, company and
 * title of the user's own contact entry for that address, when they have one in their own mailboxes' address books. A lookup that fails just leaves those out.
 */
export async function buildOwnCardFile(mailbox: Mailbox, mailboxes: readonly Mailbox[], userUid: string | undefined, client?: ApiClient): Promise<File> {
    let own: Contact | undefined;
    try {
        const mine = ownMailboxes(mailboxes, userUid);
        own = await findContact(await loadFolders(mine.length > 0 ? mine : [mailbox], client), mailbox.primarySmtpAddress, client);
    } catch {
        // The card is still worth sending without them.
    }
    const { displayName, vcard } = ownContactCard(mailbox, own);
    return new File([vcard], `${displayName.replace(/[\\/:*?"<>|]/g, "").trim() || "Contact"}.vcf`, { type: "text/vcard" });
}

/** The outcome of adding a vCard file's cards to the address book. */
export interface AddCardsResult {
    added: number;
    skipped: number;
}

/**
 * Adds every card of a vCard file to the contacts folder `scope` names, skipping the ones whose email is already a stored contact's (or an earlier
 * card's in the same file). A card that cannot be stored fails the whole call after the earlier ones were added - `AddCardsError` says how many.
 */
export async function addCardsToAddressBook(
    cards: readonly ParsedVCardContact[],
    scope: { mailboxUid: string; folderUid: string },
    client?: ApiClient,
): Promise<AddCardsResult> {
    const { fresh, skipped } = withoutDuplicates(cards, await listContactsInFolders([scope.folderUid], client));
    let added = 0;
    for (const card of fresh) {
        try {
            await createContact(contactInputFromCard(card, scope), client);
            added += 1;
        } catch (err) {
            throw new AddCardsError(err, added);
        }
    }
    return { added, skipped };
}

/** A card failed to store: the message is the failure's and `added` how many cards were stored before it. */
export class AddCardsError extends Error {
    readonly added: number;

    constructor(failure: unknown, added: number) {
        super(failure instanceof Error ? failure.message : "Could not add the contact.");
        this.name = "AddCardsError";
        this.added = added;
    }
}
