// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../../testUtils.js";
import BookingTypeDetailPage from "../../../../apps/www/settings/booking-types/[uid].js";

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

function bookingType(overrides: Record<string, unknown> = {}) {
    return {
        uid: "bt1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        calendarFolderUid: "f-cal",
        slug: "intro-call",
        name: "Intro Call",
        description: "",
        hostDisplayName: "My Mail",
        durationMinutes: 30,
        timezone: "America/New_York",
        availability: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }],
        dateOverrides: [],
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        minimumNoticeMinutes: 60,
        bookingWindowDays: 30,
        requiresApproval: false,
        enabled: true,
        ...overrides,
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

beforeEach(() => {
    window.history.pushState(null, "", "/settings/booking-types/bt1?mailboxUid=mb1");
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.history.pushState(null, "", "/");
});

describe("BookingTypeDetailPage", () => {
    it("loads and pre-fills the form from the existing booking type", async () => {
        mockShell((url) => (url === "/api/mail/booking-types/bt1" ? jsonResponse(200, bookingType()) : undefined));
        render(<BookingTypeDetailPage userUid="u1" params={{ uid: "bt1" }} />);

        expect(await screen.findByRole("heading", { name: "Intro Call" })).toBeInTheDocument();
        expect(screen.getByLabelText("Name")).toHaveValue("Intro Call");
        expect(screen.getByLabelText("Enabled (publicly bookable)")).toBeChecked();
        expect(screen.getByText("Monday 09:00–17:00")).toBeInTheDocument();
        expect(screen.getByText(/\/book\/intro-call/)).toBeInTheDocument();
    });

    it("defaults description to an empty string when the loaded booking type has none", async () => {
        const { description, ...withoutDescription } = bookingType();
        mockShell((url) => (url === "/api/mail/booking-types/bt1" ? jsonResponse(200, withoutDescription) : undefined));
        render(<BookingTypeDetailPage userUid="u1" params={{ uid: "bt1" }} />);
        expect(await screen.findByLabelText("Description (optional)")).toHaveValue("");
    });

    it("shows an error message when loading fails", async () => {
        mockShell((url) => (url === "/api/mail/booking-types/bt1" ? jsonResponse(404, { message: "not found" }) : undefined));
        render(<BookingTypeDetailPage userUid="u1" params={{ uid: "bt1" }} />);
        expect(await screen.findByText("not found")).toBeInTheDocument();
    });

    it("shows a generic error message when loading fails with a non-API error", async () => {
        mockShell((url) => {
            if (url === "/api/mail/booking-types/bt1") throw new TypeError("network down");
            return undefined;
        });
        render(<BookingTypeDetailPage userUid="u1" params={{ uid: "bt1" }} />);
        expect(await screen.findByText("Could not load this booking link.")).toBeInTheDocument();
    });

    it("saves changes", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url === "/api/mail/booking-types/bt1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, bookingType());
            if (url === "/api/mail/booking-types/bt1" && init?.method === "PUT") {
                return jsonResponse(200, { ...bookingType(), name: "Updated" });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<BookingTypeDetailPage userUid="u1" params={{ uid: "bt1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByLabelText("Enabled (publicly bookable)"));
        await user.clear(screen.getByLabelText("Name"));
        await user.type(screen.getByLabelText("Name"), "Updated");
        await user.type(screen.getByLabelText("Description (optional)"), "A quick chat");
        await user.clear(screen.getByLabelText("Host name shown to visitors"));
        await user.type(screen.getByLabelText("Host name shown to visitors"), "New Host");
        const duration = screen.getByLabelText("Duration (minutes)");
        await user.clear(duration);
        await user.type(duration, "45");
        await user.clear(screen.getByLabelText("Timezone"));
        await user.type(screen.getByLabelText("Timezone"), "UTC");
        const notice = screen.getByLabelText("Minimum notice (minutes)");
        await user.clear(notice);
        await user.type(notice, "30");
        const windowDays = screen.getByLabelText("Booking window (days ahead)");
        await user.clear(windowDays);
        await user.type(windowDays, "14");
        await user.click(screen.getByLabelText("Require my approval before confirming a booking"));
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([url, init]: any) => url === "/api/mail/booking-types/bt1" && init?.method === "PUT")).toBe(
            true,
        );
    });

    it("shows an error message when saving fails", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/booking-types/bt1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, bookingType());
            if (url === "/api/mail/booking-types/bt1" && init?.method === "PUT") return jsonResponse(400, { message: "boom" });
            return undefined;
        });
        const user = userEvent.setup();
        render(<BookingTypeDetailPage userUid="u1" params={{ uid: "bt1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when saving fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/booking-types/bt1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, bookingType());
            if (url === "/api/mail/booking-types/bt1" && init?.method === "PUT") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<BookingTypeDetailPage userUid="u1" params={{ uid: "bt1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Could not save this booking link.")).toBeInTheDocument();
    });

    it("copies the public link to the clipboard", async () => {
        mockShell((url) => (url === "/api/mail/booking-types/bt1" ? jsonResponse(200, bookingType()) : undefined));
        const writeText = vi.fn().mockResolvedValue(undefined);
        const user = userEvent.setup();
        render(<BookingTypeDetailPage userUid="u1" params={{ uid: "bt1" }} />);
        await screen.findByLabelText("Name");
        Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

        await user.click(screen.getByRole("button", { name: "Copy" }));

        expect(writeText).toHaveBeenCalled();
        expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    });

    it("reverts the 'Copied' confirmation back to 'Copy' after a couple of seconds", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        mockShell((url) => (url === "/api/mail/booking-types/bt1" ? jsonResponse(200, bookingType()) : undefined));
        const writeText = vi.fn().mockResolvedValue(undefined);
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<BookingTypeDetailPage userUid="u1" params={{ uid: "bt1" }} />);
        await screen.findByLabelText("Name");
        Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

        await user.click(screen.getByRole("button", { name: "Copy" }));
        expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();

        await act(() => vi.advanceTimersByTimeAsync(2000));
        expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    });

    it("swallows a clipboard write failure", async () => {
        mockShell((url) => (url === "/api/mail/booking-types/bt1" ? jsonResponse(200, bookingType()) : undefined));
        const writeText = vi.fn().mockRejectedValue(new Error("denied"));
        const user = userEvent.setup();
        render(<BookingTypeDetailPage userUid="u1" params={{ uid: "bt1" }} />);
        await screen.findByLabelText("Name");
        Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

        await user.click(screen.getByRole("button", { name: "Copy" }));

        expect(writeText).toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
    });

    it("cancels the delete confirmation without deleting", async () => {
        const fetchMock = mockShell((url) => (url === "/api/mail/booking-types/bt1" ? jsonResponse(200, bookingType()) : undefined));
        const user = userEvent.setup();
        render(<BookingTypeDetailPage userUid="u1" params={{ uid: "bt1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Delete" }));
        const dialog = screen.getByRole("dialog", { name: "Delete booking link" });
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([, init]: any) => init?.method === "DELETE")).toBe(false);
    });

    it("also closes the delete modal via its own Close button (Modal's onClose, distinct from Cancel)", async () => {
        mockShell((url) => (url === "/api/mail/booking-types/bt1" ? jsonResponse(200, bookingType()) : undefined));
        const user = userEvent.setup();
        render(<BookingTypeDetailPage userUid="u1" params={{ uid: "bt1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Delete" }));
        await user.click(screen.getByRole("button", { name: "Close" }));

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows an error message when deletion fails, keeping the modal open", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/booking-types/bt1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, bookingType());
            if (url === "/api/mail/booking-types/bt1?version=0" && init?.method === "DELETE") return jsonResponse(500, { message: "boom" });
            return undefined;
        });
        const user = userEvent.setup();
        render(<BookingTypeDetailPage userUid="u1" params={{ uid: "bt1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Delete" }));
        await user.click(screen.getAllByRole("button", { name: "Delete" })[1]);

        expect(await screen.findByText("boom")).toBeInTheDocument();
        expect(screen.getByRole("dialog", { name: "Delete booking link" })).toBeInTheDocument();
    });

    it("shows a generic error message when deletion fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/booking-types/bt1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, bookingType());
            if (url === "/api/mail/booking-types/bt1?version=0" && init?.method === "DELETE") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<BookingTypeDetailPage userUid="u1" params={{ uid: "bt1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Delete" }));
        await user.click(screen.getAllByRole("button", { name: "Delete" })[1]);

        expect(await screen.findByText("Could not delete this booking link.")).toBeInTheDocument();
    });

    // Mocks `window.location` wholesale (see `testUtils.mockLocation`) — `SettingsShell`'s own
    // `mailboxUid` resolution needs the real, pushState-driven `window.location` on mount, and
    // `mockLocation`'s replacement isn't undone between tests (unlike `vi.stubGlobal`). Must run last in
    // this file, same convention as `apps/admin/domains/[uid].test.tsx`'s own delete-navigation test.
    it("deletes the booking type via the confirmation modal and navigates to the list", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url === "/api/mail/booking-types/bt1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, bookingType());
            if (url === "/api/mail/booking-types/bt1?version=0" && init?.method === "DELETE") return new Response(null, { status: 204 });
            return undefined;
        });
        const user = userEvent.setup();
        render(<BookingTypeDetailPage userUid="u1" params={{ uid: "bt1" }} />);
        await screen.findByLabelText("Name");
        const location = mockLocation();

        await user.click(screen.getByRole("button", { name: "Delete" }));
        const dialog = screen.getByRole("dialog", { name: "Delete booking link" });
        await user.click(within(dialog).getByRole("button", { name: "Delete" }));

        await vi.waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/booking-types/bt1?version=0",
                expect.objectContaining({ method: "DELETE" }),
            ),
        );
        await vi.waitFor(() => expect(location.href).toBe("/settings/booking-types?mailboxUid=mb1"));
    });
});
