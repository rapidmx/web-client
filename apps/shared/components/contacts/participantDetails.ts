///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The pure rules behind the contact card (`ContactCard`), the "Add to address book" action of a vCard attachment and the compose window's
 * "Attach my contact card": who a participant is, whether they are external, which contact (or vCard) describes them and what a new contact
 * made from them holds. No network and no React - the calls that use these are in `contactCardData.ts`.
 */
import type { Contact, ContactEmail, ContactInput, ContactPhone, ContactPostalAddress } from "../../../../lib/contacts/contactsApi.js";
import { contactToVCard, type ParsedVCardContact } from "../../../../lib/contacts/vcard.js";
import { splitMailAddress } from "../../../../lib/mail/mailAddress.js";
import type { Mailbox } from "../../../../lib/mail/mailApi.js";

/** Someone who took part in a message or an event: a sender, a recipient, an organizer, a guest. */
export interface Participant {
    address: string;
    displayName?: string;
}

/** The MIME types a vCard file travels as. */
const VCARD_MIME_TYPES = new Set(["text/vcard", "text/x-vcard", "text/directory", "application/vcard"]);

/** Whether an attachment is a vCard: by its MIME type (parameters such as `; charset=utf-8` ignored), else by a `.vcf`/`.vcard` name. */
export function isVCardAttachment(attachment: { filename?: string; mimeType?: string }): boolean {
    const mimeType = (attachment.mimeType ?? "").split(";")[0].trim().toLowerCase();
    return VCARD_MIME_TYPES.has(mimeType) || /\.(vcf|vcard)$/i.test(attachment.filename ?? "");
}

/** An address in the form two of them are compared by. */
export function normalizeAddress(address: string): string {
    return address.trim().toLowerCase();
}

/** The name to show for a participant: their own when distinct from the address, else the address's local part. */
export function participantName(participant: Participant): string {
    const { name, address } = splitMailAddress(participant);
    if (name) {
        return name;
    }
    const at = address.lastIndexOf("@");
    return at > 0 ? address.slice(0, at) : address;
}

/** A display name as given name + surname: `Doe, Jane` and `Jane Doe` are both Jane Doe; a single word is only a given name, and a middle name stays with the given. */
export function splitPersonName(displayName: string): { givenName?: string; surname?: string } {
    const name = displayName.trim();
    const comma = name.indexOf(",");
    if (comma > 0) {
        return { givenName: name.slice(comma + 1).trim() || undefined, surname: name.slice(0, comma).trim() };
    }
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
        return { givenName: parts[0] };
    }
    return { givenName: parts.slice(0, -1).join(" "), surname: parts[parts.length - 1] };
}

/** The first of `contacts` with an email equal (case-insensitively) to `address`. */
export function findContactByAddress(contacts: readonly Contact[], address: string): Contact | undefined {
    const wanted = normalizeAddress(address);
    return contacts.find((contact) => contact.emails.some((email) => normalizeAddress(email.address) === wanted));
}

/** The domains (lower case) of every address of `mailboxes` - primary and aliases. */
export function ownDomains(mailboxes: readonly Pick<Mailbox, "primarySmtpAddress" | "aliasAddresses">[]): Set<string> {
    const domains = new Set<string>();
    for (const mailbox of mailboxes) {
        for (const address of [mailbox.primarySmtpAddress, ...(mailbox.aliasAddresses ?? [])]) {
            const at = address.lastIndexOf("@");
            if (at > 0) {
                domains.add(address.slice(at + 1).trim().toLowerCase());
            }
        }
    }
    return domains;
}

/** Whether `address` is outside the user's own domains. An address with no domain at all is not called external. */
export function isExternalAddress(address: string, domains: ReadonlySet<string>): boolean {
    const at = address.lastIndexOf("@");
    return at > 0 && !domains.has(address.slice(at + 1).trim().toLowerCase());
}

/** The card of `cards` that carries `address`; when none does and `orFirst` (the message's sender - a vCard a person attaches is their own), the first card. */
export function cardForAddress(cards: readonly ParsedVCardContact[], address: string, orFirst: boolean): ParsedVCardContact | undefined {
    const wanted = normalizeAddress(address);
    return cards.find((card) => (card.emails ?? []).some((email) => normalizeAddress(email.address) === wanted)) ?? (orFirst ? cards[0] : undefined);
}

/** A `ContactInput` whose lists are always there. */
export type KnownPerson = ContactInput & { emails: ContactEmail[]; phones: ContactPhone[]; addresses: ContactPostalAddress[] };

/**
 * What a new contact for `participant` holds: everything the vCard `card` says (when there is one) and always the participant's address. The
 * name is the vCard's, else the participant's, else the address's local part; given name and surname are the vCard's `N`, else split from the name.
 */
export function contactInputFor(
    participant: Participant,
    card: ParsedVCardContact | undefined,
    scope: { mailboxUid: string; folderUid: string },
): KnownPerson {
    // A vCard with no name at all is parsed as "Unnamed contact": not a name worth keeping over the participant's own.
    const cardName = card && (card.givenName || card.surname || card.displayName !== "Unnamed contact") ? card.displayName : "";
    const displayName = cardName || participantName(participant);
    const emails: ContactEmail[] = [...(card?.emails ?? [])];
    if (!emails.some((email) => normalizeAddress(email.address) === normalizeAddress(participant.address))) {
        emails.push({ address: participant.address.trim(), type: "other" });
    }
    const names = card?.givenName || card?.surname ? { givenName: card.givenName, surname: card.surname } : splitPersonName(displayName);
    return {
        ...scope,
        displayName,
        givenName: names.givenName,
        surname: names.surname,
        emails,
        phones: card?.phones ?? [],
        addresses: card?.addresses ?? [],
        company: card?.company,
        jobTitle: card?.jobTitle,
        notes: card?.notes,
    };
}

/** A contact made from a vCard on its own, for "Add to address book": the card's own name and details, with the given/surname split when it lacks them. */
export function contactInputFromCard(card: ParsedVCardContact, scope: { mailboxUid: string; folderUid: string }): KnownPerson {
    const names = card.givenName || card.surname ? { givenName: card.givenName, surname: card.surname } : splitPersonName(card.displayName);
    return { ...card, ...scope, ...names, emails: card.emails ?? [], phones: card.phones ?? [], addresses: card.addresses ?? [] };
}

/** What a card with no email is told apart by: its name and its first phone number (digits only). */
function identityKey(person: { displayName: string; phones?: readonly { phoneNumber: string }[] }): string {
    return `${person.displayName.trim().toLowerCase()}|${(person.phones?.[0]?.phoneNumber ?? "").replace(/\D/g, "")}`;
}

/**
 * The cards that are not yet in the address book, and how many were: a card is a duplicate when one of its emails is a stored contact's or an earlier card's,
 * and a card with no email at all when its name and first phone number are a stored contact's or an earlier card's (so importing the same file twice adds nothing).
 */
export function withoutDuplicates(
    cards: readonly ParsedVCardContact[],
    existing: readonly Contact[],
): { fresh: ParsedVCardContact[]; skipped: number } {
    const known = new Set(existing.flatMap((contact) => contact.emails.map((email) => normalizeAddress(email.address))));
    const knownIdentities = new Set(existing.map(identityKey));
    const fresh: ParsedVCardContact[] = [];
    for (const card of cards) {
        const addresses = (card.emails ?? []).map((email) => normalizeAddress(email.address));
        if (addresses.length === 0) {
            const identity = identityKey(card);
            if (!knownIdentities.has(identity)) {
                knownIdentities.add(identity);
                fresh.push(card);
            }
            continue;
        }
        if (addresses.some((address) => known.has(address))) {
            continue;
        }
        addresses.forEach((address) => known.add(address));
        fresh.push(card);
    }
    return { fresh, skipped: cards.length - fresh.length };
}

/** The sender's own vCard, and the name it is filed under. It is built from - the mailbox's name and primary address, with the phones, company and title of the user's own contact entry when they have one (never its other emails or postal addresses: a card that is sent out says only what it should). */
export function ownContactCard(mailbox: Pick<Mailbox, "displayName" | "primarySmtpAddress">, own: Contact | undefined): { displayName: string; vcard: string } {
    const displayName = own?.displayName || mailbox.displayName || participantName({ address: mailbox.primarySmtpAddress });
    const names = own?.givenName || own?.surname ? { givenName: own.givenName, surname: own.surname } : splitPersonName(displayName);
    const vcard = contactToVCard({
        uid: "",
        version: 0,
        dateCreated: "",
        dateModified: "",
        mailboxUid: "",
        folderUid: "",
        displayName,
        ...names,
        emails: [{ address: mailbox.primarySmtpAddress, type: "work" }],
        phones: own?.phones ?? [],
        addresses: [],
        company: own?.company,
        jobTitle: own?.jobTitle,
    });
    return { displayName, vcard };
}
