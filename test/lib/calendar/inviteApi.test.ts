// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { ApiRequestError, createApiClient } from "../../../lib/util/api.js";
import {
    acceptProposal,
    getMessageInvite,
    proposeNewTime,
    removeMessageInvite,
    respondToMessageInvite,
    type MessageInvite,
} from "../../../lib/calendar/inviteApi.js";

const invite: MessageInvite = {
    method: "REQUEST",
    uid: "ical-1",
    sequence: 0,
    summary: "Planning",
    startDate: "2026-06-16T14:00:00.000Z",
    endDate: "2026-06-16T15:00:00.000Z",
    allDay: false,
    organizer: { address: "boss@example.com", displayName: "Boss" },
    attendees: [{ address: "me@example.com", responseStatus: "needs-action" }],
    recurring: false,
    isOrganizer: false,
    onCalendar: false,
    outdated: false,
    canRespond: true,
    canAdd: false,
    canRemove: false,
    canPropose: true,
    canAcceptProposal: false,
    conflicts: [],
    schedule: [],
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("getMessageInvite", () => {
    it("GETs the invite route with the message uid encoded", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, invite));
        const result = await getMessageInvite("m/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/invite/m%2F1", expect.anything());
        expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
        expect(result).toEqual(invite);
    });

    it("resolves null when the message has no readable invite (404)", async () => {
        mockFetch(() => jsonResponse(404, { message: "No invite" }));
        await expect(getMessageInvite("m1")).resolves.toBeNull();
    });

    it("rejects for any other failure", async () => {
        mockFetch(() => jsonResponse(500, { message: "Boom" }));
        const err = await getMessageInvite("m1").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApiRequestError);
        expect((err as ApiRequestError).status).toBe(500);
    });

    it("rejects when the request never gets an answer", async () => {
        mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
        await expect(getMessageInvite("m1")).rejects.toThrow("Failed to fetch");
    });
});

describe("respondToMessageInvite", () => {
    it("POSTs the encoded uid's respond route with the response status and resolves with the updated invite", async () => {
        const updated = { ...invite, response: "tentative" as const, onCalendar: true };
        const fetchMock = mockFetch(() => jsonResponse(200, updated));
        const result = await respondToMessageInvite("m/1", "tentative");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/calendar-events/invite/m%2F1/respond",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ responseStatus: "tentative" }) }),
        );
        expect(result).toEqual(updated);
    });

    it.each(["accepted", "declined"] as const)("sends %s as is", async (status) => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...invite, response: status }));
        await respondToMessageInvite("m1", status);
        expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ responseStatus: status }));
    });

    it("rejects with the server's error - a 404 is not turned into null here", async () => {
        mockFetch(() => jsonResponse(404, { message: "No invite" }));
        await expect(respondToMessageInvite("m1", "accepted")).rejects.toBeInstanceOf(ApiRequestError);
    });
});

describe("removeMessageInvite", () => {
    it("POSTs the encoded uid's remove route with no body and resolves with the updated invite", async () => {
        const updated = { ...invite, method: "CANCEL", onCalendar: false, canRemove: false };
        const fetchMock = mockFetch(() => jsonResponse(200, updated));
        const result = await removeMessageInvite("m/1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/calendar-events/invite/m%2F1/remove",
            expect.objectContaining({ method: "POST" }),
        );
        expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
        expect(result).toEqual(updated);
    });

    it("rejects with the server's error", async () => {
        mockFetch(() => jsonResponse(409, { message: "Conflict" }));
        await expect(removeMessageInvite("m1")).rejects.toBeInstanceOf(ApiRequestError);
    });
});

describe("proposeNewTime", () => {
    it("POSTs the encoded uid's propose route with the times and comment and resolves with the updated invite", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, invite));
        const proposal = { startDate: "2026-06-17T14:00:00.000Z", endDate: "2026-06-17T15:00:00.000Z", comment: "Wednesday works better" };
        const result = await proposeNewTime("m/1", proposal);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/calendar-events/invite/m%2F1/propose",
            expect.objectContaining({ method: "POST", body: JSON.stringify(proposal) }),
        );
        expect(result).toEqual(invite);
    });

    it("leaves the comment out when there is none", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, invite));
        await proposeNewTime("m1", { startDate: "2026-06-17T14:00:00.000Z", endDate: "2026-06-17T15:00:00.000Z" });
        expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ startDate: "2026-06-17T14:00:00.000Z", endDate: "2026-06-17T15:00:00.000Z" });
    });

    it("rejects with the server's error", async () => {
        mockFetch(() => jsonResponse(400, { message: "Bad" }));
        await expect(proposeNewTime("m1", { startDate: "a", endDate: "b" })).rejects.toBeInstanceOf(ApiRequestError);
    });
});

describe("acceptProposal", () => {
    it("POSTs the encoded uid's accept-proposal route with no body and resolves with the updated invite", async () => {
        const updated = { ...invite, method: "COUNTER", response: "accepted" as const, canAcceptProposal: false };
        const fetchMock = mockFetch(() => jsonResponse(200, updated));
        const result = await acceptProposal("m/1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/calendar-events/invite/m%2F1/accept-proposal",
            expect.objectContaining({ method: "POST" }),
        );
        expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
        expect(result).toEqual(updated);
    });

    it("rejects with the server's error", async () => {
        mockFetch(() => jsonResponse(409, { message: "Conflict" }));
        await expect(acceptProposal("m1")).rejects.toBeInstanceOf(ApiRequestError);
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, invite));

        await getMessageInvite("m1", client);
        await respondToMessageInvite("m1", "accepted", client);
        await removeMessageInvite("m1", client);
        await proposeNewTime("m1", { startDate: "2026-06-17T14:00:00.000Z", endDate: "2026-06-17T15:00:00.000Z" }, client);
        await acceptProposal("m1", client);

        expect(fetchMock).toHaveBeenCalledTimes(5);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, invite));
        await getMessageInvite("m1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/invite/m1", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
