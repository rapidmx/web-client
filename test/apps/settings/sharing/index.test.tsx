// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import SettingsSharingPage from "../../../../apps/www/settings/sharing/index.js";

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "shared@example.com",
    aliasAddresses: [],
    displayName: "Support",
    timezone: "America/New_York",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};

function mockShell(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("SettingsSharingPage", () => {
    it("shows an empty state when no one else has access", async () => {
        mockShell((url) => (url.startsWith("/api/mail/mailboxes/mb1/access") ? jsonResponse(200, []) : undefined));
        render(<SettingsSharingPage userUid="u1" />);
        expect(await screen.findByText("No one else has access to this mailbox yet.")).toBeInTheDocument();
    });

    it("lists existing members with their role", async () => {
        mockShell((url) =>
            url === "/api/mail/mailboxes/mb1/access" ? jsonResponse(200, [{ userOrRoleId: "u2", role: "manager" }]) : undefined,
        );
        render(<SettingsSharingPage userUid="u1" />);
        expect(await screen.findByText("u2")).toBeInTheDocument();
        expect(screen.getByLabelText("Role for u2")).toHaveValue("manager");
    });

    it("shows a forbidden message when the caller can't manage this mailbox's sharing", async () => {
        mockShell((url) => (url.startsWith("/api/mail/mailboxes/mb1/access") ? jsonResponse(403, { message: "nope" }) : undefined));
        render(<SettingsSharingPage userUid="u1" />);
        expect(await screen.findByText("You don’t have permission to manage sharing for this mailbox.")).toBeInTheDocument();
    });

    it("looks up an email, grants access, and reloads the member list", async () => {
        let granted: unknown;
        mockShell((url, init) => {
            if (url === "/api/mail/mailboxes/mb1/access") return jsonResponse(200, granted ? [granted] : []);
            if (url.startsWith("/api/mail/mailboxes/lookup-by-email")) {
                expect(url).toContain("email=jane%40example.com");
                return jsonResponse(200, { userUid: "u2", displayName: "Jane Doe" });
            }
            if (url === "/api/mail/mailboxes/mb1/access/u2" && init?.method === "PUT") {
                granted = { userOrRoleId: "u2", role: "viewer" };
                return jsonResponse(200, granted);
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsSharingPage userUid="u1" />);
        await screen.findByText("No one else has access to this mailbox yet.");

        await user.type(screen.getByLabelText("Email address"), "jane@example.com");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByText("u2")).toBeInTheDocument();
    });

    it("shows an inline error when the email doesn't resolve to anyone", async () => {
        mockShell((url) => {
            if (url === "/api/mail/mailboxes/mb1/access") return jsonResponse(200, []);
            if (url.startsWith("/api/mail/mailboxes/lookup-by-email")) return jsonResponse(200, null);
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsSharingPage userUid="u1" />);
        await screen.findByText("No one else has access to this mailbox yet.");

        await user.type(screen.getByLabelText("Email address"), "nobody@example.com");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByText("No one found with that email on this platform.")).toBeInTheDocument();
    });

    it("removes a member after confirming", async () => {
        let removed = false;
        mockShell((url, init) => {
            if (url === "/api/mail/mailboxes/mb1/access") return jsonResponse(200, removed ? [] : [{ userOrRoleId: "u2", role: "viewer" }]);
            if (url === "/api/mail/mailboxes/mb1/access/u2" && init?.method === "DELETE") {
                removed = true;
                return jsonResponse(204, undefined);
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsSharingPage userUid="u1" />);
        await screen.findByText("u2");

        await user.click(screen.getByRole("button", { name: "Remove" }));
        await screen.findByText("Remove access");
        await user.click(screen.getAllByRole("button", { name: "Remove" })[1]);

        expect(await screen.findByText("No one else has access to this mailbox yet.")).toBeInTheDocument();
    });
});
