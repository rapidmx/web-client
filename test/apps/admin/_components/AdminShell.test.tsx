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
import {
    ELEVATION_ATTEMPT_KEY,
    ELEVATION_RETRY_WINDOW_MS,
    elevationUrl,
} from "../../../../apps/shared/components/admin/elevation.js";

const AUTH_SERVER_URL = "https://auth.example.com";
const ADMIN_URL = "https://mail.example.com/admin/domains?tab=dns";
const ELEVATE_URL = elevationUrl(AUTH_SERVER_URL, ADMIN_URL);

/** A canary that answers as `@RequiresElevation()` does for a caller whose token isn't elevated. */
function mockNeedsElevation() {
    return mockFetch(() => jsonResponse(403, { code: "api-104", message: "Requires elevation." }));
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sessionStorage.clear();
});

/** Opens the phone layout's menu (the hamburger in the header) and returns the section links in it. */
async function openMenu(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    return within(await screen.findByRole("navigation", { name: "Admin menu" }));
}

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

    it("shows the access-denied message when the /admin canary returns 401", async () => {
        mockFetch(() => jsonResponse(401, { code: "api-100", message: "Authentication required." }));
        render(
            <AdminShell active="mailboxes" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AdminShell>,
        );
        expect(await screen.findByText("You do not have administrator access.")).toBeInTheDocument();
    });

    describe("elevation", () => {
        it("sends an administrator whose token is not elevated (403 api-104) to auth-server to elevate, returning to this page", async () => {
            mockNeedsElevation();
            const location = mockLocation();
            location.href = ADMIN_URL;
            const before = Date.now();
            render(
                <AdminShell active="domains" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                    content
                </AdminShell>,
            );

            await waitFor(() => expect(location.href).toBe(ELEVATE_URL));
            expect(ELEVATE_URL).toBe(`${AUTH_SERVER_URL}/auth/elevate?return_to=${encodeURIComponent(ADMIN_URL)}`);
            // It says so meanwhile, rather than flashing "no administrator access" or the console.
            expect(screen.getByRole("status")).toHaveTextContent("Redirecting to confirm your identity");
            expect(screen.queryByText("You do not have administrator access.")).not.toBeInTheDocument();
            expect(screen.queryByText("content")).not.toBeInTheDocument();
            // ... and remembers having done so.
            expect(Number(sessionStorage.getItem(ELEVATION_ATTEMPT_KEY))).toBeGreaterThanOrEqual(before);
        });

        it("does not send the browser round again while an attempt is recent, and explains that elevation did not take effect", async () => {
            mockNeedsElevation();
            const location = mockLocation();
            location.href = ADMIN_URL;
            sessionStorage.setItem(ELEVATION_ATTEMPT_KEY, String(Date.now() - 30_000));
            render(
                <AdminShell active="domains" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                    content
                </AdminShell>,
            );

            expect(await screen.findByRole("alert")).toHaveTextContent("didn\u2019t take effect");
            expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
            expect(location.href).toBe(ADMIN_URL);
            expect(screen.queryByText("content")).not.toBeInTheDocument();
        });

        it("'Try again' clears the marker and sends the browser to elevate once more, recording the new attempt", async () => {
            mockNeedsElevation();
            const location = mockLocation();
            location.href = ADMIN_URL;
            const stale = Date.now() - 30_000;
            sessionStorage.setItem(ELEVATION_ATTEMPT_KEY, String(stale));
            const user = userEvent.setup();
            render(
                <AdminShell active="domains" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                    content
                </AdminShell>,
            );

            await user.click(await screen.findByRole("button", { name: "Try again" }));

            expect(location.href).toBe(ELEVATE_URL);
            expect(screen.getByRole("status")).toHaveTextContent("Redirecting to confirm your identity");
            expect(Number(sessionStorage.getItem(ELEVATION_ATTEMPT_KEY))).toBeGreaterThan(stale);
        });

        it("elevates again once the last attempt is older than the retry window", async () => {
            mockNeedsElevation();
            const location = mockLocation();
            location.href = ADMIN_URL;
            sessionStorage.setItem(ELEVATION_ATTEMPT_KEY, String(Date.now() - ELEVATION_RETRY_WINDOW_MS - 1_000));
            render(
                <AdminShell active="domains" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                    content
                </AdminShell>,
            );

            await waitFor(() => expect(location.href).toBe(ELEVATE_URL));
        });

        it("shows the denied message, and goes nowhere, when auth-server's URL is not configured", async () => {
            mockNeedsElevation();
            const location = mockLocation();
            location.href = ADMIN_URL;
            render(
                <AdminShell active="domains" userUid="admin-1">
                    content
                </AdminShell>,
            );

            expect(await screen.findByText("You do not have administrator access.")).toBeInTheDocument();
            expect(location.href).toBe(ADMIN_URL);
            expect(sessionStorage.getItem(ELEVATION_ATTEMPT_KEY)).toBeNull();
        });

        it("does not elevate for api-103 (already elevated, not an administrator) or any other 403", async () => {
            const location = mockLocation();
            location.href = ADMIN_URL;
            mockFetch(() => jsonResponse(403, { code: "api-103", message: "User does not have permission." }));
            const { unmount } = render(
                <AdminShell active="domains" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                    content
                </AdminShell>,
            );
            expect(await screen.findByText("You do not have administrator access.")).toBeInTheDocument();
            unmount();

            mockFetch(() => jsonResponse(403, { message: "Forbidden" }));
            render(
                <AdminShell active="domains" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                    content
                </AdminShell>,
            );
            expect(await screen.findByText("You do not have administrator access.")).toBeInTheDocument();
            expect(location.href).toBe(ADMIN_URL);
            expect(sessionStorage.getItem(ELEVATION_ATTEMPT_KEY)).toBeNull();
        });

        it("forgets an earlier attempt once the console loads elevated, so a later expiry can elevate again", async () => {
            mockFetch((url) => {
                if (url === "/api/admin/release-notes") return jsonResponse(200, {});
                if (url === "/api/system/setup") return jsonResponse(200, { required: false });
                throw new Error(`unexpected ${url}`);
            });
            sessionStorage.setItem(ELEVATION_ATTEMPT_KEY, String(Date.now()));
            render(
                <AdminShell active="domains" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                    content
                </AdminShell>,
            );

            expect(await screen.findByText("content")).toBeInTheDocument();
            expect(sessionStorage.getItem(ELEVATION_ATTEMPT_KEY)).toBeNull();
        });

        it("still sends the browser to elevate when storage is unavailable", async () => {
            for (const method of ["getItem", "setItem", "removeItem"] as const) {
                vi.spyOn(Storage.prototype, method).mockImplementation(() => {
                    throw new DOMException("blocked", "SecurityError");
                });
            }
            mockNeedsElevation();
            const location = mockLocation();
            location.href = ADMIN_URL;
            render(
                <AdminShell active="domains" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                    content
                </AdminShell>,
            );

            await waitFor(() => expect(location.href).toBe(ELEVATE_URL));
        });
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

    it("does not render mailbox-scoped sections (Quarantine, Ingest Queue) in the icon rail or the phone menu", async () => {
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
        const menu = await openMenu(userEvent.setup());
        expect(menu.queryByRole("link", { name: "Quarantine" })).not.toBeInTheDocument();
        expect(menu.queryByRole("link", { name: "Ingest Queue" })).not.toBeInTheDocument();

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

            const menu = await openMenu(userEvent.setup());
            for (const nav of [within(screen.getByRole("navigation", { name: "Admin sections" })), menu]) {
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
            expect((await openMenu(userEvent.setup())).getByRole("link", { name: "Bookings" })).toHaveAttribute("aria-current", "page");
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

    it("renders the admin-configured footer but not the admin-configured header", async () => {
        mockFetch((url) => {
            if (url === "/api/system/branding") {
                return jsonResponse(200, {
                    companyName: "Acme",
                    title: "Acme Mail",
                    headerHtml: '<div data-testid="brand-header">Acme banner</div>',
                    footerHtml: '<div data-testid="brand-footer">Acme footer</div>',
                });
            }
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new Error(`unexpected ${url}`);
        });
        render(
            <AdminShell active="mailboxes" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AdminShell>,
        );

        expect(await screen.findByTestId("brand-footer")).toHaveTextContent("Acme footer");
        expect(screen.getByText("content")).toBeInTheDocument();
        expect(screen.queryByTestId("brand-header")).not.toBeInTheDocument();
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

    it("has no bottom tab bar: on a phone the sections are a menu that slides in from the left, opened from the header", async () => {
        mockFetch(() => jsonResponse(200, {}));
        render(
            <AdminShell active="domains" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AdminShell>,
        );
        await screen.findByText("content");

        expect(screen.queryByRole("navigation", { name: "Mobile navigation" })).not.toBeInTheDocument();
        // Closed until asked for, and phone-only.
        expect(screen.queryByRole("dialog", { name: "Admin" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Open menu" })).toHaveClass("md:hidden");

        const user = userEvent.setup();
        const menu = await openMenu(user);
        expect(screen.getByRole("dialog", { name: "Admin" })).toBeInTheDocument();
        expect(menu.getByRole("link", { name: "Domains" })).toHaveAttribute("aria-current", "page");
        expect(menu.getByRole("link", { name: "Mailboxes" })).not.toHaveAttribute("aria-current");
        expect(menu.getByRole("link", { name: "Mailboxes" })).toHaveAttribute("href", "/admin");

        await user.click(within(screen.getByRole("dialog", { name: "Admin" })).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog", { name: "Admin" })).not.toBeInTheDocument();
    });

    it("closes the menu when a section is picked", async () => {
        mockFetch(() => jsonResponse(200, {}));
        render(
            <AdminShell active="domains" userUid="admin-1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AdminShell>,
        );
        await screen.findByText("content");
        const user = userEvent.setup();
        const menu = await openMenu(user);

        // The link goes on to a page load; the menu doesn't wait for it.
        menu.getByRole("link", { name: "Audit Log" }).addEventListener("click", (event) => event.preventDefault());
        await user.click(menu.getByRole("link", { name: "Audit Log" }));

        expect(screen.queryByRole("dialog", { name: "Admin" })).not.toBeInTheDocument();
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
