// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { CalendarOccurrence } from "@rapidmx/react-shared/calendar/recurrence.js";
import { EventFormValues } from "../../../apps/shared/components/calendar/eventForm.js";
import {
    descriptionProblem,
    dialogFields,
    hasDescriptionText,
    initialDescriptionHtml,
    plainTextToHtml,
} from "../../../apps/shared/components/calendar/eventDialogFields.js";

// What the event dialog says about the description, the visibility and the guests' permissions when it saves: only what the user changed.

function values(overrides: Partial<EventFormValues> = {}): EventFormValues {
    return {
        title: "T",
        location: "",
        start: "2026-06-10T09:00",
        end: "2026-06-10T10:00",
        allDay: false,
        formZone: "UTC",
        timezone: "UTC",
        attendees: [],
        guestDraft: "",
        guestInvalid: [],
        recurrenceRule: null,
        reminderMinutes: "",
        busyStatus: "busy",
        visibility: "default",
        descriptionHtml: "",
        guestsCanModify: false,
        guestsCanInviteOthers: true,
        guestsCanSeeGuestList: true,
        autoReplyEnabled: false,
        autoReplyMessage: "",
        videoEnabled: false,
        targetMailboxUid: "mb1",
        targetFolderUid: "f1",
        ...overrides,
    };
}

function occurrence(overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
    return {
        uid: "e1",
        version: 1,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        title: "T",
        startDate: "2026-06-10T09:00:00.000Z",
        endDate: "2026-06-10T10:00:00.000Z",
        allDay: false,
        timezone: "UTC",
        organizer: { address: "jane@example.com", type: "to" },
        attendees: [],
        status: "confirmed",
        busyStatus: "busy",
        icalUid: "abc",
        sequence: 0,
        occurrenceKey: "e1",
        isRecurringOccurrence: false,
        ...overrides,
    };
}

describe("plainTextToHtml", () => {
    it("makes a paragraph of each line and escapes markup", () => {
        expect(plainTextToHtml("one\r\ntwo <b>&\n\nfour")).toBe("<p>one</p><p>two &lt;b&gt;&amp;</p><p></p><p>four</p>");
    });
});

describe("initialDescriptionHtml", () => {
    it("is the HTML, else the plain text as paragraphs, else nothing", () => {
        expect(initialDescriptionHtml(occurrence({ descriptionHtml: "<p>Rich</p>", description: "Rich" }))).toBe("<p>Rich</p>");
        expect(initialDescriptionHtml(occurrence({ description: "Plain" }))).toBe("<p>Plain</p>");
        expect(initialDescriptionHtml(occurrence({ description: null, descriptionHtml: null }))).toBe("");
        expect(initialDescriptionHtml(occurrence())).toBe("");
        expect(initialDescriptionHtml(null)).toBe("");
    });
});

describe("hasDescriptionText", () => {
    it("is false for an emptied editor and true once there is text", () => {
        expect(hasDescriptionText("")).toBe(false);
        expect(hasDescriptionText("<p></p>")).toBe(false);
        expect(hasDescriptionText("<p> <br></p>")).toBe(false);
        expect(hasDescriptionText("<p>x</p>")).toBe(true);
    });
});

describe("descriptionProblem", () => {
    it("is only a description too long for the server", () => {
        expect(descriptionProblem("<p>short</p>")).toBeUndefined();
        expect(descriptionProblem(`<p>${"a".repeat(33_000)}</p>`)).toBe("The description is too long.");
        expect(descriptionProblem(`<p>${"<b>a</b>".repeat(11_000)}</p>`)).toBe("The description is too long.");
    });
});

describe("dialogFields", () => {
    it("says nothing about a new event that keeps the defaults", () => {
        expect(dialogFields(values(), null)).toEqual({});
        expect(dialogFields(values({ descriptionHtml: "<p></p>" }), null)).toEqual({});
    });

    it("sends a new event's description as its sanitized HTML and the plain text derived from it", () => {
        expect(dialogFields(values({ descriptionHtml: '<p>Hi <strong onclick="x()">there</strong></p><ul><li><p>one</p></li></ul>' }), null)).toEqual({
            description: "Hi there\n- one",
            descriptionHtml: "<p>Hi <strong>there</strong></p><ul><li>one</li></ul>",
        });
    });

    it("sends what differs from the defaults: visibility and each guest permission", () => {
        expect(dialogFields(values({ visibility: "private", guestsCanModify: true, guestsCanInviteOthers: false, guestsCanSeeGuestList: false }), null)).toEqual({
            visibility: "private",
            guestsCanModify: true,
            guestsCanInviteOthers: false,
            guestsCanSeeGuestList: false,
        });
    });

    it("says nothing about an existing event whose description, visibility and permissions were not touched", () => {
        const stored = occurrence({
            descriptionHtml: "<p>Rich</p>",
            description: "Rich",
            visibility: "public",
            guestsCanModify: true,
            guestsCanInviteOthers: false,
            guestsCanSeeGuestList: false,
        });
        expect(
            dialogFields(
                values({ descriptionHtml: "<p>Rich</p>", visibility: "public", guestsCanModify: true, guestsCanInviteOthers: false, guestsCanSeeGuestList: false }),
                stored,
            ),
        ).toEqual({});
        // Or an old event that has none of them.
        expect(dialogFields(values(), occurrence())).toEqual({});
    });

    it("does not count the editor writing the same text differently, nor an event that had only plain text, as a change", () => {
        expect(dialogFields(values({ descriptionHtml: '<p>Rich</p><p></p>' }), occurrence({ descriptionHtml: "<p>Rich</p>" }))).toEqual({});
        expect(dialogFields(values({ descriptionHtml: "<p>Plain</p>" }), occurrence({ description: "Plain" }))).toEqual({});
        expect(dialogFields(values({ descriptionHtml: "<p>Plain</p>" }), occurrence({ description: "Plain", descriptionHtml: undefined }))).toEqual({});
    });

    it("sends a changed description, and null twice when it was emptied", () => {
        const stored = occurrence({ descriptionHtml: "<p>Rich</p>", description: "Rich" });
        expect(dialogFields(values({ descriptionHtml: "<p>Richer</p>" }), stored)).toEqual({ description: "Richer", descriptionHtml: "<p>Richer</p>" });
        expect(dialogFields(values({ descriptionHtml: "<p></p>" }), stored)).toEqual({ description: null, descriptionHtml: null });
        expect(dialogFields(values({ descriptionHtml: "" }), stored)).toEqual({ description: null, descriptionHtml: null });
    });

    it("sends only the fields that changed", () => {
        expect(dialogFields(values({ visibility: "confidential", guestsCanSeeGuestList: false }), occurrence({ visibility: "private", guestsCanSeeGuestList: true }))).toEqual({
            visibility: "confidential",
            guestsCanSeeGuestList: false,
        });
    });
});
