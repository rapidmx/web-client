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

    it("sends an administrator to the setup wizard while first-run setup is required", async () => {
        const location = mockLocation();
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/system/setup") return jsonResponse(200, { required: true });
            throw new Error(`unexpected ${url}`);
        });
        render(
            <AdminShell active="domains" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AdminShell>,
        );
        await waitFor(() => expect(location.href).toBe("/admin/setup"));
        expect(screen.queryByText("content")).not.toBeInTheDocument();
    });

    it("shows the page when setup is finished, and never checks setup on the wizard itself", async () => {
        const fetchMock = mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/system/setup") return jsonResponse(200, { required: false });
            throw new Error(`unexpected ${url}`);
        });
        const { unmount } = render(
            <AdminShell active="domains" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AdminShell>,
        );
        expect(await screen.findByText("content")).toBeInTheDocument();
        unmount();

        fetchMock.mockClear();
        render(
            <AdminShell active="setup" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                wizard
            </AdminShell>,
        );
        expect(await screen.findByText("wizard")).toBeInTheDocument();
        expect(screen.getByText("Setup", { selector: "span" })).toBeInTheDocument();
        expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain("/api/system/setup");
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

    describe("plugin admin nav items", () => {
        const pluginNav = {
            adminNav: [
                { id: "bookings", href: "/admin/bookings", label: "Bookings" },
                // Core ids win - on the rail and off it (mailbox-scoped sections and the setup wizard).
                { id: "domains", href: "/admin/plugin-domains", label: "Plugin Domains" },
                { id: "quarantine", href: "/admin/plugin-quarantine", label: "Plugin Quarantine" },
                { id: "setup", href: "/admin/plugin-setup", label: "Plugin Setup" },
                { id: "rooms", href: "/admin/rooms", label: "Rooms" },
            ],
            appRail: [{ id: "notes", href: "/notes", label: "Notes" }],
        };

        function mockAuthorized() {
            mockFetch((url) => {
                if (url === "/api/admin/release-notes") return jsonResponse(200, {});
                if (url === "/api/system/setup") return jsonResponse(200, { required: false });
                throw new Error(`unexpected ${url}`);
            });
        }

        it("appends them after the core sections in the rail and the tab bar, skipping ids a core section already uses", async () => {
            mockAuthorized();
            render(
                <AdminShell active="domains" userUid="admin-1" authServerUrl={AUTH_SERVER_URL} pluginNav={pluginNav}>
                    content
                </AdminShell>,
            );
            await screen.findByText("content");

            for (const name of ["Admin sections", "Mobile navigation"]) {
                const nav = within(screen.getByRole("navigation", { name }));
                const labels = nav.getAllByRole("link").map((link) => link.getAttribute("aria-label") ?? link.textContent);
                expect(labels.slice(-3)).toEqual(["Branding", "Bookings", "Rooms"]);
                expect(nav.getByRole("link", { name: "Bookings" })).toHaveAttribute("href", "/admin/bookings");
                expect(nav.getByRole("link", { name: "Bookings" }).querySelector("svg")).not.toBeNull();
                expect(nav.getByRole("link", { name: "Domains" })).toHaveAttribute("aria-current", "page");
            }
            for (const name of ["Plugin Domains", "Plugin Quarantine", "Plugin Setup", "Notes"]) {
                expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
            }
        });

        it("highlights a plugin section and titles the header with its label when it is active", async () => {
            mockAuthorized();
            render(
                <AdminShell active="bookings" userUid="admin-1" authServerUrl={AUTH_SERVER_URL} pluginNav={pluginNav}>
                    content
                </AdminShell>,
            );
            await screen.findByText("content");

            const rail = within(screen.getByRole("navigation", { name: "Admin sections" }));
            expect(rail.getByRole("link", { name: "Bookings" })).toHaveAttribute("aria-current", "page");
            expect(rail.getByRole("link", { name: "Bookings" }).className).toContain("bg-primary/10");
            expect(within(screen.getByRole("navigation", { name: "Mobile navigation" })).getByRole("link", { name: "Bookings" })).toHaveAttribute(
                "aria-current",
                "page",
            );
            expect(rail.getByRole("link", { name: "Mailboxes" })).not.toHaveAttribute("aria-current");
            expect(screen.getByText("Bookings", { selector: "header span" })).toBeInTheDocument();
        });

        it("keeps the core header labels for off-rail sections, and shows only core sections without plugin nav", async () => {
            mockAuthorized();
            const { unmount } = render(
                <AdminShell active="quarantine" userUid="admin-1" authServerUrl={AUTH_SERVER_URL} pluginNav={pluginNav}>
                    content
                </AdminShell>,
            );
            await screen.findByText("content");
            expect(screen.getByText("Quarantine", { selector: "header span" })).toBeInTheDocument();
            unmount();

            mockAuthorized();
            render(
                <AdminShell active="bookings" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                    content
                </AdminShell>,
            );
            await screen.findByText("content");
            expect(screen.queryByRole("link", { name: "Bookings" })).not.toBeInTheDocument();
            expect(within(screen.getByRole("navigation", { name: "Admin sections" })).queryByRole("link", { current: "page" })).toBeNull();
        });
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
        const fetchMock = mockFetch((url) => {
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
        await waitFor(() => expect(location.href).toBe(AUTH_SERVER_URL));
        // Ends the auth-server session too (the mock throws for it - sign-out still completes).
        expect(fetchMock).toHaveBeenCalledWith(
            `${AUTH_SERVER_URL}/api/auth/logout`,
            expect.objectContaining({ method: "POST", credentials: "include" }),
        );
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
        await waitFor(() => expect(location.href).toBe("/"));
    });
});
