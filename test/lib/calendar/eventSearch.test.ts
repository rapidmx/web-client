// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { CalendarEvent } from "../../../lib/calendar/calendarApi.js";
import {
    SEARCH_MAX_OCCURRENCES_PER_SERIES,
    eventMatchesTerms,
    initialMatchIndex,
    occurrencesInRange,
    searchOccurrences,
    searchTerms,
    stepMatchIndex,
} from "../../../lib/calendar/eventSearch.js";
import { CalendarOccurrence } from "../../../lib/calendar/recurrence.js";

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

function occurrence(start: string, end: string, title = "T"): CalendarOccurrence {
    return { ...event({ startDate: start, endDate: end, title }), occurrenceKey: `${title}::${start}`, isRecurringOccurrence: false };
}

const NOW = new Date("2026-06-15T12:00:00.000Z");

describe("searchTerms", () => {
    it("splits on whitespace, folds case and accents, and is empty for a blank query", () => {
        expect(searchTerms("  Café   STAND ")).toEqual(["cafe", "stand"]);
        expect(searchTerms("   ")).toEqual([]);
    });
});

describe("eventMatchesTerms", () => {
    it("matches the title, location, description, organizer and guests, case- and accent-insensitively", () => {
        const e = event({
            title: "Quarterly Review",
            location: "Room Café",
            description: "Bring the BUDGET notes",
            organizer: { address: "jane@example.com", displayName: "Jane Doe", type: "to" },
            attendees: [
                { address: "bob@example.org", displayName: "Robert Smith", role: "required", responseStatus: "accepted", isOrganizer: false },
                { address: "amy@example.org", role: "optional", responseStatus: "needsAction", isOrganizer: false },
            ],
        });
        for (const term of ["quarterly", "cafe", "budget", "jane doe", "jane@example.com", "robert", "bob@example.org", "amy@"]) {
            expect(eventMatchesTerms(e, searchTerms(term)), term).toBe(true);
        }
        expect(eventMatchesTerms(e, searchTerms("nothing here"))).toBe(false);
    });

    it("needs every term, each anywhere among the fields", () => {
        const e = event({ title: "Budget", location: "Paris" });
        expect(eventMatchesTerms(e, searchTerms("budget paris"))).toBe(true);
        expect(eventMatchesTerms(e, searchTerms("budget london"))).toBe(false);
    });

    it("never matches a blank query or a busy block, and copes with missing fields", () => {
        expect(eventMatchesTerms(event(), [])).toBe(false);
        expect(eventMatchesTerms(event({ title: "Busy", redacted: true }), ["busy"])).toBe(false);
        const bare = { ...event({ description: null }), organizer: undefined, attendees: undefined } as unknown as CalendarEvent;
        expect(eventMatchesTerms(bare, ["standup"])).toBe(true);
    });
});

describe("searchOccurrences", () => {
    it("returns [] for a blank query", () => {
        expect(searchOccurrences([event()], "  ", NOW)).toEqual([]);
    });

    it("finds single events wherever they fall in time, in chronological order", () => {
        const far = event({ uid: "far", title: "Offsite", startDate: "2035-01-01T10:00:00.000Z", endDate: "2035-01-01T11:00:00.000Z" });
        const old = event({ uid: "old", title: "Offsite", startDate: "2019-01-01T10:00:00.000Z", endDate: "2019-01-01T11:00:00.000Z" });
        const same = event({ uid: "same", title: "Alpha offsite", startDate: "2019-01-01T10:00:00.000Z", endDate: "2019-01-01T11:00:00.000Z" });
        const other = event({ uid: "other", title: "Lunch" });
        const found = searchOccurrences([far, other, old, same], "offsite", NOW);
        expect(found.map((o) => o.occurrenceKey)).toEqual(["same", "old", "far"]);
    });

    it("finds a zero-length event", () => {
        const e = event({ startDate: "2026-06-01T15:00:00.000Z", endDate: "2026-06-01T15:00:00.000Z" });
        expect(searchOccurrences([e], "standup", NOW)).toHaveLength(1);
    });

    it("expands a recurring event within five years either side of today", () => {
        const weekly = event({
            uid: "w",
            startDate: "2026-06-01T15:00:00.000Z",
            endDate: "2026-06-01T15:30:00.000Z",
            recurrenceRule: { freq: "weekly", interval: 1, exceptions: [], count: 10 },
        });
        const found = searchOccurrences([weekly], "standup", NOW);
        expect(found).toHaveLength(10);
        expect(found.every((o) => o.isRecurringOccurrence)).toBe(true);
    });

    it("caps a long series at the occurrences nearest today", () => {
        const daily = event({
            uid: "d",
            startDate: "2026-06-01T15:00:00.000Z",
            endDate: "2026-06-01T15:30:00.000Z",
            recurrenceRule: { freq: "daily", interval: 1, exceptions: [] },
        });
        const found = searchOccurrences([daily], "standup", NOW);
        expect(found).toHaveLength(SEARCH_MAX_OCCURRENCES_PER_SERIES);
        const first = new Date(found[0].startDate).getTime();
        const last = new Date(found[found.length - 1].startDate).getTime();
        expect(first).toBeLessThan(NOW.getTime());
        expect(last).toBeGreaterThan(NOW.getTime());
        // Ordered by start and centered on now (the series starts 14 days before it, so the span is skewed by those days only).
        expect(found.map((o) => o.startDate)).toEqual([...found.map((o) => o.startDate)].sort());
    });
});

describe("occurrencesInRange", () => {
    it("keeps those overlapping the range", () => {
        const a = occurrence("2026-06-01T10:00:00.000Z", "2026-06-01T11:00:00.000Z", "a");
        const b = occurrence("2026-06-10T10:00:00.000Z", "2026-06-10T11:00:00.000Z", "b");
        const c = occurrence("2026-05-31T10:00:00.000Z", "2026-06-05T11:00:00.000Z", "c");
        expect(occurrencesInRange([a, b, c], new Date("2026-06-02T00:00:00.000Z"), new Date("2026-06-12T00:00:00.000Z"))).toEqual([b, c]);
    });
});

describe("initialMatchIndex", () => {
    const early = occurrence("2026-01-10T10:00:00.000Z", "2026-01-10T11:00:00.000Z", "early");
    const mid = occurrence("2026-06-20T10:00:00.000Z", "2026-06-20T11:00:00.000Z", "mid");
    const late = occurrence("2026-09-10T10:00:00.000Z", "2026-09-10T11:00:00.000Z", "late");
    const range = [new Date("2026-06-01T00:00:00.000Z"), new Date("2026-07-01T00:00:00.000Z")] as const;

    it("is -1 without matches", () => {
        expect(initialMatchIndex([], range[0], range[1], NOW)).toBe(-1);
    });

    it("prefers the first match inside the view", () => {
        expect(initialMatchIndex([early, mid, late], range[0], range[1], new Date("2026-06-01T00:00:00.000Z"))).toBe(1);
    });

    it("else the first from the viewed day on", () => {
        expect(initialMatchIndex([early, late], range[0], range[1], NOW)).toBe(1);
    });

    it("else the nearest before", () => {
        expect(initialMatchIndex([early, mid], new Date("2026-11-01T00:00:00.000Z"), new Date("2026-12-01T00:00:00.000Z"), new Date("2026-11-15T00:00:00.000Z"))).toBe(1);
    });
});

describe("stepMatchIndex", () => {
    it("wraps round at either end", () => {
        expect(stepMatchIndex(0, 3, 1)).toBe(1);
        expect(stepMatchIndex(2, 3, 1)).toBe(0);
        expect(stepMatchIndex(0, 3, -1)).toBe(2);
        expect(stepMatchIndex(2, 3, -1)).toBe(1);
    });

    it("starts from an end when none is current, and is -1 without matches", () => {
        expect(stepMatchIndex(-1, 3, 1)).toBe(0);
        expect(stepMatchIndex(-1, 3, -1)).toBe(2);
        expect(stepMatchIndex(-1, 0, 1)).toBe(-1);
    });
});
