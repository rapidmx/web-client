///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { Attendee } from "@rapidmx/react-shared/calendar/calendarApi.js";
import {
    applyGuestChips,
    bestReminderUnit,
    describeReminder,
    formatFormWhen,
    formatStoredWhen,
    formatWhen,
    guestChip,
    reminderOf,
    localDateFromKey,
    mergeGuests,
    msToWallString,
    newGuest,
    wallStringToMs,
} from "../../../apps/shared/components/calendar/eventFormat.js";

// The suite runs with TZ=UTC (see vitest.config.ts), so the "device zone" here is UTC.
const NOW = new Date("2026-09-24T12:00:00.000Z");

describe("reminders", () => {
    it("reads a stored reminder in the largest unit that divides it evenly", () => {
        expect(bestReminderUnit(30).unit).toBe("minutes");
        expect(bestReminderUnit(90).unit).toBe("minutes");
        expect(bestReminderUnit(120).unit).toBe("hours");
        expect(bestReminderUnit(2880).unit).toBe("days");
        expect(bestReminderUnit(10080).unit).toBe("weeks");
        expect(bestReminderUnit(0).unit).toBe("minutes");
    });

    it("describes a reminder, or the lack of one", () => {
        expect(describeReminder(undefined)).toBe("No notification");
        expect(describeReminder(Number.NaN)).toBe("No notification");
        expect(describeReminder(-5)).toBe("No notification");
        expect(describeReminder(0)).toBe("Notify at the start");
        expect(describeReminder(1)).toBe("Notify 1 minute before");
        expect(describeReminder(30)).toBe("Notify 30 minutes before");
        expect(describeReminder(60)).toBe("Notify 1 hour before");
        expect(describeReminder(180)).toBe("Notify 3 hours before");
        expect(describeReminder(1440)).toBe("Notify 1 day before");
        expect(describeReminder(20160)).toBe("Notify 2 weeks before");
    });
});

describe("reminders as typed", () => {
    it("reads the form's minutes, blank meaning none", () => {
        expect(reminderOf("")).toBeUndefined();
        expect(reminderOf("  ")).toBeUndefined();
        expect(reminderOf("45")).toBe(45);
        expect(reminderOf("0")).toBe(0);
    });
});

describe("guests", () => {
    it("builds a required, unanswered guest, with the name it was given", () => {
        expect(newGuest("bob@example.com")).toEqual({ address: "bob@example.com", role: "required", responseStatus: "needsAction", isOrganizer: false });
        expect(newGuest("bob@example.com", "Bob")).toEqual({
            address: "bob@example.com",
            displayName: "Bob",
            role: "required",
            responseStatus: "needsAction",
            isOrganizer: false,
        });
    });

    it("shows a guest as compose shows a recipient: Name <address>, or the bare address", () => {
        expect(guestChip({ address: "bob@example.com" })).toBe("bob@example.com");
        expect(guestChip({ address: "bob@example.com", displayName: "Bob" })).toBe("Bob <bob@example.com>");
        expect(guestChip({ address: "bob@example.com", displayName: "Doe, Bob" })).toBe('"Doe, Bob" <bob@example.com>');
    });

    it("adds new addresses, skips ones already listed in any case, and returns what is not an address", () => {
        const current: Attendee[] = [newGuest("Bob@Example.com")];
        const merged = mergeGuests(current, "bob@example.com, amy@example.com; Support Desk");
        expect(merged.attendees.map((a) => a.address)).toEqual(["Bob@Example.com", "amy@example.com"]);
        expect(merged.invalid).toEqual(["Support Desk"]);
        // The list it was given is left alone.
        expect(current).toHaveLength(1);
    });

    it("keeps the name of a guest typed as Name <address>, and takes addresses that only white space separates as several", () => {
        const merged = mergeGuests([], 'Amy Lee <amy@example.com>, bob@example.com cat@example.com, "Doe, Dan" <dan@example.com>');
        expect(merged.attendees.map((a) => [a.address, a.displayName])).toEqual([
            ["amy@example.com", "Amy Lee"],
            ["bob@example.com", undefined],
            ["cat@example.com", undefined],
            ["dan@example.com", "Doe, Dan"],
        ]);
        expect(merged.invalid).toEqual([]);
    });

    it("leaves out the addresses it is told to, such as the organizer's, in any case, and an address typed twice", () => {
        const merged = mergeGuests([], "Jane@Example.com, bob@example.com, BOB@example.com", ["jane@example.com"]);
        expect(merged.attendees.map((a) => a.address)).toEqual(["bob@example.com"]);
    });

    it("flags what is not an address once, and a list of addresses with something else among them as it was typed", () => {
        const merged = applyGuestChips([], ["nonsense", "nonsense", "bob@example.com nonsense", "@example.com"]);
        expect(merged.attendees).toEqual([]);
        expect(merged.invalid).toEqual(["nonsense", "bob@example.com nonsense", "@example.com"]);
    });

    it("keeps a guest whose chip is there as they are, removes one whose chip is gone, and lists an address once", () => {
        const bob: Attendee = { ...newGuest("bob@example.com", "Bob"), role: "optional", responseStatus: "accepted" };
        const amy = newGuest("amy@example.com");
        const odd = newGuest("not an address");
        const { attendees } = applyGuestChips([bob, amy, odd], ["Robert <BOB@example.com>", "bob@example.com", "not an address"]);
        expect(attendees).toEqual([bob, odd]);
        expect(attendees[0]).toBe(bob);
    });
});

describe("wall clocks", () => {
    it("reads a form value on the device's own clock without conversion", () => {
        expect(wallStringToMs("2026-06-10T09:00", "UTC", "UTC")).toBe(Date.parse("2026-06-10T09:00:00Z"));
        expect(msToWallString(Date.parse("2026-06-10T09:00:00Z"), "UTC", "UTC")).toBe("2026-06-10T09:00");
    });

    it("reads a form value on another zone's clock, and writes one back", () => {
        // 09:00 in New York (EDT, UTC-4) is 13:00Z.
        expect(wallStringToMs("2026-06-10T09:00", "America/New_York", "UTC")).toBe(Date.parse("2026-06-10T13:00:00Z"));
        expect(msToWallString(Date.parse("2026-06-10T13:00:00Z"), "America/New_York", "UTC")).toBe("2026-06-10T09:00");
    });

    it("reads a local date key as a local date", () => {
        const date = localDateFromKey("2026-06-10");
        expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 5, 10]);
    });
});

describe("saying when", () => {
    it("says a timed event's day and time range, leaving the year out for the current one", () => {
        expect(formatWhen(new Date("2026-09-24T14:00:00"), new Date("2026-09-24T15:00:00"), false, NOW)).toBe("Thursday, September 24   2:00pm – 3:00pm");
        expect(formatWhen(new Date("2027-01-07T09:30:00"), new Date("2027-01-07T10:00:00"), false, NOW)).toBe("Thursday, January 7, 2027   9:30am – 10:00am");
    });

    it("names both days when a timed event crosses midnight", () => {
        expect(formatWhen(new Date("2026-09-24T22:00:00"), new Date("2026-09-25T01:00:00"), false, NOW)).toBe(
            "Thursday, September 24 10:00pm – Friday, September 25 1:00am",
        );
    });

    it("says an all-day event's day, or its first and last day", () => {
        expect(formatWhen(new Date(2026, 8, 24), new Date(2026, 8, 24), true, NOW)).toBe("Thursday, September 24");
        expect(formatWhen(new Date(2026, 8, 24), new Date(2026, 8, 26), true, NOW)).toBe("Thursday, September 24 – Saturday, September 26");
    });

    it("says a stored event's when: instants for a timed one, date-only keys with an exclusive end for an all-day one", () => {
        expect(formatStoredWhen("2026-09-24T14:00:00.000Z", "2026-09-24T15:00:00.000Z", false, NOW)).toBe("Thursday, September 24   2:00pm – 3:00pm");
        expect(formatStoredWhen("2026-09-24T00:00:00.000Z", "2026-09-25T00:00:00.000Z", true, NOW)).toBe("Thursday, September 24");
        expect(formatStoredWhen("2026-09-24T00:00:00.000Z", "2026-09-27T00:00:00.000Z", true, NOW)).toBe("Thursday, September 24 – Saturday, September 26");
        // A zero-length all-day event never ends before it starts.
        expect(formatStoredWhen("2026-09-24T00:00:00.000Z", "2026-09-24T00:00:00.000Z", true, NOW)).toBe("Thursday, September 24");
    });

    it("says what the form's wall-clock strings mean, or asks for a date while one is empty", () => {
        expect(formatFormWhen("2026-09-24T14:00", "2026-09-24T15:00", false, NOW)).toBe("Thursday, September 24   2:00pm – 3:00pm");
        expect(formatFormWhen("2026-09-24T00:00", "2026-09-25T00:00", true, NOW)).toBe("Thursday, September 24 – Friday, September 25");
        expect(formatFormWhen("", "2026-09-24T15:00", false, NOW)).toBe("Pick a date and time");
        expect(formatFormWhen("2026-09-24T00:00", "", true, NOW)).toBe("Pick a date and time");
    });
});
