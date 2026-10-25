// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { ApiRequestError, createApiClient } from "../../../lib/util/api.js";
import {
    PROTECTED_PROPOSAL_MESSAGE,
    acceptProposal,
    getMessageInvite,
    proposeNewTime,
    removeMessageInvite,
    respondToMessageInvite,
    type MessageInvite,
} from "../../../lib/calendar/inviteApi.js";
import { clearSealedInvites, onSealedInvitesForgotten, rememberSealedInvite, sealedInviteCalendar } from "../../../lib/calendar/sealedInvites.js";

const { getUnlockedKeys, keyListeners } = vi.hoisted(() => ({
    getUnlockedKeys: vi.fn((): unknown => ({ zeroAccessKeys: [{}] })),
    keyListeners: [] as ((event: { mailboxUid: string; state: "locked" | "unlocked" }) => void)[],
}));
vi.mock("../../../lib/crypto/keySession.js", () => ({
    getUnlockedKeys,
    subscribeKeySession: (listener: (event: { mailboxUid: string; state: "locked" | "unlocked" }) => void) => {
        keyListeners.push(listener);
        return () => undefined;
    },
}));

const { invitationContentOf, meetingLinkSecrets, followMeetingKeyExpiry } = vi.hoisted(() => ({
    invitationContentOf: vi.fn((): unknown => undefined),
    meetingLinkSecrets: vi.fn(async (): Promise<unknown> => undefined),
    followMeetingKeyExpiry: vi.fn(async (): Promise<void> => undefined),
}));
vi.mock("../../../lib/calendar/protectedEvents.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/calendar/protectedEvents.js")>()),
    invitationContentOf,
}));
vi.mock("../../../lib/videoconf/protectedMeetings.js", () => ({ meetingLinkSecrets, followMeetingKeyExpiry }));
// The event read for an accepted proposal comes back as stored (opening is sealedRecords' own tests'), subscribing to no key session.
vi.mock("../../../lib/zeroAccess/sealedRecords.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/zeroAccess/sealedRecords.js")>()),
    openSealedRecord: async (record: unknown) => record,
}));

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

    const counter = { ...invite, method: "COUNTER", response: "accepted" as const, canAcceptProposal: false };
    const event = {
        uid: "ev1",
        mailboxUid: "mb",
        title: "Protected event",
        videoMeetingUid: "vm1",
        organizer: { address: "me@example.com" },
        attendees: [{ address: "me@example.com" }, { address: "guest@example.com" }],
    };
    const routed = (stored: unknown, status: number = 200) =>
        mockFetch((url: string) => (String(url).endsWith("/accept-proposal") ? jsonResponse(200, counter) : jsonResponse(status, stored)));

    it("sends a protected or keyed meeting's content and guests' link keys, for the server to send the moved meeting's invitations", async () => {
        invitationContentOf.mockReturnValueOnce({ title: "Board meeting", location: "Room 4" });
        meetingLinkSecrets.mockResolvedValueOnce({ "guest@example.com": "k" });
        const fetchMock = routed({ ...event, sealedFields: { title: "c" } });
        expect(await acceptProposal("m1", undefined, "ev1")).toEqual(counter);
        expect(fetchMock.mock.calls[0][0]).toBe("/api/mail/calendar-events/ev1");
        expect(meetingLinkSecrets).toHaveBeenLastCalledWith({ videoMeetingUid: "vm1", attendees: event.attendees, organizer: event.organizer }, undefined);
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
            invitationContent: { title: "Board meeting", location: "Room 4", meetingLinkSecrets: { "guest@example.com": "k" } },
        });
        // The meeting key's expiry follows the accepted time (the COUNTER's).
        expect(followMeetingKeyExpiry).toHaveBeenLastCalledWith("vm1", new Date(counter.endDate!), undefined);
        // A keyed meeting whose content isn't sealed: the link keys alone.
        meetingLinkSecrets.mockResolvedValueOnce({ "guest@example.com": "k" });
        const keyedOnly = routed(event);
        await acceptProposal("m1", undefined, "ev1");
        expect(JSON.parse(keyedOnly.mock.calls[1][1].body)).toEqual({ invitationContent: { meetingLinkSecrets: { "guest@example.com": "k" } } });
    });

    it("sends nothing more for a meeting that needs neither, or that can't be read here", async () => {
        followMeetingKeyExpiry.mockClear();
        const plain = routed({ ...event, videoMeetingUid: undefined });
        await acceptProposal("m1", undefined, "ev1");
        expect(plain.mock.calls[1][1].body).toBeUndefined();
        expect(followMeetingKeyExpiry).not.toHaveBeenCalled();
        const unreadable = routed({ message: "Not found" }, 404);
        expect(await acceptProposal("m1", undefined, "ev1")).toEqual(counter);
        expect(unreadable.mock.calls[1][1].body).toBeUndefined();
    });

    it("refuses a protected meeting it can't open, before moving anything", async () => {
        const fetchMock = routed({ ...event, sealedFields: { title: "c" } });
        await expect(acceptProposal("m1", undefined, "ev1")).rejects.toThrow(PROTECTED_PROPOSAL_MESSAGE);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // One the organizer's own client sealed is claimed, never mailed: nothing is needed.
        const originated = routed({ ...event, sealedFields: { title: "c" }, encryptionOrigin: "originated", videoMeetingUid: undefined });
        await acceptProposal("m1", undefined, "ev1");
        expect(originated.mock.calls[1][1].body).toBeUndefined();
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

describe("a zero-access message's invitation (the calendar file decrypted here goes along)", () => {
    afterEach(() => {
        clearSealedInvites();
    });

    it("reads it with POST .../view, and sends the file with every answer", async () => {
        rememberSealedInvite("m1", "ICS", "mb1");
        const fetchMock = mockFetch(() => jsonResponse(200, invite));
        const body = (i: number) => JSON.parse(fetchMock.mock.calls[i][1].body);

        await getMessageInvite("m1");
        await respondToMessageInvite("m1", "accepted");
        await removeMessageInvite("m1");
        await proposeNewTime("m1", { startDate: "a", endDate: "b" });
        await acceptProposal("m1");

        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            "/api/mail/calendar-events/invite/m1/view",
            "/api/mail/calendar-events/invite/m1/respond",
            "/api/mail/calendar-events/invite/m1/remove",
            "/api/mail/calendar-events/invite/m1/propose",
            "/api/mail/calendar-events/invite/m1/accept-proposal",
        ]);
        expect([0, 1, 2, 3, 4].map(body)).toEqual([
            { ics: "ICS" },
            { responseStatus: "accepted", ics: "ICS" },
            { ics: "ICS" },
            { startDate: "a", endDate: "b", ics: "ICS" },
            { ics: "ICS" },
        ]);
    });

    it("keeps only the most recently read messages' files, and forgets them all on clear", () => {
        for (let i = 0; i <= 100; i++) {
            rememberSealedInvite(`m${i}`, `ICS${i}`, "mb1");
        }
        rememberSealedInvite("m1", "again", "mb1");
        rememberSealedInvite("m101", "ICS101", "mb1");

        expect(sealedInviteCalendar("m0")).toBeUndefined();
        expect(sealedInviteCalendar("m1")).toBe("again");
        expect(sealedInviteCalendar("m2")).toBeUndefined();
        expect(sealedInviteCalendar("m101")).toBe("ICS101");
        clearSealedInvites();
        expect(sealedInviteCalendar("m1")).toBeUndefined();
    });

    it("never sends or keeps a file past its mailbox's lock, telling who listens which messages' files went", async () => {
        const forgotten = vi.fn();
        const off = onSealedInvitesForgotten(forgotten);
        rememberSealedInvite("m1", "ICS", "mb1");
        rememberSealedInvite("m2", "ICS2", "mb2");
        // One subscription, made with the first file.
        expect(keyListeners).toHaveLength(1);

        // Locked (the idle timeout): not sent, even before the lock's event has run.
        getUnlockedKeys.mockReturnValue(undefined);
        expect(sealedInviteCalendar("m1")).toBeUndefined();
        const fetchMock = mockFetch(() => jsonResponse(200, invite));
        await getMessageInvite("m1");
        expect(fetchMock.mock.calls[0][0]).toBe("/api/mail/calendar-events/invite/m1");
        // A pane still drawing what it decrypted before the lock doesn't put it back.
        rememberSealedInvite("m3", "ICS3", "mb1");

        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [{}] });
        keyListeners[0]({ mailboxUid: "mb1", state: "unlocked" });
        keyListeners[0]({ mailboxUid: "mb3", state: "locked" });
        expect(forgotten).not.toHaveBeenCalled();
        keyListeners[0]({ mailboxUid: "mb1", state: "locked" });
        expect(forgotten).toHaveBeenCalledExactlyOnceWith(["m1"]);
        expect(sealedInviteCalendar("m1")).toBeUndefined();
        expect(sealedInviteCalendar("m3")).toBeUndefined();
        expect(sealedInviteCalendar("m2")).toBe("ICS2");
        off();
    });
});
