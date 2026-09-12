// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../../testUtils.js";
import EscrowShell from "../../../../apps/shared/components/escrow/layout/EscrowShell.js";

const AUTH_SERVER_URL = "https://auth.example.com";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("EscrowShell", () => {
    it("redirects to auth-server's sign-in page, carrying return_to, when there is no userUid", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/escrow";
        render(
            <EscrowShell active="matters" authServerUrl={AUTH_SERVER_URL}>
                content
            </EscrowShell>,
        );
        await waitFor(() =>
            expect(location.href).toBe(
                `${AUTH_SERVER_URL}/auth/signin?return_to=${encodeURIComponent("https://mail.example.com/escrow")}`,
            ),
        );
        expect(screen.queryByText("content")).not.toBeInTheDocument();
    });

    it("shows an error message when the reachability probe fails with an API error", async () => {
        mockFetch(() => jsonResponse(500, { message: "boom" }));
        render(
            <EscrowShell active="matters" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </EscrowShell>,
        );
        expect(await screen.findByText("boom")).toBeInTheDocument();
        expect(screen.queryByText("content")).not.toBeInTheDocument();
    });

    it("shows a generic error message when the reachability probe fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        render(
            <EscrowShell active="matters" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </EscrowShell>,
        );
        expect(await screen.findByText("Could not verify escrow console access.")).toBeInTheDocument();
    });

    it("renders both sections in the icon rail, highlighting the active one, even when the probe returns an empty list", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/escrow/matters")) return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        render(
            <EscrowShell active="auditLog" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </EscrowShell>,
        );
        await screen.findByText("content");

        const rail = within(screen.getByRole("navigation", { name: "Escrow sections" }));
        const matters = rail.getByRole("link", { name: "Matters" });
        const auditLog = rail.getByRole("link", { name: "Audit Log" });

        expect(matters).toHaveAttribute("href", "/escrow");
        expect(auditLog).toHaveAttribute("href", "/escrow/audit-log");
        expect(auditLog).toHaveAttribute("aria-current", "page");
        expect(auditLog.className).toContain("bg-primary/10");
        expect(matters).not.toHaveAttribute("aria-current");
    });

    it("renders the mobile bottom tab bar with the same sections", async () => {
        mockFetch(() => jsonResponse(200, []));
        render(
            <EscrowShell active="matters" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </EscrowShell>,
        );
        await screen.findByText("content");

        const tabBar = within(screen.getByRole("navigation", { name: "Mobile navigation" }));
        expect(tabBar.getByRole("link", { name: "Matters" })).toHaveAttribute("aria-current", "page");
        expect(tabBar.getByRole("link", { name: "Audit Log" })).not.toHaveAttribute("aria-current");
    });

    it("shows the header with the active section's label and renders children, and signs out to auth-server", async () => {
        mockFetch(() => jsonResponse(200, []));
        const location = mockLocation();
        const user = userEvent.setup();
        render(
            <EscrowShell active="matters" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </EscrowShell>,
        );

        expect(await screen.findByText("content")).toBeInTheDocument();
        expect(screen.getByText("Matters", { selector: "span" })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.getByText("u1")).toBeInTheDocument();
        await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
        expect(location.href).toBe(AUTH_SERVER_URL);
    });

    it("signs out to '/' when authServerUrl is not configured", async () => {
        mockFetch(() => jsonResponse(200, []));
        const location = mockLocation();
        const user = userEvent.setup();
        render(
            <EscrowShell active="matters" userUid="u1">
                content
            </EscrowShell>,
        );

        await screen.findByText("content");
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
        expect(location.href).toBe("/");
    });
});
