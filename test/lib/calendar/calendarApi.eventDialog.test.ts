// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { ApiRequestError } from "../../../lib/util/api.js";
import {
    DEFAULT_GUEST_PERMISSIONS,
    createCalendarEvent,
    guestPermissionsOf,
    requestEventChange,
    updateCalendarEvent,
    visibilityOf,
} from "../../../lib/calendar/calendarApi.js";
import { freeBusyVisibilityOf, updateMailbox } from "../../../lib/mail/mailApi.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("guestPermissionsOf", () => {
    it("reads a missing or null flag as Google's defaults: guests cannot modify, can invite, can see the list", () => {
        expect(DEFAULT_GUEST_PERMISSIONS).toEqual({ guestsCanModify: false, guestsCanInviteOthers: true, guestsCanSeeGuestList: true });
        expect(guestPermissionsOf({})).toEqual(DEFAULT_GUEST_PERMISSIONS);
        expect(guestPermissionsOf({ guestsCanModify: null, guestsCanInviteOthers: null, guestsCanSeeGuestList: null })).toEqual(DEFAULT_GUEST_PERMISSIONS);
    });

    it("takes a flag that is set, false included", () => {
        expect(guestPermissionsOf({ guestsCanModify: true, guestsCanInviteOthers: false, guestsCanSeeGuestList: false })).toEqual({
            guestsCanModify: true,
            guestsCanInviteOthers: false,
            guestsCanSeeGuestList: false,
        });
    });
});

describe("visibilityOf", () => {
    it("is default when an event says none", () => {
        expect(visibilityOf({})).toBe("default");
        expect(visibilityOf({ visibility: null })).toBe("default");
        expect(visibilityOf({ visibility: "confidential" })).toBe("confidential");
    });
});

describe("the event dialog's fields on create and update", () => {
    it("sends the description, visibility and guest permissions as given, and null to clear", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        await createCalendarEvent({
            mailboxUid: "mb1",
            folderUid: "f1",
            title: "T",
            startDate: "2026-06-16T09:00:00.000Z",
            endDate: "2026-06-16T10:00:00.000Z",
            timezone: "UTC",
            organizer: { address: "a@example.com", type: "to" },
            description: "Agenda",
            descriptionHtml: "<p>Agenda</p>",
            visibility: "private",
            guestsCanModify: true,
            guestsCanInviteOthers: false,
            guestsCanSeeGuestList: false,
        });
        expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual(
            expect.objectContaining({ description: "Agenda", descriptionHtml: "<p>Agenda</p>", visibility: "private", guestsCanModify: true, guestsCanInviteOthers: false, guestsCanSeeGuestList: false }),
        );
        await updateCalendarEvent({ uid: "e1", version: 1, description: null, descriptionHtml: null });
        expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({ uid: "e1", version: 1, description: null, descriptionHtml: null });
    });
});

describe("requestEventChange", () => {
    it("POSTs only the change asked for to the encoded uid's request-change route", async () => {
        const answer = { requested: true, changes: ["title", "addAttendees"], addAttendees: [{ address: "new@example.com" }] };
        const fetchMock = mockFetch(() => jsonResponse(200, answer));
        const result = await requestEventChange("e/1", { title: "New title", addAttendees: [{ address: "new@example.com" }] });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/calendar-events/e%2F1/request-change",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ title: "New title", addAttendees: [{ address: "new@example.com" }] }) }),
        );
        expect(result).toEqual(answer);
    });

    it("rejects with the server's reason for a refusal", async () => {
        mockFetch(() => jsonResponse(403, { message: "The organizer does not allow guests to change this event." }));
        await expect(requestEventChange("e1", { title: "x" })).rejects.toBeInstanceOf(ApiRequestError);
    });
});

describe("Mailbox.freeBusyVisibility", () => {
    it("reads as domain when a mailbox says none", () => {
        expect(freeBusyVisibilityOf({})).toBe("domain");
        expect(freeBusyVisibilityOf({ freeBusyVisibility: "nobody" })).toBe("nobody");
    });

    it("is sent by updateMailbox", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        await updateMailbox({ uid: "mb1", version: 3, freeBusyVisibility: "shared" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/mb1",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ uid: "mb1", version: 3, freeBusyVisibility: "shared" }) }),
        );
    });
});
