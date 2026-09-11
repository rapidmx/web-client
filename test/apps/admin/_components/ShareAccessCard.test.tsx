// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import ShareAccessCard from "../../../../apps/shared/components/admin/mailboxes/ShareAccessCard.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ShareAccessCard", () => {
    it("shows an empty-state message when the mailbox's ACL has no records", async () => {
        mockFetch(() => jsonResponse(200, { uid: "mb1", version: 0, records: [] }));
        render(<ShareAccessCard mailboxUid="mb1" />);
        expect(await screen.findByText("No grants on this mailbox yet.")).toBeInTheDocument();
    });

    it("lists existing grants with their actions", async () => {
        mockFetch(() =>
            jsonResponse(200, {
                uid: "mb1",
                version: 0,
                records: [{ userOrRoleId: "delegate-1", actions: ["read", "list"] }],
            }),
        );
        render(<ShareAccessCard mailboxUid="mb1" />);
        expect(await screen.findByText("delegate-1")).toBeInTheDocument();
        expect(screen.getByText("read, list")).toBeInTheDocument();
    });

    it("shows an error message when loading the ACL fails", async () => {
        mockFetch(() => jsonResponse(500, { message: "boom" }));
        render(<ShareAccessCard mailboxUid="mb1" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading the ACL fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        render(<ShareAccessCard mailboxUid="mb1" />);
        expect(await screen.findByText("Could not load share settings.")).toBeInTheDocument();
    });

    it("grants access to a new delegate and reloads the list", async () => {
        let records: { userOrRoleId: string; actions: string[] }[] = [];
        const fetchMock = mockFetch((url, init) => {
            const method = init?.method ?? "GET";
            if (method === "GET") return jsonResponse(200, { uid: "mb1", version: records.length, records });
            const body = JSON.parse(init.body as string);
            records = body.records;
            return jsonResponse(200, { uid: "mb1", version: body.version + 1, records });
        });

        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" />);
        await screen.findByText("No grants on this mailbox yet.");

        await user.type(screen.getByPlaceholderText("User uid to grant access to"), "delegate-1");
        await user.click(screen.getByRole("button", { name: "Grant" }));

        expect(await screen.findByText("delegate-1")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/acls/mb1",
            expect.objectContaining({ method: "PUT" }),
        );
    });

    it("does not submit the grant form when the input is blank", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "mb1", version: 0, records: [] }));
        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" />);
        await screen.findByText("No grants on this mailbox yet.");

        await user.click(screen.getByRole("button", { name: "Grant" }));

        expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial load, no PUT
    });

    it("shows an error when granting access fails", async () => {
        mockFetch((url, init) => {
            const method = init?.method ?? "GET";
            if (method === "GET") return jsonResponse(200, { uid: "mb1", version: 0, records: [] });
            return jsonResponse(500, { message: "grant failed" });
        });
        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" />);
        await screen.findByText("No grants on this mailbox yet.");

        await user.type(screen.getByPlaceholderText("User uid to grant access to"), "delegate-1");
        await user.click(screen.getByRole("button", { name: "Grant" }));

        expect(await screen.findByText("grant failed")).toBeInTheDocument();
    });

    it("shows a generic error message when granting access fails with a non-API error", async () => {
        mockFetch((url, init) => {
            const method = init?.method ?? "GET";
            if (method === "GET") return jsonResponse(200, { uid: "mb1", version: 0, records: [] });
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" />);
        await screen.findByText("No grants on this mailbox yet.");

        await user.type(screen.getByPlaceholderText("User uid to grant access to"), "delegate-1");
        await user.click(screen.getByRole("button", { name: "Grant" }));

        expect(await screen.findByText("Could not grant access.")).toBeInTheDocument();
    });

    it("revokes an existing delegate's access and reloads the list", async () => {
        let records = [{ userOrRoleId: "delegate-1", actions: ["read"] }];
        mockFetch((url, init) => {
            const method = init?.method ?? "GET";
            if (method === "GET") return jsonResponse(200, { uid: "mb1", version: 0, records });
            const body = JSON.parse(init.body as string);
            records = body.records;
            return jsonResponse(200, { uid: "mb1", version: 1, records });
        });

        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" />);
        await screen.findByText("delegate-1");

        await user.click(screen.getByRole("button", { name: "Revoke" }));

        await waitFor(() => expect(screen.getByText("No grants on this mailbox yet.")).toBeInTheDocument());
    });

    it("shows an error when revoking access fails", async () => {
        const records = [{ userOrRoleId: "delegate-1", actions: ["read"] }];
        mockFetch((url, init) => {
            const method = init?.method ?? "GET";
            if (method === "GET") return jsonResponse(200, { uid: "mb1", version: 0, records });
            return jsonResponse(500, { message: "revoke failed" });
        });
        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" />);
        await screen.findByText("delegate-1");

        await user.click(screen.getByRole("button", { name: "Revoke" }));

        expect(await screen.findByText("revoke failed")).toBeInTheDocument();
    });

    it("shows a generic error message when revoking access fails with a non-API error", async () => {
        const records = [{ userOrRoleId: "delegate-1", actions: ["read"] }];
        mockFetch((url, init) => {
            const method = init?.method ?? "GET";
            if (method === "GET") return jsonResponse(200, { uid: "mb1", version: 0, records });
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<ShareAccessCard mailboxUid="mb1" />);
        await screen.findByText("delegate-1");

        await user.click(screen.getByRole("button", { name: "Revoke" }));

        expect(await screen.findByText("Could not revoke access.")).toBeInTheDocument();
    });
});
