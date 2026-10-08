///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import type { PushEvent } from "../../../lib/mail/pushClient.js";
import {
    calendarEventHref,
    calendarReminderOf,
    joinMeetingUrl,
    locationActionLabel,
    reminderMessage,
    reminderNotificationId,
} from "../../../apps/shared/calendar/calendarReminders.js";

const NOTICE = { eventUid: "evt1", title: "Team sync", startDate: "2026-09-22T15:00:00.000Z" };

describe("calendarReminderOf", () => {
    it("reads a CalendarEvent reminder push event", () => {
        const event: PushEvent = { type: "CalendarEvent", action: "reminder", data: NOTICE };
        expect(calendarReminderOf(event)).toEqual(NOTICE);
    });

    it("ignores every other type", () => {
        expect(calendarReminderOf({ type: "MessageMongo", action: "create", data: NOTICE })).toBeUndefined();
    });

    it("ignores a CalendarEvent event that isn't a reminder", () => {
        expect(calendarReminderOf({ type: "CalendarEvent", action: "update", data: NOTICE })).toBeUndefined();
    });

    it("ignores a reminder whose payload is malformed", () => {
        expect(calendarReminderOf({ type: "CalendarEvent", action: "reminder", data: { eventUid: "evt1" } })).toBeUndefined();
        expect(calendarReminderOf({ type: "CalendarEvent", action: "reminder", data: null })).toBeUndefined();
        expect(calendarReminderOf({ type: "CalendarEvent", action: "reminder", data: undefined })).toBeUndefined();
        expect(calendarReminderOf({ type: "CalendarEvent", action: "reminder", data: { ...NOTICE, location: 42 } })).toBeUndefined();
    });

    it("accepts a reminder with a location - a string, null, or absent", () => {
        expect(calendarReminderOf({ type: "CalendarEvent", action: "reminder", data: { ...NOTICE, location: "Room 12" } })?.location).toBe(
            "Room 12",
        );
        expect(calendarReminderOf({ type: "CalendarEvent", action: "reminder", data: { ...NOTICE, location: null } })?.location).toBeNull();
        expect(calendarReminderOf({ type: "CalendarEvent", action: "reminder", data: NOTICE })?.location).toBeUndefined();
    });
});

describe("joinMeetingUrl", () => {
    it("reads an http(s) URL as a join link", () => {
        expect(joinMeetingUrl("https://meet.example.com/room/abc")).toBe("https://meet.example.com/room/abc");
        expect(joinMeetingUrl("http://meet.example.com/room/abc")).toBe("http://meet.example.com/room/abc");
    });

    it("trims incidental whitespace", () => {
        expect(joinMeetingUrl("  https://meet.example.com/room/abc  ")).toBe("https://meet.example.com/room/abc");
    });

    it("is undefined for a plain room name, address or other non-URL text", () => {
        expect(joinMeetingUrl("Room 12")).toBeUndefined();
        expect(joinMeetingUrl("123 Main St, Springfield")).toBeUndefined();
        expect(joinMeetingUrl("Ask the front desk")).toBeUndefined();
    });

    it("is undefined for a non-http(s) URL scheme", () => {
        expect(joinMeetingUrl("ftp://example.com/file")).toBeUndefined();
        expect(joinMeetingUrl("mailto:someone@example.com")).toBeUndefined();
    });

    it("is undefined for empty, missing or null location", () => {
        expect(joinMeetingUrl("")).toBeUndefined();
        expect(joinMeetingUrl("   ")).toBeUndefined();
        expect(joinMeetingUrl(undefined)).toBeUndefined();
        expect(joinMeetingUrl(null)).toBeUndefined();
    });
});

describe("locationActionLabel", () => {
    it.each([
        "https://us06web.zoom.us/j/86056299697?pwd=abc",
        "https://meet.google.com/abc-defg-hij",
        "https://teams.microsoft.com/l/meetup-join/xyz",
        "https://acme.webex.com/meet/room",
        "https://meet.example.com/room/abc",
        "https://example.com/join/12345",
        "https://video.example.org/x",
    ])("calls %s a meeting to Join", (url) => {
        expect(locationActionLabel(url)).toBe("Join");
    });

    it.each(["https://www.example.com/", "https://maps.example.com/place/12", "http://intranet.local/rooms"])("calls %s a page to Open", (url) => {
        expect(locationActionLabel(url)).toBe("Open");
    });
});

describe("calendarEventHref", () => {
    it("leads to the Calendar with the event and the occurrence named, encoded", () => {
        expect(calendarEventHref("evt 1", "2026-09-22T15:00:00.000Z")).toBe("/calendar?event=evt%201&start=2026-09-22T15%3A00%3A00.000Z");
    });
});

describe("reminderMessage", () => {
    const start = "2026-09-22T15:00:00.000Z";
    const startMs = new Date(start).getTime();

    it("says how many minutes remain", () => {
        expect(reminderMessage(start, startMs - 10 * 60_000)).toMatch(/^Starting in 10 minutes - /);
    });

    it("uses the singular for one minute", () => {
        expect(reminderMessage(start, startMs - 60_000)).toMatch(/^Starting in 1 minute - /);
    });

    it("says 'now' once the start time has arrived", () => {
        expect(reminderMessage(start, startMs)).toMatch(/^Starting now - /);
        expect(reminderMessage(start, startMs + 60_000)).toMatch(/^Starting now - /);
    });
});

describe("reminderNotificationId", () => {
    it("is stable for the same occurrence and distinct for another", () => {
        const id = reminderNotificationId("evt1", "2026-09-22T15:00:00.000Z");
        expect(reminderNotificationId("evt1", "2026-09-22T15:00:00.000Z")).toBe(id);
        expect(reminderNotificationId("evt2", "2026-09-22T15:00:00.000Z")).not.toBe(id);
        expect(reminderNotificationId("evt1", "2026-09-23T15:00:00.000Z")).not.toBe(id);
    });
});
