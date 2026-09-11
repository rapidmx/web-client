// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch, mockLocation, mockMatchMedia } from "../testUtils.js";
import ContactsPage from "../../../apps/www/contacts/index.js";

// The "Email" toolbar action opens a real `ComposeWindow` overlay — mocked here the same way every
// compose-related test file mocks it, to avoid mounting real TipTap/ProseMirror (which needs DOM APIs
// jsdom doesn't fully implement) in a test file that isn't otherwise exercising the editor itself.
vi.mock("../../../apps/shared/components/mail/compose/RichTextEditor.js", () => ({
    default: () => <textarea data-testid="html-editor" />,
}));

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "My Mail",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};
const contactsFolder = {
    uid: "f-contacts",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    name: "Contacts",
    type: "contacts" as const,
    unreadCount: 0,
    totalCount: 0,
};
const jane = {
    uid: "c1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    folderUid: "f-contacts",
    displayName: "Jane Doe",
    givenName: "Jane",
    surname: "Doe",
    emails: [{ address: "jane@example.com", type: "work" as const }],
    phones: [{ phoneNumber: "555-1234", type: "home" as const }],
    addresses: [{ street: "123 Main St", city: "Springfield", state: "IL", postalCode: "62701", country: "USA", type: "home" as const }],
    company: "Acme",
    jobTitle: "Engineer",
    notes: "VIP customer",
};
const bob = {
    uid: "c2",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    folderUid: "f-contacts",
    displayName: "Bob Smith",
    emails: [],
    phones: [],
    addresses: [],
};

function mockShellAndContacts(
    contacts: unknown[],
    extra?: (url: string, init?: RequestInit) => Response | undefined,
    folders: unknown[] = [contactsFolder],
) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, folders);
        // ContactsSidebar fetches this on mount for "Your contact lists" — empty by default here, since
        // most tests in this file aren't exercising that feature specifically.
        if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, []);
        if (url.startsWith("/api/mail/contacts") && (init?.method ?? "GET") === "GET") return jsonResponse(200, contacts);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ContactsPage", () => {
    it("loads and lists contacts, filtering by name or email as the user types", async () => {
        mockShellAndContacts([jane, bob]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        expect(screen.getByText("Bob Smith")).toBeInTheDocument();
        expect(screen.getByText("jane@example.com")).toBeInTheDocument();

        await user.type(screen.getByLabelText("Search contacts"), "bob");
        expect(screen.queryByText("Jane Doe")).not.toBeInTheDocument();
        expect(screen.getByText("Bob Smith")).toBeInTheDocument();

        await user.clear(screen.getByLabelText("Search contacts"));
        await user.type(screen.getByLabelText("Search contacts"), "jane@example");
        expect(screen.getByText("Jane Doe")).toBeInTheDocument();
        expect(screen.queryByText("Bob Smith")).not.toBeInTheDocument();

        await user.clear(screen.getByLabelText("Search contacts"));
        await user.type(screen.getByLabelText("Search contacts"), "nobody");
        expect(await screen.findByText("No contacts found.")).toBeInTheDocument();
    });

    it("shows 'No contacts found.' when the list is empty", async () => {
        mockShellAndContacts([]);
        render(<ContactsPage userUid="u1" />);
        expect(await screen.findByText("No contacts found.")).toBeInTheDocument();
    });

    it("shows an error message when loading contacts fails", async () => {
        mockShellAndContacts([], (url, init) =>
            url.startsWith("/api/mail/contacts") && (init?.method ?? "GET") === "GET" ? jsonResponse(500, { message: "boom" }) : undefined,
        );
        render(<ContactsPage userUid="u1" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading contacts fails with a non-API error", async () => {
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [contactsFolder]);
            if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, []);
            throw new TypeError("network down");
        });
        render(<ContactsPage userUid="u1" />);
        expect(await screen.findByText("Could not load contacts.")).toBeInTheDocument();
    });

    it("shows the 'select a contact' placeholder, and no list flashes 'Loading…' forever, when the mailbox has no contacts folder yet", async () => {
        mockShellAndContacts([], undefined, []);
        render(<ContactsPage userUid="u1" />);
        expect(await screen.findByText("Select a contact, or create a new one.")).toBeInTheDocument();
        expect(await screen.findByText("No contacts found.")).toBeInTheDocument();
    });

    it("selecting a contact shows its full detail view", async () => {
        mockShellAndContacts([jane, bob]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByText("Jane Doe"));

        expect(screen.getByRole("heading", { name: "Jane Doe" })).toBeInTheDocument();
        expect(screen.getByText("Engineer at Acme")).toBeInTheDocument();
        expect(screen.getAllByText(/jane@example\.com/)).toHaveLength(2); // sidebar preview + detail panel
        expect(screen.getByText("(work)")).toBeInTheDocument();
        expect(screen.getByText(/555-1234/)).toBeInTheDocument();
        expect(screen.getByText("123 Main St, Springfield, IL, 62701, USA")).toBeInTheDocument();
        expect(screen.getByText("VIP customer")).toBeInTheDocument();
    });

    it("detail view shows a contact's categories when it has any.", async () => {
        const categorized = { ...jane, categories: ["VIP", "Work"] };
        mockShellAndContacts([categorized]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByText("Jane Doe"));

        const detail = within(screen.getByRole("region", { name: "Contact details" }));
        expect(detail.getByText("Categories")).toBeInTheDocument();
        expect(detail.getByText("VIP, Work")).toBeInTheDocument();
    });

    it("detail view omits empty sections (no company/title, email, phone, address, notes)", async () => {
        mockShellAndContacts([jane, bob]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByText("Bob Smith"));

        const detail = within(screen.getByRole("region", { name: "Contact details" }));
        expect(detail.getByRole("heading", { name: "Bob Smith" })).toBeInTheDocument();
        expect(detail.queryByText(/ at /)).not.toBeInTheDocument();
        expect(detail.queryByText("Email")).not.toBeInTheDocument();
        expect(detail.queryByText("Phone")).not.toBeInTheDocument();
        expect(detail.queryByText("Address")).not.toBeInTheDocument();
        expect(detail.queryByText("Notes")).not.toBeInTheDocument();
    });

    it("clicking + New contact shows a blank form", async () => {
        mockShellAndContacts([jane]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByRole("button", { name: "New contact" }));

        expect(screen.getByRole("heading", { name: "New contact" })).toBeInTheDocument();
        expect(screen.getByLabelText("Display name")).toHaveValue("");
    });

    it("creating a new contact posts the input and shows the saved contact", async () => {
        const created = { ...jane, uid: "c3", displayName: "New Person", emails: [], phones: [], addresses: [], notes: undefined };
        // The list panel's post-save `reload()` must see the newly created contact, so this mock's GET
        // response reflects whatever's been POSTed so far, rather than a fixed list.
        let allContacts: unknown[] = [];
        const fetchMock = mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [contactsFolder]);
            if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, []);
            if (url === "/api/mail/contacts" && init?.method === "POST") {
                allContacts = [...allContacts, created];
                return jsonResponse(200, created);
            }
            if (url.startsWith("/api/mail/contacts") && (init?.method ?? "GET") === "GET") return jsonResponse(200, allContacts);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: "New contact" }));
        await user.type(screen.getByLabelText("Display name"), "New Person");
        await user.type(screen.getByLabelText("First name"), "New");
        await user.type(screen.getByLabelText("Last name"), "Person");
        await user.type(screen.getByLabelText("Company"), "Acme");
        await user.type(screen.getByLabelText("Job title"), "Engineer");
        await user.type(screen.getByLabelText("Notes"), "Met at conference");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/contacts",
                expect.objectContaining({ method: "POST" }),
            ),
        );
        const body = JSON.parse(
            (fetchMock.mock.calls.find((c) => c[0] === "/api/mail/contacts" && (c[1] as RequestInit).method === "POST")![1] as RequestInit)
                .body as string,
        );
        expect(body).toEqual(
            expect.objectContaining({
                mailboxUid: "mb1",
                folderUid: "f-contacts",
                displayName: "New Person",
                givenName: "New",
                surname: "Person",
                company: "Acme",
                jobTitle: "Engineer",
                notes: "Met at conference",
                emails: [],
                phones: [],
                addresses: [],
            }),
        );
        expect(await screen.findByRole("heading", { name: "New Person" })).toBeInTheDocument();
    });

    it("shows a validation error and does not submit when display name is blank", async () => {
        const fetchMock = mockShellAndContacts([]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: "New contact" }));
        const callsBefore = fetchMock.mock.calls.length;
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("A display name is required.")).toBeInTheDocument();
        expect(fetchMock.mock.calls.length).toBe(callsBefore);
    });

    it("shows an error message when creating a contact fails", async () => {
        mockShellAndContacts([], (url, init) =>
            url === "/api/mail/contacts" && init?.method === "POST" ? jsonResponse(500, { message: "create failed" }) : undefined,
        );
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: "New contact" }));
        await user.type(screen.getByLabelText("Display name"), "New Person");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("create failed")).toBeInTheDocument();
    });

    it("shows a generic error message when creating a contact fails with a non-API error", async () => {
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [contactsFolder]);
            if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, []);
            if (url.startsWith("/api/mail/contacts") && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: "New contact" }));
        await user.type(screen.getByLabelText("Display name"), "New Person");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Could not save this contact.")).toBeInTheDocument();
    });

    it("editing a contact pre-fills the form and PUTs the changes", async () => {
        // Same reasoning as the "creating" test above: the post-save `reload()` must see the rename.
        let allContacts: unknown[] = [jane];
        const fetchMock = mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [contactsFolder]);
            if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, []);
            if (url === "/api/mail/contacts/c1" && init?.method === "PUT") {
                const renamed = { ...jane, displayName: "Jane Renamed" };
                allContacts = allContacts.map((c) => ((c as { uid: string }).uid === "c1" ? renamed : c));
                return jsonResponse(200, renamed);
            }
            if (url.startsWith("/api/mail/contacts") && (init?.method ?? "GET") === "GET") return jsonResponse(200, allContacts);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByText("Jane Doe"));
        await user.click(within(screen.getByRole("region", { name: "Contact details" })).getByRole("button", { name: "Edit" }));

        expect(screen.getByLabelText("Display name")).toHaveValue("Jane Doe");
        expect(screen.getByLabelText("First name")).toHaveValue("Jane");
        expect(screen.getByLabelText("Email address 1")).toHaveValue("jane@example.com");
        expect(screen.getByLabelText("Phone number 1")).toHaveValue("555-1234");

        await user.clear(screen.getByLabelText("Display name"));
        await user.type(screen.getByLabelText("Display name"), "Jane Renamed");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/contacts/c1", expect.objectContaining({ method: "PUT" })));
        expect(await screen.findByRole("heading", { name: "Jane Renamed" })).toBeInTheDocument();
    });

    it("Cancel on the form returns to the detail view", async () => {
        mockShellAndContacts([jane]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByText("Jane Doe"));
        await user.click(within(screen.getByRole("region", { name: "Contact details" })).getByRole("button", { name: "Edit" }));
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        expect(screen.getByRole("heading", { name: "Jane Doe" })).toBeInTheDocument();
    });

    it("deleting a contact removes the selection and reloads the list", async () => {
        const fetchMock = mockShellAndContacts([jane, bob], (url, init) =>
            url === "/api/mail/contacts/c1?version=0" && init?.method === "DELETE" ? emptyResponse(200) : undefined,
        );
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByText("Jane Doe"));
        await user.click(within(screen.getByRole("region", { name: "Contact details" })).getByRole("button", { name: "Delete" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/contacts/c1?version=0", expect.objectContaining({ method: "DELETE" })),
        );
        expect(await screen.findByText("Select a contact, or create a new one.")).toBeInTheDocument();
    });

    it("shows an error message when deleting a contact fails", async () => {
        mockShellAndContacts([jane], (url, init) =>
            url === "/api/mail/contacts/c1?version=0" && init?.method === "DELETE" ? jsonResponse(500, { message: "delete failed" }) : undefined,
        );
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByText("Jane Doe"));
        await user.click(within(screen.getByRole("region", { name: "Contact details" })).getByRole("button", { name: "Delete" }));

        expect(await screen.findByText("delete failed")).toBeInTheDocument();
    });

    it("shows a generic error message when deleting a contact fails with a non-API error", async () => {
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [contactsFolder]);
            if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, []);
            if (url.startsWith("/api/mail/contacts") && (init?.method ?? "GET") === "GET") return jsonResponse(200, [jane]);
            if (url === "/api/mail/contacts/c1?version=0" && init?.method === "DELETE") throw new TypeError("network down");
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByText("Jane Doe"));
        await user.click(within(screen.getByRole("region", { name: "Contact details" })).getByRole("button", { name: "Delete" }));

        expect(await screen.findByText("Could not delete this contact.")).toBeInTheDocument();
    });

    it("adds and removes an email row", async () => {
        mockShellAndContacts([]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: "New contact" }));
        await user.click(screen.getByRole("button", { name: "+ Add email" }));
        await user.click(screen.getByRole("button", { name: "+ Add email" }));

        await user.type(screen.getByLabelText("Email address 1"), "first@example.com");
        await user.type(screen.getByLabelText("Email address 2"), "second@example.com");
        expect(screen.getByLabelText("Email address 1")).toHaveValue("first@example.com");
        expect(screen.getByLabelText("Email address 2")).toHaveValue("second@example.com");

        // Editing row 2 must leave row 1 untouched — exercises the "not this index" branch of the map.
        await user.selectOptions(screen.getByLabelText("Email type 2"), "home");
        expect(screen.getByLabelText("Email type 2")).toHaveValue("home");
        expect(screen.getByLabelText("Email address 1")).toHaveValue("first@example.com");

        await user.click(screen.getByRole("button", { name: "Remove email 1" }));
        expect(screen.queryByLabelText("Email address 2")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Email address 1")).toHaveValue("second@example.com");
    });

    it("adds and removes a phone row", async () => {
        mockShellAndContacts([]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: "New contact" }));
        await user.click(screen.getByRole("button", { name: "+ Add phone" }));
        await user.click(screen.getByRole("button", { name: "+ Add phone" }));

        await user.type(screen.getByLabelText("Phone number 1"), "555-1111");
        await user.type(screen.getByLabelText("Phone number 2"), "555-9999");
        expect(screen.getByLabelText("Phone number 1")).toHaveValue("555-1111");
        expect(screen.getByLabelText("Phone number 2")).toHaveValue("555-9999");

        // Editing row 2 must leave row 1 untouched — exercises the "not this index" branch of the map.
        await user.selectOptions(screen.getByLabelText("Phone type 2"), "other");
        expect(screen.getByLabelText("Phone type 2")).toHaveValue("other");
        expect(screen.getByLabelText("Phone number 1")).toHaveValue("555-1111");

        await user.click(screen.getByRole("button", { name: "Remove phone 1" }));
        expect(screen.queryByLabelText("Phone number 2")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Phone number 1")).toHaveValue("555-9999");
    });

    it("adds and removes an address", async () => {
        mockShellAndContacts([]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: "New contact" }));
        await user.click(screen.getByRole("button", { name: "+ Add address" }));

        const addressField = screen.getByText("Address").closest("div") as HTMLElement;
        await user.type(within(addressField).getByPlaceholderText("Street"), "1 Infinite Loop");
        expect(within(addressField).getByPlaceholderText("Street")).toHaveValue("1 Infinite Loop");
        await user.type(within(addressField).getByPlaceholderText("City"), "Cupertino");
        await user.type(within(addressField).getByPlaceholderText("State/Province"), "CA");
        await user.type(within(addressField).getByPlaceholderText("Postal code"), "95014");
        await user.type(within(addressField).getByPlaceholderText("Country"), "USA");
        expect(within(addressField).getByPlaceholderText("City")).toHaveValue("Cupertino");
        expect(within(addressField).getByPlaceholderText("State/Province")).toHaveValue("CA");
        expect(within(addressField).getByPlaceholderText("Postal code")).toHaveValue("95014");
        expect(within(addressField).getByPlaceholderText("Country")).toHaveValue("USA");

        await user.selectOptions(screen.getByLabelText("Address type"), "work");
        expect(screen.getByLabelText("Address type")).toHaveValue("work");

        await user.click(screen.getByRole("button", { name: "Remove address" }));
        expect(screen.queryByPlaceholderText("Street")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "+ Add address" })).toBeInTheDocument();
    });

    it("saves the favorite checkbox and categories field.", async () => {
        const fetchMock = mockShellAndContacts([]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: "New contact" }));
        await user.type(screen.getByLabelText("Display name"), "New Person");
        await user.click(screen.getByRole("checkbox", { name: "Favorite" }));
        await user.type(screen.getByLabelText("Categories (comma-separated)"), "VIP, Work");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/contacts", expect.objectContaining({ method: "POST" })));
        const body = JSON.parse(
            (fetchMock.mock.calls.find((c) => c[0] === "/api/mail/contacts" && (c[1] as RequestInit).method === "POST")![1] as RequestInit)
                .body as string,
        );
        expect(body.favorite).toBe(true);
        expect(body.categories).toEqual(["VIP", "Work"]);
    });
});

describe("ContactsPage — sidebar views, sorting, and toolbar bulk actions", () => {
    const favContact = { ...bob, uid: "c3", displayName: "Fav Person", favorite: true };
    const listedContact = { ...bob, uid: "c4", displayName: "Listed Person", contactListUid: "l1" };
    const categorizedContact = { ...bob, uid: "c5", displayName: "VIP Person", categories: ["VIP"] };
    const list = { uid: "l1", version: 0, dateCreated: "", dateModified: "", mailboxUid: "mb1", name: "Friends" };

    function mockShellAndContactsWithLists(contacts: unknown[], lists: unknown[] = [list], extra?: (url: string, init?: RequestInit) => Response | undefined) {
        return mockFetch((url, init) => {
            const custom = extra?.(url, init);
            if (custom) return custom;
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [contactsFolder]);
            if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, lists);
            if (url.startsWith("/api/mail/contacts/deleted-marker")) return jsonResponse(200, []);
            if (url.includes("deleted=true")) return jsonResponse(200, [{ ...jane, deleted: true }]);
            if (url.startsWith("/api/mail/contacts") && (init?.method ?? "GET") === "GET") return jsonResponse(200, contacts);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
    }

    it("Favorites view shows only favorited contacts.", async () => {
        mockShellAndContactsWithLists([jane, favContact]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByText("Favorites"));

        expect(await screen.findByText("Fav Person")).toBeInTheDocument();
        expect(screen.queryByText("Jane Doe")).not.toBeInTheDocument();
    });

    it("a contact list view shows only contacts in that list.", async () => {
        mockShellAndContactsWithLists([jane, listedContact]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(await screen.findByText("Friends"));

        expect(await screen.findByText("Listed Person")).toBeInTheDocument();
        expect(screen.queryByText("Jane Doe")).not.toBeInTheDocument();
    });

    it("a category view shows only contacts with that category.", async () => {
        mockShellAndContactsWithLists([jane, categorizedContact]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(await screen.findByText("VIP"));

        expect(await screen.findByText("VIP Person")).toBeInTheDocument();
        expect(screen.queryByText("Jane Doe")).not.toBeInTheDocument();
    });

    it("the Deleted view fetches and shows soft-deleted contacts, with no checkbox column.", async () => {
        mockShellAndContactsWithLists([bob]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Bob Smith");
        await user.click(screen.getByText("Deleted"));

        expect(await screen.findByText("Jane Doe")).toBeInTheDocument();
        expect(screen.queryByLabelText("Select Jane Doe")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Select all contacts")).not.toBeInTheDocument();
    });

    it("shows an error, using the ApiRequestError message, when loading deleted contacts fails.", async () => {
        const { ApiRequestError } = await import("@rapidmx/react-shared/api.js");
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [contactsFolder]);
            if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, []);
            if (url.includes("deleted=true")) throw new ApiRequestError("nope", 500);
            if (url.startsWith("/api/mail/contacts") && (init?.method ?? "GET") === "GET") return jsonResponse(200, [bob]);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Bob Smith");
        await user.click(screen.getByText("Deleted"));

        expect(await screen.findByText("nope")).toBeInTheDocument();
    });

    it("shows a generic error message when loading deleted contacts fails with a non-API error.", async () => {
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [contactsFolder]);
            if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, []);
            if (url.includes("deleted=true")) throw new TypeError("network down");
            if (url.startsWith("/api/mail/contacts") && (init?.method ?? "GET") === "GET") return jsonResponse(200, [bob]);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Bob Smith");
        await user.click(screen.getByText("Deleted"));

        expect(await screen.findByText("Could not load deleted contacts.")).toBeInTheDocument();
    });

    it("sorts by Name ascending/descending, and by Contact info, toggling direction on repeated clicks.", async () => {
        mockShellAndContactsWithLists([jane, bob]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        function names() {
            return screen.getAllByRole("row").slice(1).map((row) => row.textContent);
        }
        // Default: ascending by name -> Bob before Jane.
        expect(names()[0]).toContain("Bob Smith");

        await user.click(screen.getByText("Name", { exact: false }));
        expect(names()[0]).toContain("Jane Doe");

        await user.click(screen.getByText("Contact info", { exact: false }));
        // Bob has no email/phone (empty string sorts first ascending).
        expect(names()[0]).toContain("Bob Smith");

        await user.click(screen.getByText("Contact info", { exact: false }));
        expect(names()[0]).toContain("Jane Doe");
    });

    it("select-all checkbox checks/unchecks every visible row, and enables/disables toolbar actions.", async () => {
        mockShellAndContactsWithLists([jane, bob]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select all contacts"));

        expect(screen.getByLabelText("Select Jane Doe")).toBeChecked();
        expect(screen.getByLabelText("Select Bob Smith")).toBeChecked();
        expect(within(screen.getByRole("toolbar")).getByText("Delete").closest("button")).not.toBeDisabled();

        await user.click(screen.getByLabelText("Select all contacts"));
        expect(screen.getByLabelText("Select Jane Doe")).not.toBeChecked();
    });

    it("an individual row checkbox can be checked, then unchecked again independently.", async () => {
        mockShellAndContactsWithLists([jane, bob]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select Jane Doe"));
        expect(screen.getByLabelText("Select Jane Doe")).toBeChecked();

        await user.click(screen.getByLabelText("Select Jane Doe"));
        expect(screen.getByLabelText("Select Jane Doe")).not.toBeChecked();
    });

    it("toolbar Edit opens the edit form for the single checked contact.", async () => {
        mockShellAndContactsWithLists([jane, bob]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select Jane Doe"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Edit"));

        expect(screen.getByRole("heading", { name: "Edit contact" })).toBeInTheDocument();
        expect(screen.getByLabelText("Display name")).toHaveValue("Jane Doe");
    });

    it("toolbar Delete removes every checked contact.", async () => {
        const deletedCalls: string[] = [];
        const fetchMock = mockShellAndContactsWithLists([jane, bob], [list], (url, init) => {
            if (init?.method === "DELETE") {
                deletedCalls.push(url);
                return emptyResponse(200);
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select all contacts"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Delete"));

        await waitFor(() => expect(deletedCalls.length).toBe(2));
        expect(fetchMock).toHaveBeenCalled();
    });

    it("toolbar Delete shows an error, using the ApiRequestError message, when one deletion fails.", async () => {
        const { ApiRequestError } = await import("@rapidmx/react-shared/api.js");
        mockShellAndContactsWithLists([jane], [list], (url, init) => {
            if (init?.method === "DELETE") throw new ApiRequestError("cannot delete", 403);
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select Jane Doe"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Delete"));

        expect(await screen.findByText("cannot delete")).toBeInTheDocument();
    });

    it("toolbar Delete shows a generic error message when one deletion fails with a non-API error.", async () => {
        mockShellAndContactsWithLists([jane], [list], (url, init) => {
            if (init?.method === "DELETE") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select Jane Doe"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Delete"));

        expect(await screen.findByText("Could not delete one or more contacts.")).toBeInTheDocument();
    });

    it("toolbar Email opens the floating Compose window with the checked contacts' addresses joined.", async () => {
        mockShellAndContactsWithLists([jane, bob]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select all contacts"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Email"));

        // Bob has no email, so only Jane's address should appear.
        expect(await screen.findByRole("dialog", { name: "New Message" })).toBeInTheDocument();
        expect(screen.getByLabelText("To")).toHaveValue("jane@example.com");
    });

    it("toolbar Favorite marks every checked contact favorited, then relabels to Unfavorite once all are.", async () => {
        const fetchMock = mockShellAndContactsWithLists([jane, bob], [list], (url, init) => {
            if (init?.method === "PUT") {
                const body = JSON.parse(init.body as string);
                return jsonResponse(200, { ...jane, ...body });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select Jane Doe"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Favorite"));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/contacts/c1",
                expect.objectContaining({ method: "PUT", body: expect.stringContaining('"favorite":true') }),
            ),
        );
    });

    it("toolbar Favorite shows an error when updating a checked contact's favorite status fails.", async () => {
        mockShellAndContactsWithLists([jane], [list], (url, init) => {
            if (init?.method === "PUT") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select Jane Doe"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Favorite"));

        expect(await screen.findByText("Could not update one or more contacts.")).toBeInTheDocument();
    });

    it("toolbar Favorite shows the ApiRequestError message when updating a checked contact fails.", async () => {
        const { ApiRequestError } = await import("@rapidmx/react-shared/api.js");
        mockShellAndContactsWithLists([jane], [list], (url, init) => {
            if (init?.method === "PUT") throw new ApiRequestError("cannot favorite", 403);
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select Jane Doe"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Favorite"));

        expect(await screen.findByText("cannot favorite")).toBeInTheDocument();
    });

    it("toolbar Add category prompts for a name and appends it to every checked contact.", async () => {
        const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("VIP");
        const fetchMock = mockShellAndContactsWithLists([jane], [list], (url, init) => {
            if (init?.method === "PUT") {
                const body = JSON.parse(init.body as string);
                return jsonResponse(200, { ...jane, ...body });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select Jane Doe"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Add category"));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/contacts/c1",
                expect.objectContaining({ method: "PUT", body: expect.stringContaining('"categories":["VIP"]') }),
            ),
        );
        promptSpy.mockRestore();
    });

    it("toolbar Add category does nothing when the prompt is cancelled or left blank.", async () => {
        const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
        const fetchMock = mockShellAndContactsWithLists([jane], [list]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select Jane Doe"));
        const callsBefore = fetchMock.mock.calls.length;
        await user.click(within(screen.getByRole("toolbar")).getByText("Add category"));

        expect(fetchMock.mock.calls.length).toBe(callsBefore);
        promptSpy.mockRestore();
    });

    it("toolbar Add category shows a generic error message when updating a checked contact fails.", async () => {
        const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("VIP");
        mockShellAndContactsWithLists([jane], [list], (url, init) => {
            if (init?.method === "PUT") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select Jane Doe"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Add category"));

        expect(await screen.findByText("Could not update one or more contacts.")).toBeInTheDocument();
        promptSpy.mockRestore();
    });

    it("toolbar Add category shows the ApiRequestError message when updating a checked contact fails.", async () => {
        const { ApiRequestError } = await import("@rapidmx/react-shared/api.js");
        const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("VIP");
        mockShellAndContactsWithLists([jane], [list], (url, init) => {
            if (init?.method === "PUT") throw new ApiRequestError("cannot categorize", 403);
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select Jane Doe"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Add category"));

        expect(await screen.findByText("cannot categorize")).toBeInTheDocument();
        promptSpy.mockRestore();
    });

    it("toolbar Export downloads a single contact's vCard, named after them.", async () => {
        mockShellAndContactsWithLists([jane, bob]);
        const user = userEvent.setup();
        const createObjectURL = vi.fn(() => "blob:fake");
        const revokeObjectURL = vi.fn();
        vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
        const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
        let downloadedFilename = "";
        vi.spyOn(HTMLAnchorElement.prototype, "download", "set").mockImplementation(function (this: any, v: string) {
            downloadedFilename = v;
        });
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select Jane Doe"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Export"));

        expect(clickSpy).toHaveBeenCalledTimes(1);
        expect(downloadedFilename).toBe("Jane Doe.vcf");
        clickSpy.mockRestore();
    });

    it("toolbar Export downloads a combined vCard file named 'contacts.vcf' for multiple selected contacts.", async () => {
        mockShellAndContactsWithLists([jane, bob]);
        const user = userEvent.setup();
        vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: vi.fn() });
        const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
        let downloadedFilename = "";
        vi.spyOn(HTMLAnchorElement.prototype, "download", "set").mockImplementation(function (this: any, v: string) {
            downloadedFilename = v;
        });
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select all contacts"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Export"));

        expect(downloadedFilename).toBe("contacts.vcf");
        clickSpy.mockRestore();
    });

    it("toolbar Import parses a .vcf file and creates each contact it contains.", async () => {
        const createdBodies: any[] = [];
        const fetchMock = mockShellAndContactsWithLists([], [list], (url, init) => {
            if (url === "/api/mail/contacts" && init?.method === "POST") {
                createdBodies.push(JSON.parse(init.body as string));
                return jsonResponse(200, { ...bob, uid: "new" });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);
        await screen.findByText("No contacts found.");

        const vcard = "BEGIN:VCARD\r\nFN:Imported Person\r\nEMAIL:imported@example.com\r\nEND:VCARD";
        const file = new File([vcard], "contacts.vcf", { type: "text/vcard" });
        await user.upload(screen.getByLabelText("Import contacts file"), file);

        await waitFor(() => expect(createdBodies).toHaveLength(1));
        expect(createdBodies[0]).toEqual(
            expect.objectContaining({ mailboxUid: "mb1", folderUid: "f-contacts", displayName: "Imported Person" }),
        );
        expect(fetchMock).toHaveBeenCalled();
    });

    it("toolbar Import shows a generic error message when creating one of the imported contacts fails.", async () => {
        mockShellAndContactsWithLists([], [list], (url, init) => {
            if (url === "/api/mail/contacts" && init?.method === "POST") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);
        await screen.findByText("No contacts found.");

        const vcard = "BEGIN:VCARD\r\nFN:Imported Person\r\nEND:VCARD";
        const file = new File([vcard], "contacts.vcf", { type: "text/vcard" });
        await user.upload(screen.getByLabelText("Import contacts file"), file);

        expect(await screen.findByText("Could not import one or more contacts.")).toBeInTheDocument();
    });

    it("toolbar Import shows the ApiRequestError message when creating one of the imported contacts fails.", async () => {
        const { ApiRequestError } = await import("@rapidmx/react-shared/api.js");
        mockShellAndContactsWithLists([], [list], (url, init) => {
            if (url === "/api/mail/contacts" && init?.method === "POST") throw new ApiRequestError("cannot import", 403);
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);
        await screen.findByText("No contacts found.");

        const vcard = "BEGIN:VCARD\r\nFN:Imported Person\r\nEND:VCARD";
        const file = new File([vcard], "contacts.vcf", { type: "text/vcard" });
        await user.upload(screen.getByLabelText("Import contacts file"), file);

        expect(await screen.findByText("cannot import")).toBeInTheDocument();
    });

    it("toolbar Import does nothing when the mailbox has no contacts folder yet.", async () => {
        // Empty folders list, same fixture shape as the "no contacts folder yet" test above — folderUid
        // never resolves, so this exercises handleImportFile's own early-return guard.
        const user = userEvent.setup();
        const fetchMock = mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, []);
            if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, []);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        render(<ContactsPage userUid="u1" />);
        await screen.findByText("Select a contact, or create a new one.");

        const callsBefore = fetchMock.mock.calls.length;
        const file = new File(["BEGIN:VCARD\r\nFN:Nobody\r\nEND:VCARD"], "contacts.vcf", { type: "text/vcard" });
        await user.upload(screen.getByLabelText("Import contacts file"), file);

        expect(fetchMock.mock.calls.length).toBe(callsBefore);
    });

    describe("on mobile", () => {
        it("navigates to the contact detail route instead of selecting in place when a row is tapped", async () => {
            mockMatchMedia(true);
            mockShellAndContacts([jane]);
            const location = mockLocation();
            const user = userEvent.setup();
            render(<ContactsPage userUid="u1" />);

            await user.click(await screen.findByText("Jane Doe"));

            expect(location.href).toBe("/contacts/c1");
            expect(screen.queryByRole("region", { name: "Contact details" })).not.toBeInTheDocument();
        });

        it("still creates a new contact in place — an unsaved contact has no uid for a route", async () => {
            mockMatchMedia(true);
            const fetchMock = mockShellAndContacts([], (url, init) => {
                if (url === "/api/mail/contacts" && init?.method === "POST") {
                    return jsonResponse(200, { ...jane, uid: "new-c" });
                }
                return undefined;
            });
            const user = userEvent.setup();
            render(<ContactsPage userUid="u1" />);
            await screen.findByText("No contacts found.");

            await user.click(screen.getByRole("button", { name: "New contact" }));
            expect(screen.getByRole("heading", { name: "New contact" })).toBeInTheDocument();

            await user.type(screen.getByLabelText("Display name"), "Jane Doe");
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith("/api/mail/contacts", expect.objectContaining({ method: "POST" })),
            );
        });
    });
});
