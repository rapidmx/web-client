// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../testUtils.js";
import AppShell, { LOGOUT_TIMEOUT_MS } from "../../../apps/shared/components/layout/AppShell.js";
import { clearSigningOut, isSigningOut, registerComposeFlush } from "../../../apps/shared/components/mail/compose/composeFlushRegistry.js";
import { apiFetch } from "@rapidmx/react-shared/util/api.js";
import { dismissAll, getNotificationsSnapshot, notify } from "../../../apps/shared/notifications/store.js";

// The hook's own behavior (activity resets the clock, disabled at 0, cleans up on unmount, ...) is
// already exercised end to end in react-shared's own test suite - this file only needs to confirm
// AppShell actually mounts it, which is its own orchestration responsibility.
const { useIdleKeyTimeout } = vi.hoisted(() => ({ useIdleKeyTimeout: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/useIdleKeyTimeout.js", () => ({ useIdleKeyTimeout }));

// The destroy mechanics themselves are covered in test/apps/_search/localIndexRpcClient.test.ts.
const { destroyAllLocalIndexes } = vi.hoisted(() => ({ destroyAllLocalIndexes: vi.fn() }));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => ({ destroyAllLocalIndexes, SIGN_OUT_CHANNEL: "test-sign-out" }));

const { destroyUnlockedKeys } = vi.hoisted(() => ({ destroyUnlockedKeys: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/crypto/keySession.js")>()),
    destroyUnlockedKeys,
}));

// Round 6: sign-out also drops the trusted-signer pins cached from contacts.
const { clearPinnedSignerCache } = vi.hoisted(() => ({ clearPinnedSignerCache: vi.fn() }));
vi.mock("../../../apps/shared/components/mail/pinnedSigners.js", () => ({ clearPinnedSignerCache }));

const AUTH_SERVER_URL = "https://auth.example.com";

beforeEach(() => {
    destroyAllLocalIndexes.mockResolvedValue(true);
});

afterEach(() => {
    vi.unstubAllGlobals();
    useIdleKeyTimeout.mockClear();
    clearPinnedSignerCache.mockClear();
    clearSigningOut();
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

    it("sends an administrator to the setup wizard while first-run setup is required", async () => {
        const location = mockLocation();
        mockFetch((url) => (url === "/api/system/setup" ? jsonResponse(200, { required: true }) : jsonResponse(404, {})));
        render(<AppShell active="mail" userUid="admin-1" trusted>content</AppShell>);
        await waitFor(() => expect(location.href).toBe("/admin/setup"));
    });

    it("leaves everyone else where they are: non-trusted users (never asked), finished setup, and impersonating admins", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/";
        const denied = mockFetch(() => jsonResponse(403, { message: "User does not have permission." }));
        const { unmount } = render(<AppShell active="mail" userUid="user-1">content</AppShell>);
        // A non-trusted caller never makes the admin-only request at all - it could only ever 403.
        await waitFor(() => expect(denied).toHaveBeenCalled());
        expect(denied).not.toHaveBeenCalledWith("/api/system/setup", expect.anything());
        unmount();

        const finished = mockFetch(() => jsonResponse(200, { required: false }));
        const second = render(<AppShell active="mail" userUid="admin-1" trusted>content</AppShell>);
        await waitFor(() => expect(finished).toHaveBeenCalledWith("/api/system/setup", expect.anything()));
        second.unmount();

        const impersonating = mockFetch(() => jsonResponse(200, { required: true }));
        render(
            <AppShell active="mail" userUid="user-1" impersonating trusted>
                content
            </AppShell>,
        );
        await Promise.resolve();
        expect(impersonating).not.toHaveBeenCalledWith("/api/system/setup", expect.anything());
        expect(location.href).toBe("https://mail.example.com/");
    });

    it("mounts the idle-key-timeout hook", () => {
        render(<AppShell active="mail" userUid="u1">content</AppShell>);
        expect(useIdleKeyTimeout).toHaveBeenCalled();
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

    describe("plugin app rail items", () => {
        const pluginNav = {
            appRail: [
                { id: "notes", href: "/notes", label: "Notes" },
                // Core ids win - including "settings", which has no rail icon of its own.
                { id: "mail", href: "/plugin-mail", label: "Plugin Mail" },
                { id: "settings", href: "/plugin-settings", label: "Plugin Settings" },
                { id: "board", href: "/board", label: "Board" },
            ],
            // Other hosts' lists never reach the app rail.
            settingsSections: [{ id: "other", href: "/settings/other", label: "Other Section" }],
            adminNav: [{ id: "admin-thing", href: "/admin/thing", label: "Admin Thing" }],
        };

        it("appends them after the core apps in the rail and the tab bar, skipping ids a core app already uses", () => {
            render(
                <AppShell active="mail" userUid="u1" pluginNav={pluginNav}>
                    content
                </AppShell>,
            );

            for (const name of ["Apps", "Mobile navigation"]) {
                const nav = within(screen.getByRole("navigation", { name }));
                expect(nav.getAllByRole("link").map((link) => link.getAttribute("aria-label") ?? link.textContent)).toEqual([
                    "Mail",
                    "Calendar",
                    "Contacts",
                    "Tasks",
                    "Notes",
                    "Board",
                ]);
                expect(nav.getByRole("link", { name: "Notes" })).toHaveAttribute("href", "/notes");
                expect(nav.getByRole("link", { name: "Notes" }).querySelector("svg")).not.toBeNull();
            }
            expect(screen.queryByRole("link", { name: "Plugin Mail" })).not.toBeInTheDocument();
            expect(screen.queryByRole("link", { name: "Plugin Settings" })).not.toBeInTheDocument();
            expect(screen.queryByRole("link", { name: "Other Section" })).not.toBeInTheDocument();
            expect(screen.queryByRole("link", { name: "Admin Thing" })).not.toBeInTheDocument();
        });

        it("highlights a plugin app and titles the header with its label when it is active", () => {
            render(
                <AppShell active="notes" userUid="u1" pluginNav={pluginNav}>
                    content
                </AppShell>,
            );

            const rail = within(screen.getByRole("navigation", { name: "Apps" }));
            const tabBar = within(screen.getByRole("navigation", { name: "Mobile navigation" }));
            expect(rail.getByRole("link", { name: "Notes" })).toHaveAttribute("aria-current", "page");
            expect(rail.getByRole("link", { name: "Notes" }).className).toContain("bg-primary/10");
            expect(tabBar.getByRole("link", { name: "Notes" })).toHaveAttribute("aria-current", "page");
            expect(rail.getByRole("link", { name: "Mail" })).not.toHaveAttribute("aria-current");
            expect(screen.getByText("Notes", { selector: "header span" })).toBeInTheDocument();
        });

        it("still titles Settings, and shows only the core apps with no plugin nav or an unknown active id", () => {
            const { unmount } = render(
                <AppShell active="settings" userUid="u1" pluginNav={pluginNav}>
                    content
                </AppShell>,
            );
            expect(screen.getByText("Settings", { selector: "header span" })).toBeInTheDocument();
            expect(within(screen.getByRole("navigation", { name: "Apps" })).queryByRole("link", { current: "page" })).toBeNull();
            unmount();

            const { container } = render(
                <AppShell active="notes" userUid="u1">
                    content
                </AppShell>,
            );
            expect(within(screen.getByRole("navigation", { name: "Apps" })).getAllByRole("link")).toHaveLength(4);
            expect(screen.queryByRole("link", { name: "Notes" })).not.toBeInTheDocument();
            expect(container.querySelector("header span")).toBeEmptyDOMElement();
        });
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
        const fetchMock = mockFetch(() => new Response(null, { status: 204 }));
        const user = userEvent.setup();
        render(
            <AppShell active="mail" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AppShell>,
        );

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
        await waitFor(() => expect(location.href).toBe(AUTH_SERVER_URL));
        expect(destroyAllLocalIndexes).toHaveBeenCalled();
        expect(destroyUnlockedKeys).toHaveBeenCalledWith();
        expect(clearPinnedSignerCache).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(
            `${AUTH_SERVER_URL}/api/auth/logout`,
            expect.objectContaining({ method: "POST", credentials: "include" }),
        );
    });

    it("lets open compose windows save their pending edits before logging out", async () => {
        const location = mockLocation();
        const fetchMock = mockFetch(() => new Response(null, { status: 204 }));
        let finishSave!: () => void;
        // Round 5: the sign-out is marked before drafts are flushed, so compose windows skip "Leave site?".
        let signingOutAtFlush: boolean | undefined;
        const flush = vi.fn(() => {
            signingOutAtFlush = isSigningOut();
            return new Promise<void>((resolve) => (finishSave = resolve));
        });
        const unregister = registerComposeFlush(flush);
        try {
            const user = userEvent.setup();
            render(
                <AppShell active="mail" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                    content
                </AppShell>,
            );

            await user.click(screen.getByRole("button", { name: "Account menu" }));
            await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
            await waitFor(() => expect(flush).toHaveBeenCalled());
            expect(signingOutAtFlush).toBe(true);
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(fetchMock).not.toHaveBeenCalledWith(`${AUTH_SERVER_URL}/api/auth/logout`, expect.anything());

            finishSave();
            await waitFor(() => expect(location.href).toBe(AUTH_SERVER_URL));
            expect(fetchMock).toHaveBeenCalledWith(`${AUTH_SERVER_URL}/api/auth/logout`, expect.anything());
        } finally {
            unregister();
        }
    });

    it("still navigates when auth-server's logout fails, or times out", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/";
        mockFetch(() => jsonResponse(500, { message: "down" }));
        const user = userEvent.setup();
        const { unmount } = render(
            <AppShell active="mail" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AppShell>,
        );
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
        await waitFor(() => expect(location.href).toBe(AUTH_SERVER_URL));
        unmount();

        location.href = "https://mail.example.com/";
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            let signal: AbortSignal | undefined;
            mockFetch(
                (_url, init) =>
                    new Promise<Response>((_resolve, reject) => {
                        signal = init.signal as AbortSignal;
                        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
                    }),
            );
            const user2 = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
            render(
                <AppShell active="mail" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                    content
                </AppShell>,
            );
            await user2.click(screen.getByRole("button", { name: "Account menu" }));
            await user2.click(screen.getByRole("menuitem", { name: "Sign Out" }));
            expect(location.href).toBe("https://mail.example.com/");
            await vi.advanceTimersByTimeAsync(LOGOUT_TIMEOUT_MS);
            await waitFor(() => expect(location.href).toBe(AUTH_SERVER_URL));
            expect(signal!.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("destroys keys and leaves when another tab signs out, but ignores its own sign-out announcement", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/";
        const other = new BroadcastChannel("test-sign-out");
        const { unmount } = render(
            <AppShell active="mail" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AppShell>,
        );

        other.postMessage({ type: "something-else" });
        other.postMessage(null);
        await new Promise((r) => setTimeout(r, 20));
        expect(destroyUnlockedKeys).not.toHaveBeenCalled();
        expect(clearPinnedSignerCache).not.toHaveBeenCalled();

        other.postMessage({ type: "sign-out" });
        await waitFor(() => expect(location.href).toBe(AUTH_SERVER_URL));
        expect(destroyUnlockedKeys).toHaveBeenCalledWith();
        expect(clearPinnedSignerCache).toHaveBeenCalledTimes(1);
        expect(destroyAllLocalIndexes).toHaveBeenCalledTimes(1);
        unmount();

        // The signing-out tab itself: its announcement doesn't re-trigger the other-tab path.
        destroyUnlockedKeys.mockClear();
        location.href = "https://mail.example.com/";
        let finishDestroy!: (ok: boolean) => void;
        destroyAllLocalIndexes.mockReturnValueOnce(new Promise<boolean>((resolve) => (finishDestroy = resolve)));
        const user = userEvent.setup();
        render(<AppShell active="mail" userUid="u1">content</AppShell>);
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
        other.postMessage({ type: "sign-out" });
        await new Promise((r) => setTimeout(r, 20));
        expect(destroyUnlockedKeys).toHaveBeenCalledTimes(1);
        expect(location.href).toBe("https://mail.example.com/");
        finishDestroy(true);
        await waitFor(() => expect(location.href).toBe("/"));
        other.close();
    });

    it("destroys every local index before leaving when another tab (e.g. an admin console) signs out, and reacts only once", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/";
        let finishDestroy!: (ok: boolean) => void;
        destroyAllLocalIndexes.mockReturnValueOnce(new Promise<boolean>((resolve) => (finishDestroy = resolve)));
        const other = new BroadcastChannel("test-sign-out");
        render(
            <AppShell active="mail" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AppShell>,
        );

        expect(isSigningOut()).toBe(false);
        other.postMessage({ type: "sign-out" });
        await waitFor(() => expect(destroyAllLocalIndexes).toHaveBeenCalledTimes(1));
        // Compose windows must skip their "Leave site?" prompt for this forced navigation.
        expect(isSigningOut()).toBe(true);
        // destroyAllLocalIndexes() re-announces the sign-out; this tab must not react to that (or a repeat) again.
        other.postMessage({ type: "sign-out" });
        await new Promise((r) => setTimeout(r, 20));
        expect(destroyAllLocalIndexes).toHaveBeenCalledTimes(1);
        expect(destroyUnlockedKeys).toHaveBeenCalledTimes(1);
        expect(location.href).toBe("https://mail.example.com/");

        finishDestroy(false);
        await waitFor(() => expect(location.href).toBe(AUTH_SERVER_URL));
        other.close();
    });

    it("leaves to '/' when another tab signs out and authServerUrl is not configured", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/";
        const other = new BroadcastChannel("test-sign-out");
        render(<AppShell active="mail" userUid="u1">content</AppShell>);
        other.postMessage({ type: "sign-out" });
        await waitFor(() => expect(location.href).toBe("/"));
        other.close();
    });

    it("doesn't listen for other tabs' sign-out where BroadcastChannel is unavailable", () => {
        vi.stubGlobal("BroadcastChannel", undefined);
        render(<AppShell active="mail" userUid="u1">content</AppShell>);
        expect(screen.getByText("content")).toBeInTheDocument();
    });

    it("waits for every local search index to be destroyed before navigating away on sign-out", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/";
        let finishDestroy!: (ok: boolean) => void;
        destroyAllLocalIndexes.mockReturnValueOnce(new Promise<boolean>((resolve) => (finishDestroy = resolve)));
        mockFetch(() => new Response(null, { status: 204 }));
        const user = userEvent.setup();
        render(
            <AppShell active="calendar" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AppShell>,
        );

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
        expect(destroyAllLocalIndexes).toHaveBeenCalled();
        expect(location.href).toBe("https://mail.example.com/");

        finishDestroy(false);
        await waitFor(() => expect(location.href).toBe(AUTH_SERVER_URL));
    });

    it("signs out to '/' when authServerUrl is not configured", async () => {
        const location = mockLocation();
        const user = userEvent.setup();
        render(<AppShell active="mail" userUid="u1">content</AppShell>);

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
        await waitFor(() => expect(location.href).toBe("/"));
    });

    it("shows the Admin Console link in the user menu when the token is trusted", async () => {
        const user = userEvent.setup();
        render(
            <AppShell active="mail" userUid="u1" trusted>
                content
            </AppShell>,
        );
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.getByRole("menuitem", { name: "Admin Console" })).toHaveAttribute("href", "/admin");
    });

    describe("Admin Console for an administrator whose token isn't elevated", () => {
        const auth = (roles: string[]) =>
            mockFetch((url) => (url.endsWith("/api/users/me") ? jsonResponse(200, { uid: "u1", roles }) : jsonResponse(404, {})));
        const askedForUser = (fetchMock: ReturnType<typeof mockFetch>) =>
            fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/users/me"));

        it("asks auth-server about the caller's own record and shows the link when it holds the admin role", async () => {
            const fetchMock = auth(["admin"]);
            const user = userEvent.setup();
            render(
                <AppShell active="mail" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                    content
                </AppShell>,
            );
            await user.click(screen.getByRole("button", { name: "Account menu" }));
            expect(await screen.findByRole("menuitem", { name: "Admin Console" })).toHaveAttribute("href", "/admin");
            expect(fetchMock).toHaveBeenCalledWith(`${AUTH_SERVER_URL}/api/users/me`, expect.anything());
        });

        it("uses the server's trusted role names", async () => {
            auth(["operator"]);
            const user = userEvent.setup();
            render(
                <AppShell active="mail" userUid="u1" authServerUrl={AUTH_SERVER_URL} trustedRoles={["operator"]}>
                    content
                </AppShell>,
            );
            await user.click(screen.getByRole("button", { name: "Account menu" }));
            expect(await screen.findByRole("menuitem", { name: "Admin Console" })).toBeInTheDocument();
        });

        it("hides it for a user without the role", async () => {
            const fetchMock = auth(["user"]);
            const user = userEvent.setup();
            render(
                <AppShell active="mail" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                    content
                </AppShell>,
            );
            await waitFor(() => expect(askedForUser(fetchMock)).toBe(true));
            await user.click(screen.getByRole("button", { name: "Account menu" }));
            expect(screen.queryByRole("menuitem", { name: "Admin Console" })).not.toBeInTheDocument();
        });

        it("never shows it, and never asks, while impersonating", async () => {
            const fetchMock = auth(["admin"]);
            const user = userEvent.setup();
            render(
                <AppShell active="mail" userUid="u1" authServerUrl={AUTH_SERVER_URL} impersonating trusted>
                    content
                </AppShell>,
            );
            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${AUTH_SERVER_URL}/api/profiles/me`, expect.anything()));
            await user.click(screen.getByRole("button", { name: "Account menu" }));
            expect(screen.queryByRole("menuitem", { name: "Admin Console" })).not.toBeInTheDocument();
            expect(askedForUser(fetchMock)).toBe(false);

            cleanup();
            fetchMock.mockClear();
            render(
                <AppShell active="mail" userUid="u1" authServerUrl={AUTH_SERVER_URL} impersonating>
                    content
                </AppShell>,
            );
            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${AUTH_SERVER_URL}/api/profiles/me`, expect.anything()));
            expect(askedForUser(fetchMock)).toBe(false);
        });
    });

    it("always shows the Settings link in the user menu, regardless of trusted", async () => {
        const user = userEvent.setup();
        render(<AppShell active="mail" userUid="u1">content</AppShell>);
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    });

    it("renders the branding header/footer HTML once loaded - the header replaces the title bar and the rail's icon - and swaps in the configured logo without a header", async () => {
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
        // The custom header is the top of the app: no title bar of its own (its label and menu), no icon at the top of the rail.
        const rail = screen.getByRole("navigation", { name: "Apps" });
        expect(rail.querySelector("img")).toBeNull();
        expect(screen.queryByText("Mail", { selector: "span.uppercase" })).not.toBeInTheDocument();
        cleanup();

        mockFetch(() => jsonResponse(200, { companyName: "Acme", title: "Acme Mail", logoUrl: "https://cdn.example.com/logo.png", footerHtml: "<p>footer</p>" }));
        render(<AppShell active="mail" userUid="u1">content</AppShell>);
        await waitFor(() => expect(screen.getByRole("navigation", { name: "Apps" }).querySelector("img")).toHaveAttribute("src", "https://cdn.example.com/logo.png"));
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


describe("AppShell keyboard shortcuts", () => {
    const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) => fireEvent.keyDown(target, { key, ...init });
    const CTRL_SHIFT = { ctrlKey: true, shiftKey: true };

    /** The address bar of a page at `pathname` - `mockLocation()` has none of its own. */
    function locationAt(pathname: string) {
        const location = mockLocation() as { href: string; pathname: string };
        location.pathname = pathname;
        return location;
    }

    it("goes to each app, Settings and the account page from wherever the user is - the chrome is what they all share", () => {
        const location = locationAt("/tasks");
        mockFetch(() => jsonResponse(404, {}));
        render(
            <AppShell active="tasks" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AppShell>,
        );

        expect(press("M", CTRL_SHIFT)).toBe(false);
        expect(location.href).toBe("/");
        press("C", CTRL_SHIFT);
        expect(location.href).toBe("/calendar");
        press("B", CTRL_SHIFT);
        expect(location.href).toBe("/contacts");
        press("S", CTRL_SHIFT);
        expect(location.href).toBe("/settings/auto-reply");
        press("A", CTRL_SHIFT);
        expect(location.href).toBe(`${AUTH_SERVER_URL}/account`);
        // Already there: nothing changes, the key is still taken.
        location.href = "";
        expect(press("L", CTRL_SHIFT)).toBe(false);
        expect(location.href).toBe("");
    });

    it("opens the shortcuts dialog with ?, listing the global shortcuts - and Account only because auth-server is configured", async () => {
        locationAt("/");
        mockFetch(() => jsonResponse(404, {}));
        render(
            <AppShell active="mail" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AppShell>,
        );

        expect(press("?", { shiftKey: true })).toBe(false);

        const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
        expect(within(dialog).getByRole("heading", { name: "Global" })).toBeInTheDocument();
        expect(within(dialog).getByText("Go to Account")).toBeInTheDocument();
        expect(within(dialog).getByText("Go to Tasks")).toBeInTheDocument();
        // Nothing of Mail: this page has no view registering any.
        expect(within(dialog).queryByRole("heading", { name: "Mail" })).not.toBeInTheDocument();
        expect(within(dialog).getByText(/Some browsers keep a few keys for themselves/)).toBeInTheDocument();
    });

    it("opens the same dialog from the account menu's Keyboard shortcuts item", async () => {
        locationAt("/");
        mockFetch(() => jsonResponse(404, {}));
        const user = userEvent.setup();
        render(
            <AppShell active="mail" userUid="u1">
                content
            </AppShell>,
        );

        await user.click(screen.getByRole("button", { name: "Account menu" }));
        await user.click(screen.getByRole("menuitem", { name: "Keyboard shortcuts" }));

        expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(screen.queryByText("Go to Account")).not.toBeInTheDocument();
        press("Escape", {}, screen.getByRole("dialog"));
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument());
    });

    it("has no shortcuts while there is no signed-in user (the chrome renders nothing)", () => {
        const location = locationAt("/calendar");
        location.href = "https://mail.example.com/";
        mockFetch(() => jsonResponse(404, {}));
        render(<AppShell active="mail" authServerUrl={AUTH_SERVER_URL}>content</AppShell>);

        expect(press("M", CTRL_SHIFT)).toBe(true);
        expect(press("?", { shiftKey: true })).toBe(true);
    });
});

describe("AppShell notifications", () => {
    it("publishes the header's height (the title bar's, or a branding header's) so the pop-up stack sticks just below it", async () => {
        const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
            const height = this.hasAttribute("data-branding-header") ? 120 : 64;
            return { height, width: 0, top: 0, left: 0, right: 0, bottom: height, x: 0, y: 0, toJSON: () => ({}) };
        });
        try {
            mockFetch(() => jsonResponse(404, {}));
            render(
                <AppShell active="mail" userUid="u1">
                    content
                </AppShell>,
            );
            expect(document.documentElement.style.getPropertyValue("--rr-header-h")).toBe("64px");
            cleanup();

            mockFetch(() => jsonResponse(200, { companyName: "Acme", title: "Acme Mail", headerHtml: '<div data-testid="brand-header">Acme banner</div>' }));
            render(
                <AppShell active="mail" userUid="u1">
                    content
                </AppShell>,
            );
            await screen.findByTestId("brand-header");
            await waitFor(() => expect(document.documentElement.style.getPropertyValue("--rr-header-h")).toBe("120px"));
        } finally {
            rect.mockRestore();
        }
    });

    it("draws every pop-up in one stack right under the header row, where it can't cover the account menu", async () => {
        mockFetch(() => jsonResponse(404, {}));
        render(
            <AppShell active="mail" userUid="u1">
                content
            </AppShell>,
        );
        const header = screen.getByRole("banner");
        expect(header.nextElementSibling).toBe(screen.getByTestId("notification-anchor"));
        act(() => {
            notify({ kind: "success", title: "Saved" });
        });
        expect(within(screen.getByTestId("notification-anchor")).getByText("Saved")).toBeInTheDocument();
        expect(header.contains(screen.getByText("Saved"))).toBe(false);
    });

    it("lists the recent notifications from the account menu, counting the errors nobody has seen", async () => {
        mockFetch(() => jsonResponse(404, {}));
        const user = userEvent.setup();
        render(
            <AppShell active="mail" userUid="u1">
                content
            </AppShell>,
        );
        act(() => {
            notify({ kind: "error", title: "Couldn't archive the message", message: "Server said no", sticky: false, timeoutMs: 1 });
        });
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.getByRole("menuitem", { name: /Recent notifications/ })).toHaveTextContent("1 unseen error");
        await user.click(screen.getByRole("menuitem", { name: /Recent notifications/ }));

        const dialog = await screen.findByRole("dialog", { name: "Recent notifications" });
        expect(within(dialog).getByText("Couldn't archive the message")).toBeInTheDocument();
        expect(within(dialog).getByText("Server said no")).toBeInTheDocument();
        // Opening it counted as seeing them.
        expect(getNotificationsSnapshot().unseenErrors).toBe(0);
        await user.click(within(dialog).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog", { name: "Recent notifications" })).not.toBeInTheDocument();
    });

    it("says 'Your session expired' once, with a Sign in action, when any request is answered 401 - and stops listening when it goes", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/mail";
        const fetchMock = mockFetch(() => jsonResponse(401, { message: "Unauthorized" }));
        const view = render(
            <AppShell active="mail" userUid="u1" authServerUrl={AUTH_SERVER_URL}>
                content
            </AppShell>,
        );
        await expect(apiFetch("/mail/mailboxes")).rejects.toMatchObject({ status: 401 });
        await expect(apiFetch("/mail/folders")).rejects.toMatchObject({ status: 401 });
        expect(await screen.findAllByText("Your session expired")).toHaveLength(1);
        // Both requests (and whatever else the frame asked for - branding, appearance - that was refused the same way) are one pop-up with a count.
        await waitFor(() => expect(getNotificationsSnapshot().visible[0].count).toBeGreaterThanOrEqual(2));
        expect(await screen.findByText(/\(\d+ times\)/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
        expect(location.href).toBe(`${AUTH_SERVER_URL}/auth/signin?return_to=${encodeURIComponent("https://mail.example.com/mail")}`);
        expect(fetchMock).toHaveBeenCalled();

        view.unmount();
        act(() => dismissAll());
        await expect(apiFetch("/mail/mailboxes")).rejects.toMatchObject({ status: 401 });
        expect(getNotificationsSnapshot().visible).toEqual([]);
    });

    it("does not listen for an expired session while nobody is signed in", async () => {
        mockLocation();
        mockFetch(() => jsonResponse(401, { message: "Unauthorized" }));
        render(
            <AppShell active="mail" authServerUrl={AUTH_SERVER_URL}>
                content
            </AppShell>,
        );
        await expect(apiFetch("/mail/mailboxes")).rejects.toMatchObject({ status: 401 });
        expect(getNotificationsSnapshot().visible).toEqual([]);
    });
});
