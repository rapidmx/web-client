///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { describeGuestPermissions, VISIBILITIES, VISIBILITY_HELP, VISIBILITY_LABEL } from "../../../apps/shared/components/calendar/eventFormat.js";
import {
    SEARCH_DAYS,
    clockLabel,
    dayStartMs,
    freeBusyErrorMessage,
    isDayKey,
    minuteOfDay,
    summaryLine,
    workingWindows,
} from "../../../apps/shared/components/calendar/findTimeGrid.js";

// The pure parts of the Find a time grid. The suite runs with TZ=UTC (see vitest.config.ts), so the "device zone" here is UTC.

const DEVICE = "UTC";
const iso = (ms: number) => new Date(ms).toISOString();

describe("isDayKey", () => {
    it("is a YYYY-MM-DD key and nothing else", () => {
        expect(isDayKey("2026-06-10")).toBe(true);
        expect(isDayKey("2026-06-10T09:00")).toBe(false);
        expect(isDayKey("")).toBe(false);
    });
});

describe("dayStartMs", () => {
    it("is midnight on the device's clock, or on another zone's", () => {
        expect(iso(dayStartMs("2026-06-10", "UTC", DEVICE))).toBe("2026-06-10T00:00:00.000Z");
        expect(iso(dayStartMs("2026-06-10", "America/New_York", DEVICE))).toBe("2026-06-10T04:00:00.000Z");
    });
});

describe("workingWindows", () => {
    it("has 8:00 to 18:00 for the first day and each weekday of the next days", () => {
        // 2026-06-10 is a Wednesday: Wed, Thu, Fri, then Mon and Tue - the weekend is left out.
        const windows = workingWindows("2026-06-10", "UTC", DEVICE);
        expect(windows.map((w) => `${iso(w.startMs)} ${iso(w.endMs)}`)).toEqual([
            "2026-06-10T08:00:00.000Z 2026-06-10T18:00:00.000Z",
            "2026-06-11T08:00:00.000Z 2026-06-11T18:00:00.000Z",
            "2026-06-12T08:00:00.000Z 2026-06-12T18:00:00.000Z",
            "2026-06-15T08:00:00.000Z 2026-06-15T18:00:00.000Z",
            "2026-06-16T08:00:00.000Z 2026-06-16T18:00:00.000Z",
        ]);
        expect(SEARCH_DAYS).toBe(7);
    });

    it("always includes the day it starts on, even a Saturday, and reads the hours in the zone the event is set in", () => {
        const windows = workingWindows("2026-06-13", "America/New_York", DEVICE);
        expect(windows[0]).toEqual({ startMs: Date.parse("2026-06-13T12:00:00Z"), endMs: Date.parse("2026-06-13T22:00:00Z") });
        // Saturday, then Monday to Friday of the week after (Sunday the 14th and Saturday the 20th are left out).
        expect(windows).toHaveLength(6);
    });
});

describe("minuteOfDay", () => {
    it("is where the instant falls on that day's clock, clamped to the day", () => {
        expect(minuteOfDay(Date.parse("2026-06-10T09:30:00Z"), "2026-06-10", "UTC", DEVICE)).toBe(570);
        expect(minuteOfDay(Date.parse("2026-06-10T09:30:00Z"), "2026-06-10", "America/New_York", DEVICE)).toBe(330);
        expect(minuteOfDay(Date.parse("2026-06-09T23:59:00Z"), "2026-06-10", "UTC", DEVICE)).toBe(0);
        expect(minuteOfDay(Date.parse("2026-06-11T00:00:00Z"), "2026-06-10", "UTC", DEVICE)).toBe(1440);
    });
});

describe("clockLabel", () => {
    it("is the time on the zone's clock", () => {
        expect(clockLabel(Date.parse("2026-06-10T09:05:00Z"), "UTC", DEVICE)).toBe("9:05am");
        expect(clockLabel(Date.parse("2026-06-10T21:00:00Z"), "America/New_York", DEVICE)).toBe("5:00pm");
    });
});

describe("freeBusyErrorMessage", () => {
    it("names the wait for a rate limit, gives the server's reason for other refusals, and a plain failure for the rest", () => {
        expect(freeBusyErrorMessage(new ApiRequestError("slow down", 429))).toMatch(/Too many availability look-ups/);
        expect(freeBusyErrorMessage(new ApiRequestError("The window is too long.", 400))).toBe("The window is too long.");
        expect(freeBusyErrorMessage(new TypeError("Failed to fetch"))).toMatch(/Couldn't load availability/);
    });
});

describe("summaryLine", () => {
    it("says everyone is free only when everyone could be checked and none is busy", () => {
        expect(summaryLine({ free: 3, conflicts: 0, tentative: 0, unknown: 0 })).toBe("Everyone is free");
    });

    it("counts the conflicts, and how many of them are tentative", () => {
        expect(summaryLine({ free: 1, conflicts: 1, tentative: 0, unknown: 0 })).toBe("1 conflict");
        expect(summaryLine({ free: 1, conflicts: 2, tentative: 1, unknown: 0 })).toBe("2 conflicts (1 tentative)");
    });

    it("never calls somebody it could not check free", () => {
        expect(summaryLine({ free: 1, conflicts: 0, tentative: 0, unknown: 1 })).toBe("No conflicts found · 1 person's availability is unknown");
        expect(summaryLine({ free: 0, conflicts: 1, tentative: 0, unknown: 2 })).toBe("1 conflict · 2 people's availability is unknown");
    });
});

describe("visibility and guest permission wording", () => {
    it("has a label and an explanation for every visibility, in the order the form lists them", () => {
        expect(VISIBILITIES).toEqual(["default", "public", "private", "confidential"]);
        for (const visibility of VISIBILITIES) {
            expect(VISIBILITY_LABEL[visibility]).toBeTruthy();
            expect(VISIBILITY_HELP[visibility]).toBeTruthy();
        }
        expect(VISIBILITY_LABEL.default).toBe("Default visibility");
    });

    it("says what guests can do", () => {
        expect(describeGuestPermissions({ guestsCanModify: true, guestsCanInviteOthers: true, guestsCanSeeGuestList: true })).toBe("Guests can modify the event, invite others and see the guest list.");
        expect(describeGuestPermissions({ guestsCanModify: false, guestsCanInviteOthers: true, guestsCanSeeGuestList: true })).toBe("Guests can invite others and see the guest list.");
        expect(describeGuestPermissions({ guestsCanModify: false, guestsCanInviteOthers: false, guestsCanSeeGuestList: true })).toBe("Guests can see the guest list.");
        expect(describeGuestPermissions({ guestsCanModify: false, guestsCanInviteOthers: false, guestsCanSeeGuestList: false })).toBe("Guests can't modify the event, invite others or see the guest list.");
    });
});
