// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it } from "vitest";
import { CalendarEvent } from "../../../lib/calendar/calendarApi.js";
import { buildRRule, describeRecurrence, expandAllOccurrences, expandOccurrences, fromEventWallClock, toEventWallClock } from "../../../lib/calendar/recurrence.js";

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
        uid: "e1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        title: "Standup",
        startDate: "2026-06-01T15:00:00.000Z",
        endDate: "2026-06-01T15:30:00.000Z",
        allDay: false,
        timezone: "UTC",
        organizer: { address: "jane@example.com", type: "to" },
        attendees: [],
        status: "confirmed",
        busyStatus: "busy",
        icalUid: "abc",
        sequence: 0,
        ...overrides,
    };
}

const RANGE_START = new Date("2026-06-01T00:00:00.000Z");
const RANGE_END = new Date("2026-06-15T00:00:00.000Z");

describe("expandOccurrences", () => {
    it("returns a non-recurring event as its own single occurrence when it overlaps the range", () => {
        const result = expandOccurrences(event(), RANGE_START, RANGE_END);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ occurrenceKey: "e1", isRecurringOccurrence: false, startDate: "2026-06-01T15:00:00.000Z" });
    });

    it("returns nothing for a non-recurring event entirely outside the range", () => {
        const result = expandOccurrences(event({ startDate: "2026-07-01T00:00:00.000Z", endDate: "2026-07-01T01:00:00.000Z" }), RANGE_START, RANGE_END);
        expect(result).toEqual([]);
    });

    it("includes a non-recurring event that started before rangeStart but is still in progress", () => {
        const result = expandOccurrences(
            event({ startDate: "2026-05-31T23:00:00.000Z", endDate: "2026-06-01T01:00:00.000Z" }),
            RANGE_START,
            RANGE_END,
        );
        expect(result).toHaveLength(1);
    });

    it("expands a weekly recurring event into every occurrence overlapping the range", () => {
        const recurring = event({
            recurrenceRule: { freq: "weekly", interval: 1, byDay: ["MO", "WE"], exceptions: [] },
        });
        const result = expandOccurrences(recurring, RANGE_START, RANGE_END);
        expect(result.map((r) => r.startDate)).toEqual([
            "2026-06-01T15:00:00.000Z",
            "2026-06-03T15:00:00.000Z",
            "2026-06-08T15:00:00.000Z",
            "2026-06-10T15:00:00.000Z",
        ]);
        expect(result.every((r) => r.isRecurringOccurrence)).toBe(true);
        expect(result.every((r) => r.recurrenceId === r.startDate)).toBe(true);
        // Each occurrence gets a unique key derived from the master uid + its own start.
        expect(new Set(result.map((r) => r.occurrenceKey)).size).toBe(result.length);
        expect(result[0].occurrenceKey).toBe("e1::2026-06-01T15:00:00.000Z");
        // Occurrence end preserves the master event's original duration (30 minutes).
        expect(result[0].endDate).toBe("2026-06-01T15:30:00.000Z");
    });

    it("excludes occurrences listed in recurrenceRule.exceptions", () => {
        const recurring = event({
            recurrenceRule: { freq: "weekly", interval: 1, byDay: ["MO", "WE"], exceptions: ["2026-06-03T15:00:00.000Z"] },
        });
        const result = expandOccurrences(recurring, RANGE_START, RANGE_END);
        expect(result.map((r) => r.startDate)).not.toContain("2026-06-03T15:00:00.000Z");
        expect(result).toHaveLength(3);
    });

    it("includes a recurring occurrence that started before rangeStart but is still in progress", () => {
        const recurring = event({
            startDate: "2026-05-25T23:30:00.000Z",
            endDate: "2026-05-26T00:30:00.000Z",
            recurrenceRule: { freq: "daily", interval: 1, count: 8, exceptions: [] },
        });
        const result = expandOccurrences(recurring, RANGE_START, RANGE_END);
        // The occurrence anchored at 2026-06-01T00:30 starts before RANGE_START's midnight boundary by
        // half an hour on the *previous* day, so this only passes if the query window is correctly
        // widened by the event's own duration rather than starting exactly at rangeStart.
        expect(result[0].startDate).toBe("2026-05-31T23:30:00.000Z");
    });

    it("returns nothing for a recurring event whose occurrences never reach the range", () => {
        const recurring = event({
            startDate: "2026-01-01T00:00:00.000Z",
            endDate: "2026-01-01T01:00:00.000Z",
            recurrenceRule: { freq: "daily", interval: 1, count: 3, exceptions: [] },
        });
        const result = expandOccurrences(recurring, RANGE_START, RANGE_END);
        expect(result).toEqual([]);
    });
});

describe("expandOccurrences in the event's own timezone", () => {
    it("keeps a late-evening local event on its local weekday (weekly MO 23:00 America/New_York)", () => {
        // 2026-01-05 (a Monday) 23:00 EST is 2026-01-06T04:00Z, a Tuesday in UTC.
        const recurring = event({
            uid: "e",
            startDate: "2026-01-06T04:00:00.000Z",
            endDate: "2026-01-06T05:00:00.000Z",
            timezone: "America/New_York",
            recurrenceRule: { freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] },
        });
        const result = expandOccurrences(recurring, RANGE_START, RANGE_END);
        // Monday 23:00 EDT (UTC-4) is Tuesday 03:00Z — not Monday 04:00Z (Sunday evening in New York).
        expect(result.map((r) => r.startDate)).toEqual(["2026-06-02T03:00:00.000Z", "2026-06-09T03:00:00.000Z"]);
        expect(result.map((r) => r.endDate)).toEqual(["2026-06-02T04:00:00.000Z", "2026-06-09T04:00:00.000Z"]);
        expect(result[0].occurrenceKey).toBe("e::2026-06-02T03:00:00.000Z");
    });

    it("keeps 10:00 local wall-clock time across the March and November DST changes", () => {
        const recurring = event({
            startDate: "2026-03-02T15:00:00.000Z", // Mon 10:00 EST
            endDate: "2026-03-02T15:30:00.000Z",
            timezone: "America/New_York",
            recurrenceRule: { freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] },
        });
        const march = expandOccurrences(recurring, new Date("2026-03-01T00:00:00.000Z"), new Date("2026-03-17T00:00:00.000Z"));
        expect(march.map((r) => r.startDate)).toEqual([
            "2026-03-02T15:00:00.000Z", // EST
            "2026-03-09T14:00:00.000Z", // EDT (DST began 2026-03-08)
            "2026-03-16T14:00:00.000Z",
        ]);
        expect(march[1].endDate).toBe("2026-03-09T14:30:00.000Z");
        const november = expandOccurrences(recurring, new Date("2026-10-25T00:00:00.000Z"), new Date("2026-11-10T00:00:00.000Z"));
        expect(november.map((r) => r.startDate)).toEqual([
            "2026-10-26T14:00:00.000Z", // EDT
            "2026-11-02T15:00:00.000Z", // EST (DST ended 2026-11-01)
            "2026-11-09T15:00:00.000Z",
        ]);
    });

    it("keeps an early-morning local time that falls right after the spring-forward gap", () => {
        const recurring = event({
            startDate: "2026-03-06T08:30:00.000Z", // Fri 03:30 EST
            endDate: "2026-03-06T09:00:00.000Z",
            timezone: "America/New_York",
            recurrenceRule: { freq: "daily", interval: 1, count: 4, exceptions: [] },
        });
        const result = expandOccurrences(recurring, new Date("2026-03-06T00:00:00.000Z"), new Date("2026-03-10T00:00:00.000Z"));
        expect(result.map((r) => r.startDate)).toEqual([
            "2026-03-06T08:30:00.000Z",
            "2026-03-07T08:30:00.000Z",
            "2026-03-08T07:30:00.000Z", // 03:30 EDT on the transition day itself
            "2026-03-09T07:30:00.000Z",
        ]);
    });

    it("expands an all-day event (stored as UTC-midnight dates) in UTC, not its timezone, across DST", () => {
        const recurring = event({
            startDate: "2026-03-02T00:00:00.000Z", // Monday 2026-03-02, date-only
            endDate: "2026-03-03T00:00:00.000Z",
            allDay: true,
            timezone: "America/New_York",
            recurrenceRule: { freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] },
        });
        const result = expandOccurrences(recurring, new Date("2026-03-09T00:00:00.000Z"), new Date("2026-03-10T00:00:00.000Z"));
        expect(result).toHaveLength(1);
        expect(result[0].startDate).toBe("2026-03-09T00:00:00.000Z");
        expect(result[0].endDate).toBe("2026-03-10T00:00:00.000Z");
    });

    // Round-4 review PoC (rec.mts): in New York, UTC midnight is the previous evening, so tz expansion put a
    // Monday all-day series on Tuesdays and a monthly-on-the-14th series on the 15th (01:00Z after DST ended).
    it.each([
        ["weekly on Monday", { freq: "weekly", interval: 1, byDay: ["MO"] }, ["2026-09-14", "2026-09-21", "2026-09-28"]],
        ["monthly on the 14th", { freq: "monthly", interval: 1, byMonthDay: [14] }, ["2026-09-14", "2026-10-14", "2026-11-14"]],
        ["daily until the 16th", { freq: "daily", interval: 1, until: "2026-09-16T00:00:00.000Z" }, ["2026-09-14", "2026-09-15", "2026-09-16"]],
    ])("keeps an all-day %s series on its own dates at UTC midnight", (_label, rule, dates) => {
        const recurring = event({
            startDate: "2026-09-14T00:00:00.000Z",
            endDate: "2026-09-15T00:00:00.000Z",
            allDay: true,
            timezone: "America/New_York",
            recurrenceRule: { ...rule, exceptions: [] } as CalendarEvent["recurrenceRule"],
        });
        const result = expandOccurrences(recurring, new Date("2026-09-10T00:00:00.000Z"), new Date("2026-11-20T00:00:00.000Z"));
        expect(result.slice(0, 3).map((o) => o.startDate)).toEqual(dates.map((d) => `${d}T00:00:00.000Z`));
    });

    // Round-4 review PoC (rec.mts): RFC 5545 §3.3.5 - a nonexistent local time uses the offset from before
    // the gap, so a daily 02:30 America/New_York event is 03:30 EDT on the spring-forward day (not 01:30
    // EST), and keeps its one-hour duration.
    it("resolves a DST-gap occurrence with the pre-transition offset, keeping its duration", () => {
        const recurring = event({
            startDate: "2027-03-13T07:30:00.000Z", // 02:30 EST
            endDate: "2027-03-13T08:30:00.000Z",
            timezone: "America/New_York",
            recurrenceRule: { freq: "daily", interval: 1, exceptions: [] },
        });
        const result = expandOccurrences(recurring, new Date("2027-03-13T00:00:00.000Z"), new Date("2027-03-16T00:00:00.000Z"));
        expect(result.map((o) => [o.startDate, o.endDate])).toEqual([
            ["2027-03-13T07:30:00.000Z", "2027-03-13T08:30:00.000Z"],
            ["2027-03-14T07:30:00.000Z", "2027-03-14T08:30:00.000Z"], // 03:30-04:30 EDT
            ["2027-03-15T06:30:00.000Z", "2027-03-15T07:30:00.000Z"], // 02:30 EDT
        ]);
    });

    it("resolves an ambiguous fall-back occurrence to its first (daylight) instance", () => {
        const recurring = event({
            startDate: "2027-11-06T05:30:00.000Z", // 01:30 EDT
            endDate: "2027-11-06T06:00:00.000Z",
            timezone: "America/New_York",
            recurrenceRule: { freq: "daily", interval: 1, exceptions: [] },
        });
        const result = expandOccurrences(recurring, new Date("2027-11-07T00:00:00.000Z"), new Date("2027-11-07T12:00:00.000Z"));
        expect(result.map((o) => o.startDate)).toEqual(["2027-11-07T05:30:00.000Z"]);
    });

    it("interprets until and exceptions as real instants in the event's zone", () => {
        const recurring = event({
            startDate: "2026-06-01T03:00:00.000Z", // Sun 2026-05-31 23:00 EDT
            endDate: "2026-06-01T04:00:00.000Z",
            timezone: "America/New_York",
            recurrenceRule: {
                freq: "daily",
                interval: 1,
                until: "2026-06-04T03:00:00.000Z",
                exceptions: ["2026-06-02T03:00:00.000Z"],
            },
        });
        const result = expandOccurrences(recurring, RANGE_START, RANGE_END);
        expect(result.map((r) => r.startDate)).toEqual(["2026-06-01T03:00:00.000Z", "2026-06-03T03:00:00.000Z", "2026-06-04T03:00:00.000Z"]);
    });

    it("does not return padding-window occurrences that fall outside the requested range", () => {
        const recurring = event({
            startDate: "2026-05-01T14:00:00.000Z",
            endDate: "2026-05-01T15:00:00.000Z",
            timezone: "Pacific/Kiritimati", // UTC+14
            recurrenceRule: { freq: "daily", interval: 1, exceptions: [] },
        });
        const result = expandOccurrences(recurring, new Date("2026-06-05T00:00:00.000Z"), new Date("2026-06-06T00:00:00.000Z"));
        expect(result.map((r) => r.startDate)).toEqual(["2026-06-05T14:00:00.000Z"]);
    });

    describe("floating (runtime-local) fallback", () => {
        const originalTz = process.env.TZ;
        afterEach(() => {
            process.env.TZ = originalTz;
        });

        it.each([
            ["an empty timezone", ""],
            ["an unrecognized timezone", "Not/AZone"],
            ["a missing timezone", undefined],
        ])("expands %s in the runtime's local zone", (_label, timezone) => {
            // Node applies a runtime `process.env.TZ` change to `Date`'s local-time methods immediately.
            process.env.TZ = "America/New_York";
            const recurring = event({
                startDate: "2026-03-02T15:00:00.000Z", // Mon 10:00 EST (local)
                endDate: "2026-03-02T15:30:00.000Z",
                timezone: timezone as string,
                recurrenceRule: { freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] },
            });
            const result = expandOccurrences(recurring, new Date("2026-03-01T00:00:00.000Z"), new Date("2026-03-10T00:00:00.000Z"));
            expect(result.map((r) => r.startDate)).toEqual(["2026-03-02T15:00:00.000Z", "2026-03-09T14:00:00.000Z"]);
            expect(result[1].endDate).toBe("2026-03-09T14:30:00.000Z");
        });
    });
});

describe("toEventWallClock / fromEventWallClock", () => {
    it("uses UTC for all-day events and the event's zone for timed ones", () => {
        const instant = Date.parse("2026-09-14T00:00:00.000Z");
        expect(toEventWallClock(instant, "America/New_York", true)).toBe(instant);
        expect(fromEventWallClock(instant, "America/New_York", true)).toBe(instant);
        const wall = toEventWallClock(instant, "America/New_York", false);
        expect(new Date(wall).toISOString()).toBe("2026-09-13T20:00:00.000Z");
        expect(fromEventWallClock(wall, "America/New_York", false)).toBe(instant);
    });
});

describe("buildRRule", () => {
    it("carries the given tzid through to the rule", () => {
        const rule = buildRRule({ freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] }, new Date(Date.UTC(2026, 0, 5, 23)), "America/New_York");
        expect(rule.options.tzid).toBe("America/New_York");
        expect(rule.toString()).toContain("DTSTART;TZID=America/New_York:20260105T230000");
    });

    it("builds a UTC rule with an until date when no tzid is given", () => {
        const rule = buildRRule({ freq: "daily", interval: 1, until: "2026-01-07T00:00:00.000Z", exceptions: [] }, new Date("2026-01-05T00:00:00.000Z"));
        expect(rule.options.tzid).toBeNull();
        expect(rule.all()).toHaveLength(3);
    });
});

describe("expandAllOccurrences", () => {
    it("expands and flattens every event", () => {
        const e1 = event({ uid: "e1" });
        const e2 = event({ uid: "e2", startDate: "2026-06-05T10:00:00.000Z", endDate: "2026-06-05T11:00:00.000Z" });
        const result = expandAllOccurrences([e1, e2], RANGE_START, RANGE_END);
        expect(result.map((r) => r.uid).sort()).toEqual(["e1", "e2"]);
    });
});

describe("describeRecurrence", () => {
    it("describes a weekly rule with specific days", () => {
        expect(describeRecurrence({ freq: "weekly", interval: 1, byDay: ["MO", "WE"], exceptions: [] })).toBe(
            "every week on Monday, Wednesday",
        );
    });

    it("describes an interval-2 rule with an until date", () => {
        expect(describeRecurrence({ freq: "weekly", interval: 2, byDay: ["MO"], until: "2027-01-01T00:00:00.000Z", exceptions: [] })).toBe(
            "every 2 weeks on Monday until January 1, 2027",
        );
    });

    it("describes a monthly rule with a count", () => {
        expect(describeRecurrence({ freq: "monthly", interval: 1, count: 6, exceptions: [] })).toBe("every month for 6 times");
    });

    it("describes a daily rule with no end condition", () => {
        expect(describeRecurrence({ freq: "daily", interval: 1, exceptions: [] })).toBe("every day");
    });

    it("describes a yearly rule", () => {
        expect(describeRecurrence({ freq: "yearly", interval: 1, exceptions: [] })).toBe("every year");
    });
});

describe("hostile and ancient recurrence rules", () => {
    const rule = (overrides: Record<string, unknown>) => ({ freq: "daily" as const, interval: 1, exceptions: [], ...overrides });
    const starts = (e: CalendarEvent) => expandOccurrences(e, RANGE_START, RANGE_END).map((o) => o.startDate);

    it.each([0, -1, Number.NaN, 1.5, undefined])("treats the interval %s as 1 rather than looping forever", (interval) => {
        const result = starts(event({ recurrenceRule: rule({ interval }) }));
        expect(result).toHaveLength(14);
        expect(result[1]).toBe("2026-06-02T15:00:00.000Z");
    });

    it("does not let one event that cannot be expanded blank the others", () => {
        const broken = event({ uid: "bad", startDate: "garbage", recurrenceRule: rule({}) });
        const result = expandAllOccurrences([broken, event({ uid: "ok", recurrenceRule: rule({ interval: 7 }) })], RANGE_START, RANGE_END);
        expect(result.map((o) => o.uid)).toEqual(["ok", "ok"]);
    });

    it("still shows the stored event of one whose rule cannot be expanded, when it is in range", () => {
        const broken = event({ uid: "odd", recurrenceRule: rule({ exceptions: undefined }) });
        const result = expandAllOccurrences([broken], RANGE_START, RANGE_END);
        expect(result).toMatchObject([{ uid: "odd", isRecurringOccurrence: false, startDate: "2026-06-01T15:00:00.000Z" }]);
    });

    it("expands a daily series that began centuries ago exactly as it would have from a recent start", () => {
        const ancient = event({ startDate: "1600-01-01T15:00:00.000Z", endDate: "1600-01-01T15:30:00.000Z", recurrenceRule: rule({ interval: 3 }) });
        const result = starts(ancient);
        expect(result.length).toBeGreaterThan(3);
        for (const start of result) {
            const days = (Date.parse(start) - Date.parse("1600-01-01T15:00:00.000Z")) / 86_400_000;
            expect(days % 3).toBe(0);
        }
        // Every third day from 2026-06-01's neighbourhood, nothing skipped.
        const gaps = result.slice(1).map((start, i) => (Date.parse(start) - Date.parse(result[i])) / 86_400_000);
        expect(new Set(gaps)).toEqual(new Set([3]));
    });

    it("expands a biweekly series on given weekdays that began long ago exactly as from a start a whole number of periods later", () => {
        const byDay = ["MO", "WE"] as const;
        const original = event({ startDate: "1700-01-03T15:00:00.000Z", endDate: "1700-01-03T15:30:00.000Z", recurrenceRule: rule({ freq: "weekly", interval: 2, byDay: [...byDay] }) });
        const shifted = new Date(Date.parse("1700-01-03T15:00:00.000Z") + 14 * 86_400_000 * 6000).toISOString();
        const later = event({ startDate: shifted, endDate: shifted, recurrenceRule: rule({ freq: "weekly", interval: 2, byDay: [...byDay] }) });
        expect(Date.parse(shifted)).toBeLessThan(RANGE_START.getTime());
        expect(starts(original)).toEqual(starts(later));
        expect(starts(original).length).toBeGreaterThan(0);
    });

    it("leaves a series with a count alone, however old", () => {
        expect(starts(event({ startDate: "1600-01-01T15:00:00.000Z", endDate: "1600-01-01T15:30:00.000Z", recurrenceRule: rule({ count: 5 }) }))).toEqual([]);
    });
});
