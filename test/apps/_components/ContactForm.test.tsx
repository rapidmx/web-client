// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import ContactForm from "../../../apps/shared/components/contacts/ContactForm.js";
import { Contact } from "../../../lib/contacts/contactsApi.js";
import { ApiClientContext } from "../../../lib/util/apiClientContext.js";
import { createApiClient } from "../../../lib/util/api.js";

// Making a picture small enough is `preparePhoto.test.ts`'s business (jsdom cannot decode or draw one): here the form is handed the file as it was chosen.
vi.mock("../../../lib/contacts/preparePhoto.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/contacts/preparePhoto.js")>()),
    prepareContactPhoto: vi.fn(async (file: File) => file),
}));

// Most of ContactForm's behavior is exercised through the Contacts page tests (test/apps/contacts); this
// file covers the round-3 fixes: every address is kept, and cleared fields are sent as null on update.

function contact(overrides: Partial<Contact> = {}): Contact {
    return {
        uid: "c1",
        version: 3,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        folderUid: "f1",
        displayName: "Jane Doe",
        givenName: "Jane",
        surname: "Doe",
        company: "Acme",
        jobTitle: "CEO",
        notes: "Met at conf",
        emails: [],
        phones: [],
        addresses: [
            { type: "home", street: "1 Home St" },
            { type: "work", street: "2 Work Ave" },
        ],
        ...overrides,
    };
}

beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ContactForm", () => {
    it("shows and saves every stored address, and edits/removes a non-first one", async () => {
        const fetchMock = mockFetch((_url, init) => jsonResponse(200, { ...contact(), ...JSON.parse(init.body as string) }));
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(<ContactForm contact={contact()} onSaved={onSaved} onCancel={vi.fn()} />);

        const streets = screen.getAllByPlaceholderText("Street");
        expect(streets).toHaveLength(2);
        expect(streets[1]).toHaveValue("2 Work Ave");

        await user.type(screen.getAllByPlaceholderText("City")[1], "Springfield");
        await user.type(screen.getAllByPlaceholderText("State/Province")[1], "IL");
        await user.type(screen.getAllByPlaceholderText("Postal code")[1], "62701");
        await user.type(screen.getAllByPlaceholderText("Country")[1], "USA");
        await user.selectOptions(screen.getByLabelText("Address type 2"), "other");
        await user.click(screen.getByRole("button", { name: "+ Add address" }));
        expect(screen.getAllByPlaceholderText("Street")).toHaveLength(3);
        await user.click(screen.getByRole("button", { name: "Remove address 3" }));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.addresses).toEqual([
            { type: "home", street: "1 Home St" },
            { type: "other", street: "2 Work Ave", city: "Springfield", state: "IL", postalCode: "62701", country: "USA" },
        ]);
    });

    it("sends null for cleared optional fields on update (and only uid/version as identity)", async () => {
        const fetchMock = mockFetch((_url, init) => jsonResponse(200, { ...contact(), ...JSON.parse(init.body as string) }));
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(<ContactForm contact={contact()} onSaved={onSaved} onCancel={vi.fn()} />);

        await user.clear(screen.getByLabelText("First name"));
        await user.clear(screen.getByLabelText("Last name"));
        await user.clear(screen.getByLabelText("Company"));
        await user.clear(screen.getByLabelText("Job title"));
        await user.clear(screen.getByLabelText("Notes"));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/contacts/c1", expect.objectContaining({ method: "PUT" }));
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body).toMatchObject({ uid: "c1", version: 3, givenName: null, surname: null, company: null, jobTitle: null, notes: null });
        expect(body.mailboxUid).toBeUndefined();
    });

    it("omits cleared optional fields on create", async () => {
        const fetchMock = mockFetch((_url, init) => jsonResponse(200, { ...contact(), ...JSON.parse(init.body as string) }));
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(<ContactForm mailboxUid="mb1" folderUid="f1" onSaved={onSaved} onCancel={vi.fn()} />);

        await user.type(screen.getByLabelText("Display name"), "New Person");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body).toMatchObject({ mailboxUid: "mb1", folderUid: "f1", displayName: "New Person", addresses: [] });
        expect("givenName" in body).toBe(false);
    });

    describe("a picture that could not be stored after the contact was saved", () => {
        const png = () => new File(["x"], "me.png", { type: "image/png" });
        const isPhoto = (url: string) => url.includes("/photo");

        it("a new contact is not created twice: the retry only sends the picture again, to the contact that was saved", async () => {
            let photoAttempts = 0;
            const fetchMock = mockFetch((url, init) => {
                if (isPhoto(url)) {
                    photoAttempts++;
                    return photoAttempts === 1 ? jsonResponse(413, { message: "Too large." }) : jsonResponse(200, { ...contact({ uid: "new1", version: 2 }), photoBlobKey: "k" });
                }
                return jsonResponse(200, { ...contact({ uid: "new1", version: 1 }), ...JSON.parse(init.body as string) });
            });
            const onSaved = vi.fn();
            const user = userEvent.setup();
            render(<ContactForm mailboxUid="mb1" folderUid="f1" onSaved={onSaved} onCancel={vi.fn()} />);
            await user.type(screen.getByLabelText("Display name"), "New Person");
            await user.upload(screen.getByLabelText("Contact photo file"), png());
            await user.click(screen.getByRole("button", { name: "Save" }));

            expect(await screen.findByText("Saved, but the picture could not be uploaded: Too large.")).toBeInTheDocument();
            expect(onSaved).not.toHaveBeenCalled();

            await user.click(screen.getByRole("button", { name: "Save" }));
            await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ uid: "new1", version: 2 })));
            const creates = fetchMock.mock.calls.filter(([url, init]) => url === "/api/mail/contacts" && (init as RequestInit).method === "POST");
            expect(creates).toHaveLength(1);
            expect(fetchMock.mock.calls.filter(([url]) => isPhoto(String(url))).map(([url]) => url)).toEqual([
                "/api/mail/contacts/new1/photo?version=1",
                "/api/mail/contacts/new1/photo?version=1",
            ]);
        });

        it("an edited contact is not sent again with its stale version: the retry sends the picture to the saved version", async () => {
            let photoAttempts = 0;
            const fetchMock = mockFetch((url, init) => {
                if (isPhoto(url)) {
                    photoAttempts++;
                    return photoAttempts === 1 ? jsonResponse(415, { message: "Not an image." }) : jsonResponse(200, contact({ version: 5 }));
                }
                return jsonResponse(200, { ...contact(), ...JSON.parse(init.body as string), version: 4 });
            });
            const onSaved = vi.fn();
            const user = userEvent.setup();
            render(<ContactForm contact={contact()} onSaved={onSaved} onCancel={vi.fn()} />);
            await user.upload(screen.getByLabelText("Contact photo file"), png());
            await user.click(screen.getByRole("button", { name: "Save" }));
            expect(await screen.findByText("Saved, but the picture could not be uploaded: Not an image.")).toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Save" }));
            await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ version: 5 })));
            expect(fetchMock.mock.calls.filter(([url]) => url === "/api/mail/contacts/c1")).toHaveLength(1);
            expect(fetchMock.mock.calls.filter(([url]) => isPhoto(String(url))).map(([url]) => url)).toEqual([
                "/api/mail/contacts/c1/photo?version=4",
                "/api/mail/contacts/c1/photo?version=4",
            ]);
        });

        it("saves what was changed since, against the saved version, when the retry follows an edit", async () => {
            let photoAttempts = 0;
            const fetchMock = mockFetch((url, init) => {
                if (isPhoto(url)) {
                    photoAttempts++;
                    return photoAttempts === 1 ? jsonResponse(500, { message: "Storage down." }) : jsonResponse(200, contact({ version: 6 }));
                }
                return jsonResponse(200, { ...contact(), ...JSON.parse(init.body as string), version: 4 });
            });
            const onSaved = vi.fn();
            const user = userEvent.setup();
            render(<ContactForm contact={contact()} onSaved={onSaved} onCancel={vi.fn()} />);
            await user.upload(screen.getByLabelText("Contact photo file"), png());
            await user.click(screen.getByRole("button", { name: "Save" }));
            await screen.findByText(/Saved, but the picture/);

            await user.type(screen.getByLabelText("Company"), " Ltd");
            await user.click(screen.getByRole("button", { name: "Save" }));
            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            const updates = fetchMock.mock.calls.filter(([url]) => url === "/api/mail/contacts/c1").map(([, init]) => JSON.parse((init as RequestInit).body as string));
            expect(updates).toHaveLength(2);
            expect(updates[1]).toMatchObject({ uid: "c1", version: 4, company: "Acme Ltd" });
        });

        it("offers to go on without the picture, which finishes with the contact as saved, and Cancel does the same", async () => {
            mockFetch((url, init) => (isPhoto(url) ? jsonResponse(500, { message: "Storage down." }) : jsonResponse(200, { ...contact(), ...JSON.parse(init.body as string), version: 4 })));
            const onSaved = vi.fn();
            const onCancel = vi.fn();
            const user = userEvent.setup();
            const { unmount } = render(<ContactForm contact={contact()} onSaved={onSaved} onCancel={onCancel} />);
            expect(screen.queryByRole("button", { name: "Continue without the picture" })).not.toBeInTheDocument();
            await user.upload(screen.getByLabelText("Contact photo file"), png());
            await user.click(screen.getByRole("button", { name: "Save" }));
            await screen.findByText(/Saved, but the picture/);

            await user.click(screen.getByRole("button", { name: "Continue without the picture" }));
            expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ version: 4 }));
            unmount();

            const again = render(<ContactForm contact={contact()} onSaved={onSaved} onCancel={onCancel} />);
            await user.upload(screen.getByLabelText("Contact photo file"), png());
            await user.click(screen.getByRole("button", { name: "Save" }));
            await screen.findByText(/Saved, but the picture/);
            await user.click(screen.getByRole("button", { name: "Cancel" }));
            expect(onSaved).toHaveBeenCalledTimes(2);
            expect(onCancel).not.toHaveBeenCalled();
            again.unmount();
        });

        it("says so when the picture could not be sent at all, and a failed contact save is still just that", async () => {
            mockFetch((url) => {
                if (isPhoto(url)) throw new TypeError("Failed to fetch");
                return jsonResponse(200, contact({ version: 4 }));
            });
            const user = userEvent.setup();
            render(<ContactForm contact={contact()} onSaved={vi.fn()} onCancel={vi.fn()} />);
            await user.upload(screen.getByLabelText("Contact photo file"), png());
            await user.click(screen.getByRole("button", { name: "Save" }));
            expect(await screen.findByText("Saved, but the picture could not be uploaded: the server could not be reached.")).toBeInTheDocument();
        });

        it("retries the removal of a picture the same way", async () => {
            let removals = 0;
            const fetchMock = mockFetch((url, init) => {
                if (isPhoto(url)) {
                    removals++;
                    return removals === 1 ? jsonResponse(500, { message: "Storage down." }) : jsonResponse(200, contact({ version: 6 }));
                }
                return jsonResponse(200, { ...contact({ photoBlobKey: "k" }), ...JSON.parse(init.body as string), version: 4 });
            });
            const onSaved = vi.fn();
            const user = userEvent.setup();
            render(<ContactForm contact={contact({ photoBlobKey: "k" })} onSaved={onSaved} onCancel={vi.fn()} />);
            // "Remove photo" is a row of the camera badge's menu.
            await user.click(screen.getByRole("button", { name: "Change contact photo" }));
            await user.click(screen.getByRole("menuitem", { name: "Remove photo" }));
            await user.click(screen.getByRole("button", { name: "Save" }));
            await screen.findByText(/Saved, but the picture could not be removed: Storage down\./);
            await user.click(screen.getByRole("button", { name: "Save" }));
            await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ version: 6 })));
            expect(fetchMock.mock.calls.filter(([url]) => url === "/api/mail/contacts/c1")).toHaveLength(1);
        });
    });

    // Round: apps components under an `ApiClientContext.Provider` (e.g. `tauri-client`) must route through that
    // client's own `baseUrl`/token instead of the default cookie-based `apiFetch()` - see `lib/util/apiClientContext.ts`.
    describe("under an ApiClientContext.Provider", () => {
        it("saves through the default global fetch with no provider above it (unchanged behavior)", async () => {
            const fetchMock = mockFetch((_url, init) => jsonResponse(200, { ...contact(), ...JSON.parse(init.body as string) }));
            const onSaved = vi.fn();
            const user = userEvent.setup();
            render(<ContactForm mailboxUid="mb1" folderUid="f1" onSaved={onSaved} onCancel={vi.fn()} />);

            await user.type(screen.getByLabelText("Display name"), "New Person");
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            expect(fetchMock.mock.calls[0][0]).toBe("/api/mail/contacts");
            expect((fetchMock.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty("Authorization");
        });

        it("saves through the provided ApiClient's own baseUrl and bearer token when one is provided", async () => {
            const fetchMock = mockFetch((_url, init) => jsonResponse(200, { ...contact(), ...JSON.parse(init.body as string) }));
            const client = createApiClient({ baseUrl: "https://acct-a.example.com", getAccessToken: async () => "tok-a" });
            const onSaved = vi.fn();
            const user = userEvent.setup();
            render(
                <ApiClientContext.Provider value={client}>
                    <ContactForm mailboxUid="mb1" folderUid="f1" onSaved={onSaved} onCancel={vi.fn()} />
                </ApiClientContext.Provider>,
            );

            await user.type(screen.getByLabelText("Display name"), "New Person");
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            expect(fetchMock.mock.calls[0][0]).toBe("https://acct-a.example.com/api/mail/contacts");
            expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get("Authorization")).toBe("jwt tok-a");
        });
    });
});
