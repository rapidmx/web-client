// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../testUtils.js";
import {
    createCalendarEvent,
    deleteCalendarEvent,
    getCalendarEvent,
    listCalendarEvents,
    respondToEvent,
    updateCalendarEvent,
} from "../../../lib/calendar/calendarApi.js";

const event = {
    uid: "e1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    folderUid: "f1",
    title: "Standup",
    startDate: "2026-01-05T09:00:00.000Z",
    endDate: "2026-01-05T09:30:00.000Z",
    allDay: false,
    timezone: "UTC",
    organizer: { address: "jane@example.com", type: "to" as const },
    attendees: [],
    status: "confirmed" as const,
    busyStatus: "busy" as const,
    icalUid: "abc",
    sequence: 0,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("listCalendarEvents", () => {
    it("fetches every event scoped by folderUid, leaving range filtering to the caller", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [event]));
        const result = await listCalendarEvents("f1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events?limit=500&page=0&folderUid=f1", expect.anything());
        expect(result).toEqual([event]);
    });

    it("pages through every full page until a short page comes back", async () => {
        const fullPage = Array.from({ length: 500 }, (_, i) => ({ ...event, uid: `p0-${i}` }));
        const secondFullPage = Array.from({ length: 500 }, (_, i) => ({ ...event, uid: `p1-${i}` }));
        const fetchMock = mockFetch((url) => {
            if (url.includes("page=0")) return jsonResponse(200, fullPage);
            if (url.includes("page=1")) return jsonResponse(200, secondFullPage);
            return jsonResponse(200, []);
        });
        const result = await listCalendarEvents("f1");
        expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
            "/api/mail/calendar-events?limit=500&page=0&folderUid=f1",
            "/api/mail/calendar-events?limit=500&page=1&folderUid=f1",
            "/api/mail/calendar-events?limit=500&page=2&folderUid=f1",
        ]);
        expect(result).toHaveLength(1000);
        expect(result[500].uid).toBe("p1-0");
    });

    it("stops after a hard page cap if the server keeps returning full pages", async () => {
        const fullPage = Array.from({ length: 500 }, () => event);
        const fetchMock = mockFetch(() => jsonResponse(200, fullPage));
        const result = await listCalendarEvents("f1");
        expect(fetchMock).toHaveBeenCalledTimes(100);
        expect(result).toHaveLength(50_000);
    });
});

describe("getCalendarEvent", () => {
    it("fetches the encoded uid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, event));
        const result = await getCalendarEvent("e/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/e%2F1", expect.anything());
        expect(result).toEqual(event);
    });
});

describe("createCalendarEvent", () => {
    it("posts the input with allDay/attendees/status/busyStatus/sequence defaults and a generated icalUid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, event));
        await createCalendarEvent({
            mailboxUid: "mb1",
            folderUid: "f1",
            title: "Standup",
            startDate: "2026-01-05T09:00:00.000Z",
            endDate: "2026-01-05T09:30:00.000Z",
            timezone: "UTC",
            organizer: { address: "jane@example.com", type: "to" },
        });
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body).toEqual(
            expect.objectContaining({
                allDay: false,
                attendees: [],
                status: "confirmed",
                busyStatus: "busy",
                sequence: 0,
                mailboxUid: "mb1",
                folderUid: "f1",
                title: "Standup",
            }),
        );
        expect(typeof body.icalUid).toBe("string");
        expect(body.icalUid.length).toBeGreaterThan(0);
    });

    it("forwards explicit allDay/attendees/status/busyStatus instead of defaulting them", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, event));
        await createCalendarEvent({
            mailboxUid: "mb1",
            folderUid: "f1",
            title: "Holiday",
            startDate: "2026-01-05T00:00:00.000Z",
            endDate: "2026-01-06T00:00:00.000Z",
            timezone: "UTC",
            organizer: { address: "jane@example.com", type: "to" },
            allDay: true,
            attendees: [{ address: "bob@example.com", role: "required", responseStatus: "needsAction", isOrganizer: false }],
            status: "tentative",
            busyStatus: "free",
        });
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.allDay).toBe(true);
        expect(body.attendees).toHaveLength(1);
        expect(body.status).toBe("tentative");
        expect(body.busyStatus).toBe("free");
    });
});

describe("updateCalendarEvent", () => {
    it("PUTs the encoded uid with the input (e.g. a drag-move's new start/end)", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...event, startDate: "2026-01-06T09:00:00.000Z" }));
        const result = await updateCalendarEvent({
            uid: "e/1",
            version: 0,
            startDate: "2026-01-06T09:00:00.000Z",
            endDate: "2026-01-06T09:30:00.000Z",
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/calendar-events/e%2F1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({
                    uid: "e/1",
                    version: 0,
                    startDate: "2026-01-06T09:00:00.000Z",
                    endDate: "2026-01-06T09:30:00.000Z",
                }),
            }),
        );
        expect(result.startDate).toBe("2026-01-06T09:00:00.000Z");
    });
});

describe("deleteCalendarEvent", () => {
    it("DELETEs the encoded uid with the version query param", async () => {
        const fetchMock = mockFetch(() => emptyResponse(200));
        await deleteCalendarEvent("e/1", 4);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/calendar-events/e%2F1?version=4",
            expect.objectContaining({ method: "DELETE" }),
        );
    });
});

describe("respondToEvent", () => {
    it("POSTs the encoded uid's respond route with the response status", async () => {
        const updated = { ...event, attendees: [{ address: "me@example.com", role: "required" as const, responseStatus: "accepted" as const, isOrganizer: false }] };
        const fetchMock = mockFetch(() => jsonResponse(200, updated));
        const result = await respondToEvent("e/1", "accepted");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/calendar-events/e%2F1/respond",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ responseStatus: "accepted" }) }),
        );
        expect(result).toEqual(updated);
    });

    it("resolves with just the uid when declining, since the server soft-deletes the mailbox's own copy", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "e1" }));
        const result = await respondToEvent("e1", "declined");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/calendar-events/e1/respond",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ responseStatus: "declined" }) }),
        );
        expect(result).toEqual({ uid: "e1" });
    });
});
