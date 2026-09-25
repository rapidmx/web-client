// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import {
    BOOKING_SETTINGS_SECTION_ID,
    bookingPublicUrl,
    bookingSettingsHref,
    createBookingType,
    newBookingLinkHref,
    slugFor,
} from "../../../apps/shared/calendar/bookingPlugin.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("bookingSettingsHref", () => {
    it("is where the plugin's Settings section points, without a trailing slash", () => {
        expect(bookingSettingsHref({ settingsSections: [{ id: BOOKING_SETTINGS_SECTION_ID, label: "Booking Links", href: "/settings/booking-types" }] })).toBe(
            "/settings/booking-types",
        );
        expect(bookingSettingsHref({ settingsSections: [{ id: "booking-types", label: "Booking Links", href: "/settings/booking-types/" }] })).toBe(
            "/settings/booking-types",
        );
    });

    it("finds the section among other plugins'", () => {
        expect(
            bookingSettingsHref({
                settingsSections: [
                    { id: "other", label: "Other", href: "/settings/other" },
                    { id: "booking-types", label: "Booking Links", href: "/settings/booking-types" },
                ],
            }),
        ).toBe("/settings/booking-types");
    });

    it("is undefined when the plugin is not running: no navigation, no settings sections, or none of them the plugin's", () => {
        expect(bookingSettingsHref(undefined)).toBeUndefined();
        expect(bookingSettingsHref({})).toBeUndefined();
        expect(bookingSettingsHref({ settingsSections: [{ id: "other", label: "Other", href: "/settings/other" }] })).toBeUndefined();
    });

    it("is undefined for a link that leaves the site", () => {
        expect(bookingSettingsHref({ settingsSections: [{ id: "booking-types", label: "Booking Links", href: "//evil.example/settings" }] })).toBeUndefined();
    });
});

describe("newBookingLinkHref", () => {
    it("is the plugin's new-link page for the mailbox", () => {
        expect(newBookingLinkHref("/settings/booking-types", "jane@example.com")).toBe("/settings/booking-types/new?mailboxUid=jane%40example.com");
    });
});

describe("slugFor", () => {
    it("lowercases a name and joins its words with hyphens", () => {
        expect(slugFor("  30 Minute Intro Call! ")).toBe("30-minute-intro-call");
    });

    it("falls back to a fixed word when nothing usable is left", () => {
        expect(slugFor("!!!")).toBe("appointments");
    });
});

describe("bookingPublicUrl", () => {
    it("is the public page on this site, with the mailbox's @ left as it is", () => {
        expect(bookingPublicUrl("jane@example.com", "intro call")).toBe(`${window.location.origin}/book/jane@example.com/intro%20call`);
    });
});

describe("createBookingType", () => {
    it("posts the booking type with the plugin's defaults under what is given", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "b1", mailboxUid: "mb1", slug: "intro", name: "Intro" }));

        const created = await createBookingType({
            mailboxUid: "mb1",
            calendarFolderUid: "f1",
            slug: "intro",
            name: "Intro",
            hostDisplayName: "Jane",
            meetingTypes: [{ name: "Intro", durationMinutes: 30, locationOptions: [{ type: "video" }] }],
            timezone: "UTC",
            availability: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }],
            bufferAfterMinutes: 10,
        });

        expect(created.uid).toBe("b1");
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("/api/mail/booking-types");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body)).toEqual({
            mailboxUid: "mb1",
            calendarFolderUid: "f1",
            slug: "intro",
            name: "Intro",
            hostDisplayName: "Jane",
            meetingTypes: [{ name: "Intro", durationMinutes: 30, locationOptions: [{ type: "video" }] }],
            timezone: "UTC",
            availability: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }],
            dateOverrides: [],
            bufferBeforeMinutes: 0,
            bufferAfterMinutes: 10,
            minimumNoticeMinutes: 60,
            bookingWindowDays: 30,
            requiresApproval: false,
            enabled: true,
        });
    });
});
