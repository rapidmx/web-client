///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { dayTimes, endTimeOptions, formatDuration, formatTimeOfDay, nextHalfHour, parseTimeInput } from "../../../apps/shared/components/calendar/timePicker.js";

// The suite runs with TZ=UTC (see vitest.config.ts).

describe("nextHalfHour", () => {
    it("rounds up to the next half hour, and leaves one that is already on it", () => {
        expect(nextHalfHour(new Date("2026-09-29T11:12:40.000Z")).toISOString()).toBe("2026-09-29T11:30:00.000Z");
        expect(nextHalfHour(new Date("2026-09-29T11:31:00.000Z")).toISOString()).toBe("2026-09-29T12:00:00.000Z");
        expect(nextHalfHour(new Date("2026-09-29T11:30:00.000Z")).toISOString()).toBe("2026-09-29T11:30:00.000Z");
        expect(nextHalfHour(new Date("2026-09-29T23:50:00.000Z")).toISOString()).toBe("2026-09-30T00:00:00.000Z");
    });
});

describe("formatTimeOfDay", () => {
    it("reads a 24 hour time on a 12 hour clock, and is empty for no time", () => {
        expect(formatTimeOfDay("00:00")).toBe("12:00 AM");
        expect(formatTimeOfDay("09:05")).toBe("9:05 AM");
        expect(formatTimeOfDay("12:30")).toBe("12:30 PM");
        expect(formatTimeOfDay("23:45")).toBe("11:45 PM");
        expect(formatTimeOfDay("")).toBe("");
    });
});

describe("parseTimeInput", () => {
    it.each([
        ["15:45", "15:45"],
        ["3:45 pm", "15:45"],
        ["3:45PM", "15:45"],
        ["3:45p", "15:45"],
        ["3:45 p.m.", "15:45"],
        ["345pm", "15:45"],
        ["1130", "11:30"],
        ["930", "09:30"],
        ["9", "09:00"],
        ["9am", "09:00"],
        ["12am", "00:00"],
        ["12 pm", "12:00"],
        ["12:15 AM", "00:15"],
        ["  8:05  ", "08:05"],
        ["0:00", "00:00"],
    ])("understands %j as %s", (text, time) => {
        expect(parseTimeInput(text)).toBe(time);
    });

    it.each(["", "noon", "25:00", "24", "12:60", "13pm", "0am", "1:2", "9:30:15", "pm"])("does not understand %j", (text) => {
        expect(parseTimeInput(text)).toBeNull();
    });
});

describe("dayTimes", () => {
    it("is every quarter hour of a day, in order", () => {
        const times = dayTimes();
        expect(times).toHaveLength(96);
        expect(times[0]).toBe("00:00");
        expect(times[1]).toBe("00:15");
        expect(times[47]).toBe("11:45");
        expect(times[95]).toBe("23:45");
    });
});

describe("formatDuration", () => {
    it.each([
        [1, "1 min"],
        [15, "15 mins"],
        [45, "45 mins"],
        [60, "1 hr"],
        [75, "1.25 hrs"],
        [90, "1.5 hrs"],
        [120, "2 hrs"],
        [24 * 60, "24 hrs"],
    ])("says %i minutes as %s", (minutes, text) => {
        expect(formatDuration(minutes)).toBe(text);
    });
});

describe("endTimeOptions", () => {
    it("offers each quarter hour after the start for a day, with how long the event would last", () => {
        const options = endTimeOptions("2026-09-29T11:30");
        expect(options).toHaveLength(96);
        expect(options[0]).toEqual({ value: "2026-09-29T11:45", label: "11:45 AM", hint: "(15 mins)" });
        expect(options[1]).toEqual({ value: "2026-09-29T12:00", label: "12:00 PM", hint: "(30 mins)" });
        expect(options[3]).toEqual({ value: "2026-09-29T12:30", label: "12:30 PM", hint: "(1 hr)" });
        expect(options[5].hint).toBe("(1.5 hrs)");
        // The last is a day later, on the next date.
        expect(options[95]).toEqual({ value: "2026-09-30T11:30", label: "11:30 AM", hint: "(24 hrs)" });
    });

    it("follows the clock's quarter hours when the start is between them", () => {
        const options = endTimeOptions("2026-09-29T11:33");
        expect(options[0]).toEqual({ value: "2026-09-29T11:45", label: "11:45 AM", hint: "(12 mins)" });
        expect(options[1].hint).toBe("(27 mins)");
    });

    it("offers nothing without a start", () => {
        expect(endTimeOptions("")).toEqual([]);
    });
});
