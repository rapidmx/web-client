// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, compareTimeZones, describeTimeZone, deviceTimeZone, timeZoneOptions, zoneClock } from "../../../lib/util/timeZone.js";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("deviceTimeZone", () => {
    it("is the zone the browser reports", () => {
        expect(deviceTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    });

    it("is UTC when the browser can't say", () => {
        vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
            throw new Error("no Intl");
        });
        expect(deviceTimeZone()).toBe(DEFAULT_TIME_ZONE);
        vi.spyOn(Intl, "DateTimeFormat").mockImplementation((() => ({ resolvedOptions: () => ({ timeZone: "" }) })));
        expect(deviceTimeZone()).toBe(DEFAULT_TIME_ZONE);
    });
});

describe("timeZoneOptions", () => {
    it("lists UTC, what the browser knows and the zones given, once each and sorted from west to east, then by city", () => {
        const options = timeZoneOptions("Nowhere/Custom", "UTC", "");
        expect(options).toContain("UTC");
        expect(options).toContain("Nowhere/Custom");
        expect(options).toContain("America/Los_Angeles");
        expect(new Set(options).size).toBe(options.length);
        const now = new Date();
        expect([...options].sort((a, b) => compareTimeZones(a, b, now))).toEqual(options);
        // The far west first, the far east last; UTC sits with the other zones at +00:00.
        expect(options.indexOf("Pacific/Pago_Pago")).toBeLessThan(options.indexOf("America/Los_Angeles"));
        expect(options.indexOf("America/Los_Angeles")).toBeLessThan(options.indexOf("America/New_York"));
        expect(options.indexOf("America/New_York")).toBeLessThan(options.indexOf("UTC"));
        expect(options.indexOf("UTC")).toBeLessThan(options.indexOf("Europe/Berlin"));
        expect(options.indexOf("Europe/Berlin")).toBeLessThan(options.indexOf("Asia/Tokyo"));
        expect(options.indexOf("Asia/Tokyo")).toBeLessThan(options.indexOf("Pacific/Kiritimati"));
    });

    it("still offers UTC and the given zones where the browser has no list", () => {
        const original = (Intl as any).supportedValuesOf;
        (Intl as any).supportedValuesOf = () => {
            throw new Error("unsupported");
        };
        try {
            expect(timeZoneOptions("Europe/Paris")).toEqual(["UTC", "Europe/Paris"]);
        } finally {
            (Intl as any).supportedValuesOf = original;
        }
        (Intl as any).supportedValuesOf = undefined;
        try {
            expect(timeZoneOptions()).toEqual(["UTC"]);
        } finally {
            (Intl as any).supportedValuesOf = original;
        }
    });
});

describe("compareTimeZones", () => {
    const at = new Date("2026-09-29T12:00:00Z");
    const sorted = (zones: string[]) => [...zones].sort((a, b) => compareTimeZones(a, b, at));

    it("puts the westernmost clock first, and orders zones on the same clock by city", () => {
        expect(sorted(["Asia/Tokyo", "UTC", "America/Los_Angeles", "Africa/Abidjan", "Asia/Kolkata", "America/Adak", "Europe/London"])).toEqual([
            "America/Adak",
            "America/Los_Angeles",
            "Africa/Abidjan",
            "UTC",
            "Europe/London",
            "Asia/Kolkata",
            "Asia/Tokyo",
        ]);
    });

    it("reads each zone's offset on the date, daylight saving included", () => {
        // London is an hour ahead of UTC in the summer, and level with it in the winter (where the city decides).
        expect(sorted(["Europe/London", "UTC"])).toEqual(["UTC", "Europe/London"]);
        expect(compareTimeZones("Europe/London", "UTC", new Date("2026-12-01T12:00:00Z"))).toBeLessThan(0);
        expect(compareTimeZones("Europe/London", "Africa/Abidjan", new Date("2026-12-01T12:00:00Z"))).toBeGreaterThan(0);
    });

    it("breaks a tie on the city by the id, and puts a zone it doesn't know last, however many there are", () => {
        expect(sorted(["Nowhere/Land", "UTC", "Mars/Olympus_Mons", "Asia/Tokyo"])).toEqual(["UTC", "Asia/Tokyo", "Nowhere/Land", "Mars/Olympus_Mons"]);
        expect(compareTimeZones("America/Indiana/Knox", "America/North_Dakota/Knox", at) < 0).toBe(true);
    });

    it("defaults to now", () => {
        expect(compareTimeZones("Pacific/Pago_Pago", "Pacific/Kiritimati")).toBeLessThan(0);
    });
});

describe("zoneClock", () => {
    it("names a zone's clock and its offset from UTC on a date, daylight saving included", () => {
        expect(zoneClock("America/Los_Angeles", new Date("2026-09-29T12:00:00Z"))).toEqual({ abbreviation: "PDT", offset: "-07:00" });
        expect(zoneClock("America/Los_Angeles", new Date("2026-12-01T12:00:00Z"))).toEqual({ abbreviation: "PST", offset: "-08:00" });
        expect(zoneClock("Asia/Kolkata", new Date("2026-09-29T12:00:00Z"))?.offset).toBe("+05:30");
        expect(zoneClock("UTC", new Date("2026-09-29T12:00:00Z"))).toEqual({ abbreviation: "UTC", offset: "+00:00" });
    });

    it("is null for a zone the runtime doesn't know, and defaults to now", () => {
        expect(zoneClock("Mars/Olympus_Mons")).toBeNull();
        expect(zoneClock("UTC")).toEqual({ abbreviation: "UTC", offset: "+00:00" });
    });
});

describe("describeTimeZone", () => {
    const at = new Date("2026-09-29T12:00:00Z");

    it("puts the city first, then its region, then the offset from UTC", () => {
        expect(describeTimeZone("America/Los_Angeles", at)).toBe("Los Angeles, America (GMT-07:00)");
        expect(describeTimeZone("Africa/Abidjan", at)).toBe("Abidjan, Africa (GMT+00:00)");
        expect(describeTimeZone("Australia/Adelaide", at)).toBe("Adelaide, Australia (GMT+09:30)");
        expect(describeTimeZone("America/Argentina/Buenos_Aires", at)).toBe("Buenos Aires, America/Argentina (GMT-03:00)");
    });

    it("has no region for a zone with none, and reads daylight saving on the date", () => {
        expect(describeTimeZone("UTC", at)).toBe("UTC (GMT+00:00)");
        expect(describeTimeZone("America/New_York", new Date("2026-12-01T12:00:00Z"))).toBe("New York, America (GMT-05:00)");
    });

    it("is just the name for a zone the runtime doesn't know", () => {
        expect(describeTimeZone("Mars/Olympus_Mons", at)).toBe("Mars/Olympus Mons");
    });
});
