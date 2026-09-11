// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import SettingsBookingTypesPage from "../../../../apps/www/settings/booking-types/index.js";

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "My Mail",
    timezone: "America/New_York",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};

function bookingType(n: number) {
    return {
        uid: `bt${n}`,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        calendarFolderUid: "f-cal",
        slug: `intro-${n}`,
        name: `Intro Call ${n}`,
        hostDisplayName: "My Mail",
        durationMinutes: 30,
        timezone: "America/New_York",
        availability: [],
        dateOverrides: [],
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        minimumNoticeMinutes: 60,
        bookingWindowDays: 30,
        requiresApproval: false,
        enabled: true,
    };
}

function mockShell(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("SettingsBookingTypesPage", () => {
    it("shows an empty state when there are no booking links", async () => {
        mockShell((url) => (url.startsWith("/api/mail/booking-types") ? jsonResponse(200, []) : undefined));
        render(<SettingsBookingTypesPage userUid="u1" />);
        expect(await screen.findByText("No booking links yet.")).toBeInTheDocument();
    });

    it("lists booking links with their public link, duration, and enabled state", async () => {
        mockShell((url) =>
            url.startsWith("/api/mail/booking-types")
                ? jsonResponse(200, [bookingType(1), { ...bookingType(2), enabled: false }])
                : undefined,
        );
        render(<SettingsBookingTypesPage userUid="u1" />);

        expect(await screen.findByText("Intro Call 1")).toBeInTheDocument();
        expect(screen.getByText("/book/intro-1")).toBeInTheDocument();
        expect(screen.getAllByText("30 min")).toHaveLength(2);
        expect(screen.getByText("Yes")).toBeInTheDocument();
        expect(screen.getByText("No")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "+ New booking link" })).toHaveAttribute(
            "href",
            "/settings/booking-types/new?mailboxUid=mb1",
        );
        expect(screen.getAllByRole("link", { name: "View" })[0]).toHaveAttribute(
            "href",
            "/settings/booking-types/bt1?mailboxUid=mb1",
        );
    });

    it("shows an error message when the list fails to load", async () => {
        mockShell((url) => (url.startsWith("/api/mail/booking-types") ? jsonResponse(500, { message: "boom" }) : undefined));
        render(<SettingsBookingTypesPage userUid="u1" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when the list fails with a non-API error", async () => {
        mockShell((url) => {
            if (url.startsWith("/api/mail/booking-types")) throw new TypeError("network down");
            return undefined;
        });
        render(<SettingsBookingTypesPage userUid="u1" />);
        expect(await screen.findByText("Could not load your booking links.")).toBeInTheDocument();
    });
});
