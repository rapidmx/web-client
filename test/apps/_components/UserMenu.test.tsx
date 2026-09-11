// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import UserMenu from "../../../apps/shared/components/layout/UserMenu.js";

const AUTH_SERVER_URL = "https://auth.example.com";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("UserMenu", () => {
    it("shows the uid's initial as a fallback avatar with no authServerUrl configured", async () => {
        render(<UserMenu userUid="jane" onSignOut={vi.fn()} />);
        expect(await screen.findByText("J")).toBeInTheDocument();
    });

    it("is closed by default and opens the menu when the trigger is clicked", async () => {
        const user = userEvent.setup();
        render(<UserMenu userUid="jane" onSignOut={vi.fn()} />);

        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.getByRole("menu")).toBeInTheDocument();
        expect(screen.getByRole("menuitem", { name: "Sign Out" })).toBeInTheDocument();
    });

    it("falls back to the uid when no authServerUrl is configured (no profile to fetch)", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        const user = userEvent.setup();
        render(<UserMenu userUid="jane" onSignOut={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.getByText("jane")).toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("shows the trusted-role-only Admin item when showAdminLink is set", async () => {
        const user = userEvent.setup();
        render(<UserMenu userUid="jane" onSignOut={vi.fn()} showAdminLink />);

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.getByRole("menuitem", { name: "Admin" })).toHaveAttribute("href", "/admin");
    });

    it("hides the Admin item when showAdminLink is not set", async () => {
        const user = userEvent.setup();
        render(<UserMenu userUid="jane" onSignOut={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.queryByRole("menuitem", { name: "Admin" })).not.toBeInTheDocument();
    });

    it("shows the Settings item when showSettingsLink is set", async () => {
        const user = userEvent.setup();
        render(<UserMenu userUid="jane" onSignOut={vi.fn()} showSettingsLink />);

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveAttribute("href", "/settings/auto-reply");
    });

    it("hides the Settings item when showSettingsLink is not set", async () => {
        const user = userEvent.setup();
        render(<UserMenu userUid="jane" onSignOut={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.queryByRole("menuitem", { name: "Settings" })).not.toBeInTheDocument();
    });

    it("calls onSignOut when 'Sign Out' is clicked", async () => {
        const onSignOut = vi.fn();
        const user = userEvent.setup();
        render(<UserMenu userUid="jane" onSignOut={onSignOut} />);

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
        expect(onSignOut).toHaveBeenCalledOnce();
    });

    it("closes the menu when clicking outside of it", async () => {
        const user = userEvent.setup();
        render(
            <div>
                <UserMenu userUid="jane" onSignOut={vi.fn()} />
                <button type="button">outside</button>
            </div>,
        );

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.getByRole("menu")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "outside" }));
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("closes the menu when Escape is pressed", async () => {
        const user = userEvent.setup();
        render(<UserMenu userUid="jane" onSignOut={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.getByRole("menu")).toBeInTheDocument();
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("stays open when a key other than Escape is pressed", async () => {
        const user = userEvent.setup();
        render(<UserMenu userUid="jane" onSignOut={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        await user.keyboard("a");
        expect(screen.getByRole("menu")).toBeInTheDocument();
    });

    it("fetches the caller's own profile from auth-server and shows the formatted name/avatar image", async () => {
        mockFetch((url) => {
            if (url === `${AUTH_SERVER_URL}/api/profiles/me`) {
                return jsonResponse(200, { uid: "jane", givenName: "Jane", familyName: "Doe", avatar: "https://example.com/a.png" });
            }
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<UserMenu userUid="jane" authServerUrl={AUTH_SERVER_URL} onSignOut={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(await screen.findByText("Jane Doe")).toBeInTheDocument();
        // A decorative `alt=""` image has no accessible "img" role, so query the DOM directly.
        const avatarImages = document.querySelectorAll("img");
        expect(avatarImages.length).toBeGreaterThan(0);
        avatarImages.forEach((img) => expect(img).toHaveAttribute("src", "https://example.com/a.png"));
    });

    it("falls back to the uid/initials when the profile fetch fails", async () => {
        mockFetch(() => jsonResponse(500, { message: "boom" }));
        const user = userEvent.setup();
        render(<UserMenu userUid="jane" authServerUrl={AUTH_SERVER_URL} onSignOut={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        await waitFor(() => expect(screen.getByText("jane")).toBeInTheDocument());
    });
});
