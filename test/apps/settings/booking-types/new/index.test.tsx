// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../../../testUtils.js";
import NewBookingTypePage from "../../../../../apps/www/settings/booking-types/new/index.js";

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
const calendarFolder = {
    uid: "f-cal",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    name: "Calendar",
    type: "calendar" as const,
    unreadCount: 0,
    totalCount: 0,
};
const inboxFolder = { ...calendarFolder, uid: "f-inbox", name: "Inbox", type: "inbox" as const };

const created = {
    uid: "bt1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    calendarFolderUid: "f-cal",
    slug: "intro-call",
    name: "Intro Call",
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

function mockShell(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, calendarFolder]);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("NewBookingTypePage", () => {
    it("prefills host name and timezone from the mailbox", async () => {
        mockShell();
        render(<NewBookingTypePage userUid="u1" />);

        expect(await screen.findByLabelText("Host name shown to visitors")).toHaveValue("My Mail");
        expect(screen.getByLabelText("Timezone")).toHaveValue("America/New_York");
    });

    it("shows an error when the calendar folder can't be resolved", async () => {
        mockShell((url) => (url.startsWith("/api/mail/folders") ? jsonResponse(200, [inboxFolder]) : undefined));
        render(<NewBookingTypePage userUid="u1" />);
        expect(await screen.findByText("This mailbox has no Calendar folder yet.")).toBeInTheDocument();
    });

    it("shows an error when loading folders fails with an API error", async () => {
        mockShell((url) => (url.startsWith("/api/mail/folders") ? jsonResponse(500, { message: "folders boom" }) : undefined));
        render(<NewBookingTypePage userUid="u1" />);
        expect(await screen.findByText("folders boom")).toBeInTheDocument();
    });

    it("shows a generic error when loading folders fails with a non-API error", async () => {
        mockShell((url) => {
            if (url.startsWith("/api/mail/folders")) throw new TypeError("network down");
            return undefined;
        });
        render(<NewBookingTypePage userUid="u1" />);
        expect(await screen.findByText("Could not load this mailbox's folders.")).toBeInTheDocument();
    });

    it("requires slug, name, and host name before submitting", async () => {
        mockShell();
        const user = userEvent.setup();
        render(<NewBookingTypePage userUid="u1" />);
        await screen.findByLabelText("Host name shown to visitors");

        await user.clear(screen.getByLabelText("Host name shown to visitors"));
        await user.click(screen.getByRole("button", { name: "Create" }));

        expect(await screen.findByText("Slug, name, and host name are all required.")).toBeInTheDocument();
    });

    it("creates the booking type and navigates to its detail page", async () => {
        const location = mockLocation();
        const fetchMock = mockShell((url, init) =>
            url === "/api/mail/booking-types" && init?.method === "POST" ? jsonResponse(200, created) : undefined,
        );
        const user = userEvent.setup();
        render(<NewBookingTypePage userUid="u1" />);
        await screen.findByLabelText("Host name shown to visitors");

        await user.type(screen.getByLabelText("Name"), "Intro Call");
        await user.type(screen.getByLabelText("Slug (used in the public link)"), "intro-call");
        await user.click(screen.getByRole("button", { name: "Create" }));

        await vi.waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/booking-types", expect.objectContaining({ method: "POST" })),
        );
        const body = JSON.parse((fetchMock.mock.calls.find(([u]) => u === "/api/mail/booking-types")![1] as RequestInit).body as string);
        expect(body.calendarFolderUid).toBe("f-cal");
        await vi.waitFor(() => expect(location.href).toBe("/settings/booking-types/bt1?mailboxUid=mb1"));
    });

    it("shows an error message when creation fails", async () => {
        mockShell((url, init) =>
            url === "/api/mail/booking-types" && init?.method === "POST" ? jsonResponse(400, { message: "slug taken" }) : undefined,
        );
        const user = userEvent.setup();
        render(<NewBookingTypePage userUid="u1" />);
        await screen.findByLabelText("Host name shown to visitors");

        await user.type(screen.getByLabelText("Name"), "Intro Call");
        await user.type(screen.getByLabelText("Slug (used in the public link)"), "intro-call");
        await user.click(screen.getByRole("button", { name: "Create" }));

        expect(await screen.findByText("slug taken")).toBeInTheDocument();
    });

    it("shows a generic error message when creation fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/booking-types" && init?.method === "POST") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<NewBookingTypePage userUid="u1" />);
        await screen.findByLabelText("Host name shown to visitors");

        await user.type(screen.getByLabelText("Name"), "Intro Call");
        await user.type(screen.getByLabelText("Slug (used in the public link)"), "intro-call");
        await user.click(screen.getByRole("button", { name: "Create" }));

        expect(await screen.findByText("Could not create this booking link.")).toBeInTheDocument();
    });

    it("adds an availability window and includes it in the created payload", async () => {
        const fetchMock = mockShell((url, init) =>
            url === "/api/mail/booking-types" && init?.method === "POST" ? jsonResponse(200, created) : undefined,
        );
        const user = userEvent.setup();
        render(<NewBookingTypePage userUid="u1" />);
        await screen.findByLabelText("Host name shown to visitors");

        await user.type(screen.getByLabelText("Name"), "Intro Call");
        await user.type(screen.getByLabelText("Slug (used in the public link)"), "intro-call");
        await user.click(screen.getByRole("button", { name: "Add window" }));
        await user.click(screen.getByRole("button", { name: "Create" }));

        await vi.waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/booking-types", expect.objectContaining({ method: "POST" })),
        );
        const body = JSON.parse((fetchMock.mock.calls.find(([u]) => u === "/api/mail/booking-types")![1] as RequestInit).body as string);
        expect(body.availability).toHaveLength(1);
    });

    it("toggles the requires-approval checkbox and updates duration/notice/window fields", async () => {
        mockShell();
        const user = userEvent.setup();
        render(<NewBookingTypePage userUid="u1" />);
        await screen.findByLabelText("Host name shown to visitors");

        await user.click(screen.getByLabelText("Require my approval before confirming a booking"));
        expect(screen.getByLabelText("Require my approval before confirming a booking")).toBeChecked();

        const duration = screen.getByLabelText("Duration (minutes)");
        await user.clear(duration);
        await user.type(duration, "45");
        expect(duration).toHaveValue(45);

        const notice = screen.getByLabelText("Minimum notice (minutes)");
        await user.clear(notice);
        await user.type(notice, "120");
        expect(notice).toHaveValue(120);

        const windowDays = screen.getByLabelText("Booking window (days ahead)");
        await user.clear(windowDays);
        await user.type(windowDays, "14");
        expect(windowDays).toHaveValue(14);

        await user.type(screen.getByLabelText("Description (optional)"), "Let's chat");
        expect(screen.getByLabelText("Description (optional)")).toHaveValue("Let's chat");

        await user.clear(screen.getByLabelText("Timezone"));
        await user.type(screen.getByLabelText("Timezone"), "UTC");
        expect(screen.getByLabelText("Timezone")).toHaveValue("UTC");
    });

    it("blocks submission with its own message when the calendar folder is still missing at submit time", async () => {
        mockShell((url) => (url.startsWith("/api/mail/folders") ? jsonResponse(200, [inboxFolder]) : undefined));
        const user = userEvent.setup();
        render(<NewBookingTypePage userUid="u1" />);
        await screen.findByText("This mailbox has no Calendar folder yet.");

        await user.type(screen.getByLabelText("Name"), "Intro Call");
        await user.type(screen.getByLabelText("Slug (used in the public link)"), "intro-call");
        await user.click(screen.getByRole("button", { name: "Create" }));

        expect(await screen.findAllByText("This mailbox has no Calendar folder yet.")).toHaveLength(2);
    });
});
