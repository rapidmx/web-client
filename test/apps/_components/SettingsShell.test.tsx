// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../testUtils.js";
import SettingsShell, { useSettingsShell } from "../../../apps/shared/components/settings/layout/SettingsShell.js";

const mailboxA = {
    uid: "mb-a",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "a@example.com",
    aliasAddresses: [],
    displayName: "Mailbox A",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};
const mailboxB = { ...mailboxA, uid: "mb-b", displayName: "Mailbox B", ownerUserUid: undefined };

function mockMailboxes(mailboxes: unknown[]) {
    return mockFetch((url) => {
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, mailboxes);
        throw new Error(`unexpected ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("SettingsShell", () => {
    it("shows a skeleton sidebar immediately, instead of a blank pane, while mailboxes are still loading", async () => {
        let resolveMailboxes: (() => void) | undefined;
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes")) {
                return new Promise((resolve) => {
                    resolveMailboxes = () => resolve(jsonResponse(200, [mailboxA]));
                });
            }
            throw new Error(`unexpected ${url}`);
        });
        const { container } = render(
            <SettingsShell active="auto-reply" userUid="u1">
                content
            </SettingsShell>,
        );

        await waitFor(() => expect(resolveMailboxes).toBeDefined());
        expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
        expect(screen.queryByText("content")).not.toBeInTheDocument();

        resolveMailboxes!();
        await screen.findByText("content");
    });

    it("redirects to auth-server's sign-in page when there is no userUid", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/settings/auto-reply";
        render(
            <SettingsShell active="auto-reply" authServerUrl="https://auth.example.com">
                content
            </SettingsShell>,
        );
        await waitFor(() =>
            expect(location.href).toBe(
                `https://auth.example.com/auth/signin?return_to=${encodeURIComponent("https://mail.example.com/settings/auto-reply")}`,
            ),
        );
        expect(screen.queryByText("content")).not.toBeInTheDocument();
    });

    it("shows an error message when loading mailboxes fails", async () => {
        mockFetch(() => jsonResponse(500, { message: "boom" }));
        render(
            <SettingsShell active="auto-reply" userUid="u1">
                content
            </SettingsShell>,
        );
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading mailboxes fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        render(
            <SettingsShell active="auto-reply" userUid="u1">
                content
            </SettingsShell>,
        );
        expect(await screen.findByText("Could not load your mailboxes.")).toBeInTheDocument();
    });

    it("shows a full-screen no-mailbox page — not the app's own chrome/content at all — when the caller has none", async () => {
        mockMailboxes([]);
        render(
            <SettingsShell active="auto-reply" userUid="u1">
                content
            </SettingsShell>,
        );
        expect(await screen.findByText("No mailbox available")).toBeInTheDocument();
        expect(screen.queryByText("content")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Mailbox")).not.toBeInTheDocument();
        expect(screen.queryByRole("navigation", { name: "Apps" })).not.toBeInTheDocument();
    });

    it("renders a single mailbox's settings with no mailbox switcher, but still shows the section nav", async () => {
        mockMailboxes([mailboxA]);
        render(
            <SettingsShell active="auto-reply" userUid="u1">
                content
            </SettingsShell>,
        );

        await screen.findByText("content");
        expect(screen.queryByLabelText("Mailbox")).not.toBeInTheDocument();
        expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument();
    });

    it("highlights the active section in the sidebar nav", async () => {
        mockMailboxes([mailboxA]);
        render(
            <SettingsShell active="auto-reply" userUid="u1">
                content
            </SettingsShell>,
        );

        const link = await screen.findByRole("link", { name: "Automatic Replies" });
        expect(link).toHaveAttribute("aria-current", "page");
        expect(link).toHaveAttribute("href", "/settings/auto-reply?mailboxUid=mb-a");
    });

    it("highlights only the active section, not the other one", async () => {
        mockMailboxes([mailboxA]);
        render(
            <SettingsShell active="filters" userUid="u1">
                content
            </SettingsShell>,
        );

        const filtersLink = await screen.findByRole("link", { name: "Mail Filters" });
        expect(filtersLink).toHaveAttribute("aria-current", "page");
        expect(filtersLink.className).toContain("bg-primary/10");

        const autoReplyLink = screen.getByRole("link", { name: "Automatic Replies" });
        expect(autoReplyLink).not.toHaveAttribute("aria-current");
        expect(autoReplyLink.className).not.toContain("bg-primary/10");
    });

    it("shows the mailbox switcher when more than one mailbox is accessible, marking a shared one", async () => {
        mockMailboxes([mailboxA, mailboxB]);
        render(
            <SettingsShell active="auto-reply" userUid="u1">
                content
            </SettingsShell>,
        );

        await screen.findByLabelText("Mailbox");
        expect(screen.getByRole("option", { name: "Mailbox A" })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: "Mailbox B (shared)" })).toBeInTheDocument();
    });

    it("navigates to the active section's href with the chosen mailbox when the switcher's selection changes", async () => {
        mockMailboxes([mailboxA, mailboxB]);
        const location = mockLocation();
        const user = userEvent.setup();
        render(
            <SettingsShell active="auto-reply" userUid="u1">
                content
            </SettingsShell>,
        );

        const select = await screen.findByLabelText("Mailbox");
        await user.selectOptions(select, "mb-b");

        expect(location.href).toBe("/settings/auto-reply?mailboxUid=mb-b");
    });

    it("honors a ?mailboxUid= query param that names an accessible mailbox", async () => {
        const location = mockLocation();
        (location as any).search = "?mailboxUid=mb-b";
        mockMailboxes([mailboxA, mailboxB]);
        render(
            <SettingsShell active="auto-reply" userUid="u1">
                content
            </SettingsShell>,
        );

        const select = await screen.findByLabelText("Mailbox");
        expect(select).toHaveValue("mb-b");
    });

    it("ignores a ?mailboxUid= query param that isn't one of the caller's accessible mailboxes", async () => {
        const location = mockLocation();
        (location as any).search = "?mailboxUid=not-mine";
        mockMailboxes([mailboxA, mailboxB]);
        render(
            <SettingsShell active="auto-reply" userUid="u1">
                content
            </SettingsShell>,
        );

        const select = await screen.findByLabelText("Mailbox");
        expect(select).toHaveValue("mb-a");
    });

    it("always shows a mobile menu button, even with only one mailbox (the section list still needs it)", async () => {
        mockMailboxes([mailboxA]);
        render(
            <SettingsShell active="auto-reply" userUid="u1">
                content
            </SettingsShell>,
        );
        await screen.findByText("content");
        expect(screen.getByRole("button", { name: "Open settings menu" })).toBeInTheDocument();
    });

    it("opens and closes the settings menu drawer via the mobile menu button", async () => {
        mockMailboxes([mailboxA, mailboxB]);
        const user = userEvent.setup();
        render(
            <SettingsShell active="auto-reply" userUid="u1">
                content
            </SettingsShell>,
        );
        await screen.findByText("content");

        expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Open settings menu" }));
        const drawer = screen.getByRole("dialog", { name: "Settings" });
        expect(within(drawer).getByRole("combobox", { name: "Mailbox" })).toBeInTheDocument();
        expect(within(drawer).getByRole("link", { name: "Automatic Replies" })).toBeInTheDocument();

        await user.click(within(drawer).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    });

    it("provides the resolved mailbox/mailboxes to children via useSettingsShell()", async () => {
        function Probe() {
            const { mailboxUid, mailboxes } = useSettingsShell();
            return <span>{`${mailboxUid}/${mailboxes.length}`}</span>;
        }
        mockMailboxes([mailboxA]);
        render(
            <SettingsShell active="auto-reply" userUid="u1">
                <Probe />
            </SettingsShell>,
        );

        expect(await screen.findByText("mb-a/1")).toBeInTheDocument();
    });
});
