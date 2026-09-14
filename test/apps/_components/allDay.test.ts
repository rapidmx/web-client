///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { CalendarOccurrence } from "@rapidmx/react-shared/calendar/recurrence.js";
import { addDaysToKey, allDayDateKey, allDayInstant, localDateKey, occursOnDay, startsOnDay } from "../../../apps/shared/components/calendar/allDay.js";

function occ(overrides: Partial<CalendarOccurrence>): CalendarOccurrence {
    return {
        uid: "e1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        title: "t",
        startDate: "2026-06-10T15:00:00.000Z",
        endDate: "2026-06-10T16:00:00.000Z",
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

describe("allDay helpers", () => {
    it("reads both UTC-midnight and legacy local-midnight all-day instants as the intended date", () => {
        expect(allDayDateKey("2026-06-10T00:00:00.000Z")).toBe("2026-06-10");
        // Local midnight June 10 in UTC+2 (legacy format).
        expect(allDayDateKey("2026-06-09T22:00:00.000Z")).toBe("2026-06-10");
        // Local midnight June 10 in UTC-7 (legacy format).
        expect(allDayDateKey("2026-06-10T07:00:00.000Z")).toBe("2026-06-10");
    });

    it("builds instants and shifts date keys", () => {
        expect(allDayInstant("2026-06-10")).toBe("2026-06-10T00:00:00.000Z");
        expect(addDaysToKey("2026-06-30", 1)).toBe("2026-07-01");
        expect(addDaysToKey("2026-07-01", -1)).toBe("2026-06-30");
        expect(localDateKey(new Date(2026, 5, 10))).toBe("2026-06-10");
    });

    it("places all-day events on each date in [start, exclusive end), and at least on the start date", () => {
        const trip = occ({ allDay: true, startDate: "2026-06-10T00:00:00.000Z", endDate: "2026-06-12T00:00:00.000Z" });
        expect(occursOnDay(trip, new Date(2026, 5, 9))).toBe(false);
        expect(occursOnDay(trip, new Date(2026, 5, 10))).toBe(true);
        expect(occursOnDay(trip, new Date(2026, 5, 11))).toBe(true);
        expect(occursOnDay(trip, new Date(2026, 5, 12))).toBe(false);
        const degenerate = occ({ allDay: true, startDate: "2026-06-10T00:00:00.000Z", endDate: "2026-06-10T00:00:00.000Z" });
        expect(occursOnDay(degenerate, new Date(2026, 5, 10))).toBe(true);
        expect(startsOnDay(trip, new Date(2026, 5, 10))).toBe(true);
        expect(startsOnDay(trip, new Date(2026, 5, 11))).toBe(false);
    });

    it("places timed events on every day their interval overlaps, and zero-length ones on their start day", () => {
        const overnight = occ({ startDate: "2026-06-10T22:00:00.000Z", endDate: "2026-06-11T01:00:00.000Z" });
        expect(occursOnDay(overnight, new Date(2026, 5, 10))).toBe(true);
        expect(occursOnDay(overnight, new Date(2026, 5, 11))).toBe(true);
        expect(occursOnDay(overnight, new Date(2026, 5, 12))).toBe(false);
        const endsAtMidnight = occ({ startDate: "2026-06-10T22:00:00.000Z", endDate: "2026-06-11T00:00:00.000Z" });
        expect(occursOnDay(endsAtMidnight, new Date(2026, 5, 11))).toBe(false);
        const instant = occ({ startDate: "2026-06-10T00:00:00.000Z", endDate: "2026-06-10T00:00:00.000Z" });
        expect(occursOnDay(instant, new Date(2026, 5, 10))).toBe(true);
        expect(occursOnDay(instant, new Date(2026, 5, 9))).toBe(false);
        expect(startsOnDay(overnight, new Date(2026, 5, 10))).toBe(true);
        expect(startsOnDay(overnight, new Date(2026, 5, 11))).toBe(false);
    });
});
