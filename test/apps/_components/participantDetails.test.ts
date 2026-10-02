// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import type { Contact } from "../../../lib/contacts/contactsApi.js";
import { parseVCards } from "../../../lib/contacts/vcard.js";
import {
    cardForAddress,
    contactInputFor,
    contactInputFromCard,
    findContactByAddress,
    isExternalAddress,
    isVCardAttachment,
    normalizeAddress,
    ownContactCard,
    ownDomains,
    participantName,
    splitPersonName,
    withoutDuplicates,
} from "../../../apps/shared/components/contacts/participantDetails.js";

const SCOPE = { mailboxUid: "mb1", folderUid: "f1" };

function contact(overrides: Partial<Contact> = {}): Contact {
    return {
        uid: "c1",
        version: 1,
        dateCreated: "",
        dateModified: "",
        mailboxUid: "mb1",
        folderUid: "f1",
        displayName: "Jane Doe",
        emails: [{ address: "Jane@Example.com", type: "work" }],
        phones: [],
        addresses: [],
        ...overrides,
    };
}

describe("isVCardAttachment", () => {
    it("recognises the vCard MIME types, ignoring case and parameters", () => {
        expect(isVCardAttachment({ mimeType: "text/vcard" })).toBe(true);
        expect(isVCardAttachment({ mimeType: "Text/X-VCard; charset=utf-8" })).toBe(true);
    });

    it("recognises a .vcf or .vcard file name whatever its MIME type", () => {
        expect(isVCardAttachment({ filename: "Jane.VCF", mimeType: "application/octet-stream" })).toBe(true);
        expect(isVCardAttachment({ filename: "jane.vcard" })).toBe(true);
    });

    it("leaves every other attachment alone", () => {
        expect(isVCardAttachment({ filename: "report.pdf", mimeType: "application/pdf" })).toBe(false);
        expect(isVCardAttachment({})).toBe(false);
    });
});

describe("names", () => {
    it("normalizes an address for comparison", () => {
        expect(normalizeAddress("  Jane@Example.COM ")).toBe("jane@example.com");
    });

    it("shows a participant's own name, else the local part of the address", () => {
        expect(participantName({ address: "jane@example.com", displayName: "Jane Doe" })).toBe("Jane Doe");
        expect(participantName({ address: "jane@example.com" })).toBe("jane");
        expect(participantName({ address: "jane@example.com", displayName: "jane@example.com" })).toBe("jane");
        expect(participantName({ address: "postmaster" })).toBe("postmaster");
    });

    it("splits a display name into given name and surname", () => {
        expect(splitPersonName("Jane Doe")).toEqual({ givenName: "Jane", surname: "Doe" });
        expect(splitPersonName("Mary Ann Smith")).toEqual({ givenName: "Mary Ann", surname: "Smith" });
        expect(splitPersonName("Doe, Jane")).toEqual({ givenName: "Jane", surname: "Doe" });
        expect(splitPersonName("Doe,")).toEqual({ givenName: undefined, surname: "Doe" });
        expect(splitPersonName("Jane")).toEqual({ givenName: "Jane" });
        expect(splitPersonName("  ")).toEqual({ givenName: undefined });
    });
});

describe("finding people", () => {
    it("finds the contact holding an address, case-insensitively", () => {
        const jane = contact();
        const bob = contact({ uid: "c2", emails: [{ address: "bob@example.com", type: "home" }] });
        expect(findContactByAddress([bob, jane], " jane@example.COM")).toBe(jane);
        expect(findContactByAddress([bob], "jane@example.com")).toBeUndefined();
    });

    it("collects the domains of every mailbox address and alias", () => {
        const domains = ownDomains([
            { primarySmtpAddress: "me@Example.com", aliasAddresses: ["me@alias.org"] },
            { primarySmtpAddress: "broken", aliasAddresses: undefined as unknown as string[] },
        ]);
        expect([...domains].sort()).toEqual(["alias.org", "example.com"]);
    });

    it("calls an address external when its domain is not the user's own", () => {
        const domains = new Set(["example.com"]);
        expect(isExternalAddress("x@other.org", domains)).toBe(true);
        expect(isExternalAddress("x@EXAMPLE.com", domains)).toBe(false);
        expect(isExternalAddress("postmaster", domains)).toBe(false);
    });

    it("picks the vCard carrying an address, else the first only when allowed", () => {
        const cards = parseVCards(
            "BEGIN:VCARD\nFN:A\nEMAIL:a@x.com\nEND:VCARD\nBEGIN:VCARD\nFN:B\nEND:VCARD\nBEGIN:VCARD\nFN:C\nEMAIL:c@x.com\nEND:VCARD",
        );
        expect(cardForAddress(cards, "C@x.com", false)?.displayName).toBe("C");
        expect(cardForAddress(cards, "z@x.com", false)).toBeUndefined();
        expect(cardForAddress(cards, "z@x.com", true)?.displayName).toBe("A");
        expect(cardForAddress([], "z@x.com", true)).toBeUndefined();
        // A card built by hand may have no list of emails at all.
        expect(cardForAddress([{ displayName: "No lists" }], "z@x.com", false)).toBeUndefined();
    });
});

describe("contactInputFor", () => {
    it("holds the name and address of a participant with no vCard", () => {
        expect(contactInputFor({ address: "jane@example.com", displayName: "Jane Doe" }, undefined, SCOPE)).toEqual({
            ...SCOPE,
            displayName: "Jane Doe",
            givenName: "Jane",
            surname: "Doe",
            emails: [{ address: "jane@example.com", type: "other" }],
            phones: [],
            addresses: [],
            company: undefined,
            jobTitle: undefined,
            notes: undefined,
        });
    });

    it("falls back to the local part of the address for a name", () => {
        const input = contactInputFor({ address: "jane@example.com" }, undefined, SCOPE);
        expect(input.displayName).toBe("jane");
        expect(input.givenName).toBe("jane");
        expect(input.surname).toBeUndefined();
    });

    it("takes everything a vCard says, and keeps its own address when the card lacks it", () => {
        const [card] = parseVCards(
            [
                "BEGIN:VCARD",
                "N:Doe;Janet;;;",
                "FN:Janet Doe",
                "ORG:Acme",
                "TITLE:CTO",
                "EMAIL;TYPE=WORK:other@acme.com",
                "TEL;TYPE=CELL:+1 555 0100",
                "ADR;TYPE=WORK:;;1 Main St;Springfield;IL;62701;USA",
                "NOTE:Met at a conference",
                "END:VCARD",
            ].join("\n"),
        );
        const input = contactInputFor({ address: "jane@example.com", displayName: "Jane" }, card, SCOPE);
        expect(input).toMatchObject({
            displayName: "Janet Doe",
            givenName: "Janet",
            surname: "Doe",
            company: "Acme",
            jobTitle: "CTO",
            notes: "Met at a conference",
            phones: [{ phoneNumber: "+1 555 0100", type: "other" }],
            addresses: [{ street: "1 Main St", city: "Springfield", state: "IL", postalCode: "62701", country: "USA", type: "work" }],
        });
        expect(input.emails).toEqual([
            { address: "other@acme.com", type: "work" },
            { address: "jane@example.com", type: "other" },
        ]);
    });

    it("does not add the address again when the vCard already has it, and splits an FN-only card's name", () => {
        const [card] = parseVCards("BEGIN:VCARD\nFN:Jane Doe\nEMAIL:JANE@example.com\nEND:VCARD");
        const input = contactInputFor({ address: "jane@example.com" }, card, SCOPE);
        expect(input.emails).toEqual([{ address: "JANE@example.com", type: "other" }]);
        expect(input.givenName).toBe("Jane");
        expect(input.surname).toBe("Doe");
    });

    it("prefers the participant's name to a vCard that has none", () => {
        const [card] = parseVCards("BEGIN:VCARD\nEMAIL:x@y.com\nEND:VCARD");
        expect(card.displayName).toBe("Unnamed contact");
        expect(contactInputFor({ address: "x@y.com", displayName: "Xavier Young" }, card, SCOPE).displayName).toBe("Xavier Young");
    });
});

describe("contactInputFromCard", () => {
    it("keeps a card's own name parts", () => {
        const [card] = parseVCards("BEGIN:VCARD\nN:Doe;Jane;;;\nFN:Jane Doe\nEMAIL:jane@example.com\nEND:VCARD");
        expect(contactInputFromCard(card, SCOPE)).toMatchObject({ ...SCOPE, displayName: "Jane Doe", givenName: "Jane", surname: "Doe" });
    });

    it("splits the name of a card without N, and tolerates a card with no lists", () => {
        expect(contactInputFromCard({ displayName: "Mary Smith" }, SCOPE)).toMatchObject({
            givenName: "Mary",
            surname: "Smith",
            emails: [],
            phones: [],
            addresses: [],
        });
    });
});

describe("withoutDuplicates", () => {
    it("drops the cards whose email is a contact's or an earlier card's", () => {
        const cards = parseVCards(
            [
                "BEGIN:VCARD\nFN:Known\nEMAIL:jane@example.com\nEND:VCARD",
                "BEGIN:VCARD\nFN:New\nEMAIL:new@example.com\nEND:VCARD",
                "BEGIN:VCARD\nFN:New again\nEMAIL:NEW@example.com\nEND:VCARD",
                "BEGIN:VCARD\nFN:No email\nEND:VCARD",
            ].join("\n"),
        );
        const { fresh, skipped } = withoutDuplicates([...cards, { displayName: "No lists" }], [contact()]);
        expect(fresh.map((card) => card.displayName)).toEqual(["New", "No email", "No lists"]);
        expect(skipped).toBe(2);
    });

    it("tells a card with no email apart by its name and first phone, against stored contacts and earlier cards", () => {
        const stored = contact({ displayName: "Bob Builder", emails: [], phones: [{ phoneNumber: "+1 (555) 010-0100", type: "mobile" }] });
        const cards = [
            { displayName: "bob builder", phones: [{ phoneNumber: "15550100100", type: "mobile" as const }] },
            { displayName: "Bob Builder", phones: [{ phoneNumber: "555-0000", type: "mobile" as const }] },
            { displayName: "Bob Builder", phones: [{ phoneNumber: "555 0000", type: "home" as const }] },
            { displayName: "No phone" },
            { displayName: "No phone" },
        ];
        const { fresh, skipped } = withoutDuplicates(cards, [stored]);
        expect(fresh.map((card) => card.displayName)).toEqual(["Bob Builder", "No phone"]);
        expect(skipped).toBe(3);
    });
});

describe("ownContactCard", () => {
    const mailbox = { displayName: "Jean-Philippe Steinmetz", primarySmtpAddress: "jp@example.com" };

    it("builds a card from the mailbox alone", () => {
        const { displayName, vcard } = ownContactCard(mailbox, undefined);
        expect(displayName).toBe("Jean-Philippe Steinmetz");
        const [card] = parseVCards(vcard);
        expect(card).toMatchObject({ displayName, givenName: "Jean-Philippe", surname: "Steinmetz", emails: [{ address: "jp@example.com", type: "work" }] });
    });

    it("adds the phones, company and title of the user's own contact, but not its other emails or addresses", () => {
        const own = contact({
            displayName: "JP",
            givenName: "JP",
            surname: "S",
            emails: [{ address: "private@home.net", type: "home" }],
            phones: [{ phoneNumber: "+1 555 0101", type: "work" }],
            addresses: [{ street: "1 Secret Rd", type: "home" }],
            company: "Power Level",
            jobTitle: "Founder",
        });
        const { displayName, vcard } = ownContactCard(mailbox, own);
        expect(displayName).toBe("JP");
        const [card] = parseVCards(vcard);
        expect(card).toMatchObject({ givenName: "JP", surname: "S", company: "Power Level", jobTitle: "Founder", phones: [{ phoneNumber: "+1 555 0101", type: "work" }] });
        expect(card.emails).toEqual([{ address: "jp@example.com", type: "work" }]);
        expect(card.addresses).toEqual([]);
    });

    it("falls back to the address's local part when nothing has a name", () => {
        expect(ownContactCard({ displayName: "", primarySmtpAddress: "sales@example.com" }, undefined).displayName).toBe("sales");
    });
});
