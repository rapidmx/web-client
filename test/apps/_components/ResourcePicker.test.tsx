// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import ResourcePicker from "../../../apps/shared/components/calendar/ResourcePicker.js";

// `PopoverPortal`'s own positioning/portal/outside-click behavior is tested in its own file — mocked
// here to a plain passthrough so this file only exercises `ResourcePicker`'s own content.
vi.mock("../../../apps/shared/components/mail/compose/PopoverPortal.js", () => ({
    default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const anchorRef = { current: null };

function resource(overrides: Partial<{ uid: string; primarySmtpAddress: string; displayName: string; resourceType: "room" | "equipment"; resourceCapacity?: number }> = {}) {
    return {
        uid: "room-a@example.com",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        primarySmtpAddress: "room-a@example.com",
        aliasAddresses: [],
        displayName: "Room A",
        timezone: "UTC",
        quotaBytes: 0,
        usedBytes: 0,
        isResource: true,
        resourceType: "room" as const,
        resourceCapacity: 8,
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ResourcePicker", () => {
    it("shows a loading state before results arrive", () => {
        mockFetch(() => new Promise(() => undefined));
        render(<ResourcePicker anchorRef={anchorRef} onClose={vi.fn()} onSelect={vi.fn()} excludeAddresses={[]} />);
        expect(screen.getByText("Loading…")).toBeInTheDocument();
    });

    it("loads resources on mount and renders them with type/capacity", async () => {
        mockFetch(() => jsonResponse(200, [resource()]));
        render(<ResourcePicker anchorRef={anchorRef} onClose={vi.fn()} onSelect={vi.fn()} excludeAddresses={[]} />);

        expect(await screen.findByRole("button", { name: /Room A/ })).toBeInTheDocument();
        expect(screen.getByText("room · 8")).toBeInTheDocument();
    });

    it("shows a 'no matching resources' message when the list is empty", async () => {
        mockFetch(() => jsonResponse(200, []));
        render(<ResourcePicker anchorRef={anchorRef} onClose={vi.fn()} onSelect={vi.fn()} excludeAddresses={[]} />);
        expect(await screen.findByText("No matching resources.")).toBeInTheDocument();
    });

    it("shows an error message when loading fails", async () => {
        mockFetch(() => jsonResponse(500, { message: "boom" }));
        render(<ResourcePicker anchorRef={anchorRef} onClose={vi.fn()} onSelect={vi.fn()} excludeAddresses={[]} />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        render(<ResourcePicker anchorRef={anchorRef} onClose={vi.fn()} onSelect={vi.fn()} excludeAddresses={[]} />);
        expect(await screen.findByText("Could not load resources.")).toBeInTheDocument();
    });

    it("filters the list client-side by name/address as the reader types", async () => {
        mockFetch(() => jsonResponse(200, [resource(), resource({ uid: "eq-b@example.com", primarySmtpAddress: "eq-b@example.com", displayName: "Projector", resourceType: "equipment", resourceCapacity: undefined })]));
        const user = userEvent.setup();
        render(<ResourcePicker anchorRef={anchorRef} onClose={vi.fn()} onSelect={vi.fn()} excludeAddresses={[]} />);
        await screen.findByRole("button", { name: /Room A/ });

        await user.type(screen.getByPlaceholderText("Search rooms & equipment…"), "projector");

        expect(screen.queryByRole("button", { name: /Room A/ })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Projector/ })).toBeInTheDocument();
    });

    it("excludes already-added attendee addresses from the list", async () => {
        mockFetch(() => jsonResponse(200, [resource()]));
        render(<ResourcePicker anchorRef={anchorRef} onClose={vi.fn()} onSelect={vi.fn()} excludeAddresses={["room-a@example.com"]} />);
        expect(await screen.findByText("No matching resources.")).toBeInTheDocument();
    });

    it("calls onSelect with the clicked resource mailbox", async () => {
        mockFetch(() => jsonResponse(200, [resource()]));
        const onSelect = vi.fn();
        const user = userEvent.setup();
        render(<ResourcePicker anchorRef={anchorRef} onClose={vi.fn()} onSelect={onSelect} excludeAddresses={[]} />);

        await user.click(await screen.findByRole("button", { name: /Room A/ }));

        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ uid: "room-a@example.com" }));
    });

    it("defaults an unset resourceType to 'room' and omits the capacity separator when capacity is unset", async () => {
        mockFetch(() => jsonResponse(200, [resource({ resourceType: undefined, resourceCapacity: undefined })]));
        render(<ResourcePicker anchorRef={anchorRef} onClose={vi.fn()} onSelect={vi.fn()} excludeAddresses={[]} />);
        expect(await screen.findByText("room")).toBeInTheDocument();
    });
});
