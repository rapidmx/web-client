// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../testUtils.js";
import AppShell from "../../../apps/shared/components/layout/AppShell.js";
import { APPEARANCE_CACHE_KEY, writeAppearanceCache } from "../../../apps/shared/appearance/appearanceCache.js";
import { APPEARANCE_STYLE_ID } from "../../../apps/shared/appearance/theme.js";

const { destroyAllLocalIndexes } = vi.hoisted(() => ({ destroyAllLocalIndexes: vi.fn() }));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => ({ destroyAllLocalIndexes, SIGN_OUT_CHANNEL: "test-sign-out-branding" }));

const AUTH_SERVER_URL = "https://auth.example.com";

/** The chrome's own requests answered, with `branding` as the deployment's. */
function serve(branding: Record<string, unknown>) {
    return mockFetch((url) => {
        if (url === "/api/system/branding") return jsonResponse(200, { companyName: "Acme", title: "Acme Mail", ...branding });
        if (url.startsWith("/api/mail/preferences/appearance")) return jsonResponse(404, { message: "none" });
        return jsonResponse(404, { message: "not found" });
    });
}

beforeEach(() => {
    destroyAllLocalIndexes.mockResolvedValue(true);
    // The account menu's profile lookups would otherwise go to auth-server for real.
    document.title = "";
});

afterEach(() => {
    vi.unstubAllGlobals();
    document.getElementById(APPEARANCE_STYLE_ID)?.remove();
    document.documentElement.removeAttribute("data-theme");
});

const titleBar = () => screen.queryByText("Mail", { selector: "span.uppercase" });

describe("AppShell with a custom header", () => {
    it("replaces the title bar and the rail's icon, and the app icons start at the top of the rail", async () => {
        serve({ headerHtml: '<div data-testid="header">Acme</div>', logoUrl: "https://cdn.example.com/logo.png" });
        render(
            <AppShell active="mail" userUid="u1">
                content
            </AppShell>,
        );
        await screen.findByTestId("header");
        expect(titleBar()).not.toBeInTheDocument();
        const rail = screen.getByRole("navigation", { name: "Apps" });
        expect(rail.querySelector("img")).toBeNull();
        expect(rail.firstElementChild!.tagName).toBe("A");
        expect(rail).toHaveClass("py-3");
        expect(rail).not.toHaveClass("pb-3");
        // The header is the one banner, at the top of the page and sticky.
        expect(screen.getAllByRole("banner")).toHaveLength(1);
        expect(screen.getByRole("banner")).toHaveClass("sticky", "top-0");
    });

    it("renders the account menu where the header writes {USER_MENU}, and once", async () => {
        serve({ headerHtml: '<div data-testid="header"><b>Acme</b><span data-testid="where">{USER_MENU}</span></div>' });
        render(
            <AppShell active="mail" userUid="u1">
                content
            </AppShell>,
        );
        const where = await screen.findByTestId("where");
        expect(within(where).getByRole("button", { name: "Account menu" })).toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: "Account menu" })).toHaveLength(1);
    });

    it("keeps the account menu reachable in a right-hand cell when the header has no {USER_MENU}", async () => {
        serve({ headerHtml: '<div data-testid="header">Acme banner</div>' });
        render(
            <AppShell active="mail" userUid="u1">
                content
            </AppShell>,
        );
        const header = await screen.findByTestId("header");
        const menu = await screen.findByRole("button", { name: "Account menu" });
        expect(header.closest("header")).toContainElement(menu);
        expect(menu.closest("[data-branding-menu-cell]")).not.toBeNull();
        expect(screen.getAllByRole("button", { name: "Account menu" })).toHaveLength(1);
        // And it still opens, with Sign Out in it.
        await userEvent.setup().click(menu);
        expect(screen.getByRole("menuitem", { name: "Sign Out" })).toBeInTheDocument();
    });

    it("takes the menu from the footer's {USER_MENU} when the header has none, opening upward", async () => {
        serve({ headerHtml: "<p>Header</p>", footerHtml: '<p data-testid="footer">Footer {USER_MENU}</p>' });
        render(
            <AppShell active="mail" userUid="u1">
                content
            </AppShell>,
        );
        const footer = await screen.findByTestId("footer");
        const menu = await within(footer).findByRole("button", { name: "Account menu" });
        expect(document.querySelector("[data-branding-menu-cell]")).toBeNull();
        expect(screen.getAllByRole("button", { name: "Account menu" })).toHaveLength(1);
        await userEvent.setup().click(menu);
        expect(screen.getByRole("menu").style.bottom).not.toBe("");
        expect(screen.getByRole("menu").style.top).toBe("");
    });

    it("prefers the header's {USER_MENU} over the footer's", async () => {
        serve({ headerHtml: '<p data-testid="header">{USER_MENU}</p>', footerHtml: '<p data-testid="footer">{USER_MENU}</p>' });
        render(
            <AppShell active="mail" userUid="u1">
                content
            </AppShell>,
        );
        const header = await screen.findByTestId("header");
        await within(header).findByRole("button", { name: "Account menu" });
        expect(within(screen.getByTestId("footer")).queryByRole("button", { name: "Account menu" })).toBeNull();
    });

    it("puts the current app's name where {APP_TITLE} is written, in the header and the footer", async () => {
        serve({ headerHtml: '<p data-testid="header">Now in {APP_TITLE}</p>', footerHtml: '<p data-testid="footer">{APP_TITLE} footer</p>' });
        const { rerender } = render(
            <AppShell active="mail" userUid="u1">
                content
            </AppShell>,
        );
        expect(await screen.findByTestId("header")).toHaveTextContent("Now in Mail");
        expect(screen.getByTestId("footer")).toHaveTextContent("Mail footer");
        rerender(
            <AppShell active="settings" userUid="u1">
                content
            </AppShell>,
        );
        expect(screen.getByTestId("header")).toHaveTextContent("Now in Settings");
        expect(screen.getByTestId("footer")).toHaveTextContent("Settings footer");
    });

    it("shows the header from the first render when the server rendered the page with the branding, before any request answers", async () => {
        mockFetch(() => new Promise<Response>(() => undefined));
        render(
            <AppShell active="mail" userUid="u1" branding={{ companyName: "Acme", title: "Acme Mail", headerHtml: '<div data-testid="header">Acme</div>', iconUrl: "https://cdn.example.com/icon.png" }}>
                content
            </AppShell>,
        );
        expect(await screen.findByTestId("header")).toBeInTheDocument();
        expect(titleBar()).not.toBeInTheDocument();
    });

    it("has no title bar or rail icon during the moment the header is being parsed - the frame's shape is already the custom one", () => {
        mockFetch(() => new Promise<Response>(() => undefined));
        const { container } = render(
            <AppShell active="mail" userUid="u1" branding={{ companyName: "Acme", title: "Acme Mail", headerHtml: "<p>Acme</p>" }}>
                content
            </AppShell>,
        );
        expect(container.querySelector("[data-rail-icon]")).toBeNull();
    });

    it("falls back to the title bar when the header sanitizes to nothing", async () => {
        serve({ headerHtml: "<script>alert(1)</script>" });
        render(
            <AppShell active="mail" userUid="u1">
                content
            </AppShell>,
        );
        await waitFor(() => expect(titleBar()).toBeInTheDocument());
        expect(screen.getByRole("navigation", { name: "Apps" }).querySelector("img")).not.toBeNull();
    });

});

describe("AppShell without a custom header", () => {
    it("has the title bar with the account menu, sticky, and the icon flush at the top of the rail", async () => {
        serve({});
        render(
            <AppShell active="calendar" userUid="u1">
                content
            </AppShell>,
        );
        const rail = screen.getByRole("navigation", { name: "Apps" });
        const icon = rail.querySelector("[data-rail-icon]")!;
        expect(rail.firstElementChild).toBe(icon);
        // No padding above it: the rail has only bottom padding, and the icon block starts at the top.
        expect(rail).toHaveClass("pb-3");
        expect(rail).not.toHaveClass("py-3");
        expect(icon).toHaveClass("h-16", "w-full");
        const bar = screen.getByRole("banner");
        expect(bar).toHaveClass("h-16", "sticky", "top-0");
        expect(bar).toHaveTextContent("Calendar");
        expect(within(bar).getByRole("button", { name: "Account menu" })).toBeInTheDocument();
    });

    it("is the same as it was before for the frame's own background: the surface-alt colour, transparent only with a background", () => {
        serve({});
        const { container } = render(
            <AppShell active="mail" userUid="u1">
                content
            </AppShell>,
        );
        expect(container.firstElementChild).toHaveClass("rr-frame-bg", "min-h-screen");
    });
});

describe("AppShell and the user's appearance", () => {
    it("applies the appearance the server rendered the page with, before asking anything", () => {
        serve({});
        render(
            <AppShell active="mail" userUid="u1" appearance={{ version: 1, mode: "dark", colors: { primary: "#1e3a8a" } }}>
                content
            </AppShell>,
        );
        expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
        expect(document.getElementById(APPEARANCE_STYLE_ID)!.textContent).toContain("--rr-color-primary:#1e3a8a");
    });

    it("forgets the cached appearance when the user signs out, so the next person to sign in here starts from their own", async () => {
        serve({});
        writeAppearanceCache({ version: 1, mode: "dark" }, "html{}", 1, "u1");
        mockFetch(() => jsonResponse(200, {}));
        const user = userEvent.setup();
        mockLocation().href = "https://mail.example.com/";
        render(
            <AppShell active="mail" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AppShell>,
        );
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
        await waitFor(() => expect(localStorage.getItem(APPEARANCE_CACHE_KEY)).toBeNull());
        cleanup();
    });
});
