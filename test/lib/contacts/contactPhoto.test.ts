// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { createApiClient } from "../../../lib/util/api.js";
import { contactPhotoUrl, deleteContactPhoto, fetchContactPhoto, uploadContactPhoto } from "../../../lib/contacts/contactsApi.js";

afterEach(() => vi.unstubAllGlobals());

describe("contactPhotoUrl", () => {
    it("is the picture's URL, versioned so a replaced one is fetched again, or nothing when there is none", () => {
        expect(contactPhotoUrl({ uid: "a/b", version: 7, photoBlobKey: "contact-photos/a/x" })).toBe("/api/mail/contacts/a%2Fb/photo?v=7");
        expect(contactPhotoUrl({ uid: "a", version: 7 })).toBeUndefined();
    });
});

describe("uploadContactPhoto", () => {
    it("sends the file's own bytes and type at the version, and returns the contact", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "c1", version: 5 }));
        const file = new File([new Uint8Array(4)], "me.png", { type: "image/png" });
        await expect(uploadContactPhoto("c1", 4, file)).resolves.toEqual({ uid: "c1", version: 5 });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("/api/mail/contacts/c1/photo?version=4");
        expect(init).toMatchObject({ method: "PUT", credentials: "include", body: file });
        expect(new Headers((init as RequestInit).headers).get("Content-Type")).toBe("image/png");
    });

    it.each([
        [() => jsonResponse(413, { message: "Too big." }), "Too big.", 413],
        [() => jsonResponse(400, { error: "Bad image." }), "Bad image.", 400],
        [() => new Response("nope", { status: 500, statusText: "Server Error" }), "Server Error", 500],
        [() => new Response("nope", { status: 500, statusText: "" }), "Upload failed.", 500],
        [() => new Response("not json", { status: 502, statusText: "Bad Gateway", headers: { "content-type": "application/json" } }), "Bad Gateway", 502],
    ])("says why it was refused (%#)", async (response, message, status) => {
        mockFetch(() => response());
        await expect(uploadContactPhoto("c1", 4, new File([], "x.png", { type: "image/png" }))).rejects.toMatchObject({ message, status });
    });
});

describe("deleteContactPhoto", () => {
    it("deletes at the version, through the client it is given", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "c1", version: 6 }));
        const client = createApiClient({ baseUrl: "https://a.example.com", getAccessToken: async () => "tok" });
        await expect(deleteContactPhoto("c1", 5, client)).resolves.toEqual({ uid: "c1", version: 6 });
        expect(fetchMock.mock.calls[0][0]).toBe("https://a.example.com/api/mail/contacts/c1/photo?version=5");
        expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
    });
});

describe("uploadContactPhoto through an explicit client", () => {
    it("goes to the client's origin with its token and the file's type, no cookie and no CSRF header", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "c1", version: 5 }));
        const client = createApiClient({ baseUrl: "https://a.example.com", getAccessToken: async () => "tok" });
        const file = new File([new Uint8Array(4)], "me.jpg", { type: "image/jpeg" });
        await expect(uploadContactPhoto("c1", 4, file, client)).resolves.toEqual({ uid: "c1", version: 5 });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("https://a.example.com/api/mail/contacts/c1/photo?version=4");
        expect(init).toMatchObject({ method: "PUT", body: file });
        expect((init as RequestInit).credentials).toBeUndefined();
        const headers = (init as RequestInit).headers as Headers;
        expect(headers.get("Content-Type")).toBe("image/jpeg");
        expect(headers.get("Authorization")).toBe("jwt tok");
    });
});

describe("fetchContactPhoto", () => {
    it("fetches the picture's bytes through the client at the version", async () => {
        const fetchMock = mockFetch(() => new Response(new Uint8Array(2), { status: 200, headers: { "content-type": "image/png" } }));
        const client = createApiClient({ baseUrl: "https://a.example.com", getAccessToken: async () => "tok" });
        const blob = await fetchContactPhoto("a/b", 7, client);
        expect(fetchMock.mock.calls[0][0]).toBe("https://a.example.com/api/mail/contacts/a%2Fb/photo?v=7");
        expect(blob.size).toBe(2);
    });
});
