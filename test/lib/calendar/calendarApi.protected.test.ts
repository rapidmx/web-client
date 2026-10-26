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

const { EVENT_LIST_FIELDS, SEALED_EVENT_CONTENT_MESSAGE, SealedEventContentError, fullyOpenedEvent, listCalendarEvents, respondToEvent, updateCalendarEvent } = await import("../../../lib/calendar/calendarApi.js");
const { isSealedContentOpened, markSealedContentOpened } = await import("../../../lib/calendar/protectedEvents.js");

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

    describe("an event made from a zero-access invitation (sealedContent)", () => {
        const sealedContent = { keyFingerprint: "fp", sealed: "x" };
        const placeholders = { ...event, sealedFields: undefined, title: "[...]", location: null, description: null, descriptionHtml: null, sealedContent };
        const opened: any = markSealedContentOpened({ ...placeholders, title: "Offsite", location: "Lisbon", description: "Plan", descriptionHtml: "<p>Plan</p>" });
        const unmocked = async (record: any) => record;

        it("sends its whole content with an edit, and returns what the server stored with placeholders shown with it, opened", async () => {
            sealed.openSealedRecord.mockImplementation(unmocked);
            const fetchMock = mockFetch(() => jsonResponse(200, { ...placeholders, version: 1, sealedContent: { keyFingerprint: "fp", sealed: "y" } }));

            const saved = await updateCalendarEvent({ uid: "e1", version: 0, title: "Retreat", location: "Lisbon" }, undefined, opened);

            expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
                uid: "e1",
                version: 0,
                title: "Retreat",
                location: "Lisbon",
                description: "Plan",
                descriptionHtml: "<p>Plan</p>",
            });
            expect(saved).toMatchObject({ version: 1, title: "Retreat", location: "Lisbon", description: "Plan", descriptionHtml: "<p>Plan</p>" });
            expect(isSealedContentOpened(saved)).toBe(true);

            // So a save that follows (the editor linking a video meeting) still sends it whole; one without content keeps it shown.
            fetchMock.mockClear();
            const linked = await updateCalendarEvent({ uid: "e1", version: 1, location: "Video" }, undefined, saved);
            expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ title: "Retreat", location: "Video", description: "Plan" });
            expect(linked).toMatchObject({ title: "Retreat", location: "Video" });
            const moved = await updateCalendarEvent({ uid: "e1", version: 1, startDate: "2026-01-07T09:00:00.000Z" }, undefined, { ...opened, location: undefined, description: undefined, descriptionHtml: undefined });
            expect(moved).toMatchObject({ title: "Offsite", location: undefined, description: null, descriptionHtml: null });
            expect(isSealedContentOpened(moved)).toBe(true);
            sealed.openSealedRecord.mockReset();
        });

        it("returns one it couldn't open, or one stored without sealed content, as the server sent it", async () => {
            sealed.openSealedRecord.mockImplementation(unmocked);
            mockFetch(() => jsonResponse(200, { ...placeholders, version: 1 }));
            const saved = await updateCalendarEvent({ uid: "e1", version: 0, startDate: "2026-01-07T09:00:00.000Z" }, undefined, placeholders);
            expect(saved).toMatchObject({ title: "[...]" });
            expect(isSealedContentOpened(saved)).toBe(false);

            mockFetch(() => jsonResponse(200, { ...placeholders, sealedContent: null, title: "Offsite" }));
            expect(isSealedContentOpened(await updateCalendarEvent({ uid: "e1", version: 0, title: "Offsite" }, undefined, opened))).toBe(false);
            sealed.openSealedRecord.mockReset();
        });

        it("sends none of the placeholders of one it hasn't opened, so a full round trip keeps its sealed content", async () => {
            sealed.openSealedRecord.mockImplementation(unmocked);
            const fetchMock = mockFetch(() => jsonResponse(200, { ...placeholders, version: 1 }));
            await updateCalendarEvent(
                { uid: "e1", version: 0, title: "[...]", location: null, description: null, descriptionHtml: null, startDate: "2026-01-07T09:00:00.000Z" } as any,
                undefined,
                placeholders,
            );
            expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ uid: "e1", version: 0, startDate: "2026-01-07T09:00:00.000Z" });
            sealed.openSealedRecord.mockReset();
        });

        it("says clearly why the server refused a location or description change sent without the opened title", async () => {
            const refusal = { code: "api-003", message: "This event's details are sealed: a change of its location or description must be sent with its opened title." };
            // An event this device loaded before it was filed sealed: nothing here knows to leave the location out.
            const stale = { ...event, sealedFields: undefined, title: "[...]", location: null };
            mockFetch(() => jsonResponse(409, refusal));
            const save = updateCalendarEvent({ uid: "e1", version: 0, title: "[...]", location: "Room 9" }, undefined, stale);
            await expect(save).rejects.toBeInstanceOf(SealedEventContentError);
            await expect(save).rejects.toMatchObject({ status: 409, code: "sealed-event-content", message: SEALED_EVENT_CONTENT_MESSAGE });
            await expect(updateCalendarEvent({ uid: "e1", version: 0, description: "Notes" }, undefined, undefined)).rejects.toBeInstanceOf(SealedEventContentError);

            // Any other refusal is passed on as it came: another 409, one with a real title, one with no location or description.
            const other = { code: "api-003", message: "This event's details are sealed to a key this mailbox no longer has, so they can't be changed." };
            mockFetch(() => jsonResponse(409, other));
            await expect(updateCalendarEvent({ uid: "e1", version: 0, title: "Real", location: "Room 9" }, undefined, stale)).rejects.toMatchObject({ message: other.message });
            await expect(updateCalendarEvent({ uid: "e1", version: 0, location: "", description: null } as any, undefined, undefined)).rejects.toMatchObject({ message: other.message });
            mockFetch(() => jsonResponse(409, { code: "api-012", message: "version" }));
            await expect(updateCalendarEvent({ uid: "e1", version: 0, location: "Room 9" }, undefined, stale)).rejects.toMatchObject({ code: "api-012" });
            mockFetch(() => jsonResponse(400, { code: "api-003", message: "bad" }));
            await expect(updateCalendarEvent({ uid: "e1", version: 0, location: "Room 9" }, undefined, stale)).rejects.toMatchObject({ message: "bad" });
        });
    });
});
