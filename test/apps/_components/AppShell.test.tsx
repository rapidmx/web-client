// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../testUtils.js";
import AppShell from "../../../apps/shared/components/layout/AppShell.js";

const AUTH_SERVER_URL = "https://auth.example.com";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("AppShell", () => {
    it("redirects to auth-server's sign-in page and renders nothing when there is no userUid", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/";
        render(<AppShell active="mail" authServerUrl={AUTH_SERVER_URL}>content</AppShell>);
        await waitFor(() =>
            expect(location.href).toBe(`${AUTH_SERVER_URL}/auth/signin?return_to=${encodeURIComponent("https://mail.example.com/")}`),
        );
        expect(screen.queryByText("content")).not.toBeInTheDocument();
        expect(screen.queryByRole("navigation", { name: "Apps" })).not.toBeInTheDocument();
    });

    it("renders the icon rail with all four apps, highlighting the active one", () => {
        render(<AppShell active="calendar" userUid="u1">content</AppShell>);

        const rail = within(screen.getByRole("navigation", { name: "Apps" }));
        const mail = rail.getByRole("link", { name: "Mail" });
        const calendar = rail.getByRole("link", { name: "Calendar" });
        const contacts = rail.getByRole("link", { name: "Contacts" });
        const tasks = rail.getByRole("link", { name: "Tasks" });

        expect(mail).toHaveAttribute("href", "/");
        expect(calendar).toHaveAttribute("href", "/calendar");
        expect(contacts).toHaveAttribute("href", "/contacts");
        expect(tasks).toHaveAttribute("href", "/tasks");

        expect(calendar).toHaveAttribute("aria-current", "page");
        expect(calendar.className).toContain("bg-primary/10");
        expect(mail).not.toHaveAttribute("aria-current");
        expect(mail.className).not.toContain("bg-primary/10");
    });

    it("is hidden below md, visible at md and above", () => {
        render(<AppShell active="mail" userUid="u1">content</AppShell>);
        expect(screen.getByRole("navigation", { name: "Apps" })).toHaveClass("hidden", "md:flex");
    });

    it("renders the mobile bottom tab bar with the same apps, highlighting the active one", () => {
        render(<AppShell active="tasks" userUid="u1">content</AppShell>);

        const tabBar = within(screen.getByRole("navigation", { name: "Mobile navigation" }));
        expect(tabBar.getByRole("link", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
        expect(tabBar.getByRole("link", { name: "Mail" })).not.toHaveAttribute("aria-current");
    });

    it("shows the header with the active app's label and renders children", () => {
        render(<AppShell active="tasks" userUid="u1">content</AppShell>);
        expect(screen.getByText("Tasks", { selector: "span" })).toBeInTheDocument();
        expect(screen.getByText("content")).toBeInTheDocument();
    });

    it("does not show the impersonation banner when impersonating is not set", () => {
        render(<AppShell active="mail" userUid="u1">content</AppShell>);
        expect(screen.queryByText(/You are viewing as/)).not.toBeInTheDocument();
    });

    it("shows the impersonation banner and returns to admin when 'Return to admin' is clicked", async () => {
        mockFetch((url, init) => {
            if (url === "https://auth.example.com/api/admin/impersonate/stop" && init?.method === "GET") {
                return jsonResponse(200, { restored: true });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(
            <AppShell active="mail" userUid="u1" authServerUrl={AUTH_SERVER_URL} impersonationBaseUrl={AUTH_SERVER_URL} impersonating>
                content
            </AppShell>,
        );

        expect(screen.getByText(/You are viewing as/)).toBeInTheDocument();
        expect(screen.getByText("u1", { selector: "strong" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Return to admin" }));

        expect(await screen.findByRole("button", { name: "Returning to admin…" })).toBeInTheDocument();
        await waitFor(() => expect(location.href).toBe("/admin"));
    });

    it("still returns to admin even when the stop-impersonating request fails", async () => {
        mockFetch((url, init) => {
            if (url === "https://auth.example.com/api/admin/impersonate/stop" && init?.method === "GET") {
                return jsonResponse(500, { message: "boom" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(
            <AppShell active="mail" userUid="u1" authServerUrl={AUTH_SERVER_URL} impersonationBaseUrl={AUTH_SERVER_URL} impersonating>
                content
            </AppShell>,
        );

        await user.click(screen.getByRole("button", { name: "Return to admin" }));
        await waitFor(() => expect(location.href).toBe("/admin"));
    });

    it("calls this app's own local dev-only stop endpoint when impersonationBaseUrl isn't provided (yarn dev)", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/impersonate/stop" && init?.method === "GET") {
                return jsonResponse(200, { restored: true });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(
            <AppShell active="mail" userUid="u1" impersonating>
                content
            </AppShell>,
        );

        await user.click(screen.getByRole("button", { name: "Return to admin" }));
        await waitFor(() => expect(location.href).toBe("/admin"));
    });

    it("signs out to auth-server", async () => {
        const location = mockLocation();
        const user = userEvent.setup();
        render(
            <AppShell active="mail" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AppShell>,
        );

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
        expect(location.href).toBe(AUTH_SERVER_URL);
    });

    it("signs out to '/' when authServerUrl is not configured", async () => {
        const location = mockLocation();
        const user = userEvent.setup();
        render(<AppShell active="mail" userUid="u1">content</AppShell>);

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
        expect(location.href).toBe("/");
    });

    it("shows the Admin link in the user menu only when trusted", async () => {
        const user = userEvent.setup();
        render(
            <AppShell active="mail" userUid="u1" trusted>
                content
            </AppShell>,
        );
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.getByRole("menuitem", { name: "Admin" })).toBeInTheDocument();
    });

    it("always shows the Settings link in the user menu, regardless of trusted", async () => {
        const user = userEvent.setup();
        render(<AppShell active="mail" userUid="u1">content</AppShell>);
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    });

    it("renders the branding header/footer HTML once loaded, and swaps in the configured logo", async () => {
        mockFetch(() =>
            jsonResponse(200, {
                companyName: "Acme",
                title: "Acme Mail",
                logoUrl: "https://cdn.example.com/logo.png",
                headerHtml: '<div data-testid="brand-header">Acme banner</div>',
                footerHtml: '<div data-testid="brand-footer">Acme footer</div>',
            }),
        );
        render(<AppShell active="mail" userUid="u1">content</AppShell>);

        expect(await screen.findByTestId("brand-header")).toHaveTextContent("Acme banner");
        expect(screen.getByTestId("brand-footer")).toHaveTextContent("Acme footer");
        const rail = screen.getByRole("navigation", { name: "Apps" });
        expect(rail.querySelector("img")).toHaveAttribute("src", "https://cdn.example.com/logo.png");
    });

    it("renders no header/footer chrome and the default logo when branding has none configured", async () => {
        mockFetch(() => jsonResponse(200, { companyName: "", title: "" }));
        render(<AppShell active="mail" userUid="u1">content</AppShell>);

        await waitFor(() => expect(screen.queryByText("content")).toBeInTheDocument());
        const rail = screen.getByRole("navigation", { name: "Apps" });
        expect(rail.querySelector("img")).toHaveAttribute("src", "/images/logo.svg");
    });

    it("shows 'Settings' as the header title and highlights no rail/tab icon when active is 'settings'", () => {
        render(<AppShell active="settings" userUid="u1">content</AppShell>);

        expect(screen.getByText("Settings", { selector: "span" })).toBeInTheDocument();

        const rail = within(screen.getByRole("navigation", { name: "Apps" }));
        for (const label of ["Mail", "Calendar", "Contacts", "Tasks"]) {
            expect(rail.getByRole("link", { name: label })).not.toHaveAttribute("aria-current");
        }
        const tabBar = within(screen.getByRole("navigation", { name: "Mobile navigation" }));
        for (const label of ["Mail", "Calendar", "Contacts", "Tasks"]) {
            expect(tabBar.getByRole("link", { name: label })).not.toHaveAttribute("aria-current");
        }
    });
});
