// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// What calendarApi opens of protected events: a list only what the views draw, a write the whole event it was given.
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";

const sealed = vi.hoisted(() => ({
    openSealedRecords: vi.fn(async (records: any[]) => records),
    openSealedRecord: vi.fn(async (record: any) => ({ ...record, title: "Board meeting", location: "Room 4", description: "Agenda", opened: true })),
    isOpenedRecord: vi.fn((record: any) => !!record?.opened),
}));
vi.mock("../../../lib/zeroAccess/sealedRecords.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/zeroAccess/sealedRecords.js")>()),
    ...sealed,
}));

const { EVENT_LIST_FIELDS, fullyOpenedEvent, listCalendarEvents, respondToEvent, updateCalendarEvent } = await import("../../../lib/calendar/calendarApi.js");

const event: any = {
    uid: "e1",
    version: 0,
    mailboxUid: "mb1",
    folderUid: "f1",
    title: "Board meeting",
    location: "Room 4",
    description: null,
    startDate: "2026-01-05T09:00:00.000Z",
    endDate: "2026-01-05T09:30:00.000Z",
    organizer: { address: "jane@example.com", type: "to" },
    attendees: [],
    sealedFields: { title: "c", location: "c", description: "c" },
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("calendarApi and protected events", () => {
    it("opens only what the views draw of a listed event", async () => {
        mockFetch(() => jsonResponse(200, [event]));
        await listCalendarEvents("f1");
        expect(sealed.openSealedRecords).toHaveBeenCalledWith([event], EVENT_LIST_FIELDS);
        expect(EVENT_LIST_FIELDS).toEqual(["title", "location"]);
    });

    it("opens a listed event in full before a write, so it sends only what changed and invites with the whole content", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, event));
        await updateCalendarEvent({ uid: "e1", version: 0, title: "Board meeting", startDate: "2026-01-06T09:00:00.000Z" }, undefined, event);
        expect(sealed.openSealedRecord).toHaveBeenCalledWith(event);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
            uid: "e1",
            version: 0,
            startDate: "2026-01-06T09:00:00.000Z",
            invitationContent: { title: "Board meeting", location: "Room 4", description: "Agenda", descriptionHtml: undefined },
        });

        // A reply names it by its real content too.
        fetchMock.mockClear();
        mockFetch(() => jsonResponse(200, { uid: "e1" }));
        await respondToEvent("e1", "declined", undefined, event);
        expect(sealed.openSealedRecord).toHaveBeenCalledTimes(3);
    });

    it("sends no invitation content nor link keys with a save that defers its invitations", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, event));
        const keyed = { ...event, videoMeetingUid: "m1", attendees: [{ address: "bob@example.org" }] };
        await updateCalendarEvent({ uid: "e1", version: 0, location: "Room 5", invitationContent: { defer: true } }, undefined, keyed);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ uid: "e1", version: 0, location: "Room 5", invitationContent: { defer: true } });
    });

    it("invites with the content given when the protected event couldn't be opened here, and with what it opened otherwise", async () => {
        const given = { title: "Board meeting", location: "Video", description: "Agenda", descriptionHtml: "<p>Agenda</p>" };
        sealed.openSealedRecord.mockImplementationOnce(async (record: any) => record);
        const fetchMock = mockFetch(() => jsonResponse(200, event));
        await updateCalendarEvent({ uid: "e1", version: 0, invitationContent: given }, undefined, event);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ uid: "e1", version: 0, invitationContent: given });

        fetchMock.mockClear();
        await updateCalendarEvent({ uid: "e1", version: 0, invitationContent: { ...given, title: "Stale" } }, undefined, event);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).invitationContent.title).toBe("Board meeting");

        // An event that isn't protected is invited with its own content.
        fetchMock.mockClear();
        await updateCalendarEvent({ uid: "e1", version: 0, invitationContent: given }, undefined, { ...event, sealedFields: undefined });
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ uid: "e1", version: 0 });
    });

    it("leaves an event that is opened in full, or not protected, as it is", async () => {
        const opened = { ...event, opened: true };
        expect(await fullyOpenedEvent(opened)).toBe(opened);
        const plain = { ...event, sealedFields: undefined };
        expect(await fullyOpenedEvent(plain)).toBe(plain);
        expect(await fullyOpenedEvent(undefined)).toBeUndefined();
        expect(sealed.openSealedRecord).not.toHaveBeenCalled();
    });
});
