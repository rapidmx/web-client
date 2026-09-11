// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import ResourceSettingsCard from "../../../../apps/shared/components/admin/mailboxes/ResourceSettingsCard.js";

const mailbox = {
    uid: "room1@example.com",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    primarySmtpAddress: "room1@example.com",
    aliasAddresses: [],
    displayName: "Conference Room 1",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
    isResource: true,
    resourceType: "room" as const,
    resourceCapacity: 8,
    autoAcceptBookings: true,
    allowConflicts: false,
    bookingWindowDays: 30,
    maxDurationMinutes: 120,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ResourceSettingsCard", () => {
    it("renders the mailbox's current resource settings", () => {
        render(<ResourceSettingsCard mailbox={mailbox} onUpdate={vi.fn()} />);
        expect(screen.getByLabelText("Resource type")).toHaveValue("room");
        expect(screen.getByLabelText("Capacity")).toHaveValue(8);
        expect(screen.getByRole("checkbox", { name: "Automatically accept booking requests" })).toBeChecked();
        expect(screen.getByRole("checkbox", { name: /Allow conflicting bookings/ })).not.toBeChecked();
        expect(screen.getByLabelText("Booking window, in days")).toHaveValue(30);
        expect(screen.getByLabelText("Maximum duration, in minutes")).toHaveValue(120);
    });

    it("toggles 'Automatically accept booking requests' and 'Allow conflicting bookings'", async () => {
        const user = userEvent.setup();
        render(<ResourceSettingsCard mailbox={mailbox} onUpdate={vi.fn()} />);

        const autoAccept = screen.getByRole("checkbox", { name: "Automatically accept booking requests" });
        const allowConflicts = screen.getByRole("checkbox", { name: /Allow conflicting bookings/ });

        await user.click(autoAccept);
        expect(autoAccept).not.toBeChecked();
        await user.click(allowConflicts);
        expect(allowConflicts).toBeChecked();
    });

    it("renders blank optional numeric fields when unset", () => {
        render(
            <ResourceSettingsCard
                mailbox={{ ...mailbox, resourceCapacity: undefined, bookingWindowDays: undefined, maxDurationMinutes: undefined }}
                onUpdate={vi.fn()}
            />,
        );
        expect(screen.getByLabelText("Capacity")).toHaveValue(null);
        expect(screen.getByLabelText("Booking window, in days")).toHaveValue(null);
        expect(screen.getByLabelText("Maximum duration, in minutes")).toHaveValue(null);
    });

    it("defaults resourceType to 'room' when unset", () => {
        render(<ResourceSettingsCard mailbox={{ ...mailbox, resourceType: undefined }} onUpdate={vi.fn()} />);
        expect(screen.getByLabelText("Resource type")).toHaveValue("room");
    });

    it("saves edited settings and calls onUpdate with the saved mailbox", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            requestBody = JSON.parse(init.body as string);
            return jsonResponse(200, { ...mailbox, version: 1, resourceType: "equipment", resourceCapacity: 2 });
        });
        const onUpdate = vi.fn();
        const user = userEvent.setup();
        render(<ResourceSettingsCard mailbox={mailbox} onUpdate={onUpdate} />);

        await user.selectOptions(screen.getByLabelText("Resource type"), "equipment");
        await user.clear(screen.getByLabelText("Capacity"));
        await user.type(screen.getByLabelText("Capacity"), "2");
        await user.click(screen.getByRole("button", { name: "Save resource settings" }));

        expect(requestBody).toEqual({
            uid: "room1@example.com",
            version: 0,
            resourceType: "equipment",
            resourceCapacity: 2,
            autoAcceptBookings: true,
            allowConflicts: false,
            bookingWindowDays: 30,
            maxDurationMinutes: 120,
        });
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(onUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ version: 1, resourceType: "equipment", resourceCapacity: 2 }),
        );
    });

    it("sends undefined for capacity/booking window/max duration when cleared", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            requestBody = JSON.parse(init.body as string);
            return jsonResponse(200, mailbox);
        });
        const user = userEvent.setup();
        render(<ResourceSettingsCard mailbox={mailbox} onUpdate={vi.fn()} />);

        await user.clear(screen.getByLabelText("Capacity"));
        await user.clear(screen.getByLabelText("Booking window, in days"));
        await user.clear(screen.getByLabelText("Maximum duration, in minutes"));
        await user.click(screen.getByRole("button", { name: "Save resource settings" }));

        await vi.waitFor(() => expect(requestBody).toBeDefined());
        expect(requestBody.resourceCapacity).toBeUndefined();
        expect(requestBody.bookingWindowDays).toBeUndefined();
        expect(requestBody.maxDurationMinutes).toBeUndefined();
    });

    it("shows an error message when saving fails", async () => {
        mockFetch(() => jsonResponse(409, { message: "version conflict" }));
        const user = userEvent.setup();
        render(<ResourceSettingsCard mailbox={mailbox} onUpdate={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Save resource settings" }));

        expect(await screen.findByText("version conflict")).toBeInTheDocument();
    });

    it("shows a generic error message when saving fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<ResourceSettingsCard mailbox={mailbox} onUpdate={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Save resource settings" }));

        expect(await screen.findByText("Could not save resource settings.")).toBeInTheDocument();
    });
});
