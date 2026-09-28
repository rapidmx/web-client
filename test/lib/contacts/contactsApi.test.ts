// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../testUtils.js";
import { createApiClient } from "../../../lib/util/api.js";
import {
    createContact,
    createContactList,
    deleteContact,
    deleteContactList,
    fetchPinnedSigningFingerprints,
    getContact,
    listContactLists,
    listContacts,
    listDeletedContacts,
    setContactFavorite,
    updateContact,
    updateContactList,
} from "../../../lib/contacts/contactsApi.js";

const contact = {
    uid: "c1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    folderUid: "f1",
    displayName: "Jane Doe",
    emails: [{ address: "jane@example.com", type: "work" as const }],
    phones: [],
    addresses: [],
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("listContacts", () => {
    it("fetches scoped by folderUid, sorted by display name, with default pagination", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [contact]));
        const result = await listContacts("f1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/contacts?limit=25&page=0&folderUid=f1&sort=" + encodeURIComponent(JSON.stringify({ displayName: "ASC" })),
            expect.anything(),
        );
        expect(result).toEqual([contact]);
    });

    it("forwards a custom page/limit", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listContacts("f1", { page: 2, limit: 10 });
        expect(fetchMock.mock.calls[0][0]).toContain("limit=10&page=2");
    });
});

describe("getContact", () => {
    it("fetches the encoded uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, contact));
        const result = await getContact("c/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/contacts/c%2F1", expect.anything());
        expect(result).toEqual(contact);
    });
});

describe("createContact", () => {
    it("posts the input with empty-array defaults for emails/phones/addresses", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, contact));
        await createContact({ mailboxUid: "mb1", folderUid: "f1", displayName: "Jane Doe" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/contacts",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({
                    emails: [],
                    phones: [],
                    addresses: [],
                    mailboxUid: "mb1",
                    folderUid: "f1",
                    displayName: "Jane Doe",
                }),
            }),
        );
    });

    it("forwards explicit emails/phones/addresses instead of defaulting them", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, contact));
        await createContact({
            mailboxUid: "mb1",
            folderUid: "f1",
            displayName: "Jane Doe",
            emails: [{ address: "jane@example.com", type: "work" }],
        });
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.emails).toEqual([{ address: "jane@example.com", type: "work" }]);
    });
});

describe("updateContact", () => {
    it("PUTs the encoded uid with the input", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...contact, displayName: "Renamed" }));
        const result = await updateContact({
            uid: "c/1",
            version: 0,
            mailboxUid: "mb1",
            folderUid: "f1",
            displayName: "Renamed",
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/contacts/c%2F1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({
                    uid: "c/1",
                    version: 0,
                    mailboxUid: "mb1",
                    folderUid: "f1",
                    displayName: "Renamed",
                }),
            }),
        );
        expect(result.displayName).toBe("Renamed");
    });

    it("accepts a minimal patch carrying only uid/version plus the changed field", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...contact, notes: "hi" }));
        await updateContact({ uid: "c1", version: 2, notes: "hi" });
        expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ uid: "c1", version: 2, notes: "hi" });
    });
});

describe("deleteContact", () => {
    it("DELETEs the encoded uid with the version query param", async () => {
        const fetchMock = mockFetch(() => emptyResponse(200));
        await deleteContact("c/1", 3);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/contacts/c%2F1?version=3",
            expect.objectContaining({ method: "DELETE" }),
        );
    });
});

describe("listDeletedContacts", () => {
    it("fetches scoped by folderUid, constrained to deleted=true", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [{ ...contact, deleted: true }]));
        const result = await listDeletedContacts("f1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/contacts?limit=25&page=0&folderUid=f1&deleted=true&sort=" +
                encodeURIComponent(JSON.stringify({ displayName: "ASC" })),
            expect.anything(),
        );
        expect(result[0].deleted).toBe(true);
    });
});

describe("setContactFavorite", () => {
    it("PUTs only uid/version/favorite, never the contact's other (server-managed) fields", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...contact, favorite: true }));
        await setContactFavorite(contact, true);
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body).toEqual({ uid: "c1", version: 0, favorite: true });
    });
});

describe("listContactLists", () => {
    it("fetches scoped by mailboxUid, sorted by name", async () => {
        const list = { uid: "cl1", version: 0, dateCreated: "", dateModified: "", mailboxUid: "mb1", name: "Friends" };
        const fetchMock = mockFetch(() => jsonResponse(200, [list]));
        const result = await listContactLists("mb1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/contact-lists?limit=25&page=0&mailboxUid=mb1&sort=" + encodeURIComponent(JSON.stringify({ name: "ASC" })),
            expect.anything(),
        );
        expect(result).toEqual([list]);
    });
});

describe("createContactList", () => {
    it("posts mailboxUid/name", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "cl1" }));
        await createContactList({ mailboxUid: "mb1", name: "Friends" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/contact-lists",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ mailboxUid: "mb1", name: "Friends" }) }),
        );
    });
});

describe("updateContactList", () => {
    it("PUTs the encoded uid with the input", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "cl1", name: "Renamed" }));
        const result = await updateContactList({ uid: "cl/1", version: 0, name: "Renamed" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/contact-lists/cl%2F1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "cl/1", version: 0, name: "Renamed" }),
            }),
        );
        expect(result.name).toBe("Renamed");
    });
});

describe("deleteContactList", () => {
    it("DELETEs the encoded uid with the version query param", async () => {
        const fetchMock = mockFetch(() => emptyResponse(200));
        await deleteContactList("cl/1", 2);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/contact-lists/cl%2F1?version=2",
            expect.objectContaining({ method: "DELETE" }),
        );
    });
});

describe("with an explicit ApiClient", () => {
    it("a directly network-backed function (getContact) routes through the given client instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, contact));
        const result = await getContact("c1", client);
        expect(fetchMock).toHaveBeenCalledWith("https://account-a.example.com/api/mail/contacts/c1", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
        expect(result).toEqual(contact);
    });

    it("setContactFavorite (which internally calls updateContact) threads the client through the internal call", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, { ...contact, favorite: true }));
        await setContactFavorite(contact, true, client);
        expect(fetchMock).toHaveBeenCalledWith(
            "https://account-a.example.com/api/mail/contacts/c1",
            expect.objectContaining({ method: "PUT" }),
        );
        expect((fetchMock.mock.calls[0][1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
    });

    it("fetchPinnedSigningFingerprints (which pages via the internal listContactsInFolders helper) threads the client through every page request", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await fetchPinnedSigningFingerprints(["f1"], "jane@example.com", client);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/account-a\.example\.com\/api\/mail\/contacts\?/);
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by a client created elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, contact));
        await getContact("c1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/contacts/c1", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
