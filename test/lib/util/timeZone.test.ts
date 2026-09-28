// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, deviceTimeZone, timeZoneOptions } from "../../../lib/util/timeZone.js";

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
    it("lists UTC, what the browser knows and the zones given, once each and sorted", () => {
        const options = timeZoneOptions("Nowhere/Custom", "UTC", "");
        expect(options).toContain("UTC");
        expect(options).toContain("Nowhere/Custom");
        expect(options).toContain("America/Los_Angeles");
        expect(new Set(options).size).toBe(options.length);
        expect(options).toEqual([...options].sort((a, b) => a.localeCompare(b)));
    });

    it("still offers UTC and the given zones where the browser has no list", () => {
        const original = (Intl as any).supportedValuesOf;
        (Intl as any).supportedValuesOf = () => {
            throw new Error("unsupported");
        };
        try {
            expect(timeZoneOptions("Europe/Paris")).toEqual(["Europe/Paris", "UTC"]);
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
