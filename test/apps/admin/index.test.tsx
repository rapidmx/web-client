// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../testUtils.js";
import MailboxesListPage from "../../../apps/admin/index.js";

const mailbox = (n: number) => ({
    uid: `mb${n}`,
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: `u${n}`,
    primarySmtpAddress: `u${n}@example.com`,
    aliasAddresses: [],
    displayName: `User ${n}`,
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("MailboxesListPage", () => {
    it("lists mailboxes once authorized", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox(1), mailbox(2)]);
            throw new Error(`unexpected ${url}`);
        });
        render(<MailboxesListPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("u1@example.com")).toBeInTheDocument();
        expect(screen.getByText("u2@example.com")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "+ New mailbox" })).toHaveAttribute(
            "href",
            "/admin/mailboxes/new",
        );
    });

    it("shows an error message when loading mailboxes fails", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(500, { message: "boom" });
        });
        render(<MailboxesListPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading mailboxes fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        render(<MailboxesListPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("Could not load mailboxes.")).toBeInTheDocument();
    });

    it("paginates: Next fetches the following page, Previous returns to the first", async () => {
        const fullPage = Array.from({ length: 25 }, (_, i) => mailbox(i));
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.includes("page=0")) return jsonResponse(200, fullPage);
            if (url.includes("page=1")) return jsonResponse(200, [mailbox(99)]);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<MailboxesListPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        await screen.findByText("u0@example.com");
        expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(await screen.findByText("u99@example.com")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Previous" }));
        expect(await screen.findByText("u0@example.com")).toBeInTheDocument();
    });

    it("reopens setup after confirming and goes to the wizard, or shows why it couldn't", async () => {
        const location = mockLocation();
        let fail = true;
        const fetchMock = mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, []);
            if (url === "/api/system/setup/reopen" && init?.method === "POST") {
                return fail ? jsonResponse(500, { message: "Could not save" }) : jsonResponse(200, { required: true });
            }
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<MailboxesListPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        const reopenCalls = () => fetchMock.mock.calls.filter((c) => c[0] === "/api/system/setup/reopen").length;

        // Nothing happens until it's confirmed.
        await user.click(await screen.findByRole("button", { name: "Run setup again" }));
        const cancelDialog = await screen.findByRole("dialog", { name: "Run setup again?" });
        await user.click(within(cancelDialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(reopenCalls()).toBe(0);

        await user.click(screen.getByRole("button", { name: "Run setup again" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Run setup" }));
        expect(await screen.findByText("Could not save")).toBeInTheDocument();

        fail = false;
        await user.click(screen.getByRole("button", { name: "Run setup again" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Run setup" }));
        await vi.waitFor(() => expect(location.href).toBe("/admin/setup"));
        expect(reopenCalls()).toBe(2);
    });

    it("closes the setup confirmation from its close button, and explains a non-API failure to reopen setup", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, []);
            if (url === "/api/system/setup/reopen" && init?.method === "POST") throw new TypeError("network down");
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<MailboxesListPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        await user.click(await screen.findByRole("button", { name: "Run setup again" }));
        const dialog = await screen.findByRole("dialog", { name: "Run setup again?" });
        await user.click(within(dialog).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Run setup again" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Run setup" }));
        expect(await screen.findByText("Could not reopen setup.")).toBeInTheDocument();
    });
});
