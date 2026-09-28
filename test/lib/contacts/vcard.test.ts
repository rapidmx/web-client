// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { contactToVCard, contactsToVCardFile, parseVCards } from "../../../lib/contacts/vcard.js";
import type { Contact } from "../../../lib/contacts/contactsApi.js";

const baseContact: Contact = {
    uid: "c1",
    version: 0,
    dateCreated: "",
    dateModified: "",
    mailboxUid: "mb1",
    folderUid: "f1",
    displayName: "Jane Doe",
    givenName: "Jane",
    surname: "Doe",
    emails: [{ address: "jane@example.com", type: "work" }],
    phones: [{ phoneNumber: "555-1234", type: "home" }],
    addresses: [{ street: "1 Main St", city: "Springfield", state: "IL", postalCode: "62704", country: "US", type: "home" }],
    company: "Acme, Inc.",
    jobTitle: "Engineer",
    notes: "Met at a conference;\nfollow up",
};

describe("contactToVCard", () => {
    it("builds a full vCard for a contact with every field populated.", () => {
        const vcard = contactToVCard(baseContact);
        expect(vcard).toContain("BEGIN:VCARD");
        expect(vcard).toContain("VERSION:3.0");
        expect(vcard).toContain("N:Doe;Jane;;;");
        expect(vcard).toContain("FN:Jane Doe");
        expect(vcard).toContain("ORG:Acme\\, Inc.");
        expect(vcard).toContain("TITLE:Engineer");
        expect(vcard).toContain("EMAIL;TYPE=WORK:jane@example.com");
        expect(vcard).toContain("TEL;TYPE=HOME:555-1234");
        expect(vcard).toContain("ADR;TYPE=HOME:;;1 Main St;Springfield;IL;62704;US");
        expect(vcard).toContain("NOTE:Met at a conference\\;\\nfollow up");
        expect(vcard).toContain("END:VCARD");
    });

    it("omits optional fields entirely when absent, rather than emitting empty lines.", () => {
        const minimal: Contact = { ...baseContact, company: undefined, jobTitle: undefined, notes: undefined, emails: [], phones: [], addresses: [] };
        const vcard = contactToVCard(minimal);
        expect(vcard).not.toContain("ORG:");
        expect(vcard).not.toContain("TITLE:");
        expect(vcard).not.toContain("NOTE:");
        expect(vcard).not.toContain("EMAIL");
        expect(vcard).not.toContain("TEL");
        expect(vcard).not.toContain("ADR");
    });

    it("still produces N:;;;; when givenName/surname are both absent.", () => {
        const vcard = contactToVCard({ ...baseContact, givenName: undefined, surname: undefined });
        expect(vcard).toContain("N:;;;;");
    });

    it("falls back to empty segments for an address missing every optional field.", () => {
        const vcard = contactToVCard({ ...baseContact, addresses: [{ type: "other" }] });
        expect(vcard).toContain("ADR;TYPE=OTHER:;;;;;;");
    });
});

describe("contactsToVCardFile", () => {
    it("joins multiple contacts' vCards into one file.", () => {
        const file = contactsToVCardFile([baseContact, { ...baseContact, uid: "c2", displayName: "John Smith" }]);
        expect(file.match(/BEGIN:VCARD/g)).toHaveLength(2);
        expect(file).toContain("FN:Jane Doe");
        expect(file).toContain("FN:John Smith");
    });
});

describe("parseVCards", () => {
    it("round-trips a full vCard back into contact fields.", () => {
        const vcard = contactToVCard(baseContact);
        const [parsed] = parseVCards(vcard);
        expect(parsed.displayName).toBe("Jane Doe");
        expect(parsed.givenName).toBe("Jane");
        expect(parsed.surname).toBe("Doe");
        expect(parsed.company).toBe("Acme, Inc.");
        expect(parsed.jobTitle).toBe("Engineer");
        expect(parsed.emails).toEqual([{ address: "jane@example.com", type: "work" }]);
        expect(parsed.phones).toEqual([{ phoneNumber: "555-1234", type: "home" }]);
        expect(parsed.addresses).toEqual([
            { street: "1 Main St", city: "Springfield", state: "IL", postalCode: "62704", country: "US", type: "home" },
        ]);
        expect(parsed.notes).toBe("Met at a conference;\nfollow up");
    });

    it("parses multiple vCards from one file.", () => {
        const file = contactsToVCardFile([baseContact, { ...baseContact, uid: "c2", displayName: "John Smith", emails: [] }]);
        const parsed = parseVCards(file);
        expect(parsed).toHaveLength(2);
        expect(parsed[0].displayName).toBe("Jane Doe");
        expect(parsed[1].displayName).toBe("John Smith");
    });

    it("defaults an email/phone/address's TYPE to 'other' when the parameter is absent.", () => {
        const parsed = parseVCards("BEGIN:VCARD\r\nFN:Test\r\nEMAIL:test@example.com\r\nTEL:555\r\nEND:VCARD");
        expect(parsed[0].emails).toEqual([{ address: "test@example.com", type: "other" }]);
        expect(parsed[0].phones).toEqual([{ phoneNumber: "555", type: "other" }]);
    });

    it("derives displayName from given/surname when FN is absent.", () => {
        const parsed = parseVCards("BEGIN:VCARD\r\nN:Doe;Jane;;;\r\nEND:VCARD");
        expect(parsed[0].displayName).toBe("Jane Doe");
    });

    it("falls back to 'Unnamed contact' when neither FN nor N is present.", () => {
        const parsed = parseVCards("BEGIN:VCARD\r\nEMAIL:test@example.com\r\nEND:VCARD");
        expect(parsed[0].displayName).toBe("Unnamed contact");
    });

    it("ignores fields it doesn't model (e.g. PHOTO) and lines with no colon.", () => {
        const parsed = parseVCards("BEGIN:VCARD\r\nFN:Test\r\nPHOTO:data:image/png;base64,xyz\r\nnotacolonline\r\nEND:VCARD");
        expect(parsed[0].displayName).toBe("Test");
    });

    it("handles an N value with only a surname (no given name).", () => {
        const parsed = parseVCards("BEGIN:VCARD\r\nN:Doe;;;;\r\nEND:VCARD");
        expect(parsed[0].surname).toBe("Doe");
        expect(parsed[0].givenName).toBeUndefined();
    });

    it("handles an N value with only a given name (no surname).", () => {
        const parsed = parseVCards("BEGIN:VCARD\r\nN:;Jane;;;\r\nEND:VCARD");
        expect(parsed[0].givenName).toBe("Jane");
        expect(parsed[0].surname).toBeUndefined();
    });
});

describe("vCard escaping and parsing fixes (round-4 review)", () => {
    it("escapes CR and CRLF line breaks so a value can't start a new content line", () => {
        const vcard = contactToVCard({ ...baseContact, notes: "line1\r\nline2\rline3\nEND:VCARD", emails: [], phones: [], addresses: [] });
        expect(vcard).toContain("NOTE:line1\\nline2\\nline3\\nEND:VCARD");
        expect(vcard.split("\r\n").filter((line) => line === "END:VCARD")).toHaveLength(1);
        expect(parseVCards(vcard)[0].notes).toBe("line1\nline2\nline3\nEND:VCARD");
    });

    it("unescapes in a single pass, so an escaped backslash before 'n' stays a literal backslash", () => {
        const contact = { ...baseContact, notes: "C:\\new\\folder; a,b", company: "Back\\slash; Inc" };
        const vcard = contactToVCard(contact);
        expect(vcard).toContain("NOTE:C:\\\\new\\\\folder\\; a\\,b");
        const [parsed] = parseVCards(vcard);
        expect(parsed.notes).toBe("C:\\new\\folder; a,b");
        expect(parsed.company).toBe("Back\\slash; Inc");
        expect(parseVCards("BEGIN:VCARD\r\nNOTE:a\\Nb\\:c\\\r\nEND:VCARD")[0].notes).toBe("a\nb:c\\");
    });

    it("splits N and ADR only on unescaped semicolons", () => {
        const [parsed] = parseVCards(contactToVCard({ ...baseContact, surname: "Doe; Jr.", addresses: [{ street: "1 Main St; Apt 2", city: "X", type: "home" }] }));
        expect(parsed.surname).toBe("Doe; Jr.");
        expect(parsed.givenName).toBe("Jane");
        expect(parsed.addresses![0]).toMatchObject({ street: "1 Main St; Apt 2", city: "X" });
    });

    it("unfolds folded lines (CRLF, LF, or CR followed by a space or tab)", () => {
        const parsed = parseVCards("BEGIN:VCARD\r\nFN:Jane\r\n  Doe\r\nNOTE:first\n\tsecond\r third\r\nEND:VCARD");
        expect(parsed[0].displayName).toBe("Jane Doe");
        expect(parsed[0].notes).toBe("firstsecondthird");
    });

    it("ignores property group prefixes and normalizes TYPE values from vCard 2.1, 3.0 and 4.0 exporters", () => {
        const parsed = parseVCards(
            [
                "BEGIN:VCARD",
                "VERSION:3.0",
                "FN:Apple Export",
                "item1.EMAIL;type=INTERNET;type=WORK;type=pref:work@example.com",
                "item2.EMAIL;TYPE=internet,HOME:home@example.com",
                'EMAIL;TYPE="work,voice":quoted@example.com',
                "EMAIL;WORK:legacy21@example.com",
                "TEL;TYPE=CELL;PREF=1:555",
                'item3.ADR;LABEL="a:b";TYPE=home:;;1 Main;Town;;;',
                "END:VCARD",
            ].join("\r\n"),
        );
        expect(parsed[0].emails).toEqual([
            { address: "work@example.com", type: "work" },
            { address: "home@example.com", type: "home" },
            { address: "quoted@example.com", type: "work" },
            { address: "legacy21@example.com", type: "work" },
        ]);
        expect(parsed[0].phones).toEqual([{ phoneNumber: "555", type: "other" }]);
        expect(parsed[0].addresses![0]).toMatchObject({ street: "1 Main", city: "Town", type: "home" });
    });

    it("skips a line whose only colon is inside a quoted parameter", () => {
        const parsed = parseVCards('BEGIN:VCARD\r\nFN:Test\r\nEMAIL;X-LABEL="a:b"\r\nEND:VCARD');
        expect(parsed[0].emails).toEqual([]);
    });

    // Round-5 review: records were split on "BEGIN:VCARD" anywhere, so a NOTE quoting it started a bogus card.
    it("starts a record only at a line that is exactly BEGIN:VCARD, after unfolding", () => {
        const parsed = parseVCards(
            [
                "BEGIN:VCARD",
                "FN:Ann",
                "NOTE:paste BEGIN:VCARD here",
                "NOTE:folded line ",
                " BEGIN:VCARD",
                "END:VCARD",
                "begin:vcard  ",
                "FN:Bob",
                "END:VCARD",
            ].join("\n"),
        );
        expect(parsed.map((c) => c.displayName)).toEqual(["Ann", "Bob"]);
        expect(parsed[0].notes).toBe("folded line BEGIN:VCARD");
    });
});
