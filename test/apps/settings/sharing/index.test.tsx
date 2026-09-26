// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import SettingsSharingPageBase from "../../../../apps/www/settings/sharing/index.js";
import { withTestRouter } from "../../routerTestUtils.js";

// Rendered inside a router, as the app's shell does (see routerTestUtils.tsx).
const SettingsSharingPage = withTestRouter(SettingsSharingPageBase);

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

    it("shows access granted outside this page as custom, which can't be chosen", async () => {
        mockShell((url) =>
            url === "/api/mail/mailboxes/mb1/access"
                ? jsonResponse(200, [{ userOrRoleId: "u3", role: "custom", actions: ["read", "update"] }])
                : undefined,
        );
        render(<SettingsSharingPage userUid="u1" />);
        const select = await screen.findByLabelText("Role for u3");
        expect(select).toHaveValue("custom");
        expect(screen.getByRole("option", { name: "Custom access" })).toBeDisabled();
    });

    it("shows a forbidden message when the caller can't manage this mailbox's sharing", async () => {
        mockShell((url) => (url.startsWith("/api/mail/mailboxes/mb1/access") ? jsonResponse(403, { message: "nope" }) : undefined));
        render(<SettingsSharingPage userUid="u1" />);
        expect(await screen.findByText("You don’t have permission to manage sharing for this mailbox.")).toBeInTheDocument();
    });

    it("looks up who was typed, shows them, then grants access and reloads the member list", async () => {
        let granted: unknown;
        mockShell((url, init) => {
            if (url === "/api/mail/mailboxes/mb1/access") return jsonResponse(200, granted ? [granted] : []);
            if (url.startsWith("/api/mail/mailboxes/mb1/access/resolve")) {
                expect(url).toContain("principal=jane%40example.com");
                return jsonResponse(200, { userUid: "u2", displayName: "Jane Doe", address: "jane@example.com" });
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

        await user.type(screen.getByLabelText("Who to share with"), "jane@example.com");
        await user.click(screen.getByRole("button", { name: "Find" }));
        // Who it is is shown before anything is saved.
        expect(await screen.findByText("Jane Doe <jane@example.com>")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Grant" }));

        expect(await screen.findByText("u2")).toBeInTheDocument();
    });

    it("shows an inline error when what was typed doesn't resolve to anyone", async () => {
        mockShell((url) => {
            if (url === "/api/mail/mailboxes/mb1/access") return jsonResponse(200, []);
            if (url.startsWith("/api/mail/mailboxes/mb1/access/resolve")) return jsonResponse(404, { message: 'No user found for "nobody".' });
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsSharingPage userUid="u1" />);
        await screen.findByText("No one else has access to this mailbox yet.");

        await user.type(screen.getByLabelText("Who to share with"), "nobody");
        await user.click(screen.getByRole("button", { name: "Find" }));

        expect(await screen.findByText('No user found for "nobody".')).toBeInTheDocument();
    });

    it("flags an entry that was never a user uid, and replaces it with the person it was meant for", async () => {
        let members: { userOrRoleId: string; role: string; noEffect?: boolean }[] = [{ userOrRoleId: "jean-philippe", role: "manager", noEffect: true }];
        const fetchMock = mockShell((url, init) => {
            if (url === "/api/mail/mailboxes/mb1/access") return jsonResponse(200, members);
            if (url.startsWith("/api/mail/mailboxes/mb1/access/resolve")) return jsonResponse(200, { userUid: "u-jp", displayName: "Jean-Philippe" });
            if (url === "/api/mail/mailboxes/mb1/access/u-jp" && init?.method === "PUT") {
                members = [...members, { userOrRoleId: "u-jp", role: "manager" }];
                return jsonResponse(200, members[1]);
            }
            if (url === "/api/mail/mailboxes/mb1/access/jean-philippe" && init?.method === "DELETE") {
                members = members.filter((member) => member.userOrRoleId !== "jean-philippe");
                return jsonResponse(204, undefined);
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsSharingPage userUid="u1" />);
        expect(await screen.findByText(/Not a user - this entry has no effect/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Replace with a user" }));
        expect(await screen.findByText("Replace jean-philippe")).toBeInTheDocument();
        expect(await screen.findByText("Jean-Philippe")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Grant" }));

        expect(await screen.findByText("u-jp")).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByText("jean-philippe")).not.toBeInTheDocument());
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb1/access/jean-philippe", expect.objectContaining({ method: "DELETE" }));
    });

    it("can back out of replacing a flagged entry, and tells when the old entry couldn't be removed", async () => {
        let removeFails = true;
        mockShell((url, init) => {
            if (url === "/api/mail/mailboxes/mb1/access") return jsonResponse(200, [{ userOrRoleId: "jean-philippe", role: "viewer", noEffect: true }]);
            if (url.startsWith("/api/mail/mailboxes/mb1/access/resolve")) return jsonResponse(200, { userUid: "u-jp" });
            if (url === "/api/mail/mailboxes/mb1/access/u-jp" && init?.method === "PUT") return jsonResponse(200, {});
            if (url === "/api/mail/mailboxes/mb1/access/jean-philippe" && init?.method === "DELETE") {
                return removeFails ? jsonResponse(500, { message: "cannot remove" }) : jsonResponse(204, undefined);
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsSharingPage userUid="u1" />);
        await user.click(await screen.findByRole("button", { name: "Replace with a user" }));
        await user.click(await screen.findByRole("button", { name: "Cancel" }));
        expect(await screen.findByText("Add someone")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Replace with a user" }));
        await user.click(await screen.findByRole("button", { name: "Grant" }));
        // Pop-up: the server's message under a title saying what failed.
        expect(await screen.findByText("cannot remove")).toBeInTheDocument();
        expect(screen.getByText("Couldn't remove the old entry")).toBeInTheDocument();
        removeFails = false;
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

    it("shows the API's own error message when loading fails", async () => {
        mockShell((url) => (url === "/api/mail/mailboxes/mb1/access" ? jsonResponse(500, { message: "db down" }) : undefined));
        render(<SettingsSharingPage userUid="u1" />);
        expect(await screen.findByText("db down")).toBeInTheDocument();
    });

    it("shows a generic error when loading fails without an API error", async () => {
        mockShell((url) => {
            if (url === "/api/mail/mailboxes/mb1/access") throw new TypeError("network down");
            return undefined;
        });
        render(<SettingsSharingPage userUid="u1" />);
        expect(await screen.findByText("Could not load sharing settings.")).toBeInTheDocument();
    });

    it("falls back to generic mailbox wording when the mailbox has no display name", async () => {
        mockFetch((url) => {
            if (url === "/api/mail/mailboxes/mb1/access") return jsonResponse(200, [{ userOrRoleId: "u2", role: "viewer" }]);
            if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [{ ...mailbox, displayName: undefined }]);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<SettingsSharingPage userUid="u1" />);
        await screen.findByText("u2");
        expect(screen.getByText(/Manage who else can access this mailbox/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Remove" }));
        expect(await screen.findByText(/will no longer be able to access this mailbox\./)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByText("Remove access")).not.toBeInTheDocument());
    });

    it("does nothing when looking up a blank box", async () => {
        const fetchMock = mockShell((url) => (url === "/api/mail/mailboxes/mb1/access" ? jsonResponse(200, []) : undefined));
        const user = userEvent.setup();
        render(<SettingsSharingPage userUid="u1" />);
        await screen.findByText("No one else has access to this mailbox yet.");
        const before = fetchMock.mock.calls.length;

        await user.type(screen.getByLabelText("Who to share with"), "   ");
        await user.click(screen.getByRole("button", { name: "Find" }));

        expect(fetchMock.mock.calls.length).toBe(before);
    });

    it("grants the selected role and shows the server's message, or a generic one, when granting fails", async () => {
        let putCount = 0;
        let putBody: unknown;
        mockShell((url, init) => {
            if (url === "/api/mail/mailboxes/mb1/access") return jsonResponse(200, []);
            if (url.startsWith("/api/mail/mailboxes/mb1/access/resolve")) return jsonResponse(200, { userUid: "u2", displayName: "Jane" });
            if (url === "/api/mail/mailboxes/mb1/access/u2" && init?.method === "PUT") {
                putCount++;
                putBody = JSON.parse(String(init.body));
                if (putCount === 1) return jsonResponse(409, { message: "already granted" });
                throw new TypeError("network down");
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsSharingPage userUid="u1" />);
        await screen.findByText("No one else has access to this mailbox yet.");

        await user.type(screen.getByLabelText("Who to share with"), "jane@example.com");
        await user.selectOptions(screen.getByLabelText("Access level"), "manager");
        await user.click(screen.getByRole("button", { name: "Find" }));
        await user.click(await screen.findByRole("button", { name: "Grant" }));
        expect(await screen.findByText("already granted")).toBeInTheDocument();
        expect(JSON.stringify(putBody)).toContain("manager");

        await user.click(screen.getByRole("button", { name: "Grant" }));
        expect(await screen.findByText("Could not grant access.")).toBeInTheDocument();
    });

    it("changes a member's role and reloads", async () => {
        let role = "viewer";
        mockShell((url, init) => {
            if (url === "/api/mail/mailboxes/mb1/access") return jsonResponse(200, [{ userOrRoleId: "u2", role }]);
            if (url === "/api/mail/mailboxes/mb1/access/u2" && init?.method === "PUT") {
                role = JSON.parse(String(init.body)).role;
                return jsonResponse(200, { userOrRoleId: "u2", role });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsSharingPage userUid="u1" />);
        await screen.findByText("u2");

        await user.selectOptions(screen.getByLabelText("Role for u2"), "manager");

        await waitFor(() => expect(screen.getByLabelText("Role for u2")).toHaveValue("manager"));
        expect(role).toBe("manager");
    });

    it("shows API and generic errors when a role change fails", async () => {
        let putCount = 0;
        mockShell((url, init) => {
            if (url === "/api/mail/mailboxes/mb1/access") return jsonResponse(200, [{ userOrRoleId: "u2", role: "viewer" }]);
            if (url === "/api/mail/mailboxes/mb1/access/u2" && init?.method === "PUT") {
                putCount++;
                if (putCount === 1) return jsonResponse(400, { message: "bad role" });
                throw new TypeError("network down");
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsSharingPage userUid="u1" />);
        await screen.findByText("u2");

        await user.selectOptions(screen.getByLabelText("Role for u2"), "manager");
        expect(await screen.findByText("bad role")).toBeInTheDocument();
        expect(screen.getByText("Couldn't change this member's role")).toBeInTheDocument();

        await user.selectOptions(screen.getByLabelText("Role for u2"), "manager");
        expect(await screen.findByText("The server couldn't be reached. Check your connection and try again.")).toBeInTheDocument();
    });

    it("shows API and generic errors when removing a member fails", async () => {
        let deleteCount = 0;
        mockShell((url, init) => {
            if (url === "/api/mail/mailboxes/mb1/access") return jsonResponse(200, [{ userOrRoleId: "u2", role: "viewer" }]);
            if (url === "/api/mail/mailboxes/mb1/access/u2" && init?.method === "DELETE") {
                deleteCount++;
                if (deleteCount === 1) return jsonResponse(500, { message: "cannot remove" });
                throw new TypeError("network down");
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsSharingPage userUid="u1" />);
        await screen.findByText("u2");

        await user.click(screen.getByRole("button", { name: "Remove" }));
        await screen.findByText("Remove access");
        await user.click(screen.getAllByRole("button", { name: "Remove" })[1]);
        expect(await screen.findByText("cannot remove")).toBeInTheDocument();
        expect(screen.getByText("Couldn't remove this member")).toBeInTheDocument();

        await user.click(screen.getAllByRole("button", { name: "Remove" })[1]);
        expect(await screen.findByText("The server couldn't be reached. Check your connection and try again.")).toBeInTheDocument();
    });
});
