// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it } from "vitest";
import { CalendarOccurrence } from "../../../lib/calendar/recurrence.js";
import {
    dayDropId,
    eventDragId,
    resizeDragId,
    resolveDragAction,
    slotDropId,
} from "../../../lib/calendar/calendarDragIds.js";

function occurrence(overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
    return {
        uid: "e1",
        version: 2,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        title: "Standup",
        startDate: "2026-06-03T15:00:00.000Z",
        endDate: "2026-06-03T15:30:00.000Z",
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

describe("id encoding", () => {
    it("dayDropId/slotDropId/eventDragId/resizeDragId produce distinct, round-trippable prefixed ids", () => {
        const day = new Date("2026-06-10T00:00:00.000Z");
        expect(dayDropId(day)).toBe("day:2026-06-10");
        expect(slotDropId(new Date("2026-06-10T09:30:00.000Z"))).toBe("slot:2026-06-10T09:30:00.000Z");
        const occ = occurrence();
        expect(eventDragId(occ)).toBe("e1");
        expect(resizeDragId(occ)).toBe("resize:e1");
    });
});

/**
 * Day-cell ids and day-drop deltas are local-time based. The suite pins TZ=UTC, so these switch the
 * runtime zone for the duration of each test (Node applies a runtime `process.env.TZ` change to
 * `Date`'s local-time methods immediately) to prove the behavior in a zone with DST and a non-zero
 * offset, not just in UTC where local and UTC dates coincide.
 */
describe("local-time day drops (non-UTC runtime zone)", () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
        process.env.TZ = originalTz;
    });

    it("dayDropId uses the local calendar date, not the UTC one", () => {
        process.env.TZ = "America/New_York";
        // Local midnight in New York (as date-fns builds month-grid days) is 04:00/05:00Z the same date,
        // but local 20:00 is already the *next* UTC date.
        expect(dayDropId(new Date(2026, 5, 8))).toBe("day:2026-06-08");
        expect(dayDropId(new Date(2026, 5, 5, 20, 0))).toBe("day:2026-06-05");
        process.env.TZ = "Asia/Tokyo";
        // Local midnight in Tokyo is the previous UTC date.
        expect(dayDropId(new Date(2026, 0, 1))).toBe("day:2026-01-01");
    });

    it("moves a late-evening event by whole local calendar days", () => {
        process.env.TZ = "America/New_York";
        const occ = occurrence({ startDate: new Date(2026, 5, 5, 20, 0).toISOString() });
        const action = resolveDragAction("e1", dayDropId(new Date(2026, 5, 8)), [occ]);
        expect(action).toMatchObject({ type: "move", deltaMs: 3 * 24 * 60 * 60 * 1000 });
    });

    it("preserves local wall-clock time when the move crosses a DST change", () => {
        process.env.TZ = "America/New_York";
        const occ = occurrence({ startDate: new Date(2026, 2, 6, 10, 0).toISOString() }); // Fri 10:00 EST
        const action = resolveDragAction("e1", dayDropId(new Date(2026, 2, 9)), [occ]); // Mon, after DST began
        expect(action).toMatchObject({ type: "move", deltaMs: 3 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000 });
        const moved = new Date(new Date(occ.startDate).getTime() + (action as { deltaMs: number }).deltaMs);
        expect([moved.getDate(), moved.getHours(), moved.getMinutes()]).toEqual([9, 10, 0]);
    });

    // Round-4 review PoC (drag.mts): west of UTC an all-day event's UTC-midnight start reads as the previous
    // evening locally, so "same local time on the target day" landed it on the day after the drop target.
    it.each(["America/Los_Angeles", "Asia/Tokyo", "UTC"])("moves an all-day event to the dropped date's UTC midnight in %s", (tz) => {
        process.env.TZ = tz;
        const occ = occurrence({ allDay: true, startDate: "2026-09-14T00:00:00.000Z", endDate: "2026-09-15T00:00:00.000Z" });
        const action = resolveDragAction("e1", "day:2026-09-20", [occ]);
        expect(action).toMatchObject({ type: "move", deltaMs: 6 * 24 * 60 * 60 * 1000 });
        expect(new Date(Date.parse(occ.startDate) + (action as { deltaMs: number }).deltaMs).toISOString()).toBe("2026-09-20T00:00:00.000Z");
    });

    it("returns null for an all-day drop on an unparseable day id", () => {
        const occ = occurrence({ allDay: true, startDate: "2026-09-14T00:00:00.000Z" });
        expect(resolveDragAction("e1", "day:not-a-date", [occ])).toBeNull();
    });
});

describe("resolveDragAction", () => {
    it("returns null when dropped outside any droppable", () => {
        expect(resolveDragAction("e1", undefined, [occurrence()])).toBeNull();
    });

    it("returns null when the dragged occurrence can't be found (e.g. removed by a mid-drag reload)", () => {
        expect(resolveDragAction("does-not-exist", "day:2026-06-10", [occurrence()])).toBeNull();
    });

    it("resolves a drop on a day cell to a move, computing the day delta in ms", () => {
        const action = resolveDragAction("e1", "day:2026-06-05", [occurrence()]);
        expect(action).toEqual({ type: "move", occurrence: occurrence(), deltaMs: 2 * 24 * 60 * 60 * 1000 });
    });

    it("resolves a drop on a day cell before the event's own day to a negative delta", () => {
        const action = resolveDragAction("e1", "day:2026-06-01", [occurrence()]);
        expect(action).toEqual({ type: "move", occurrence: occurrence(), deltaMs: -2 * 24 * 60 * 60 * 1000 });
    });

    it("resolves a drop on a time slot to a move, computing the exact ms delta", () => {
        const action = resolveDragAction("e1", "slot:2026-06-03T16:00:00.000Z", [occurrence()]);
        expect(action).toEqual({ type: "move", occurrence: occurrence(), deltaMs: 60 * 60 * 1000 });
    });

    it("resolves a resize-handle drag onto a time slot to a resize with that slot as the new end", () => {
        const action = resolveDragAction("resize:e1", "slot:2026-06-03T16:00:00.000Z", [occurrence()]);
        expect(action).toEqual({ type: "resize", occurrence: occurrence(), newEnd: new Date("2026-06-03T16:00:00.000Z") });
    });

    it("returns null when a resize handle is dropped on a day cell instead of a time slot", () => {
        expect(resolveDragAction("resize:e1", "day:2026-06-05", [occurrence()])).toBeNull();
    });

    it("returns null for a malformed day drop id", () => {
        expect(resolveDragAction("e1", "day:not-a-date", [occurrence()])).toBeNull();
    });

    it("returns null for an unrecognized over-id prefix", () => {
        expect(resolveDragAction("e1", "something-else", [occurrence()])).toBeNull();
    });

    it("finds the right occurrence among several by matching occurrenceKey exactly", () => {
        const a = occurrence({ occurrenceKey: "a" });
        const b = occurrence({ occurrenceKey: "b", startDate: "2026-06-04T10:00:00.000Z", endDate: "2026-06-04T10:30:00.000Z" });
        const action = resolveDragAction("b", "day:2026-06-05", [a, b]);
        expect(action).toMatchObject({ occurrence: b });
    });
});
