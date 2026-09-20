// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
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

    describe("displayed name fallback chain", () => {
        const PROFILE_URL = `${AUTH_SERVER_URL}/api/profiles/me`;
        const ALIASES_URL = `${AUTH_SERVER_URL}/api/aliases?type=name`;

        it("uses the profile's name and never asks for the username when the profile has one", async () => {
            const fetchMock = mockFetch((url) => {
                if (url === PROFILE_URL) return jsonResponse(200, { uid: "u1", givenName: "Jane", familyName: "Doe" });
                throw new Error(`unexpected ${url}`);
            });
            const user = userEvent.setup();
            render(<UserMenu userUid="u1" authServerUrl={AUTH_SERVER_URL} onSignOut={vi.fn()} />);

            await user.click(screen.getByRole("button", { name: "Account menu" }));
            expect(await screen.findByText("Jane Doe")).toBeInTheDocument();
            expect(screen.getAllByText("JD")).toHaveLength(2);
            expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([PROFILE_URL]);
        });

        it("falls back to the username, and its initial, when the profile is a 404 (no profile document)", async () => {
            const fetchMock = mockFetch((url) => {
                if (url === PROFILE_URL) return jsonResponse(404, { message: "Not found." });
                if (url === ALIASES_URL) return jsonResponse(200, [{ alias: "arthur", type: "name", verified: true }]);
                throw new Error(`unexpected ${url}`);
            });
            const user = userEvent.setup();
            render(<UserMenu userUid="b1c2d3" authServerUrl={AUTH_SERVER_URL} onSignOut={vi.fn()} />);

            await user.click(screen.getByRole("button", { name: "Account menu" }));
            expect(await screen.findByText("arthur")).toBeInTheDocument();
            expect(screen.queryByText("b1c2d3")).not.toBeInTheDocument();
            expect(screen.getAllByText("A")).toHaveLength(2);
            expect(fetchMock).toHaveBeenCalledWith(ALIASES_URL, expect.objectContaining({ credentials: "include" }));
        });

        it("falls back to the username when the profile fetch is blocked outright (CORS)", async () => {
            mockFetch((url) => {
                if (url === PROFILE_URL) throw new TypeError("Failed to fetch");
                return jsonResponse(200, [{ alias: "arthur", type: "name", verified: true }]);
            });
            const user = userEvent.setup();
            render(<UserMenu userUid="b1c2d3" authServerUrl={AUTH_SERVER_URL} onSignOut={vi.fn()} />);

            await user.click(screen.getByRole("button", { name: "Account menu" }));
            expect(await screen.findByText("arthur")).toBeInTheDocument();
        });

        it("asks for the username when the profile exists but has no name, and keeps the profile's avatar image", async () => {
            mockFetch((url) => {
                if (url === PROFILE_URL) return jsonResponse(200, { uid: "u1", avatar: "https://example.com/a.png" });
                if (url === ALIASES_URL) return jsonResponse(200, [{ alias: "arthur", type: "name", verified: true }]);
                throw new Error(`unexpected ${url}`);
            });
            const user = userEvent.setup();
            render(<UserMenu userUid="u1" authServerUrl={AUTH_SERVER_URL} onSignOut={vi.fn()} />);

            await user.click(screen.getByRole("button", { name: "Account menu" }));
            expect(await screen.findByText("arthur")).toBeInTheDocument();
            const images = document.querySelectorAll("img");
            expect(images.length).toBe(2);
            images.forEach((img) => expect(img).toHaveAttribute("src", "https://example.com/a.png"));
        });

        it("falls back to the uid when the profile and the username both fail, without surfacing an error", async () => {
            const fetchMock = mockFetch(() => jsonResponse(500, { message: "boom" }));
            const user = userEvent.setup();
            render(<UserMenu userUid="b1c2d3" authServerUrl={AUTH_SERVER_URL} onSignOut={vi.fn()} />);

            await user.click(screen.getByRole("button", { name: "Account menu" }));
            await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
            expect(screen.getByText("b1c2d3")).toBeInTheDocument();
            expect(screen.getAllByText("B")).toHaveLength(2);
            expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        });

        it("falls back to the uid when the caller has no verified username", async () => {
            const fetchMock = mockFetch((url) => {
                if (url === PROFILE_URL) return jsonResponse(404, { message: "Not found." });
                return jsonResponse(200, [{ alias: "pending", type: "name", verified: false }]);
            });
            const user = userEvent.setup();
            render(<UserMenu userUid="b1c2d3" authServerUrl={AUTH_SERVER_URL} onSignOut={vi.fn()} />);

            await user.click(screen.getByRole("button", { name: "Account menu" }));
            await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
            expect(screen.getByText("b1c2d3")).toBeInTheDocument();
        });

        it("ignores a profile response that lands after the menu is gone, and does not go on to ask for the username", async () => {
            let resolveProfile: (response: Response) => void = () => undefined;
            const fetchMock = mockFetch(() => new Promise<Response>((resolve) => (resolveProfile = resolve)));
            const { unmount } = render(<UserMenu userUid="u1" authServerUrl={AUTH_SERVER_URL} onSignOut={vi.fn()} />);
            unmount();

            await act(async () => {
                resolveProfile(jsonResponse(404, { message: "Not found." }));
            });
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it("ignores a username response that lands after the menu is gone", async () => {
            let resolveAliases: (response: Response) => void = () => undefined;
            const fetchMock = mockFetch((url) =>
                url === PROFILE_URL
                    ? Promise.resolve(jsonResponse(404, { message: "Not found." }))
                    : new Promise<Response>((resolve) => (resolveAliases = resolve)),
            );
            const { unmount } = render(<UserMenu userUid="u1" authServerUrl={AUTH_SERVER_URL} onSignOut={vi.fn()} />);
            await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
            unmount();

            await act(async () => {
                resolveAliases(jsonResponse(200, [{ alias: "arthur", type: "name", verified: true }]));
            });
            expect(screen.queryByText("arthur")).not.toBeInTheDocument();
        });
    });

    describe("Account item", () => {
        it("links to auth-server's account page, in the same tab, when authServerUrl is set", async () => {
            mockFetch(() => jsonResponse(200, {}));
            const user = userEvent.setup();
            render(<UserMenu userUid="jane" authServerUrl={AUTH_SERVER_URL} onSignOut={vi.fn()} />);

            await user.click(screen.getByRole("button", { name: "Account menu" }));
            const account = screen.getByRole("menuitem", { name: "Account" });
            expect(account).toHaveAttribute("href", "https://auth.example.com/account");
            expect(account).not.toHaveAttribute("target");
        });

        it("does not double the slash when authServerUrl carries trailing slashes", async () => {
            mockFetch(() => jsonResponse(200, {}));
            const user = userEvent.setup();
            render(<UserMenu userUid="jane" authServerUrl="https://auth.example.com//" onSignOut={vi.fn()} />);

            await user.click(screen.getByRole("button", { name: "Account menu" }));
            expect(screen.getByRole("menuitem", { name: "Account" })).toHaveAttribute("href", "https://auth.example.com/account");
        });

        it("is left out without authServerUrl", async () => {
            const user = userEvent.setup();
            render(<UserMenu userUid="jane" onSignOut={vi.fn()} showSettingsLink showAdminLink />);

            await user.click(screen.getByRole("button", { name: "Account menu" }));
            expect(screen.queryByRole("menuitem", { name: "Account" })).not.toBeInTheDocument();
        });

        it("comes first among the items, above Settings, Admin and Sign Out", async () => {
            mockFetch(() => jsonResponse(200, {}));
            const user = userEvent.setup();
            render(<UserMenu userUid="jane" authServerUrl={AUTH_SERVER_URL} onSignOut={vi.fn()} showSettingsLink showAdminLink />);

            await user.click(screen.getByRole("button", { name: "Account menu" }));
            expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Account", "Settings", "Admin", "Sign Out"]);
        });
    });
});
