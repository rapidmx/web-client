// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import ShareAccessCard from "../../../../apps/shared/components/admin/mailboxes/ShareAccessCard.js";

const ACCESS = "/api/mail/mailboxes/mb1/access";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ShareAccessCard", () => {
    it("shows an empty-state message when the mailbox has no members", async () => {
        mockFetch(() => jsonResponse(200, []));
        render(<ShareAccessCard mailboxUid="mb1" />);
        expect(await screen.findByText("No grants on this mailbox yet.")).toBeInTheDocument();
    });

    it("lists members through the Sharing endpoint, with a readable role", async () => {
        const fetchMock = mockFetch(() =>
            jsonResponse(200, [
                { userOrRoleId: "viewer-1", role: "viewer", actions: ["read", "list"] },
                { userOrRoleId: "manager-1", role: "manager", actions: ["*"] },
                { userOrRoleId: "custom-1", role: "custom", actions: ["read", "delete"] },
                { userOrRoleId: "custom-2", role: "custom" },
            ]),
        );
        render(<ShareAccessCard mailboxUid="mb1" ownerUserUid="owner-1" />);
        expect(await screen.findByText("viewer-1")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith(ACCESS, expect.anything());
        expect(screen.getByText("Read only")).toBeInTheDocument();
        expect(screen.getByText("Full access")).toBeInTheDocument();
        expect(screen.getByText("read, delete")).toBeInTheDocument();
    });

    it("says a personal mailbox is shared by its owner: no grant form, only review and revoke", async () => {
        mockFetch(() => jsonResponse(200, [{ userOrRoleId: "viewer-1", role: "viewer" }]));
        render(<ShareAccessCard mailboxUid="mb1" ownerUserUid="owner-1" currentUserUid="admin-1" />);
        expect(await screen.findByText("viewer-1")).toBeInTheDocument();
        expect(screen.getByText(/only the owner can grant it/i)).toBeInTheDocument();
        expect(screen.queryByPlaceholderText("User uid to grant access to")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Add me" })).not.toBeInTheDocument();
    });

    it("shows an error message when loading the members fails", async () => {
        mockFetch(() => jsonResponse(403, { message: "not yours" }));
        render(<ShareAccessCard mailboxUid="mb1" />);
        expect(await screen.findByText("not yours")).toBeInTheDocument();
    });

    it("shows a generic error message when loading the members fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        render(<ShareAccessCard mailboxUid="mb1" />);
        expect(await screen.findByText("Could not load share settings.")).toBeInTheDocument();
    });

    it("shows who a typed name is before granting, then grants the resolved user with the chosen level and reloads the list", async () => {
        let members: { userOrRoleId: string; role: string }[] = [];
        const fetchMock = mockFetch((url, init) => {
            const method = init?.method ?? "GET";
            if (url.startsWith(`${ACCESS}/resolve`)) return jsonResponse(200, { userUid: "u-new", displayName: "New Person", address: "new@example.com" });
            if (method === "GET") return jsonResponse(200, members);
            const body = JSON.parse(init.body as string);
            members = [{ userOrRoleId: decodeURIComponent(url.split("/").pop()!), role: body.role }];
            return jsonResponse(200, members[0]);
        });

        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" />);
        await screen.findByText("No grants on this mailbox yet.");
        await user.selectOptions(screen.getByLabelText("Access level"), "manager");
        await user.type(screen.getByLabelText("Who to share with"), "  new-name  ");
        await user.click(screen.getByRole("button", { name: "Find" }));

        // The person is shown first; nothing has been granted yet.
        expect(await screen.findByText("New Person <new@example.com>")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith(`${ACCESS}/resolve?principal=new-name`, expect.anything());
        expect(fetchMock).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: "PUT" }));
        await user.click(screen.getByRole("button", { name: "Grant" }));

        const row = (await screen.findByText("u-new")).closest("li")!;
        expect(within(row).getByText("Full access")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith(`${ACCESS}/u-new`, expect.objectContaining({ method: "PUT", body: JSON.stringify({ role: "manager" }) }));
    });

    it("lets an administrator add themselves to a shared mailbox - and stops offering it once they are a member", async () => {
        let members: { userOrRoleId: string; role: string }[] = [];
        const fetchMock = mockFetch((_url, init) => {
            if ((init?.method ?? "GET") === "GET") return jsonResponse(200, members);
            members = [{ userOrRoleId: "admin-1", role: "manager" }];
            return jsonResponse(200, members[0]);
        });

        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" currentUserUid="admin-1" />);
        await user.click(await screen.findByRole("button", { name: "Add me" }));

        expect(await screen.findByText("admin-1")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith(`${ACCESS}/admin-1`, expect.objectContaining({ method: "PUT", body: JSON.stringify({ role: "manager" }) }));
        expect(screen.queryByRole("button", { name: "Add me" })).not.toBeInTheDocument();
    });

    it("does not look anyone up when the box is blank", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" />);
        await screen.findByText("No grants on this mailbox yet.");
        await user.click(screen.getByRole("button", { name: "Find" }));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("says so when nobody is found, and when granting fails", async () => {
        mockFetch((url, init) => {
            if (url.includes("principal=nobody")) return jsonResponse(404, { message: 'No user found for "nobody".' });
            if (url.includes("principal=someone")) return jsonResponse(200, { userUid: "u9" });
            if ((init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            return jsonResponse(403, { message: "The owner's to give" });
        });
        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" />);
        await screen.findByText("No grants on this mailbox yet.");
        await user.type(screen.getByLabelText("Who to share with"), "nobody");
        await user.click(screen.getByRole("button", { name: "Find" }));
        expect(await screen.findByText('No user found for "nobody".')).toBeInTheDocument();

        await user.clear(screen.getByLabelText("Who to share with"));
        await user.type(screen.getByLabelText("Who to share with"), "someone");
        await user.click(screen.getByRole("button", { name: "Find" }));
        expect(await screen.findByText("user u9")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Grant" }));
        expect(await screen.findByText("The owner's to give")).toBeInTheDocument();
    });

    it("flags an entry that is not a user uid as having no effect, and replaces it with the user it was meant for", async () => {
        let members: { userOrRoleId: string; role: string; noEffect?: boolean }[] = [{ userOrRoleId: "jean-philippe", role: "viewer", noEffect: true }];
        const fetchMock = mockFetch((url, init) => {
            const method = init?.method ?? "GET";
            if (url.startsWith(`${ACCESS}/resolve`)) return jsonResponse(200, { userUid: "u-jp", displayName: "Jean-Philippe", address: "jp@example.com" });
            if (method === "GET") return jsonResponse(200, members);
            if (method === "PUT") {
                members = [...members, { userOrRoleId: "u-jp", role: "viewer" }];
                return jsonResponse(200, members[1]);
            }
            members = members.filter((member) => member.userOrRoleId !== decodeURIComponent(url.split("/").pop()!));
            return new Response(null, { status: 204 });
        });

        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" />);
        expect(await screen.findByText(/Not a user - this entry has no effect - replace it/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Replace with a user" }));

        // The stored string is looked up straight away and the person shown.
        expect(await screen.findByText("Jean-Philippe <jp@example.com>")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith(`${ACCESS}/resolve?principal=jean-philippe`, expect.anything());
        await user.click(screen.getByRole("button", { name: "Grant" }));

        expect(await screen.findByText("u-jp")).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByText("jean-philippe")).not.toBeInTheDocument());
        expect(fetchMock).toHaveBeenCalledWith(`${ACCESS}/jean-philippe`, expect.objectContaining({ method: "DELETE" }));
    });

    it("keeps the flagged entry when the replacement is cancelled, and reports a failure to remove it", async () => {
        let removeFails = true;
        mockFetch((url, init) => {
            const method = init?.method ?? "GET";
            if (url.startsWith(`${ACCESS}/resolve`)) return jsonResponse(200, { userUid: "u-jp" });
            if (method === "GET") return jsonResponse(200, [{ userOrRoleId: "jean-philippe", role: "manager", noEffect: true }]);
            if (method === "PUT") return jsonResponse(200, {});
            return removeFails ? jsonResponse(500, { message: "cannot remove" }) : new Response(null, { status: 204 });
        });
        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" />);
        await user.click(await screen.findByRole("button", { name: "Replace with a user" }));
        await user.click(await screen.findByRole("button", { name: "Cancel" }));
        expect(screen.queryByText(/Share with/)).not.toBeInTheDocument();
        expect(screen.getByText("jean-philippe")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Replace with a user" }));
        await user.click(await screen.findByRole("button", { name: "Grant" }));
        expect(await screen.findByText("cannot remove")).toBeInTheDocument();
        removeFails = false;
    });

    it("says only the owner can fix an entry with no effect on a personal mailbox - it can be removed, not replaced here", async () => {
        mockFetch(() => jsonResponse(200, [{ userOrRoleId: "jean-philippe", role: "viewer", noEffect: true }]));
        render(<ShareAccessCard mailboxUid="mb1" ownerUserUid="owner-1" />);
        expect(await screen.findByText(/Not a user - this entry has no effect - remove it\./)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Replace with a user" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    });

    it("shows a generic message when the old entry cannot be removed for a reason that is not an API error", async () => {
        mockFetch((url, init) => {
            const method = init?.method ?? "GET";
            if (url.startsWith(`${ACCESS}/resolve`)) return jsonResponse(200, { userUid: "u-jp" });
            if (method === "GET") return jsonResponse(200, [{ userOrRoleId: "jean-philippe", role: "viewer", noEffect: true }]);
            if (method === "PUT") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" />);
        await user.click(await screen.findByRole("button", { name: "Replace with a user" }));
        await user.click(await screen.findByRole("button", { name: "Grant" }));
        expect(await screen.findByText("Could not remove the old entry.")).toBeInTheDocument();
    });

    it("shows the server's message, or a generic one, when adding the administrator to a shared mailbox fails", async () => {
        let mode: "api" | "network" = "api";
        mockFetch((_url, init) => {
            if ((init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            if (mode === "network") throw new TypeError("network down");
            return jsonResponse(403, { message: "not allowed" });
        });
        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" currentUserUid="admin-1" />);
        await user.click(await screen.findByRole("button", { name: "Add me" }));
        expect(await screen.findByText("not allowed")).toBeInTheDocument();
        mode = "network";
        await user.click(screen.getByRole("button", { name: "Add me" }));
        expect(await screen.findByText("Could not grant access.")).toBeInTheDocument();
    });

    it("revokes a member's access after confirming, and reloads the list", async () => {
        let members: { userOrRoleId: string; role: string }[] = [{ userOrRoleId: "delegate-1", role: "viewer" }];
        const fetchMock = mockFetch((_url, init) => {
            if ((init?.method ?? "GET") === "GET") return jsonResponse(200, members);
            members = [];
            return new Response(null, { status: 204 });
        });

        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" ownerUserUid="owner-1" />);
        await user.click(await screen.findByRole("button", { name: "Revoke" }));
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText("delegate-1")).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Revoke" }));

        expect(await screen.findByText("No grants on this mailbox yet.")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith(`${ACCESS}/delegate-1`, expect.objectContaining({ method: "DELETE" }));
    });

    it("shows an error when revoking access fails", async () => {
        mockFetch((_url, init) =>
            (init?.method ?? "GET") === "GET" ? jsonResponse(200, [{ userOrRoleId: "delegate-1", role: "viewer" }]) : jsonResponse(500, { message: "nope" }),
        );
        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" ownerUserUid="owner-1" />);
        await user.click(await screen.findByRole("button", { name: "Revoke" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke" }));
        expect(await screen.findByText("nope")).toBeInTheDocument();
    });

    it("shows a generic error message when revoking access fails with a non-API error", async () => {
        mockFetch((_url, init) => {
            if ((init?.method ?? "GET") === "GET") return jsonResponse(200, [{ userOrRoleId: "delegate-1", role: "viewer" }]);
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" ownerUserUid="owner-1" />);
        await user.click(await screen.findByRole("button", { name: "Revoke" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke" }));
        expect(await screen.findByText("Could not revoke access.")).toBeInTheDocument();
    });

    it("asks before revoking, and Cancel or closing the dialog keeps the member", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [{ userOrRoleId: "delegate-1", role: "viewer" }]));
        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" ownerUserUid="owner-1" />);
        await user.click(await screen.findByRole("button", { name: "Revoke" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

        await user.click(screen.getByRole("button", { name: "Revoke" }));
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(screen.getByText("delegate-1")).toBeInTheDocument();
    });
});
