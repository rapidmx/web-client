// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../../../testUtils.js";
import NewMailboxPage from "../../../../../apps/admin/mailboxes/new/index.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("NewMailboxPage", () => {
    it("validates required fields before submitting", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, []);
            return jsonResponse(200, {});
        });
        const user = userEvent.setup();
        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New mailbox");

        await user.click(screen.getByRole("button", { name: "Create mailbox" }));
        expect(await screen.findByText("A primary SMTP address is required.")).toBeInTheDocument();

        await user.type(screen.getByLabelText("Primary SMTP address"), "support@example.com");
        await user.click(screen.getByRole("button", { name: "Create mailbox" }));
        expect(await screen.findByText("A display name is required.")).toBeInTheDocument();
    });

    it("creates the mailbox (with custom timezone/quota) and redirects to its detail page", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, []);
            if (url === "/api/mail/mailboxes" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "mb1" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New mailbox");

        await user.type(screen.getByLabelText("Primary SMTP address"), "support@example.com");
        await user.type(screen.getByLabelText("Display name"), "Support");
        await user.clear(screen.getByLabelText("Timezone"));
        await user.type(screen.getByLabelText("Timezone"), "America/Los_Angeles");
        await user.clear(screen.getByLabelText("Quota (GB)"));
        await user.type(screen.getByLabelText("Quota (GB)"), "10");
        await user.click(screen.getByRole("button", { name: "Create mailbox" }));

        await vi.waitFor(() => expect(location.href).toBe("/admin/mailboxes/mb1"));
        expect(requestBody.timezone).toBe("America/Los_Angeles");
        expect(requestBody.quotaBytes).toBe(10_000_000_000);
        expect(requestBody.ownerUserUid).toBeUndefined();
    });

    it("creates a mailbox with an explicit owner when one is provided", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, []);
            if (url === "/api/mail/mailboxes" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "mb2" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New mailbox");

        await user.type(screen.getByLabelText("Primary SMTP address"), "jdoe@example.com");
        await user.type(screen.getByLabelText("Display name"), "Jane Doe");
        await user.type(screen.getByLabelText("Owner user uid (optional)"), "jdoe");
        await user.click(screen.getByRole("button", { name: "Create mailbox" }));

        await vi.waitFor(() => expect(location.href).toBe("/admin/mailboxes/mb2"));
        expect(requestBody.ownerUserUid).toBe("jdoe");
    });

    it("shows an error message when creation fails", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, []);
            return jsonResponse(400, { message: "address already in use" });
        });
        const user = userEvent.setup();
        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New mailbox");

        await user.type(screen.getByLabelText("Primary SMTP address"), "support@example.com");
        await user.type(screen.getByLabelText("Display name"), "Support");
        await user.click(screen.getByRole("button", { name: "Create mailbox" }));

        expect(await screen.findByText("address already in use")).toBeInTheDocument();
    });

    it("shows a generic error message when creation fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, []);
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New mailbox");

        await user.type(screen.getByLabelText("Primary SMTP address"), "support@example.com");
        await user.type(screen.getByLabelText("Display name"), "Support");
        await user.click(screen.getByRole("button", { name: "Create mailbox" }));

        expect(await screen.findByText("Could not create the mailbox.")).toBeInTheDocument();
    });

    it("when this server has configured domains, shows a local-part + domain picker instead of a free-text address field", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, ["example.com", "example.org"]);
            if (url === "/api/mail/mailboxes" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "mb3" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New mailbox");

        // The domain list loads asynchronously (a separate fetch from the page's own render) — wait for
        // the constrained-mode field to actually appear before asserting the free-text one is gone,
        // rather than checking synchronously right after the page header, which can race ahead of it.
        await screen.findByLabelText("Local part");
        expect(screen.queryByLabelText("Primary SMTP address")).not.toBeInTheDocument();
        await user.type(screen.getByLabelText("Local part"), "support");
        await user.selectOptions(screen.getByLabelText("Domain"), "example.org");
        await user.type(screen.getByLabelText("Display name"), "Support");
        await user.click(screen.getByRole("button", { name: "Create mailbox" }));

        await vi.waitFor(() => expect(location.href).toBe("/admin/mailboxes/mb3"));
        expect(requestBody.primarySmtpAddress).toBe("support@example.org");
    });

    it("falls back to the free-text address field when the configured-domains lookup itself fails", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(500, { message: "boom" });
            return jsonResponse(200, {});
        });
        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        expect(await screen.findByLabelText("Primary SMTP address")).toBeInTheDocument();
        expect(screen.queryByLabelText("Local part")).not.toBeInTheDocument();
    });

    it("the Cancel link returns to the mailboxes list", async () => {
        mockFetch(() => jsonResponse(200, {}));
        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/admin");
    });

    it("hides the resource fieldset until 'This is a resource mailbox' is checked", async () => {
        mockFetch(() => jsonResponse(200, {}));
        const user = userEvent.setup();
        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New mailbox");

        expect(screen.queryByLabelText("Resource type")).not.toBeInTheDocument();
        await user.click(screen.getByRole("checkbox", { name: /This is a resource mailbox/ }));
        expect(screen.getByLabelText("Resource type")).toBeInTheDocument();
        await user.click(screen.getByRole("checkbox", { name: /This is a resource mailbox/ }));
        expect(screen.queryByLabelText("Resource type")).not.toBeInTheDocument();
    });

    it("creates a resource mailbox with its booking settings, using per-field defaults for blank optional numbers", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, []);
            if (url === "/api/mail/mailboxes" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "room1" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New mailbox");

        await user.type(screen.getByLabelText("Primary SMTP address"), "room1@example.com");
        await user.type(screen.getByLabelText("Display name"), "Conference Room 1");
        await user.click(screen.getByRole("checkbox", { name: /This is a resource mailbox/ }));
        await user.selectOptions(screen.getByLabelText("Resource type"), "equipment");
        await user.type(screen.getByLabelText("Capacity (optional)"), "4");
        await user.click(screen.getByRole("checkbox", { name: "Automatically accept booking requests" }));
        await user.click(screen.getByRole("button", { name: "Create mailbox" }));

        await vi.waitFor(() => expect(location.href).toBe("/admin/mailboxes/room1"));
        expect(requestBody.isResource).toBe(true);
        expect(requestBody.resourceType).toBe("equipment");
        expect(requestBody.resourceCapacity).toBe(4);
        expect(requestBody.autoAcceptBookings).toBe(true);
        expect(requestBody.allowConflicts).toBe(false);
        expect(requestBody.bookingWindowDays).toBeUndefined();
        expect(requestBody.maxDurationMinutes).toBeUndefined();
    });

    it("forwards booking window and max duration when both are set", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, []);
            if (url === "/api/mail/mailboxes" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "room2" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New mailbox");

        await user.type(screen.getByLabelText("Primary SMTP address"), "room2@example.com");
        await user.type(screen.getByLabelText("Display name"), "Conference Room 2");
        await user.click(screen.getByRole("checkbox", { name: /This is a resource mailbox/ }));
        await user.click(screen.getByRole("checkbox", { name: "Allow conflicting bookings (skip conflict checking entirely)" }));
        await user.type(screen.getByLabelText("Booking window, in days (optional)"), "14");
        await user.type(screen.getByLabelText("Maximum duration, in minutes (optional)"), "60");
        await user.click(screen.getByRole("button", { name: "Create mailbox" }));

        await vi.waitFor(() => expect(requestBody).toBeDefined());
        expect(requestBody.allowConflicts).toBe(true);
        expect(requestBody.bookingWindowDays).toBe(14);
        expect(requestBody.maxDurationMinutes).toBe(60);
    });

    it("omits every resource field when 'This is a resource mailbox' is not checked", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, []);
            if (url === "/api/mail/mailboxes" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "mb1" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New mailbox");

        await user.type(screen.getByLabelText("Primary SMTP address"), "support@example.com");
        await user.type(screen.getByLabelText("Display name"), "Support");
        await user.click(screen.getByRole("button", { name: "Create mailbox" }));

        await vi.waitFor(() => expect(requestBody).toBeDefined());
        expect(requestBody.isResource).toBeUndefined();
        expect(requestBody.resourceType).toBeUndefined();
    });
});
