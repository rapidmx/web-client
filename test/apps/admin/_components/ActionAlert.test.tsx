// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../../testUtils.js";
import ActionAlert, { ReconfirmIdentityContext } from "../../../../apps/shared/components/admin/ActionAlert.js";
import AdminShell from "../../../../apps/shared/components/admin/layout/AdminShell.js";
import {
    ELEVATION_ACTION_MESSAGE,
    ELEVATION_ATTEMPT_KEY,
    elevationUrl,
    isElevationMessage,
} from "../../../../apps/shared/components/admin/elevation.js";
import { ELEVATION_MESSAGE as DIAGNOSTICS_ELEVATION_MESSAGE } from "../../../../apps/shared/components/admin/diagnostics/format.js";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sessionStorage.clear();
});

describe("isElevationMessage", () => {
    it("recognizes the message of an action, a plugin and the diagnostics, and nothing else", () => {
        expect(isElevationMessage(ELEVATION_ACTION_MESSAGE)).toBe(true);
        expect(isElevationMessage(DIAGNOSTICS_ELEVATION_MESSAGE)).toBe(true);
        expect(isElevationMessage("Deleting data needs you to have recently confirmed your identity. Reload this page.")).toBe(true);
        expect(isElevationMessage("Could not save the retention policy.")).toBe(false);
    });
});

describe("ActionAlert", () => {
    it("offers to confirm the user's identity again beside the message that says it is needed", async () => {
        const reconfirm = vi.fn();
        const user = userEvent.setup();
        render(
            <ReconfirmIdentityContext.Provider value={reconfirm}>
                <ActionAlert>{ELEVATION_ACTION_MESSAGE}</ActionAlert>
            </ReconfirmIdentityContext.Provider>,
        );
        expect(screen.getByRole("alert")).toHaveTextContent(ELEVATION_ACTION_MESSAGE);
        await user.click(screen.getByRole("button", { name: "Confirm identity again" }));
        expect(reconfirm).toHaveBeenCalledTimes(1);
    });

    it("offers nothing for any other failure, for content that is not a message, or where there is nothing to confirm with", () => {
        const { rerender } = render(
            <ReconfirmIdentityContext.Provider value={vi.fn()}>
                <ActionAlert>Could not save the retention policy.</ActionAlert>
            </ReconfirmIdentityContext.Provider>,
        );
        expect(screen.getByRole("alert")).toHaveTextContent("Could not save the retention policy.");
        expect(screen.queryByRole("button")).not.toBeInTheDocument();

        rerender(
            <ReconfirmIdentityContext.Provider value={vi.fn()}>
                <ActionAlert>
                    <b>{ELEVATION_ACTION_MESSAGE}</b>
                </ActionAlert>
            </ReconfirmIdentityContext.Provider>,
        );
        expect(screen.queryByRole("button")).not.toBeInTheDocument();

        rerender(<ActionAlert>{ELEVATION_ACTION_MESSAGE}</ActionAlert>);
        expect(screen.getByRole("alert")).toHaveTextContent(ELEVATION_ACTION_MESSAGE);
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("inside the admin shell sends the browser to auth-server to confirm identity again, returning to the page, and records the attempt", async () => {
        const returnTo = "https://mail.example.com/admin/retention-policy";
        mockFetch((url) => (url === "/api/admin/release-notes" ? jsonResponse(200, {}) : jsonResponse(200, { required: false })));
        const location = mockLocation();
        location.href = returnTo;
        const user = userEvent.setup();
        render(
            <AdminShell active="retentionPolicy" userUid="admin-1" authServerUrl="https://auth.example.com">
                <ActionAlert>{ELEVATION_ACTION_MESSAGE}</ActionAlert>
            </AdminShell>,
        );

        await user.click(await screen.findByRole("button", { name: "Confirm identity again" }));
        await waitFor(() => expect(location.href).toBe(elevationUrl("https://auth.example.com", returnTo)));
        expect(sessionStorage.getItem(ELEVATION_ATTEMPT_KEY)).not.toBeNull();
    });

    it("inside an admin shell with no auth-server to send the browser to, offers no button", async () => {
        mockFetch((url) => (url === "/api/admin/release-notes" ? jsonResponse(200, {}) : jsonResponse(200, { required: false })));
        render(
            <AdminShell active="retentionPolicy" userUid="admin-1">
                <ActionAlert>{ELEVATION_ACTION_MESSAGE}</ActionAlert>
            </AdminShell>,
        );
        expect(await screen.findByRole("alert")).toHaveTextContent(ELEVATION_ACTION_MESSAGE);
        expect(screen.queryByRole("button", { name: "Confirm identity again" })).not.toBeInTheDocument();
    });
});
