// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "../../../lib/calendar/calendarApi.js";
import { parseVCards } from "../../../lib/contacts/vcard.js";
import type { Attachment, Folder, Mailbox, Message } from "../../../lib/mail/mailApi.js";
import {
    AddCardsError,
    MAX_VCARD_BYTES,
    addCardsToAddressBook,
    buildOwnCardFile,
    contactScope,
    createContactFor,
    fetchVCardText,
    findContact,
    loadFolders,
    loadParticipantCard,
    loadRecentMessages,
    loadUpcomingEvents,
    scopeMailboxes,
} from "../../../apps/shared/components/contacts/contactCardData.js";
import { jsonResponse, mockFetch } from "../testUtils.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

function mailbox(uid: string, overrides: Partial<Mailbox> = {}): Mailbox {
    return {
        uid,
        version: 1,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "",
        ownerUserUid: "u1",
        primarySmtpAddress: `${uid}@example.com`,
        aliasAddresses: [],
        displayName: uid,
        accessRole: "owner",
        ...overrides,
    } as Mailbox;
}

function folder(uid: string, mailboxUid: string, type: Folder["type"]): Folder {
    return { uid, mailboxUid, type, name: type } as Folder;
}

function message(uid: string, overrides: Partial<Message> = {}): Message {
    return {
        uid,
        version: 1,
        folderUid: "inbox",
        mailboxUid: "mb1",
        subject: `Subject ${uid}`,
        from: { address: "jane@example.com", displayName: "Jane", type: "to" },
        recipients: [],
        receivedDate: "2026-09-01T10:00:00.000Z",
        bodyPreview: "",
        hasAttachments: false,
        ...overrides,
    } as Message;
}

function attachment(uid: string, filename: string, overrides: Partial<Attachment> = {}): Attachment {
    return { uid, filename, mimeType: "text/vcard", sizeBytes: 100, messageUid: "m1", folderUid: "inbox", mailboxUid: "mb1", isInline: false, ...overrides } as Attachment;
}

function event(uid: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
        uid,
        version: 1,
        folderUid: "cal1",
        mailboxUid: "mb1",
        title: `Event ${uid}`,
        startDate: "2026-10-05T14:00:00.000Z",
        endDate: "2026-10-05T15:00:00.000Z",
        allDay: false,
        timezone: "UTC",
        organizer: { address: "boss@example.com", type: "to" },
        attendees: [],
        status: "confirmed",
        ...overrides,
    } as CalendarEvent;
}

describe("scopeMailboxes", () => {
    it("is the user's own mailboxes, plus the message's mailbox when it is another one they can reach", () => {
        const own = mailbox("mb1");
        const shared = mailbox("shared", { ownerUserUid: undefined, accessRole: "delegate" });
        const other = mailbox("other", { ownerUserUid: undefined, accessRole: "delegate" });
        expect(scopeMailboxes([own, shared], "u1").map((m) => m.uid)).toEqual(["mb1"]);
        expect(scopeMailboxes([own, shared], "u1", message("m1", { mailboxUid: "shared" })).map((m) => m.uid)).toEqual(["mb1", "shared"]);
        expect(scopeMailboxes([own, shared], "u1", message("m1", { mailboxUid: "mb1" })).map((m) => m.uid)).toEqual(["mb1"]);
        expect(scopeMailboxes([own, shared], "u1", message("m1", { mailboxUid: "unknown" })).map((m) => m.uid)).toEqual(["mb1"]);
        expect(scopeMailboxes([shared, other], "u1").map((m) => m.uid)).toEqual(["shared"]);
        expect(scopeMailboxes([], "u1")).toEqual([]);
    });
});

describe("loadFolders and findContact", () => {
    it("lists every folder of the mailboxes, leaving out a mailbox that fails", async () => {
        mockFetch((url) =>
            url.includes("mailboxUid=mb1") ? jsonResponse(200, [folder("f1", "mb1", "contacts")]) : jsonResponse(500, { message: "down" }),
        );
        expect(await loadFolders([mailbox("mb1"), mailbox("mb2")])).toEqual([folder("f1", "mb1", "contacts")]);
    });

    it("finds the contact holding the address in the contacts folders only", async () => {
        const fetchMock = mockFetch((url) =>
            url.includes("folderUid=c1")
                ? jsonResponse(200, [{ uid: "k1", displayName: "Jane", emails: [{ address: "JANE@example.com", type: "work" }], phones: [], addresses: [] }])
                : jsonResponse(200, []),
        );
        const folders = [folder("c1", "mb1", "contacts"), folder("cal", "mb1", "calendar"), folder("c2", "mb2", "contacts")];
        expect((await findContact(folders, "jane@example.com"))?.uid).toBe("k1");
        expect(await findContact(folders, "nobody@example.com")).toBeUndefined();
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes("folderUid=cal"))).toBe(false);
    });
});

describe("loadRecentMessages", () => {
    it("merges what was sent and received, newest first, at most five, dropping hits that no longer resolve", async () => {
        const fetchMock = mockFetch((url) => {
            if (url.startsWith("/api/mail/search")) {
                const params = new URL(url, "http://x").searchParams;
                return jsonResponse(200, {
                    results: params.get("from") ? [1, 2, 3, 4].map((n) => ({ entityUid: `m${n}` })) : [3, 4, 5, 6, 7].map((n) => ({ entityUid: `m${n}` })),
                });
            }
            const uid = url.split("/").pop() as string;
            if (uid === "m7") {
                return jsonResponse(404, { message: "gone" });
            }
            return jsonResponse(200, message(uid, { receivedDate: `2026-09-0${uid.slice(1)}T10:00:00.000Z` }));
        });
        const messages = await loadRecentMessages([mailbox("mb1")], "jane@example.com");
        expect(messages.map((m) => m.uid)).toEqual(["m6", "m5", "m4", "m3", "m2"]);
        const searches = fetchMock.mock.calls.map(([url]) => new URL(String(url), "http://x")).filter((u) => u.pathname === "/api/mail/search");
        expect(searches.map((u) => [u.searchParams.get("from"), u.searchParams.get("to"), u.searchParams.get("mailboxUid"), u.searchParams.get("types")])).toEqual([
            ["jane@example.com", null, "mb1", "message"],
            [null, "jane@example.com", "mb1", "message"],
        ]);
    });
});

describe("loadUpcomingEvents", () => {
    const now = new Date("2026-09-29T00:00:00.000Z");
    const jane = { address: "Jane@example.com", role: "required", responseStatus: "accepted", isOrganizer: false } as const;

    it("lists the events within 60 days that the address organizes or is invited to, soonest first", async () => {
        const events = [
            event("late", { startDate: "2026-10-20T09:00:00.000Z", endDate: "2026-10-20T10:00:00.000Z", attendees: [jane] }),
            event("soon", { organizer: { address: "JANE@example.com", type: "to" } }),
            event("cancelled", { attendees: [jane], status: "cancelled" }),
            event("stranger", { attendees: [{ ...jane, address: "bob@example.com" }] }),
            event("hidden", { attendees: undefined as unknown as CalendarEvent["attendees"] }),
            event("far", { startDate: "2027-03-01T09:00:00.000Z", endDate: "2027-03-01T10:00:00.000Z", attendees: [jane] }),
            event("past", { startDate: "2026-09-01T09:00:00.000Z", endDate: "2026-09-01T10:00:00.000Z", attendees: [jane] }),
            event("weekly", {
                startDate: "2026-09-21T08:00:00.000Z",
                endDate: "2026-09-21T09:00:00.000Z",
                attendees: [jane],
                recurrenceRule: { freq: "weekly", interval: 1, exceptions: [] },
            }),
        ];
        const fetchMock = mockFetch(() => jsonResponse(200, events));
        const folders = [folder("cal1", "mb1", "calendar"), folder("c1", "mb1", "contacts")];
        const upcoming = await loadUpcomingEvents(folders, "jane@example.com", now);
        // The weekly one has an occurrence every Monday from the 5th; the fifth listed is the 20th, the sixth (the 26th) is cut.
        expect(upcoming.map((o) => [o.title, o.startDate.slice(0, 10)])).toEqual([
            ["Event weekly", "2026-10-05"],
            ["Event soon", "2026-10-05"],
            ["Event weekly", "2026-10-12"],
            ["Event weekly", "2026-10-19"],
            ["Event late", "2026-10-20"],
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe("fetchVCardText", () => {
    it("reads an attachment's text, and says when it cannot", async () => {
        mockFetch((url) => (url.includes("/a1/") ? new Response("BEGIN:VCARD", { status: 200 }) : new Response(null, { status: 404, statusText: "Not Found" })));
        expect(await fetchVCardText("a1")).toBe("BEGIN:VCARD");
        await expect(fetchVCardText("a2")).rejects.toThrow("Not Found");
    });

    it("has a message of its own when the server says nothing", async () => {
        mockFetch(() => new Response(null, { status: 500 }));
        await expect(fetchVCardText("a1")).rejects.toThrow("Could not load this contact card.");
    });
});

describe("loadParticipantCard", () => {
    const cardFile = (name: string, email: string) => `BEGIN:VCARD\nFN:${name}\nEMAIL:${email}\nEND:VCARD`;
    const serve = (files: Record<string, string>) => mockFetch((url) => new Response(files[url.split("/").slice(-2)[0]] ?? "", { status: 200 }));

    it("takes the first vCard attachment holding the participant's address", async () => {
        serve({ a1: cardFile("Someone Else", "else@x.com"), a2: cardFile("Bob B", "bob@x.com") });
        const context = { message: message("m1"), attachments: [attachment("a0", "notes.txt", { mimeType: "text/plain" }), attachment("a1", "a.vcf"), attachment("a2", "b.vcf")] };
        expect((await loadParticipantCard({ address: "BOB@x.com" }, context))?.displayName).toBe("Bob B");
    });

    it("falls back to the first card only for the message's sender", async () => {
        serve({ a1: cardFile("Sender Card", "other@x.com") });
        const context = { message: message("m1"), attachments: [attachment("a1", "a.vcf")] };
        expect((await loadParticipantCard({ address: "jane@example.com" }, context))?.displayName).toBe("Sender Card");
        expect(await loadParticipantCard({ address: "bob@x.com" }, context)).toBeUndefined();
        expect(await loadParticipantCard({ address: "jane@example.com" }, { attachments: context.attachments })).toBeUndefined();
    });

    it("lists the message's attachments itself when it was not given them, and only when it has any", async () => {
        const fetchMock = mockFetch((url) =>
            url.startsWith("/api/mail/attachments?") ? jsonResponse(200, [attachment("a1", "a.vcf")]) : new Response(cardFile("Listed", "jane@example.com"), { status: 200 }),
        );
        const withFiles = { message: message("m1", { hasAttachments: true }) };
        expect((await loadParticipantCard({ address: "jane@example.com" }, withFiles))?.displayName).toBe("Listed");
        fetchMock.mockClear();
        expect(await loadParticipantCard({ address: "jane@example.com" }, { message: message("m1") })).toBeUndefined();
        expect(await loadParticipantCard({ address: "jane@example.com" }, {})).toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("skips oversized files and reads at most three", async () => {
        const fetchMock = serve({});
        const attachments = [
            attachment("big", "big.vcf", { sizeBytes: MAX_VCARD_BYTES + 1 }),
            attachment("a1", "1.vcf"),
            attachment("a2", "2.vcf"),
            attachment("a3", "3.vcf"),
            attachment("a4", "4.vcf"),
        ];
        expect(await loadParticipantCard({ address: "jane@example.com" }, { message: message("m1"), attachments })).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("is undefined when a file cannot be read", async () => {
        mockFetch(() => new Response(null, { status: 500 }));
        expect(await loadParticipantCard({ address: "jane@example.com" }, { message: message("m1"), attachments: [attachment("a1", "a.vcf")] })).toBeUndefined();
    });
});

describe("contactScope", () => {
    const own = mailbox("mb1");
    const other = mailbox("mb2", { dateCreated: "2026-02-01T00:00:00.000Z" });
    const shared = mailbox("shared", { ownerUserUid: undefined, accessRole: "delegate" });
    const folders = [folder("c1", "mb1", "contacts"), folder("c2", "mb2", "contacts"), folder("cs", "shared", "contacts")];

    it("is the message's mailbox when it is one of the user's own, else their primary mailbox", () => {
        expect(contactScope([own, other, shared], folders, "u1", message("m", { mailboxUid: "mb2" }))).toEqual({ mailboxUid: "mb2", folderUid: "c2" });
        expect(contactScope([own, other, shared], folders, "u1", message("m", { mailboxUid: "shared" }))).toEqual({ mailboxUid: "mb1", folderUid: "c1" });
        expect(contactScope([own, other, shared], folders, "u1")).toEqual({ mailboxUid: "mb1", folderUid: "c1" });
    });

    it("throws when there is nowhere to put a contact", () => {
        expect(() => contactScope([own], [], "u1")).toThrow("no contacts folder");
        expect(() => contactScope([], folders, "u1")).toThrow("no contacts folder");
    });
});

describe("creating contacts", () => {
    const scope = { mailboxUid: "mb1", folderUid: "c1" };

    it("stores a contact for a participant with everything known", async () => {
        const fetchMock = mockFetch((_url, init) => jsonResponse(200, { uid: "new", ...JSON.parse(init.body as string) }));
        const [card] = parseVCards("BEGIN:VCARD\nFN:Jane Doe\nORG:Acme\nEMAIL:jane@example.com\nEND:VCARD");
        const made = await createContactFor({ address: "jane@example.com" }, card, scope);
        expect(made).toMatchObject({ uid: "new", displayName: "Jane Doe", company: "Acme", folderUid: "c1", mailboxUid: "mb1" });
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
    });

    it("adds each card that is not already in the address book, and counts the ones it skipped", async () => {
        const bodies: { displayName: string }[] = [];
        mockFetch((_url, init) => {
            if (init.method === "POST") {
                bodies.push(JSON.parse(init.body as string));
                return jsonResponse(200, { uid: "new" });
            }
            return jsonResponse(200, [{ uid: "k", displayName: "Known", emails: [{ address: "known@x.com", type: "work" }], phones: [], addresses: [] }]);
        });
        const cards = parseVCards("BEGIN:VCARD\nFN:Known\nEMAIL:known@x.com\nEND:VCARD\nBEGIN:VCARD\nFN:New One\nEMAIL:one@x.com\nEND:VCARD\nBEGIN:VCARD\nFN:New Two\nEMAIL:two@x.com\nEND:VCARD");
        expect(await addCardsToAddressBook(cards, scope)).toEqual({ added: 2, skipped: 1 });
        expect(bodies.map((b) => b.displayName)).toEqual(["New One", "New Two"]);
    });

    it("says how many cards were added before one failed", async () => {
        let posts = 0;
        mockFetch((_url, init) => {
            if (init.method !== "POST") {
                return jsonResponse(200, []);
            }
            posts += 1;
            return posts === 1 ? jsonResponse(200, { uid: "new" }) : jsonResponse(500, { message: "Disk full" });
        });
        const cards = parseVCards("BEGIN:VCARD\nFN:One\nEMAIL:one@x.com\nEND:VCARD\nBEGIN:VCARD\nFN:Two\nEMAIL:two@x.com\nEND:VCARD");
        const failure = await addCardsToAddressBook(cards, scope).catch((err: unknown) => err);
        expect(failure).toBeInstanceOf(AddCardsError);
        expect(failure).toMatchObject({ added: 1, message: "Disk full", name: "AddCardsError" });
    });

    it("gives a failure that is not an error a message of its own", () => {
        expect(new AddCardsError("plain", 0).message).toBe("Could not add the contact.");
    });
});

describe("buildOwnCardFile", () => {
    const me = mailbox("mb1", { displayName: "Jean/Philippe: Steinmetz", primarySmtpAddress: "jp@example.com" });

    it("builds <name>.vcf from the mailbox and the user's own contact entry", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/folders")) {
                return jsonResponse(200, [folder("c1", "mb1", "contacts")]);
            }
            return jsonResponse(200, [
                { uid: "k", displayName: "JP", emails: [{ address: "jp@example.com", type: "work" }], phones: [{ phoneNumber: "+1 555 0101", type: "work" }], addresses: [], company: "Power Level" },
            ]);
        });
        const file = await buildOwnCardFile(me, [me], "u1");
        expect(file.name).toBe("JP.vcf");
        expect(file.type).toBe("text/vcard");
        const [card] = parseVCards(await file.text());
        expect(card).toMatchObject({ displayName: "JP", company: "Power Level", phones: [{ phoneNumber: "+1 555 0101", type: "work" }] });
    });

    it("still builds the card when the contact cannot be looked up, and looks in the mailbox itself when the user owns none", async () => {
        const fetchMock = mockFetch(() => jsonResponse(500, { message: "down" }));
        const file = await buildOwnCardFile(me, [], "u1");
        expect(file.name).toBe("JeanPhilippe Steinmetz.vcf");
        expect(await file.text()).toContain("EMAIL;TYPE=WORK:jp@example.com");
        expect(String(fetchMock.mock.calls[0][0])).toContain("mailboxUid=mb1");
    });

    it("names a card whose name is nothing but punctuation Contact", async () => {
        mockFetch(() => jsonResponse(200, []));
        const file = await buildOwnCardFile(mailbox("mb1", { displayName: "///", primarySmtpAddress: "jp@example.com" }), [], "u1");
        expect(file.name).toBe("Contact.vcf");
    });
});
