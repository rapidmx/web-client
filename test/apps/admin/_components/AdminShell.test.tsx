// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../../testUtils.js";
import AdminShell from "../../../../apps/shared/components/admin/layout/AdminShell.js";

const AUTH_SERVER_URL = "https://auth.example.com";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("AdminShell", () => {
    it("redirects to auth-server's sign-in page, carrying return_to, when there is no userUid", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/admin";
        render(
            <AdminShell active="mailboxes" authServerUrl={AUTH_SERVER_URL}>
                content
            </AdminShell>,
        );
        await waitFor(() =>
            expect(location.href).toBe(
                `${AUTH_SERVER_URL}/auth/signin?return_to=${encodeURIComponent("https://mail.example.com/admin")}`,
            ),
        );
        expect(screen.queryByText("content")).not.toBeInTheDocument();
    });

    it("shows an access-denied message when the /admin canary returns 403", async () => {
        mockFetch(() => jsonResponse(403, { code: "api-103", message: "User does not have permission." }));
        render(
            <AdminShell active="mailboxes" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AdminShell>,
        );
        expect(await screen.findByText("You do not have administrator access.")).toBeInTheDocument();
        expect(screen.queryByText("content")).not.toBeInTheDocument();
    });

    it("shows an error message when the authorization check fails for a reason other than 401/403", async () => {
        mockFetch(() => jsonResponse(500, { message: "boom" }));
        render(
            <AdminShell active="mailboxes" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AdminShell>,
        );
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when the authorization check fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        render(
            <AdminShell active="mailboxes" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AdminShell>,
        );
        expect(await screen.findByText("Could not verify administrator access.")).toBeInTheDocument();
    });

    it("renders the icon rail with the five global sections, highlighting the active one", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new Error(`unexpected ${url}`);
        });
        render(
            <AdminShell active="domains" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AdminShell>,
        );
        await screen.findByText("content");

        const rail = within(screen.getByRole("navigation", { name: "Admin sections" }));
        const mailboxes = rail.getByRole("link", { name: "Mailboxes" });
        const domains = rail.getByRole("link", { name: "Domains" });
        const auditLog = rail.getByRole("link", { name: "Audit Log" });
        const distributionLists = rail.getByRole("link", { name: "Distribution Lists" });
        const transportRules = rail.getByRole("link", { name: "Transport Rules" });

        expect(mailboxes).toHaveAttribute("href", "/admin");
        expect(domains).toHaveAttribute("href", "/admin/domains");
        expect(auditLog).toHaveAttribute("href", "/admin/audit-log");
        expect(distributionLists).toHaveAttribute("href", "/admin/distribution-lists");
        expect(transportRules).toHaveAttribute("href", "/admin/transport-rules");

        expect(domains).toHaveAttribute("aria-current", "page");
        expect(domains.className).toContain("bg-primary/10");
        expect(mailboxes).not.toHaveAttribute("aria-current");
        expect(mailboxes.className).not.toContain("bg-primary/10");
    });

    it("does not render mailbox-scoped sections (Quarantine, Ingest Queue) in the icon rail or mobile tab bar", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new Error(`unexpected ${url}`);
        });
        render(
            <AdminShell active="quarantine" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AdminShell>,
        );
        await screen.findByText("content");

        expect(
            within(screen.getByRole("navigation", { name: "Admin sections" })).queryByRole("link", {
                name: "Quarantine",
            }),
        ).not.toBeInTheDocument();
        expect(
            within(screen.getByRole("navigation", { name: "Admin sections" })).queryByRole("link", {
                name: "Ingest Queue",
            }),
        ).not.toBeInTheDocument();
        expect(
            within(screen.getByRole("navigation", { name: "Mobile navigation" })).queryByRole("link", {
                name: "Quarantine",
            }),
        ).not.toBeInTheDocument();
        expect(
            within(screen.getByRole("navigation", { name: "Mobile navigation" })).queryByRole("link", {
                name: "Ingest Queue",
            }),
        ).not.toBeInTheDocument();

        // Still resolves the header label for a mailbox-scoped section reached via a mailbox detail page link.
        expect(screen.getByText("Quarantine", { selector: "span" })).toBeInTheDocument();
    });

    it("hides the icon rail below md, shows it at md and above", async () => {
        mockFetch(() => jsonResponse(200, {}));
        render(
            <AdminShell active="mailboxes" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AdminShell>,
        );
        await screen.findByText("content");
        expect(screen.getByRole("navigation", { name: "Admin sections" })).toHaveClass("hidden", "md:flex");
    });

    it("renders the mobile bottom tab bar with the same global sections, highlighting the active one", async () => {
        mockFetch(() => jsonResponse(200, {}));
        render(
            <AdminShell active="domains" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AdminShell>,
        );
        await screen.findByText("content");

        const tabBar = within(screen.getByRole("navigation", { name: "Mobile navigation" }));
        expect(tabBar.getByRole("link", { name: "Domains" })).toHaveAttribute("aria-current", "page");
        expect(tabBar.getByRole("link", { name: "Mailboxes" })).not.toHaveAttribute("aria-current");
    });

    it("shows the header with the active section's label and renders children, and signs out to auth-server", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") {
                return jsonResponse(200, {});
            }
            throw new Error(`unexpected ${url}`);
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(
            <AdminShell active="mailboxes" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AdminShell>,
        );

        expect(await screen.findByText("content")).toBeInTheDocument();
        expect(screen.getByText("Mailboxes", { selector: "span" })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.getByText("admin-1")).toBeInTheDocument();
        await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
        expect(location.href).toBe(AUTH_SERVER_URL);
    });

    it("signs out to '/' when authServerUrl is not configured", async () => {
        mockFetch(() => jsonResponse(200, {}));
        const location = mockLocation();
        const user = userEvent.setup();
        render(
            <AdminShell active="mailboxes" userUid="admin-1">
                content
            </AdminShell>,
        );

        await screen.findByText("content");
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
        expect(location.href).toBe("/");
    });
});
