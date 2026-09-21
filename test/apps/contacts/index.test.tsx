// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch, mockLocation, mockMatchMedia } from "../testUtils.js";
import ContactsPageRouted from "../../../apps/www/contacts/index.js";

// The page's own component: what a test renders is the page, not the client-side router around it (see `routedPage()`).
const ContactsPage = ContactsPageRouted.page;

// The "Email" toolbar action opens a real `ComposeWindow` overlay — mocked here the same way every
// compose-related test file mocks it, to avoid mounting real TipTap/ProseMirror (which needs DOM APIs
// jsdom doesn't fully implement) in a test file that isn't otherwise exercising the editor itself.
vi.mock("../../../apps/shared/components/mail/compose/RichTextEditor.js", () => ({
    default: () => <textarea data-testid="html-editor" />,
}));

// Lets a test mark specific `listAllPages()` results as truncated (one entry per call, in call order)
// without fetching 20,000 fixtures; every other call passes through to the real implementation.
const { truncateNextLists } = vi.hoisted(() => ({ truncateNextLists: [] as boolean[] }));
vi.mock("../../../apps/shared/mail/listAllPages.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../apps/shared/mail/listAllPages.js")>();
    return {
        ...actual,
        listAllPages: async (...args: Parameters<typeof actual.listAllPages>) => {
            const result = await actual.listAllPages(...args);
            return truncateNextLists.shift() ? { ...result, truncated: true } : result;
        },
    };
});

// Round 6: every contact add/update/delete drops the trusted-signer pins cached from contacts.
const { clearPinnedSignerCache } = vi.hoisted(() => ({ clearPinnedSignerCache: vi.fn() }));
vi.mock("../../../apps/shared/components/mail/pinnedSigners.js", () => ({ clearPinnedSignerCache }));

// Key rotation continuity: a contact's key change is resolved through resolveKeyConflict(), mocked at the module
// boundary (see .claude/NOTES.md on fetch stubs not reaching keyvaultApi.js).
const { resolveKeyConflict } = vi.hoisted(() => ({ resolveKeyConflict: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/keyvaultApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/crypto/keyvaultApi.js")>()),
    resolveKeyConflict,
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

/** The recipients a compose field shows as chips. */
function recipientChips(label: string): (string | null)[] {
    return within(screen.getByRole("list", { name: `${label} recipients` }))
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("title"));
}

afterEach(() => {
    vi.unstubAllGlobals();
    truncateNextLists.length = 0;
    clearPinnedSignerCache.mockClear();
    resolveKeyConflict.mockReset();
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
        expect(detail.queryByText("Encryption")).not.toBeInTheDocument();
    });

    it("detail view shows the contact's encryption preference and key fingerprints when known", async () => {
        const encrypting = {
            ...jane,
            encryptPreference: { preferEncrypt: "mutual" as const },
            keys: [
                {
                    publicKey: "base64cert",
                    type: "x509",
                    useType: "encrypt" as const,
                    fingerprint: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
                    notBefore: 1,
                    notAfter: 2,
                },
            ],
        };
        mockShellAndContacts([encrypting]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByText("Jane Doe"));

        const detail = within(screen.getByRole("region", { name: "Contact details" }));
        expect(detail.getByText("Encryption")).toBeInTheDocument();
        expect(detail.getByText(/also encrypts to you/)).toBeInTheDocument();
        expect(detail.getByText(/Encryption key: abcd 1234/)).toBeInTheDocument();
    });

    it("detail view marks a revoked key and shows a 'no preference' message when the contact hasn't opted into mutual encryption", async () => {
        const revoked = {
            ...bob,
            encryptPreference: { preferEncrypt: "nopreference" as const },
            keys: [
                {
                    publicKey: "base64cert",
                    type: "x509",
                    useType: "sign" as const,
                    fingerprint: "ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000",
                    notBefore: 1,
                    notAfter: 2,
                    revokedAt: 3,
                },
            ],
        };
        mockShellAndContacts([revoked]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByText("Bob Smith"));

        const detail = within(screen.getByRole("region", { name: "Contact details" }));
        expect(detail.getByText(/has not indicated a mutual encryption preference/)).toBeInTheDocument();
        expect(detail.getByText(/Signing key: ffff 0000/)).toBeInTheDocument();
        expect(detail.getByText("(revoked)")).toBeInTheDocument();
    });

    it("detail view shows a key change with both fingerprints, keeps the pinned key, and reloads after accepting it", async () => {
        const pinned = {
            publicKey: "base64cert",
            type: "x509",
            useType: "encrypt" as const,
            fingerprint: "1111222211112222111122221111222211112222111122221111222211112222",
            notBefore: 1,
            notAfter: 2,
        };
        const conflicted = {
            ...jane,
            keys: [pinned],
            keyConflicts: [
                {
                    useType: "encrypt" as const,
                    observedKey: { ...pinned, fingerprint: "9999888899998888999988889999888899998888999988889999888899998888" },
                    observedAt: new Date("2026-02-01T00:00:00.000Z").getTime(),
                    source: "discovery" as const,
                },
            ],
        };
        const resolved = { ...jane, keys: [{ ...pinned, fingerprint: "9999888899998888999988889999888899998888999988889999888899998888" }] };
        let contactsServed = 0;
        const fetchMock = mockShellAndContacts([], (url, init) => {
            if (url.startsWith("/api/mail/contacts") && (init?.method ?? "GET") === "GET") {
                contactsServed++;
                return jsonResponse(200, contactsServed === 1 ? [conflicted] : [resolved]);
            }
            return undefined;
        });
        resolveKeyConflict.mockResolvedValue({ keys: resolved.keys });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByText("Jane Doe"));

        const detail = within(screen.getByRole("region", { name: "Contact details" }));
        const change = within(detail.getByRole("region", { name: "Encryption key change" }));
        expect(change.getByText("A different encryption key was seen for Jane Doe")).toBeInTheDocument();
        expect(change.getByText("9999 8888 9999 8888 9999 8888 9999 8888 9999 8888 9999 8888 9999 8888 9999 8888")).toBeInTheDocument();
        expect(change.getByText(`First seen ${new Date("2026-02-01T00:00:00.000Z").toLocaleDateString()}, by key discovery`)).toBeInTheDocument();
        expect(screen.queryByText(/There is no automatic way to accept or reject this yet/)).not.toBeInTheDocument();
        // The pinned key is still shown, unchanged - the spec's "retain the previously stored key".
        expect(detail.getByText(/Encryption key: 1111 2222/)).toBeInTheDocument();

        await user.click(change.getByRole("button", { name: "Accept new key" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Accept new key" }));

        expect(await detail.findByText("The new encryption key is now trusted for Jane Doe.")).toBeInTheDocument();
        expect(resolveKeyConflict).toHaveBeenCalledWith("mb1", {
            address: "jane@example.com",
            useType: "encrypt",
            action: "accept",
            expectedPinnedFingerprint: pinned.fingerprint,
        });
        expect(clearPinnedSignerCache).toHaveBeenCalled();
        await waitFor(() => expect(detail.queryByRole("region", { name: "Encryption key change" })).not.toBeInTheDocument());
        expect(detail.getByText(/Encryption key: 9999 8888/)).toBeInTheDocument();
        expect(contactsServed).toBe(2);
        expect(fetchMock).toHaveBeenCalled();
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

    it("with more than one mailbox, a new contact can be created in another mailbox, which then offers a link to it", async () => {
        const sharedMailbox = { ...mailbox, uid: "mb-shared", ownerUserUid: undefined, displayName: "Support" };
        const sharedContactsFolder = { ...contactsFolder, uid: "f-shared-contacts", mailboxUid: "mb-shared" };
        const fetchMock = mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox, sharedMailbox]);
            if (url.startsWith("/api/mail/folders")) {
                return jsonResponse(200, url.includes("mailboxUid=mb-shared") ? [sharedContactsFolder] : [contactsFolder]);
            }
            if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, []);
            if (url === "/api/mail/contacts" && init?.method === "POST") {
                const body = JSON.parse(init.body as string);
                return jsonResponse(200, { ...jane, uid: "c9", ...body });
            }
            if (url.startsWith("/api/mail/contacts") && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: "New contact" }));
        // Scoped to the form - the Contacts app's own mailbox switcher is also labeled "Mailbox".
        const form = within(screen.getByRole("heading", { name: "New contact" }).closest("form")!);
        expect(form.getByLabelText("Mailbox")).toHaveValue("mb1");
        await user.selectOptions(form.getByLabelText("Mailbox"), "mb-shared");
        await user.type(screen.getByLabelText("Display name"), "Vendor Rep");
        await user.click(screen.getByRole("button", { name: "Save" }));

        const status = await screen.findByRole("status");
        expect(status).toHaveTextContent("Vendor Rep was added to Support.");
        expect(within(status).getByRole("link", { name: "View that mailbox’s contacts" })).toHaveAttribute("href", "/contacts?mailboxUid=mb-shared");
        const post = fetchMock.mock.calls.find(([url, init]) => url === "/api/mail/contacts" && (init as RequestInit)?.method === "POST")!;
        expect(JSON.parse((post[1] as RequestInit).body as string)).toMatchObject({ mailboxUid: "mb-shared", folderUid: "f-shared-contacts" });
    });

    it("refuses to create a contact in another mailbox that has no Contacts folder", async () => {
        const sharedMailbox = { ...mailbox, uid: "mb-shared", ownerUserUid: undefined, displayName: "Support" };
        const fetchMock = mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox, sharedMailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, url.includes("mailboxUid=mb-shared") ? [] : [contactsFolder]);
            if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, []);
            if (url.startsWith("/api/mail/contacts") && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: "New contact" }));
        const form = within(screen.getByRole("heading", { name: "New contact" }).closest("form")!);
        await user.selectOptions(form.getByLabelText("Mailbox"), "mb-shared");
        await user.type(screen.getByLabelText("Display name"), "Vendor Rep");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("That mailbox has no Contacts folder.")).toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalledWith("/api/mail/contacts", expect.objectContaining({ method: "POST" }));
    });

    it("names an unnamed other mailbox generically after creating a contact in it", async () => {
        const sharedMailbox = { ...mailbox, uid: "mb-shared", ownerUserUid: undefined, displayName: undefined };
        const sharedContactsFolder = { ...contactsFolder, uid: "f-shared-contacts", mailboxUid: "mb-shared" };
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox, sharedMailbox]);
            if (url.startsWith("/api/mail/folders")) {
                return jsonResponse(200, url.includes("mailboxUid=mb-shared") ? [sharedContactsFolder] : [contactsFolder]);
            }
            if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, []);
            if (url === "/api/mail/contacts" && init?.method === "POST") {
                const body = JSON.parse(init.body as string);
                return jsonResponse(200, { ...jane, uid: "c9", ...body });
            }
            if (url.startsWith("/api/mail/contacts") && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: "New contact" }));
        const form = within(screen.getByRole("heading", { name: "New contact" }).closest("form")!);
        await user.selectOptions(form.getByLabelText("Mailbox"), "mb-shared");
        await user.type(screen.getByLabelText("Display name"), "Vendor Rep");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByRole("status")).toHaveTextContent("Vendor Rep was added to another mailbox.");
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
        expect(clearPinnedSignerCache).toHaveBeenCalled();
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
        expect(clearPinnedSignerCache).toHaveBeenCalledTimes(1);
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
            // Distinguish the single-mailbox GET (ComposeWindow.tsx's own getMailbox(mailboxUid) call,
            // fired unconditionally on mount - see the "toolbar Email" test below) from the mailbox-list
            // GET (MailShell's own resolution) - both start with the same prefix, but only the list form
            // is array-wrapped. Returning the array for both used to be harmless (nothing read a field
            // that collided with an Array.prototype method), but ComposeWindow now reads `mailbox.keys` -
            // `[mailbox].keys` resolves to the built-in Array.prototype.keys function instead of
            // `undefined`, which does NOT get replaced by `?? []` and crashes findActivePublicKey().
            if (url.startsWith("/api/mail/mailboxes/")) return jsonResponse(200, mailbox);
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

    it("says so when the contact list (or the Deleted view) stopped at the page cap", async () => {
        truncateNextLists.push(true, false);
        mockShellAndContactsWithLists([bob]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Bob Smith");
        expect(screen.getByText(/more contacts than can be shown at once - only the first 20000 are/)).toBeInTheDocument();

        await user.click(screen.getByText("Deleted"));
        expect(await screen.findByText("Jane Doe")).toBeInTheDocument();
        expect(screen.queryByText(/more contacts than can be shown at once/)).not.toBeInTheDocument();
    });

    it("shows the truncation notice in the Deleted view when only that list was cut off", async () => {
        truncateNextLists.push(false, true);
        mockShellAndContactsWithLists([bob]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Bob Smith");
        expect(screen.queryByText(/more contacts than can be shown at once/)).not.toBeInTheDocument();
        await user.click(screen.getByText("Deleted"));
        expect(await screen.findByText(/more contacts than can be shown at once/)).toBeInTheDocument();
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
        const { ApiRequestError } = await import("@rapidmx/react-shared/util/api.js");
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
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));

        await waitFor(() => expect(deletedCalls.length).toBe(2));
        expect(fetchMock).toHaveBeenCalled();
        await waitFor(() => expect(clearPinnedSignerCache).toHaveBeenCalledTimes(1));
    });

    it("toolbar Delete shows an error, using the ApiRequestError message, when one deletion fails.", async () => {
        const { ApiRequestError } = await import("@rapidmx/react-shared/util/api.js");
        mockShellAndContactsWithLists([jane], [list], (url, init) => {
            if (init?.method === "DELETE") throw new ApiRequestError("cannot delete", 403);
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select Jane Doe"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Delete"));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));

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
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));

        expect(await screen.findByText("Could not delete one or more contacts.")).toBeInTheDocument();
    });

    it("toolbar Delete asks first, naming how many contacts, and deletes nothing when cancelled or dismissed.", async () => {
        const fetchMock = mockShellAndContactsWithLists([jane, bob]);
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select Jane Doe"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Delete"));
        expect(within(await screen.findByRole("dialog")).getByText(/Delete 1 selected contact\?/)).toBeInTheDocument();
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

        await user.click(screen.getByLabelText("Select Bob Smith"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Delete"));
        expect(within(await screen.findByRole("dialog")).getByText(/Delete 2 selected contacts\?/)).toBeInTheDocument();
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

        expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
    });

    it("toolbar Add category sends only uid, version, and the new categories.", async () => {
        const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(" Work ");
        const categorized = { ...jane, categories: ["VIP"] };
        const fetchMock = mockShellAndContactsWithLists([categorized], [list], (url, init) =>
            init?.method === "PUT" ? jsonResponse(200, categorized) : undefined,
        );
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select Jane Doe"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Add category"));

        await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(true));
        const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
        expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ uid: "c1", version: 0, categories: ["VIP", "Work"] });
        promptSpy.mockRestore();
    });

    it("toolbar Export keeps the download URL alive for a while instead of revoking it immediately.", async () => {
        mockShellAndContactsWithLists([jane]);
        const user = userEvent.setup();
        const revokeObjectURL = vi.fn();
        vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL });
        const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
        const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
        render(<ContactsPage userUid="u1" />);

        await screen.findByText("Jane Doe");
        await user.click(screen.getByLabelText("Select Jane Doe"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Export"));

        expect(clickSpy).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).not.toHaveBeenCalled();
        const revokeTimer = timeoutSpy.mock.calls.find(([, delay]) => delay === 60_000)!;
        (revokeTimer[0] as () => void)();
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
        expect(document.querySelector('a[download]')).toBeNull();
        timeoutSpy.mockRestore();
        clickSpy.mockRestore();
    });

    it("pages through a folder with more contacts than one page holds, in both the main and Deleted views.", async () => {
        const firstPage = Array.from({ length: 500 }, (_, i) => ({ ...bob, uid: `bulk-${i}`, displayName: `Bulk ${String(i).padStart(3, "0")}` }));
        const fetchMock = mockShellAndContactsWithLists([], [list], (url, init) => {
            if (url.startsWith("/api/mail/contacts?") && (init?.method ?? "GET") === "GET") {
                const deleted = url.includes("deleted=true");
                if (url.includes("page=1")) {
                    return jsonResponse(200, [{ ...bob, uid: deleted ? "d-last" : "c-last", displayName: deleted ? "Zed Deleted" : "Zed Last", deleted }]);
                }
                return jsonResponse(200, deleted ? firstPage.map((c) => ({ ...c, deleted: true })) : firstPage);
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactsPage userUid="u1" />);

        expect(await screen.findByText("Zed Last")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /Deleted/ }));
        expect(await screen.findByText("Zed Deleted")).toBeInTheDocument();
        const pageOneCalls = fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("/api/mail/contacts?") && url.includes("page=1"));
        expect(pageOneCalls).toHaveLength(2);
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
        // The window's frame is up on the click; its fields arrive with its code.
        await waitFor(() => expect(recipientChips("To")).toEqual(["jane@example.com"]));
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
        await waitFor(() => expect(clearPinnedSignerCache).toHaveBeenCalled());
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
        const { ApiRequestError } = await import("@rapidmx/react-shared/util/api.js");
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
        await waitFor(() => expect(clearPinnedSignerCache).toHaveBeenCalled());
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
        const { ApiRequestError } = await import("@rapidmx/react-shared/util/api.js");
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
        await waitFor(() => expect(clearPinnedSignerCache).toHaveBeenCalled());
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
        const { ApiRequestError } = await import("@rapidmx/react-shared/util/api.js");
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
    describe("round 5: the Deleted view for delegates", () => {
        const delegatedMailbox = { ...mailbox, ownerUserUid: "boss" };

        function mockDelegate(access: (() => Response) | undefined) {
            return mockFetch((url, init) => {
                if (url === "/api/mail/mailboxes/mb1/access/me") {
                    if (!access) throw new Error("network down");
                    return access();
                }
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [delegatedMailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [contactsFolder]);
                if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/contacts") && (init?.method ?? "GET") === "GET") return jsonResponse(200, [bob]);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
        }

        const accessWith = (canUpdate: boolean, canDelete: boolean) => () =>
            jsonResponse(200, { canRead: true, canCreate: canUpdate, canUpdate, canDelete, canManage: false });

        it("offers the Deleted view to an owner without asking the server", async () => {
            const fetchMock = mockShellAndContacts([bob]);
            render(<ContactsPage userUid="u1" />);
            await screen.findByText("Bob Smith");

            expect(screen.getAllByRole("button", { name: "Deleted" }).length).toBeGreaterThan(0);
            expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/access/me"))).toBe(false);
        });

        it("offers the Deleted view to a delegate with delete and update rights", async () => {
            mockDelegate(accessWith(true, true));
            render(<ContactsPage userUid="u1" />);
            await screen.findByText("Bob Smith");

            expect((await screen.findAllByRole("button", { name: "Deleted" })).length).toBeGreaterThan(0);
        });

        it.each([
            ["update but not delete", accessWith(true, false)],
            ["delete but not update", accessWith(false, true)],
            ["read only", accessWith(false, false)],
        ])("hides the Deleted view from a delegate with %s", async (_label, access) => {
            const fetchMock = mockDelegate(access);
            render(<ContactsPage userUid="u1" />);
            await screen.findByText("Bob Smith");

            await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/mail/mailboxes/mb1/access/me")).toBe(true));
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(screen.queryByRole("button", { name: "Deleted" })).not.toBeInTheDocument();
        });

        it("hides the Deleted view when the access check fails", async () => {
            const fetchMock = mockDelegate(undefined);
            render(<ContactsPage userUid="u1" />);
            await screen.findByText("Bob Smith");

            await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/mail/mailboxes/mb1/access/me")).toBe(true));
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(screen.queryByRole("button", { name: "Deleted" })).not.toBeInTheDocument();
        });

        it("round 6: says so, and lists nothing, when the server ignores the deleted filter (no rights on the contacts folder)", async () => {
            // A mailbox-level delegate can still lack delete/update on the folder's own ACL: restapi then drops
            // `deleted=true` and answers with live contacts.
            mockFetch((url, init) => {
                if (url === "/api/mail/mailboxes/mb1/access/me") return accessWith(true, true)();
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [delegatedMailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [contactsFolder]);
                if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, []);
                if (url.includes("deleted=true")) return jsonResponse(200, [{ ...jane, deleted: true }, bob]);
                if (url.startsWith("/api/mail/contacts") && (init?.method ?? "GET") === "GET") return jsonResponse(200, [bob]);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<ContactsPage userUid="u1" />);
            await screen.findByText("Bob Smith");

            await user.click((await screen.findAllByRole("button", { name: "Deleted" }))[0]);
            expect(await screen.findByText("You don't have permission to view deleted contacts in this folder.")).toBeInTheDocument();
            expect(screen.queryByText("Bob Smith")).not.toBeInTheDocument();
            expect(screen.queryByText("Jane Doe")).not.toBeInTheDocument();
            expect(screen.getByText("No contacts found.")).toBeInTheDocument();
        });

        it("hides key change actions from a delegate who can't update the mailbox, and shows them to one who can", async () => {
            const conflicted = {
                ...jane,
                keys: [{ publicKey: "p", type: "x509", useType: "sign" as const, fingerprint: "aaaa", notBefore: 1, notAfter: 2 }],
                keyConflicts: [
                    {
                        useType: "sign" as const,
                        observedKey: { publicKey: "p", type: "x509", useType: "sign" as const, fingerprint: "bbbb", notBefore: 1, notAfter: 2 },
                        observedAt: 1,
                        source: "header" as const,
                    },
                ],
            };
            for (const [canUpdate, visible] of [
                [false, false],
                [true, true],
            ] as const) {
                const fetchMock = mockFetch((url, init) => {
                    if (url === "/api/mail/mailboxes/mb1/access/me") return accessWith(canUpdate, false)();
                    if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [delegatedMailbox]);
                    if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [contactsFolder]);
                    if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, []);
                    if (url.startsWith("/api/mail/contacts") && (init?.method ?? "GET") === "GET") return jsonResponse(200, [conflicted]);
                    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
                });
                const user = userEvent.setup();
                const { unmount } = render(<ContactsPage userUid="u1" />);
                await user.click(await screen.findByText("Jane Doe"));
                await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/mail/mailboxes/mb1/access/me")).toBe(true));
                const change = within(await screen.findByRole("region", { name: "Signing key change" }));
                if (visible) {
                    expect(await change.findByRole("button", { name: "Accept new key" })).toBeInTheDocument();
                } else {
                    await waitFor(() => expect(change.queryByRole("button", { name: "Accept new key" })).not.toBeInTheDocument());
                }
                unmount();
                vi.unstubAllGlobals();
            }
        });

        it("ignores an access answer that arrives after unmounting", async () => {
            let answer!: (response: Response) => void;
            mockDelegate(() => new Promise<Response>((resolve) => (answer = resolve)) as unknown as Response);
            const { unmount } = render(<ContactsPage userUid="u1" />);
            await screen.findByText("Bob Smith");
            await waitFor(() => expect(answer).toBeDefined());

            unmount();
            answer(accessWith(true, true)());
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
    });
});


describe("ContactsPage keyboard shortcuts", () => {
    const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) => fireEvent.keyDown(target, { key, ...init });

    it("Alt+N starts a new contact, as the toolbar's New contact does - and Ctrl+N only in the desktop client", async () => {
        mockShellAndContacts([jane]);
        render(<ContactsPage userUid="u1" />);
        await screen.findByText("Jane Doe");

        expect(press("n", { ctrlKey: true })).toBe(true);
        expect(screen.queryByRole("heading", { name: "New contact" })).not.toBeInTheDocument();
        expect(press("n", { altKey: true })).toBe(false);
        expect(screen.getByRole("heading", { name: "New contact" })).toBeInTheDocument();
    });

    it("Ctrl+N is the same key in the desktop client", async () => {
        (window as { rapidmx?: unknown }).rapidmx = {};
        try {
            mockShellAndContacts([jane]);
            render(<ContactsPage userUid="u1" />);
            await screen.findByText("Jane Doe");

            expect(press("n", { ctrlKey: true })).toBe(false);
            expect(screen.getByRole("heading", { name: "New contact" })).toBeInTheDocument();
        } finally {
            delete (window as { rapidmx?: unknown }).rapidmx;
        }
    });

    it("focuses the search box with / and with Ctrl+E - and leaves / to the box once it has the focus", async () => {
        mockShellAndContacts([jane]);
        render(<ContactsPage userUid="u1" />);
        await screen.findByText("Jane Doe");
        const search = screen.getByLabelText("Search contacts");

        expect(press("/")).toBe(false);
        expect(search).toHaveFocus();
        expect(press("/", {}, search)).toBe(true);
        (document.activeElement as HTMLElement).blur();
        expect(press("e", { ctrlKey: true })).toBe(false);
        expect(search).toHaveFocus();
    });

    it("names the shortcut on the New contact button, leaving its name alone", async () => {
        mockShellAndContacts([jane]);
        render(<ContactsPage userUid="u1" />);
        await screen.findByText("Jane Doe");

        const button = screen.getByRole("button", { name: "New contact" });
        expect(button).toHaveAttribute("title", "New contact (Alt+N)");
        expect(button).toHaveAttribute("aria-keyshortcuts", "Alt+N");
        // The other toolbar buttons have no shortcut.
        expect(screen.getByRole("button", { name: "Export" })).not.toHaveAttribute("aria-keyshortcuts");
    });

    it("has no keys while the new-contact form's own dialog-like fields have the focus for typing", async () => {
        mockShellAndContacts([jane]);
        render(<ContactsPage userUid="u1" />);
        await screen.findByText("Jane Doe");
        press("n", { altKey: true });
        const name = screen.getByLabelText("Display name");

        expect(press("/", {}, name)).toBe(true);
        expect(press("e", {}, name)).toBe(true);
    });
});
