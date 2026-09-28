// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { createVideoMeeting, getVideoMeeting, listVideoMeetings, updateVideoMeeting } from "../../../lib/videoconf/videoMeetingsApi.js";
import { createApiClient } from "../../../lib/util/api.js";

const meeting = {
    uid: "vm1",
    mailboxUid: "mb1",
    title: "Standup",
    visibility: "private" as const,
    status: "scheduled" as const,
    calendarEventUid: "e1",
    dateCreated: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("createVideoMeeting", () => {
    it("POSTs the input and returns the meeting with its invitee and organizer join links", async () => {
        const created = {
            meeting,
            invitees: [{ uid: "i1", email: "bob@example.com", displayName: "Bob", joinUrl: "https://meet.example.com/tok-bob" }],
            organizerJoinUrl: "https://meet.example.com/tok-org",
        };
        const fetchMock = mockFetch(() => jsonResponse(200, created));
        const input = {
            mailboxUid: "mb1",
            title: "Standup",
            visibility: "private" as const,
            calendarEventUid: "e1",
            startTime: "2026-01-05T09:00:00.000Z",
            endTime: "2026-01-05T09:30:00.000Z",
            invitees: [{ email: "bob@example.com", displayName: "Bob" }],
        };
        const result = await createVideoMeeting(input);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/video-meetings",
            expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
        );
        expect(result).toEqual(created);
    });

    it("rejects with the server's own message when a private meeting has no invitees", async () => {
        mockFetch(() => jsonResponse(400, { message: "'invitees' must name at least one person.", code: "api-400" }));
        await expect(
            createVideoMeeting({ mailboxUid: "mb1", title: "Standup", visibility: "private", invitees: [] }),
        ).rejects.toMatchObject({ message: "'invitees' must name at least one person.", status: 400, code: "api-400" });
    });
});

describe("updateVideoMeeting", () => {
    it("PUTs a cancellation to the encoded uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...meeting, status: "cancelled" }));
        const result = await updateVideoMeeting("vm/1", { status: "cancelled" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/video-meetings/vm%2F1",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ status: "cancelled" }) }),
        );
        expect(result.status).toBe("cancelled");
    });

    it("PUTs a new title", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...meeting, title: "Renamed" }));
        await updateVideoMeeting("vm1", { title: "Renamed" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/video-meetings/vm1",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ title: "Renamed" }) }),
        );
    });

    it("rejects when the caller no longer owns the meeting", async () => {
        mockFetch(() => jsonResponse(403, { message: "Forbidden.", code: "api-103" }));
        await expect(updateVideoMeeting("vm1", { status: "cancelled" })).rejects.toMatchObject({ status: 403, code: "api-103" });
    });
});

describe("getVideoMeeting", () => {
    it("GETs the encoded uid and returns the organizer's own join link with the meeting", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...meeting, organizerJoinUrl: "https://meet.example.com/tok-org" }));
        const result = await getVideoMeeting("vm/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/video-meetings/vm%2F1", expect.anything());
        expect(result.organizerJoinUrl).toBe("https://meet.example.com/tok-org");
    });

    it("rejects with a 404 when the plugin isn't installed (its routes aren't mounted at all)", async () => {
        mockFetch(() => jsonResponse(404, { message: "Not found." }));
        await expect(getVideoMeeting("vm1")).rejects.toMatchObject({ status: 404 });
    });
});

describe("listVideoMeetings", () => {
    it("GETs the mailbox's meetings with the default paging query, each carrying its own join link", async () => {
        const pub = { ...meeting, uid: "vm2", visibility: "public" as const, calendarEventUid: undefined, publicJoinUrl: "https://meet.example.com/slug" };
        const priv = { ...meeting, organizerJoinUrl: "https://meet.example.com/tok-org" };
        const fetchMock = mockFetch(() => jsonResponse(200, [pub, priv]));
        const result = await listVideoMeetings("mb1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/video-meetings?limit=25&page=0&mailboxUid=mb1", expect.anything());
        expect(result).toEqual([pub, priv]);
    });

    it("passes explicit limit/page through", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [meeting]));
        await listVideoMeetings("mb1", { limit: 100, page: 2 });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/video-meetings?limit=100&page=2&mailboxUid=mb1", expect.anything());
    });

    it("rejects with the server's own message on failure", async () => {
        mockFetch(() => jsonResponse(403, { message: "Forbidden.", code: "api-103" }));
        await expect(listVideoMeetings("mb1")).rejects.toMatchObject({ status: 403, code: "api-103" });
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, { meeting }));

        await createVideoMeeting({ mailboxUid: "mb1", title: "Standup", visibility: "private", invitees: [{ email: "bob@example.com" }] }, client);
        await updateVideoMeeting("vm1", { title: "Renamed" }, client);
        await getVideoMeeting("vm1", client);
        await listVideoMeetings("mb1", {}, client);

        expect(fetchMock).toHaveBeenCalledTimes(4);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, meeting));
        await getVideoMeeting("vm1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/video-meetings/vm1", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
