// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "../../../lib/calendar/calendarApi.js";
import type { Attachment, Mailbox, Message } from "../../../lib/mail/mailApi.js";
import ContactCardProvider, { useContactCard } from "../../../apps/shared/components/contacts/ContactCardProvider.js";
import Modal from "../../../lib/components/overlays/Modal.js";
import ParticipantLink from "../../../apps/shared/components/contacts/ParticipantLink.js";
import type { ContactCardContext } from "../../../apps/shared/components/contacts/contactCardData.js";
import { MailConnectionContext, type MailConnection } from "../../../apps/shared/mail/useMailConnection.js";
import { getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { ContactPhotoError, prepareContactPhoto } from "../../../lib/contacts/preparePhoto.js";

// Making a picture small enough is `preparePhoto.test.ts`'s business (jsdom cannot decode or draw one): here the card is handed the file as it was chosen.
vi.mock("../../../lib/contacts/preparePhoto.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/contacts/preparePhoto.js")>()),
    prepareContactPhoto: vi.fn(async (file: File) => file),
}));

const { openCompose } = vi.hoisted(() => ({ openCompose: vi.fn() }));
vi.mock("../../../apps/shared/components/mail/compose/ComposeContext.js", () => ({ useCompose: () => ({ openCompose }) }));

afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
});

const ME = { uid: "mb1", ownerUserUid: "u1", primarySmtpAddress: "me@example.com", aliasAddresses: ["me@alias.org"], displayName: "Me", dateCreated: "2026-01-01T00:00:00.000Z", accessRole: "owner" } as Mailbox;

function connection(status: MailConnection["status"], mailboxes: Mailbox[] = [ME]): MailConnection {
    return { status, mailboxes } as MailConnection;
}

interface Server {
    contacts?: unknown[] | Response;
    messages?: Message[] | Response;
    events?: Partial<CalendarEvent>[] | Response;
    attachments?: Attachment[];
    files?: Record<string, string>;
    create?: (body: Record<string, unknown>) => Response;
    update?: (body: Record<string, unknown>) => Response;
    mailboxes?: Response;
    /** What a change of the contact's picture (PUT or DELETE `/photo`) answers. */
    photo?: (init: RequestInit) => Response;
}

// 14:00 UTC tomorrow or later, so the event stays "upcoming" whenever the tests run.
const EVENT_START = new Date(Math.ceil(Date.now() / 86_400_000 + 1) * 86_400_000 + 14 * 3_600_000);

const JANE_EVENT = {
    uid: "ev1",
    folderUid: "cal1",
    title: "Design review",
    startDate: EVENT_START.toISOString(),
    endDate: new Date(EVENT_START.getTime() + 3_600_000).toISOString(),
    allDay: false,
    timezone: "UTC",
    organizer: { address: "boss@example.com", type: "to" },
    attendees: [{ address: "jane@other.org", role: "required", responseStatus: "accepted", isOrganizer: false }],
    status: "confirmed",
};

function serve(server: Server = {}) {
    const posted: Record<string, unknown>[] = [];
    const fetchMock = mockFetch((url, init) => {
        const path = url.split("?")[0];
        if (path === "/api/mail/contacts/k1/photo" && init?.method) {
            return server.photo ? server.photo(init) : jsonResponse(200, { ...JANE, version: 5, photoBlobKey: "contact-photos/k1/new" });
        }
        if (init?.method === "PUT") {
            const body = JSON.parse(init.body as string);
            return server.update ? server.update(body) : jsonResponse(200, { ...JANE, ...body });
        }
        if (init?.method === "POST") {
            const body = JSON.parse(init.body as string);
            posted.push(body);
            return server.create ? server.create(body) : jsonResponse(200, { uid: "new1", ...body });
        }
        if (path === "/api/mail/mailboxes") {
            return server.mailboxes ?? jsonResponse(200, [ME]);
        }
        if (path === "/api/mail/folders") {
            return jsonResponse(200, [
                { uid: "c1", mailboxUid: "mb1", type: "contacts", name: "Contacts" },
                { uid: "cal1", mailboxUid: "mb1", type: "calendar", name: "Calendar" },
            ]);
        }
        if (path === "/api/mail/contacts") {
            return server.contacts instanceof Response ? server.contacts : jsonResponse(200, server.contacts ?? []);
        }
        if (path === "/api/mail/search") {
            if (server.messages instanceof Response) {
                return server.messages;
            }
            return jsonResponse(200, { results: (server.messages ?? []).map((m) => ({ entityUid: m.uid })) });
        }
        if (path.startsWith("/api/mail/messages/")) {
            const uid = path.split("/").pop();
            return jsonResponse(200, ((server.messages as Message[]) ?? []).find((m) => m.uid === uid));
        }
        if (path === "/api/mail/calendar-events") {
            return server.events instanceof Response ? server.events : jsonResponse(200, server.events ?? []);
        }
        if (path === "/api/mail/attachments") {
            return jsonResponse(200, server.attachments ?? []);
        }
        if (path.startsWith("/api/mail/attachments/")) {
            return new Response(server.files?.[path.split("/")[4]] ?? "", { status: 200 });
        }
        return jsonResponse(404, { message: `unexpected ${url}` });
    });
    return { fetchMock, posted };
}

function message(uid: string, overrides: Partial<Message> = {}): Message {
    return {
        uid,
        version: 1,
        folderUid: "inbox",
        mailboxUid: "mb1",
        subject: `Subject ${uid}`,
        from: { address: "jane@other.org", displayName: "Jane Doe", type: "to" },
        recipients: [],
        receivedDate: `2026-09-2${uid.slice(1)}T10:00:00.000Z`,
        bodyPreview: `Preview of ${uid}`,
        hasAttachments: false,
        ...overrides,
    } as Message;
}

function Trigger({ address = "jane@other.org", displayName = "Jane Doe", context }: { address?: string; displayName?: string; context?: ContactCardContext }) {
    return (
        <ParticipantLink participant={{ address, displayName }} context={context}>
            {displayName} &lt;{address}&gt;
        </ParticipantLink>
    );
}

function renderCard(ui: React.ReactElement = <Trigger />, conn: MailConnection | null = connection("ready")) {
    return render(
        <MailConnectionContext.Provider value={conn}>
            <ContactCardProvider userUid="u1">{ui}</ContactCardProvider>
        </MailConnectionContext.Provider>,
    );
}

async function openCard(user: ReturnType<typeof userEvent.setup>, name = "Jane Doe <jane@other.org>") {
    await user.click(screen.getByRole("button", { name }));
    return screen.findByRole("dialog", { name: "Jane Doe" });
}

const JANE = { uid: "k1", displayName: "Jane Doe", emails: [{ address: "JANE@other.org", type: "work" }, { address: "jd@home.net", type: "home" }, { address: "j@x.org", type: "other" }], phones: [{ phoneNumber: "+1 555 0100", type: "work" }, { phoneNumber: "+1 555 0101", type: "home" }], addresses: [{ street: "1 Main St", city: "Springfield", postalCode: "62701", state: "IL", country: "USA", type: "home" }], company: "Acme", jobTitle: "CTO", notes: "Met at a conference" };

describe("ParticipantLink", () => {
    it("is plain text outside a contact card provider", () => {
        render(<Trigger />);
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
        expect(screen.getByText("Jane Doe <jane@other.org>")).toBeInTheDocument();
    });

    it("is a button that opens the card, named by what it shows or by its label", async () => {
        serve();
        const user = userEvent.setup();
        renderCard(
            <>
                <Trigger />
                <ParticipantLink participant={{ address: "bob@other.org" }} label="Contact card for Bob">
                    <span aria-hidden="true">B</span>
                </ParticipantLink>
            </>,
        );
        expect(screen.getByRole("button", { name: "Contact card for Bob" })).toHaveAttribute("type", "button");
        expect(await openCard(user)).toBeInTheDocument();
    });

    it("reports itself unavailable, and does nothing, outside a provider", async () => {
        let added: unknown;
        function Probe() {
            const card = useContactCard();
            return (
                <button
                    type="button"
                    onClick={() => {
                        card.show({ address: "x@y.z" });
                        void card.addVCards("BEGIN:VCARD\nEND:VCARD").then((result) => (added = result));
                    }}
                >
                    {String(card.available)}
                </button>
            );
        }
        render(<Probe />);
        await userEvent.setup().click(screen.getByRole("button", { name: "false" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        await waitFor(() => expect(added).toEqual({ added: 0, skipped: 0 }));
    });
});

describe("ContactCard for someone who is not a contact", () => {
    it("shows an external person with their recent messages and upcoming events, and creates the contact", async () => {
        const m1 = message("m1");
        const m2 = message("m2", { subject: "", bodyPreview: "Second" });
        const { posted } = serve({ messages: [m1, m2], events: [JANE_EVENT] });
        const user = userEvent.setup();
        renderCard();
        const trigger = screen.getByRole("button", { name: "Jane Doe <jane@other.org>" });
        await user.click(trigger);
        const dialog = await screen.findByRole("dialog", { name: "Jane Doe" });

        expect(await within(dialog).findByText("External")).toBeInTheDocument();
        expect(within(dialog).getByRole("heading", { name: "Contact" })).toBeInTheDocument();
        expect(await within(dialog).findByText("Not in your address book.")).toBeInTheDocument();
        const recent = within(dialog).getByRole("heading", { name: "Recent messages" }).parentElement as HTMLElement;
        expect(await within(recent).findByRole("link", { name: /Subject m1/ })).toHaveAttribute("href", "/messages/m1");
        expect(within(recent).getByRole("link", { name: /\(No subject\)/ })).toHaveAttribute("href", "/messages/m2");
        expect(within(recent).getByText("Preview of m1")).toBeInTheDocument();
        const upcoming = within(dialog).getByRole("heading", { name: "Upcoming events" }).parentElement as HTMLElement;
        expect(await within(upcoming).findByRole("link", { name: /Design review/ })).toHaveAttribute("href", "/calendar");

        const create = within(dialog).getByRole("button", { name: "Add to contacts" });
        await waitFor(() => expect(create).toBeEnabled());
        await user.click(create);
        expect(await within(dialog).findByRole("link", { name: "Open contact" })).toHaveAttribute("href", "/contacts/new1");
        expect(posted).toEqual([
            expect.objectContaining({
                displayName: "Jane Doe",
                givenName: "Jane",
                surname: "Doe",
                emails: [{ address: "jane@other.org", type: "other" }],
                mailboxUid: "mb1",
                folderUid: "c1",
            }),
        ]);
        expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "success", title: "Contact created", message: "Jane Doe was added to your contacts." }]);
        expect(within(dialog).queryByText("Not in your address book.")).not.toBeInTheDocument();

        // Closing gives focus back to the participant that was clicked.
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });

    it("says when there are no recent messages or upcoming events", async () => {
        serve();
        const user = userEvent.setup();
        renderCard();
        const dialog = await openCard(user);
        expect(await within(dialog).findByText("No recent messages")).toBeInTheDocument();
        expect(await within(dialog).findByText("No upcoming events")).toBeInTheDocument();
    });

    it("does not call an address in the user's own domains external", async () => {
        serve();
        const user = userEvent.setup();
        renderCard(<Trigger address="colleague@alias.org" displayName="Jane Doe" />);
        const dialog = await openCard(user, "Jane Doe <colleague@alias.org>");
        await within(dialog).findByText("No recent messages");
        expect(within(dialog).queryByText("External")).not.toBeInTheDocument();
    });

    it("fills the card and the new contact in from a vCard attached to the message", async () => {
        const vcard = "BEGIN:VCARD\nN:Doe;Janet;;;\nFN:Janet Doe\nORG:Acme\nTITLE:CTO\nEMAIL;TYPE=WORK:jane@other.org\nTEL;TYPE=WORK:+1 555 0100\nTEL:+1 555 0102\nADR;TYPE=HOME:;;1 Main St;Springfield;IL;62701;USA\nNOTE:Met at a conference\nEND:VCARD";
        const { posted } = serve({ files: { a1: vcard } });
        const user = userEvent.setup();
        const context = { message: message("m9", { from: { address: "jane@other.org", displayName: "Jane Doe", type: "to" } }), attachments: [{ uid: "a1", filename: "jane.vcf", mimeType: "text/vcard", sizeBytes: 200 } as Attachment] };
        renderCard(<Trigger context={context} />);
        const dialog = await openCard(user);
        expect(await within(dialog).findByText("Job title")).toBeInTheDocument();
        expect(within(dialog).getByText("CTO, Acme")).toBeInTheDocument();
        expect(within(dialog).getByText("Phone Work")).toBeInTheDocument();
        expect(within(dialog).getByText("+1 555 0102")).toBeInTheDocument();
        expect(within(dialog).getByText("Address Home")).toBeInTheDocument();
        expect(within(dialog).getByText(/1 Main St/)).toHaveTextContent("1 Main St 62701 Springfield IL USA");
        expect(within(dialog).getByText("Met at a conference")).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Add to contacts" }));
        await within(dialog).findByRole("link", { name: "Open contact" });
        expect(posted[0]).toMatchObject({ displayName: "Janet Doe", givenName: "Janet", surname: "Doe", company: "Acme", jobTitle: "CTO", notes: "Met at a conference" });
        // The name in the dialog title is still the participant's, and the card now shows the stored contact.
        expect(within(dialog).queryByText("Not in your address book.")).not.toBeInTheDocument();
    });

    it("reports a failure to create the contact and lets the user try again", async () => {
        serve({ create: () => jsonResponse(500, { message: "The address book is full" }) });
        const user = userEvent.setup();
        renderCard();
        const dialog = await openCard(user);
        const create = within(dialog).getByRole("button", { name: "Add to contacts" });
        await waitFor(() => expect(create).toBeEnabled());
        await user.click(create);
        await waitFor(() => expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "error", title: "Couldn't create this contact" }]));
        expect(within(dialog).getByRole("button", { name: "Add to contacts" })).toBeEnabled();
        expect(within(dialog).queryByRole("link", { name: "Open contact" })).not.toBeInTheDocument();
    });

    it("reports that there is nowhere to put the contact", async () => {
        serve();
        const user = userEvent.setup();
        // A mailbox owned by somebody else, none of the user's own, and no contacts folder in it.
        renderCard(undefined, connection("ready", [{ ...ME, ownerUserUid: "someone", accessRole: "delegate", uid: "other" }]));
        const dialog = await openCard(user);
        const create = within(dialog).getByRole("button", { name: "Add to contacts" });
        await waitFor(() => expect(create).toBeEnabled());
        await user.click(create);
        await waitFor(() => expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "error", title: "Couldn't create this contact" }]));
    });

    it("keeps going when the card is closed while a contact is being created", async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const { fetchMock } = serve();
        const original = fetchMock.getMockImplementation() as (url: string, init: RequestInit) => Response | Promise<Response>;
        fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
            if (init?.method === "POST") {
                await gate;
            }
            return original(url, init);
        });
        const user = userEvent.setup();
        renderCard();
        const dialog = await openCard(user);
        const create = within(dialog).getByRole("button", { name: "Add to contacts" });
        await waitFor(() => expect(create).toBeEnabled());
        await user.click(create);
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        await act(async () => release());
        await waitFor(() => expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "success", title: "Contact created" }]));
    });
});

describe("ContactCard for a contact", () => {
    it("shows what the address book holds and links to the contact", async () => {
        serve({ contacts: [JANE] });
        const user = userEvent.setup();
        renderCard();
        const dialog = await openCard(user);
        expect(await within(dialog).findByRole("link", { name: "Open contact" })).toHaveAttribute("href", "/contacts/k1");
        expect(within(dialog).queryByRole("button", { name: "Add to contacts" })).not.toBeInTheDocument();
        expect(within(dialog).queryByText("Not in your address book.")).not.toBeInTheDocument();
        for (const text of ["JANE@other.org", "jd@home.net", "j@x.org", "+1 555 0100", "+1 555 0101", "Met at a conference", "Company", "Acme"]) {
            expect(within(dialog).getByText(text)).toBeInTheDocument();
        }
        expect(within(dialog).getByText("Email Work")).toBeInTheDocument();
        expect(within(dialog).getByText("Email Home")).toBeInTheDocument();
        expect(within(dialog).getByText("Phone Home")).toBeInTheDocument();
        expect(within(dialog).getByText("Job title")).toBeInTheDocument();
        expect(within(dialog).getByText("CTO, Acme")).toBeInTheDocument();
    });

    it("closes the card when the contact is opened", async () => {
        serve({ contacts: [JANE] });
        const user = userEvent.setup();
        renderCard();
        await openCard(user);
        const link = await screen.findByRole("link", { name: "Open contact" });
        link.addEventListener("click", (event) => event.preventDefault());
        await user.click(link);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
});

describe("ContactCard actions", () => {
    it("opens a compose window addressed to the person, and closes", async () => {
        serve();
        const user = userEvent.setup();
        renderCard();
        const dialog = await openCard(user);
        await user.click(within(dialog).getByRole("button", { name: "Email" }));
        expect(openCompose).toHaveBeenCalledWith({ to: "Jane Doe <jane@other.org>" });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("closes the card underneath it too, when it was opened from another card", async () => {
        serve();
        const user = userEvent.setup();
        const onCloseUnder = vi.fn();
        renderCard(
            <Modal open onClose={onCloseUnder} title="Event">
                <Trigger />
            </Modal>,
        );
        const dialog = await openCard(user);
        await user.click(within(dialog).getByRole("button", { name: "Email" }));
        expect(onCloseUnder).toHaveBeenCalled();
    });

    it("offers to copy the address", async () => {
        serve();
        const user = userEvent.setup();
        renderCard();
        const dialog = await openCard(user);
        expect(within(dialog).getByRole("button", { name: "Copy address" })).toBeInTheDocument();
    });

    it("opens a message and an event from their rows, closing the card", async () => {
        serve({ messages: [message("m1")], events: [JANE_EVENT] });
        const user = userEvent.setup();
        renderCard();
        await openCard(user);
        for (const name of [/Subject m1/, /Design review/]) {
            const link = await screen.findByRole("link", { name });
            link.addEventListener("click", (event) => event.preventDefault());
            await user.click(link);
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: "Jane Doe <jane@other.org>" }));
            await screen.findByRole("dialog", { name: "Jane Doe" });
        }
    });

    it("shows a new card for the next person clicked", async () => {
        serve();
        const user = userEvent.setup();
        renderCard(
            <>
                <Trigger />
                <Trigger address="bob@other.org" displayName="Bob Brown" />
            </>,
        );
        await openCard(user);
        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "Bob Brown <bob@other.org>" }));
        expect(await screen.findByRole("dialog", { name: "Bob Brown" })).toBeInTheDocument();
    });
});

describe("ContactCard failures", () => {
    it("keeps the rest of the card when one section fails", async () => {
        serve({ contacts: jsonResponse(500, { message: "down" }), messages: jsonResponse(500, { message: "down" }), events: jsonResponse(500, { message: "down" }) });
        const user = userEvent.setup();
        renderCard();
        const dialog = await openCard(user);
        expect(await within(dialog).findByText("Couldn’t check your address book.")).toBeInTheDocument();
        expect(await within(dialog).findByText("Couldn't load recent messages.")).toBeInTheDocument();
        expect(await within(dialog).findByText("Couldn't load upcoming events.")).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Email" })).toBeInTheDocument();
        expect(within(dialog).getAllByText("jane@other.org").length).toBeGreaterThan(0);
    });

    it("fails every section, and nothing else, when the mailboxes cannot be read", async () => {
        serve();
        const user = userEvent.setup();
        renderCard(undefined, connection("error", []));
        const dialog = await openCard(user);
        expect(await within(dialog).findByText("Couldn't load recent messages.")).toBeInTheDocument();
        expect(within(dialog).getByText("Couldn't load upcoming events.")).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Add to contacts" })).toBeDisabled();
    });

    it("waits while the app frame is still checking the mailboxes", async () => {
        serve();
        const user = userEvent.setup();
        renderCard(undefined, connection("checking", []));
        const dialog = await openCard(user);
        expect(within(dialog).getByRole("status", { name: "Loading recent messages" })).toBeInTheDocument();
        expect(within(dialog).queryByText("External")).not.toBeInTheDocument();
    });
});

describe("ContactCard outside the app frame", () => {
    it("asks for the mailboxes itself", async () => {
        const { fetchMock } = serve();
        const user = userEvent.setup();
        renderCard(undefined, null);
        const dialog = await openCard(user);
        expect(await within(dialog).findByText("External")).toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/mail/mailboxes"))).toBe(true);
    });

    it("fails its sections when the mailboxes cannot be listed", async () => {
        serve({ mailboxes: jsonResponse(500, { message: "down" }) });
        const user = userEvent.setup();
        renderCard(undefined, null);
        const dialog = await openCard(user);
        expect(await within(dialog).findByText("Couldn't load recent messages.")).toBeInTheDocument();
    });

    it("drops the mailboxes when the card is closed before they arrive", async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const { fetchMock } = serve();
        const original = fetchMock.getMockImplementation() as (url: string, init: RequestInit) => Response | Promise<Response>;
        fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
            if (url.startsWith("/api/mail/mailboxes")) {
                await gate;
            }
            return original(url, init);
        });
        const user = userEvent.setup();
        renderCard(undefined, null);
        await openCard(user);
        await user.keyboard("{Escape}");
        await act(async () => release());
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("drops a failed mailbox list when the card is closed before it fails", async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const { fetchMock } = serve();
        fetchMock.mockImplementation(async (url: string) => {
            if (url.startsWith("/api/mail/mailboxes")) {
                await gate;
                return jsonResponse(500, { message: "down" });
            }
            return jsonResponse(200, []);
        });
        const user = userEvent.setup();
        renderCard(undefined, null);
        await openCard(user);
        await user.keyboard("{Escape}");
        await act(async () => release());
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
});

describe("ContactCard actions and picture", () => {
    it("stars and unstars a contact, right beside the name", async () => {
        const { fetchMock } = serve({ contacts: [{ ...JANE, version: 3, favorite: false }] });
        const user = userEvent.setup();
        renderCard();
        const dialog = await openCard(user);

        const star = await within(dialog).findByRole("button", { name: "Favorite" });
        expect(star).toHaveAttribute("aria-pressed", "false");
        await user.click(star);
        await waitFor(() => expect(within(dialog).getByRole("button", { name: "Favorite" })).toHaveAttribute("aria-pressed", "true"));
        const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PUT")!;
        expect(put[0]).toBe("/api/mail/contacts/k1");
        expect(JSON.parse((put[1] as RequestInit).body as string)).toMatchObject({ uid: "k1", version: 3, favorite: true });

        await user.click(within(dialog).getByRole("button", { name: "Favorite" }));
        await waitFor(() => expect(within(dialog).getByRole("button", { name: "Favorite" })).toHaveAttribute("aria-pressed", "false"));
    });

    it("has no star for someone who is not a contact yet", async () => {
        serve();
        const user = userEvent.setup();
        renderCard();
        const dialog = await openCard(user);
        await within(dialog).findByRole("button", { name: "Add to contacts" });
        expect(within(dialog).queryByRole("button", { name: "Favorite" })).not.toBeInTheDocument();
    });

    it("says so when the star could not be changed, and keeps the card as it was", async () => {
        serve({ contacts: [{ ...JANE, favorite: false }], update: () => jsonResponse(403, { message: "No." }) });
        const user = userEvent.setup();
        renderCard();
        const dialog = await openCard(user);
        await user.click(await within(dialog).findByRole("button", { name: "Favorite" }));
        await waitFor(() => expect(getNotificationsSnapshot().visible.some((n) => n.title === "Couldn't update this contact")).toBe(true));
        expect(within(dialog).getByRole("button", { name: "Favorite" })).toHaveAttribute("aria-pressed", "false");
    });

    it("ignores a star that finishes after the card is closed", async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const { fetchMock } = serve({ contacts: [{ ...JANE, favorite: false }] });
        const inner = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            if (init?.method === "PUT") {
                await gate;
            }
            return inner(url, init);
        });
        const user = userEvent.setup();
        renderCard();
        const dialog = await openCard(user);
        await user.click(await within(dialog).findByRole("button", { name: "Favorite" }));
        await user.keyboard("{Escape}");
        await act(async () => release());
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("copies the address from an icon right after it, and again from the one after the contact's email", async () => {
        serve({ contacts: [JANE] });
        const user = userEvent.setup();
        const writeText = vi.spyOn(navigator.clipboard, "writeText");
        renderCard();
        const dialog = await openCard(user);

        await user.click(within(dialog).getByRole("button", { name: "Copy address" }));
        await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("jane@other.org"));
        const emails = await within(dialog).findAllByRole("button", { name: "Copy email address" });
        expect(emails).toHaveLength(3);
        await user.click(emails[1]);
        await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("jd@home.net"));
        expect(within(dialog).queryByText("Copy address")).not.toBeInTheDocument();
    });

    it("shows the contact's own picture, then their Gravatar, then initials as each fails to load", async () => {
        localStorage.setItem("rapidmx:gravatar", "on");
        vi.stubGlobal("IntersectionObserver", undefined); // the setup's stub never fires
        serve({ contacts: [{ ...JANE, version: 4, photoBlobKey: "contact-photos/k1/abc" }] });
        const user = userEvent.setup();
        renderCard();
        const dialog = await openCard(user);

        await waitFor(() => expect(dialog.querySelector("img")?.getAttribute("src")).toBe("/api/mail/contacts/k1/photo?v=4"));
        fireEvent.error(dialog.querySelector("img")!);
        await waitFor(() => expect(dialog.querySelector("img")?.getAttribute("src")).toMatch(/^https:\/\/gravatar\.com\/avatar\/[0-9a-f]{64}\?s=144&d=404$/));
        fireEvent.error(dialog.querySelector("img")!);
        await waitFor(() => expect(dialog.querySelector("img")).toBeNull());
        expect(within(dialog).getByText("JD")).toBeInTheDocument();
    });
});

describe("ContactCard photo badge", () => {
    const pick = (name = "me.jpg") => new File([new Uint8Array(4)], name, { type: "image/jpeg" });

    beforeEach(() => {
        vi.mocked(prepareContactPhoto).mockImplementation(async (file: File) => file);
    });

    async function openStoredCard(user: ReturnType<typeof userEvent.setup>) {
        renderCard();
        const dialog = await openCard(user);
        await within(dialog).findByRole("button", { name: "Favorite" });
        return dialog;
    }

    it("saves a picked picture at once, through the prepared file, and shows it", async () => {
        const { fetchMock } = serve({ contacts: [{ ...JANE, version: 3 }] });
        const user = userEvent.setup();
        const dialog = await openStoredCard(user);
        expect(dialog.querySelector("img")).toBeNull();
        await user.click(within(dialog).getByRole("button", { name: "Change contact photo" }));
        expect(screen.queryByRole("menuitem", { name: "Remove photo" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("menuitem", { name: "Upload file" }));

        const ready = pick("ready.jpg");
        vi.mocked(prepareContactPhoto).mockResolvedValueOnce(ready);
        await user.upload(within(dialog).getByLabelText("Contact photo file"), pick());
        await waitFor(() => expect(dialog.querySelector("img")?.getAttribute("src")).toBe("/api/mail/contacts/k1/photo?v=5"));
        const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PUT")!;
        expect(put[0]).toBe("/api/mail/contacts/k1/photo?version=3");
        expect((put[1] as RequestInit).body).toBe(ready);
    });

    it("removes the picture at once from a Remove photo row that is there only when there is one", async () => {
        const { fetchMock } = serve({
            contacts: [{ ...JANE, version: 5, photoBlobKey: "contact-photos/k1/new" }],
            photo: () => jsonResponse(200, { ...JANE, version: 6 }),
        });
        const user = userEvent.setup();
        const dialog = await openStoredCard(user);
        await waitFor(() => expect(dialog.querySelector("img")).not.toBeNull());
        await user.click(within(dialog).getByRole("button", { name: "Change contact photo" }));
        await user.click(screen.getByRole("menuitem", { name: "Remove photo" }));
        await waitFor(() => expect(dialog.querySelector("img")).toBeNull());
        const del = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "DELETE")!;
        expect(del[0]).toBe("/api/mail/contacts/k1/photo?version=5");
        expect(within(dialog).getByText("JD")).toBeInTheDocument();
    });

    it("says so, with the server's reason, when the picture could not be saved, and keeps the card as it was", async () => {
        serve({ contacts: [{ ...JANE }], photo: () => jsonResponse(403, { message: "No." }) });
        const user = userEvent.setup();
        const dialog = await openStoredCard(user);
        await user.upload(within(dialog).getByLabelText("Contact photo file"), pick());
        await waitFor(() => expect(getNotificationsSnapshot().visible.some((n) => n.title === "Couldn't change this contact's photo")).toBe(true));
        expect(dialog.querySelector("img")).toBeNull();
        expect(within(dialog).getByRole("button", { name: "Change contact photo" })).toBeEnabled();
    });

    it("says why a picture could not be used, without asking the server", async () => {
        const { fetchMock } = serve({ contacts: [{ ...JANE }] });
        vi.mocked(prepareContactPhoto).mockRejectedValueOnce(new ContactPhotoError());
        const user = userEvent.setup();
        const dialog = await openStoredCard(user);
        await user.upload(within(dialog).getByLabelText("Contact photo file"), pick("IMG.HEIC"));
        await waitFor(() =>
            expect(
                getNotificationsSnapshot().visible.some((n) => n.title === "Couldn't change this contact's photo" && /isn't supported by your browser/.test(n.message ?? "")),
            ).toBe(true),
        );
        expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "PUT")).toBe(false);
    });

    it("is not there for someone who is not a contact yet", async () => {
        serve();
        const user = userEvent.setup();
        renderCard();
        const dialog = await openCard(user);
        await within(dialog).findByRole("button", { name: "Add to contacts" });
        expect(within(dialog).queryByRole("button", { name: "Change contact photo" })).not.toBeInTheDocument();
    });

    it("is not there for a contact in a mailbox shared view-only", async () => {
        const shared = { ...ME, uid: "mb2", ownerUserUid: "u2", accessRole: "delegate" } as Mailbox;
        mockFetch((url) => {
            const path = url.split("?")[0];
            if (path === "/api/mail/mailboxes/mb2/access/me") return jsonResponse(200, { canUpdate: false });
            if (path === "/api/mail/contacts") return jsonResponse(200, [{ ...JANE, mailboxUid: "mb2" }]);
            if (path === "/api/mail/folders") return jsonResponse(200, [{ uid: "c1", mailboxUid: "mb2", type: "contacts", name: "Contacts" }]);
            return jsonResponse(200, []);
        });
        const user = userEvent.setup();
        renderCard(undefined, connection("ready", [shared]));
        const dialog = await openCard(user);
        await within(dialog).findByRole("button", { name: "Favorite" });
        await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Change contact photo" })).not.toBeInTheDocument());
    });

    it("closes its menu on Escape without closing the card", async () => {
        serve({ contacts: [{ ...JANE }] });
        const user = userEvent.setup();
        const dialog = await openStoredCard(user);
        await user.click(within(dialog).getByRole("button", { name: "Change contact photo" }));
        const menu = screen.getByRole("menu", { name: "Change contact photo" });
        // The card is a dialog above which the menu has to show.
        expect(menu.closest("[role=dialog]")).toHaveClass("z-[1010]");
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(screen.getByRole("dialog", { name: "Jane Doe" })).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Change contact photo" })).toHaveFocus();
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog", { name: "Jane Doe" })).not.toBeInTheDocument();
    });
});
