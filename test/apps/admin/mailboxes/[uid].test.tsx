// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../../testUtils.js";
import MailboxDetailPage from "../../../../apps/admin/mailboxes/[uid].js";

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: ["alias@example.com"],
    displayName: "User One",
    timezone: "America/Los_Angeles",
    quotaBytes: 5_000_000_000,
    usedBytes: 1_000_000_000,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("MailboxDetailPage", () => {
    it("renders mailbox details, links to quarantine/ingest-queue, and the share panel once loaded", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/mailboxes/mb1") return jsonResponse(200, mailbox);
            if (url === "/api/acls/mb1") return jsonResponse(200, { uid: "mb1", version: 0, records: [] });
            throw new Error(`unexpected ${url}`);
        });
        render(<MailboxDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "mb1" }} />);

        expect(await screen.findByRole("heading", { name: "u1@example.com" })).toBeInTheDocument();
        expect(screen.getByText("User One")).toBeInTheDocument();
        expect(screen.getByText("u1")).toBeInTheDocument();
        expect(screen.getByText("1.00 GB / 5.00 GB")).toBeInTheDocument();
        expect(screen.getByText("alias@example.com")).toBeInTheDocument();
        expect(screen.getByText("Display name").closest("dl")).toHaveClass("grid-cols-1", "sm:grid-cols-2");
        expect(screen.getByRole("link", { name: "View quarantine" })).toHaveAttribute(
            "href",
            "/admin/quarantine?mailboxUid=mb1",
        );
        expect(screen.getByRole("link", { name: "View ingest queue" })).toHaveAttribute(
            "href",
            "/admin/ingest-queue?mailboxUid=mb1",
        );
        expect(await screen.findByText("Shared access")).toBeInTheDocument();
        expect(screen.queryByText("Resource type")).not.toBeInTheDocument();
        expect(screen.queryByText("Resource settings")).not.toBeInTheDocument();
    });

    it("shows the resource type and the resource settings card for a resource mailbox", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/mailboxes/mb1") {
                return jsonResponse(200, { ...mailbox, ownerUserUid: undefined, isResource: true, resourceType: "equipment" });
            }
            if (url === "/api/acls/mb1") return jsonResponse(200, { uid: "mb1", version: 0, records: [] });
            throw new Error(`unexpected ${url}`);
        });
        render(<MailboxDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "mb1" }} />);

        // "Resource type" also labels the resource-settings card's own select — one match each.
        expect(await screen.findAllByText("Resource type")).toHaveLength(2);
        expect(screen.getByText("equipment")).toBeInTheDocument();
        expect(screen.getByText("Resource settings")).toBeInTheDocument();
    });

    it("defaults the displayed resource type to 'room' when unset", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/mailboxes/mb1") {
                return jsonResponse(200, { ...mailbox, ownerUserUid: undefined, isResource: true, resourceType: undefined });
            }
            if (url === "/api/acls/mb1") return jsonResponse(200, { uid: "mb1", version: 0, records: [] });
            throw new Error(`unexpected ${url}`);
        });
        render(<MailboxDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "mb1" }} />);

        await screen.findAllByText("Resource type");
        expect(screen.getByText("room")).toBeInTheDocument();
    });

    it("formats sub-GB and sub-KB quota sizes correctly", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/mailboxes/mb1") {
                return jsonResponse(200, { ...mailbox, usedBytes: 500, quotaBytes: 2_500_000 });
            }
            if (url === "/api/acls/mb1") return jsonResponse(200, { uid: "mb1", version: 0, records: [] });
            throw new Error(`unexpected ${url}`);
        });
        render(<MailboxDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "mb1" }} />);
        expect(await screen.findByText("500 B / 2.5 MB")).toBeInTheDocument();
    });

    it("formats a sub-MB, KB-range quota correctly", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/mailboxes/mb1") {
                return jsonResponse(200, { ...mailbox, usedBytes: 2_000, quotaBytes: 900_000 });
            }
            if (url === "/api/acls/mb1") return jsonResponse(200, { uid: "mb1", version: 0, records: [] });
            throw new Error(`unexpected ${url}`);
        });
        render(<MailboxDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "mb1" }} />);
        expect(await screen.findByText("2.0 KB / 900.0 KB")).toBeInTheDocument();
    });

    it("shows 'None (shared mailbox)' for an ownerless mailbox", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/mailboxes/mb1") return jsonResponse(200, { ...mailbox, ownerUserUid: undefined });
            if (url === "/api/acls/mb1") return jsonResponse(200, { uid: "mb1", version: 0, records: [] });
            throw new Error(`unexpected ${url}`);
        });
        render(<MailboxDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "mb1" }} />);
        expect(await screen.findByText("None (shared mailbox)")).toBeInTheDocument();
    });

    it("shows 'None' when the mailbox has no alias addresses", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/mailboxes/mb1") return jsonResponse(200, { ...mailbox, aliasAddresses: [] });
            if (url === "/api/acls/mb1") return jsonResponse(200, { uid: "mb1", version: 0, records: [] });
            throw new Error(`unexpected ${url}`);
        });
        render(<MailboxDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "mb1" }} />);
        expect(await screen.findByText("None")).toBeInTheDocument();
    });

    it("shows an error message when the mailbox fails to load", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(404, { message: "not found" });
        });
        render(<MailboxDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "mb1" }} />);
        expect(await screen.findByText("not found")).toBeInTheDocument();
    });

    it("shows a generic error message when loading the mailbox fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        render(<MailboxDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "mb1" }} />);
        expect(await screen.findByText("Could not load this mailbox.")).toBeInTheDocument();
    });

    it("falls back to 'Mailbox not found.' when the load succeeds with no mailbox and no error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/mailboxes/mb1") return jsonResponse(200, null);
            throw new Error(`unexpected ${url}`);
        });
        render(<MailboxDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "mb1" }} />);
        expect(await screen.findByText("Mailbox not found.")).toBeInTheDocument();
    });

    it("hides the 'Access this mailbox' button for an ownerless mailbox", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/mailboxes/mb1") return jsonResponse(200, { ...mailbox, ownerUserUid: undefined });
            if (url === "/api/acls/mb1") return jsonResponse(200, { uid: "mb1", version: 0, records: [] });
            throw new Error(`unexpected ${url}`);
        });
        render(<MailboxDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "mb1" }} />);
        await screen.findByRole("heading", { name: "u1@example.com" });
        expect(screen.queryByRole("button", { name: "Access this mailbox" })).not.toBeInTheDocument();
    });

    it("shows an error message when impersonation fails", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/mailboxes/mb1") return jsonResponse(200, mailbox);
            if (url === "/api/acls/mb1") return jsonResponse(200, { uid: "mb1", version: 0, records: [] });
            if (url === "https://auth.example.com/api/admin/impersonate" && init?.method === "POST") {
                return jsonResponse(403, { message: "caller lacks the trusted role" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<MailboxDetailPage userUid="admin-1" impersonationBaseUrl="https://auth.example.com" params={{ uid: "mb1" }} />);

        await user.click(await screen.findByRole("button", { name: "Access this mailbox" }));
        expect(await screen.findByText("caller lacks the trusted role")).toBeInTheDocument();
    });

    it("shows a generic error message when impersonation fails with a non-API error", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/mailboxes/mb1") return jsonResponse(200, mailbox);
            if (url === "/api/acls/mb1") return jsonResponse(200, { uid: "mb1", version: 0, records: [] });
            if (url === "https://auth.example.com/api/admin/impersonate" && init?.method === "POST") {
                throw new TypeError("network down");
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<MailboxDetailPage userUid="admin-1" impersonationBaseUrl="https://auth.example.com" params={{ uid: "mb1" }} />);

        await user.click(await screen.findByRole("button", { name: "Access this mailbox" }));
        expect(await screen.findByText("Could not access this mailbox.")).toBeInTheDocument();
    });

    // Mocks window.location wholesale (see testUtils.mockLocation), which isn't undone between tests
    // (unlike vi.stubGlobal) — must run last in this file.
    it("impersonates via this app's own local endpoint and redirects when impersonationBaseUrl isn't provided", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/mailboxes/mb1") return jsonResponse(200, mailbox);
            if (url === "/api/acls/mb1") return jsonResponse(200, { uid: "mb1", version: 0, records: [] });
            if (url === "/api/admin/impersonate" && init?.method === "POST") {
                expect(JSON.parse(init.body as string)).toEqual({ userUid: "u1" });
                return jsonResponse(200, { token: "tok", user: { uid: "u1", roles: [], scopes: [] } });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<MailboxDetailPage userUid="admin-1" params={{ uid: "mb1" }} />);

        const button = await screen.findByRole("button", { name: "Access this mailbox" });
        const location = mockLocation();
        await user.click(button);
        await vi.waitFor(() => expect(location.href).toBe("/"));
    });
});
