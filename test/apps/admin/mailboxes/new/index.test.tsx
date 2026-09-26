// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../../../testUtils.js";
import NewMailboxPageBase from "../../../../../apps/admin/mailboxes/new/index.js";
import { latestRouter, withTestRouter } from "../../../routerTestUtils.js";

// Rendered inside a router: what the page does after a save is navigate through it (see routerTestUtils.tsx).
const NewMailboxPage = withTestRouter(NewMailboxPageBase);

// A fixed device zone, so the form's starting zone doesn't depend on the machine the tests run on.
vi.mock("@rapidmx/react-shared/util/timeZone.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/util/timeZone.js")>()),
    deviceTimeZone: () => "Europe/Berlin",
}));

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

    it.each([
        ["an @", "support@example.com"],
        ["a fullwidth @ (U+FF20)", "ceo＠example.com"],
        ["a small @ (U+FE6B)", "ceo﹫example.com"],
    ])("refuses a display name that contains %s, without submitting", async (_label, badName) => {
        let posted = false;
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, []);
            if (url === "/api/mail/mailboxes" && init?.method === "POST") posted = true;
            return jsonResponse(200, {});
        });
        const user = userEvent.setup();
        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New mailbox");

        await user.type(screen.getByLabelText("Primary SMTP address"), "support@example.com");
        await user.type(screen.getByLabelText("Display name"), badName);
        await user.click(screen.getByRole("button", { name: "Create mailbox" }));

        expect(await screen.findByText("A display name can't contain \"@\" (or a look-alike) or line breaks.")).toBeInTheDocument();
        expect(posted).toBe(false);
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

        await vi.waitFor(() => expect(latestRouter().navigate.mock.lastCall?.[0]).toBe("/admin/mailboxes/mb1"));
        expect(requestBody.timezone).toBe("America/Los_Angeles");
        expect(requestBody.quotaBytes).toBe(10_000_000_000);
        expect(requestBody.ownerUserUid).toBeUndefined();
    });

    it("starts the timezone on the admin's device zone, and sends it when it is left alone", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, []);
            if (url === "/api/mail/mailboxes" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "mb4" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        mockLocation();
        const user = userEvent.setup();
        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New mailbox");

        expect(screen.getByLabelText("Timezone")).toHaveValue("Europe/Berlin");
        await user.type(screen.getByLabelText("Primary SMTP address"), "support@example.com");
        await user.type(screen.getByLabelText("Display name"), "Support");
        await user.click(screen.getByRole("button", { name: "Create mailbox" }));

        await vi.waitFor(() => expect(requestBody).toBeDefined());
        expect(requestBody.timezone).toBe("Europe/Berlin");
    });

    it("creates a mailbox with an explicit owner, looked up and confirmed first", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, []);
            if (url.startsWith("/api/mail/mailboxes/resolve-owner")) {
                expect(url).toBe("/api/mail/mailboxes/resolve-owner?principal=jdoe");
                return jsonResponse(200, { userUid: "u-jdoe", displayName: "Jane Doe", address: "jdoe@example.com" });
            }
            if (url === "/api/mail/mailboxes" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "mb2" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New mailbox");

        await user.type(screen.getByLabelText("Primary SMTP address"), "jdoe@example.com");
        await user.type(screen.getByLabelText("Display name"), "Jane Doe");
        await user.click(screen.getByRole("radio", { name: "Owned by a specific person" }));
        await user.type(screen.getByLabelText("Mailbox owner"), "jdoe");
        await user.click(screen.getByRole("button", { name: "Find" }));
        expect(await screen.findByText("Jane Doe <jdoe@example.com>")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Use this owner" }));
        expect(await screen.findByText("Jane Doe <jdoe@example.com>")).toBeInTheDocument();
        expect(screen.getByText("Owner:")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Create mailbox" }));

        await vi.waitFor(() => expect(latestRouter().navigate.mock.lastCall?.[0]).toBe("/admin/mailboxes/mb2"));
        expect(requestBody.ownerUserUid).toBe("u-jdoe");
    });

    it("lets the admin change a confirmed owner, or switch back to a shared mailbox", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, []);
            if (url.startsWith("/api/mail/mailboxes/resolve-owner")) {
                return jsonResponse(200, { userUid: "u-jdoe", displayName: "Jane Doe", address: "jdoe@example.com" });
            }
            return jsonResponse(200, {});
        });
        const user = userEvent.setup();
        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New mailbox");

        await user.click(screen.getByRole("radio", { name: "Owned by a specific person" }));
        await user.type(screen.getByLabelText("Mailbox owner"), "jdoe");
        await user.click(screen.getByRole("button", { name: "Find" }));
        await user.click(await screen.findByRole("button", { name: "Use this owner" }));
        expect(await screen.findByText("Jane Doe <jdoe@example.com>")).toBeInTheDocument();

        // "Change" drops the confirmed owner and shows the lookup box again.
        await user.click(screen.getByRole("button", { name: "Change" }));
        expect(screen.queryByText("Owner:")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Mailbox owner")).toBeInTheDocument();

        // Switching back to "Shared mailbox" and back to "Owned" clears any previously confirmed owner too.
        await user.click(screen.getByRole("radio", { name: "Shared mailbox (no single owner)" }));
        await user.click(screen.getByRole("radio", { name: "Owned by a specific person" }));
        expect(screen.queryByText("Owner:")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Mailbox owner")).toHaveValue("");
    });

    it("refuses to submit 'Owned by a specific person' without confirming who that is", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, []);
            return jsonResponse(200, {});
        });
        const user = userEvent.setup();
        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New mailbox");

        await user.type(screen.getByLabelText("Primary SMTP address"), "jdoe@example.com");
        await user.type(screen.getByLabelText("Display name"), "Jane Doe");
        await user.click(screen.getByRole("radio", { name: "Owned by a specific person" }));
        await user.click(screen.getByRole("button", { name: "Create mailbox" }));

        expect(await screen.findByText("Look up and confirm the mailbox's owner, or choose a shared mailbox instead.")).toBeInTheDocument();
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

        await vi.waitFor(() => expect(latestRouter().navigate.mock.lastCall?.[0]).toBe("/admin/mailboxes/mb3"));
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

    it("starts the quota at the mailbox policy's default, unless a quota was typed before the policy loaded", async () => {
        let releasePolicy: () => void = () => undefined;
        mockFetch((url: string) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, []);
            if (url === "/api/system/mailbox-policy") {
                return new Promise<Response>((resolve) => {
                    releasePolicy = () => resolve(jsonResponse(200, { defaultQuotaBytes: 7_000_000_000, autoProvisionEnabled: false, autoProvisionQuotaBytes: 1 }));
                });
            }
            return jsonResponse(200, {});
        });
        const user = userEvent.setup();
        const { unmount } = render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New mailbox");
        await vi.waitFor(() => expect(screen.getByLabelText("Quota (GB)")).toBeInTheDocument());
        releasePolicy();
        await vi.waitFor(() => expect(screen.getByLabelText("Quota (GB)")).toHaveValue(7));
        unmount();

        render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New mailbox");
        const quota = await screen.findByLabelText("Quota (GB)");
        await user.clear(quota);
        await user.type(quota, "12");
        releasePolicy();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(screen.getByLabelText("Quota (GB)")).toHaveValue(12);
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

        await vi.waitFor(() => expect(latestRouter().navigate.mock.lastCall?.[0]).toBe("/admin/mailboxes/room1"));
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

    describe("an address a deleted mailbox left data at", () => {
        const REMAINING = {
            code: "api-011",
            message: "This address still has data from a deleted mailbox. Erase that data before reusing the address.",
            reason: "mailbox-data-remaining",
            mailboxUid: "admin@powerlevel.gg",
        };
        const ERASING = {
            code: "api-011",
            message: "The data at this address is being erased. Try again once that has finished.",
            reason: "mailbox-data-erasing",
            mailboxUid: "admin@powerlevel.gg",
            erasure: { uid: "der1", status: "in_progress" },
        };
        const request = (status: string) => ({
            uid: "der1",
            version: 0,
            dateCreated: "2026-01-01T00:00:00.000Z",
            dateModified: "2026-01-01T00:00:00.000Z",
            mailboxUid: "admin@powerlevel.gg",
            requestedByUserUid: "admin-1",
            status,
            leftoverOnly: true,
        });

        /** A server whose first create answers `first`, whose erasure finishes on the first look, and whose later creates succeed. */
        function server(first: { status: number; body: unknown }, options: { eraseFails?: boolean } = {}) {
            const calls: string[] = [];
            const fetchMock = mockFetch((url, init) => {
                calls.push(`${init?.method ?? "GET"} ${url}`);
                if (url === "/api/admin/release-notes") return jsonResponse(200, {});
                if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, []);
                if (url === "/api/mail/mailboxes" && init?.method === "POST") {
                    const created = calls.filter((call) => call === "POST /api/mail/mailboxes").length;
                    return created === 1 ? jsonResponse(first.status, first.body) : jsonResponse(200, { uid: "mb9" });
                }
                if (url === "/api/mail/erasure-requests/leftover" && init?.method === "POST") {
                    return options.eraseFails
                        ? jsonResponse(409, { message: "This action is blocked by an active legal hold: matter-1." })
                        : jsonResponse(200, request("approved"));
                }
                if (url === "/api/mail/erasure-requests/der1") return jsonResponse(200, request("completed"));
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            return { calls, fetchMock };
        }

        async function fillShared(user: ReturnType<typeof userEvent.setup>) {
            render(<NewMailboxPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
            await screen.findByText("New mailbox");
            await user.type(screen.getByLabelText("Primary SMTP address"), "admin@powerlevel.gg");
            await user.type(screen.getByLabelText("Display name"), "Admin");
        }

        it("explains it, instead of showing the bare error, and offers to erase the leftover data", async () => {
            server({ status: 409, body: REMAINING });
            const user = userEvent.setup();
            await fillShared(user);

            await user.click(screen.getByRole("button", { name: "Create mailbox" }));

            const alert = await screen.findByRole("alert");
            expect(within(alert).getByText("This address still has data from a deleted mailbox.")).toBeInTheDocument();
            expect(within(alert).getByText(/a new mailbox can.t take the address until that data is erased/)).toBeInTheDocument();
            expect(screen.queryByText(/Erase that data before reusing the address/)).not.toBeInTheDocument();
            expect(within(alert).getByRole("button", { name: "Erase the leftover data" })).toBeInTheDocument();
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });

        it("erases it after the address is typed, watches the erasure finish, then creates the mailbox again", async () => {
            const { calls } = server({ status: 409, body: REMAINING });
            const user = userEvent.setup();
            await fillShared(user);
            await user.click(screen.getByRole("button", { name: "Create mailbox" }));

            await user.click(await screen.findByRole("button", { name: "Erase the leftover data" }));
            const dialog = await screen.findByRole("dialog", { name: "Erase leftover data" });
            expect(within(dialog).getAllByText("admin@powerlevel.gg").length).toBeGreaterThan(0);
            const erase = within(dialog).getByRole("button", { name: "Erase data" });
            expect(erase).toBeDisabled();
            await user.type(within(dialog).getByLabelText("Type the address to confirm"), "admin@powerlevel.gg");
            await user.click(erase);

            expect(await within(dialog).findByText(/The address is free to use again/)).toBeInTheDocument();
            // Nothing is created again until the admin says so.
            expect(calls.filter((call) => call === "POST /api/mail/mailboxes")).toHaveLength(1);
            await user.click(within(dialog).getByRole("button", { name: "Create mailbox" }));

            await vi.waitFor(() => expect(latestRouter().navigate.mock.lastCall?.[0]).toBe("/admin/mailboxes/mb9"));
            expect(calls.filter((call) => call === "POST /api/mail/mailboxes")).toHaveLength(2);
            expect(calls.indexOf("POST /api/mail/erasure-requests/leftover")).toBeGreaterThan(calls.indexOf("POST /api/mail/mailboxes"));
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });

        it("watches an erasure that is already running, without filing another, when that is what the server says", async () => {
            const { calls } = server({ status: 409, body: ERASING });
            const user = userEvent.setup();
            await fillShared(user);

            await user.click(screen.getByRole("button", { name: "Create mailbox" }));
            const alert = await screen.findByRole("alert");
            expect(within(alert).getByText("The data left at this address is being erased.")).toBeInTheDocument();
            await user.click(within(alert).getByRole("button", { name: "Show the erasure" }));

            const dialog = await screen.findByRole("dialog", { name: "Erase leftover data" });
            expect(within(dialog).queryByLabelText("Type the address to confirm")).not.toBeInTheDocument();
            await user.click(await within(dialog).findByRole("button", { name: "Create mailbox" }));

            await vi.waitFor(() => expect(latestRouter().navigate.mock.lastCall?.[0]).toBe("/admin/mailboxes/mb9"));
            expect(calls).not.toContain("POST /api/mail/erasure-requests/leftover");
        });

        it("keeps the explanation, and does not create anything, when the erasure is refused - the server's own words are shown", async () => {
            const { calls } = server({ status: 409, body: REMAINING }, { eraseFails: true });
            const user = userEvent.setup();
            await fillShared(user);
            await user.click(screen.getByRole("button", { name: "Create mailbox" }));

            await user.click(await screen.findByRole("button", { name: "Erase the leftover data" }));
            const dialog = await screen.findByRole("dialog", { name: "Erase leftover data" });
            await user.type(within(dialog).getByLabelText("Type the address to confirm"), "admin@powerlevel.gg");
            await user.click(within(dialog).getByRole("button", { name: "Erase data" }));

            expect(await within(dialog).findByText("This action is blocked by an active legal hold: matter-1.")).toBeInTheDocument();
            await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Erase the leftover data" })).toBeInTheDocument();
            expect(calls.filter((call) => call === "POST /api/mail/mailboxes")).toHaveLength(1);
        });

        it("shows the explanation again if the address is still taken when the mailbox is created after the erasure", async () => {
            const bodies = [REMAINING, REMAINING];
            mockFetch((url, init) => {
                if (url === "/api/admin/release-notes") return jsonResponse(200, {});
                if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, []);
                if (url === "/api/mail/mailboxes" && init?.method === "POST") return jsonResponse(409, bodies.shift());
                if (url === "/api/mail/erasure-requests/leftover" && init?.method === "POST") return jsonResponse(200, request("approved"));
                if (url === "/api/mail/erasure-requests/der1") return jsonResponse(200, request("completed"));
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            await fillShared(user);
            await user.click(screen.getByRole("button", { name: "Create mailbox" }));
            await user.click(await screen.findByRole("button", { name: "Erase the leftover data" }));
            await user.type(screen.getByLabelText("Type the address to confirm"), "admin@powerlevel.gg");
            await user.click(screen.getByRole("button", { name: "Erase data" }));

            const dialog = await screen.findByRole("dialog", { name: "Erase leftover data" });
            await user.click(await within(dialog).findByRole("button", { name: "Create mailbox" }));

            expect(await screen.findByText("This address still has data from a deleted mailbox.")).toBeInTheDocument();
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });

        it("takes the explanation away when a different address is typed", async () => {
            server({ status: 409, body: REMAINING });
            const user = userEvent.setup();
            await fillShared(user);
            await user.click(screen.getByRole("button", { name: "Create mailbox" }));
            await screen.findByRole("button", { name: "Erase the leftover data" });

            await user.type(screen.getByLabelText("Primary SMTP address"), "2");

            await waitFor(() => expect(screen.queryByRole("button", { name: "Erase the leftover data" })).not.toBeInTheDocument());
        });

        it("still shows a 409 that does not say it is about leftover data as the plain error it is", async () => {
            server({ status: 409, body: { code: "api-011", message: "This address is already in use by another mailbox or distribution list." } });
            const user = userEvent.setup();
            await fillShared(user);

            await user.click(screen.getByRole("button", { name: "Create mailbox" }));

            expect(await screen.findByText("This address is already in use by another mailbox or distribution list.")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Erase the leftover data" })).not.toBeInTheDocument();
        });
    });
});
