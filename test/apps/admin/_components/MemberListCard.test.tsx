// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import MemberListCard from "../../../../apps/shared/components/admin/distributionLists/MemberListCard.js";

const list = {
    uid: "team@example.com",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    primarySmtpAddress: "team@example.com",
    name: "Team",
    memberAddresses: [] as string[],
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("MemberListCard", () => {
    it("shows an empty-state message when there are no members yet", () => {
        render(<MemberListCard list={list} onUpdate={vi.fn()} />);
        expect(screen.getByText("No members yet.")).toBeInTheDocument();
    });

    it("lists existing members", () => {
        render(<MemberListCard list={{ ...list, memberAddresses: ["a@example.com", "b@example.com"] }} onUpdate={vi.fn()} />);
        expect(screen.getByText("a@example.com")).toBeInTheDocument();
        expect(screen.getByText("b@example.com")).toBeInTheDocument();
    });

    it("adds a new member and calls onUpdate with the saved list", async () => {
        const fetchMock = mockFetch((url, init) => {
            const body = JSON.parse(init.body as string);
            expect(body).toEqual({ uid: "team@example.com", version: 0, memberAddresses: ["new@example.com"] });
            return jsonResponse(200, { ...list, version: 1, memberAddresses: ["new@example.com"] });
        });
        const onUpdate = vi.fn();
        const user = userEvent.setup();
        render(<MemberListCard list={list} onUpdate={onUpdate} />);

        await user.type(screen.getByPlaceholderText("Member address to add"), "new@example.com");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(fetchMock).toHaveBeenCalledWith("/api/mail/distribution-lists/team%40example.com", expect.objectContaining({ method: "PUT" }));
        expect(onUpdate).toHaveBeenCalledWith({ ...list, version: 1, memberAddresses: ["new@example.com"] });
    });

    it("does not submit when the input is blank", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, list));
        const user = userEvent.setup();
        render(<MemberListCard list={list} onUpdate={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not submit a duplicate of an existing member", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, list));
        const user = userEvent.setup();
        render(<MemberListCard list={{ ...list, memberAddresses: ["a@example.com"] }} onUpdate={vi.fn()} />);

        await user.type(screen.getByPlaceholderText("Member address to add"), "a@example.com");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("shows an error message when adding a member fails", async () => {
        mockFetch(() => jsonResponse(500, { message: "add failed" }));
        const user = userEvent.setup();
        render(<MemberListCard list={list} onUpdate={vi.fn()} />);

        await user.type(screen.getByPlaceholderText("Member address to add"), "new@example.com");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByText("add failed")).toBeInTheDocument();
    });

    it("shows a generic error message when adding a member fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<MemberListCard list={list} onUpdate={vi.fn()} />);

        await user.type(screen.getByPlaceholderText("Member address to add"), "new@example.com");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByText("Could not add this member.")).toBeInTheDocument();
    });

    it("removes an existing member and calls onUpdate with the saved list", async () => {
        const fetchMock = mockFetch((url, init) => {
            const body = JSON.parse(init.body as string);
            expect(body).toEqual({ uid: "team@example.com", version: 0, memberAddresses: [] });
            return jsonResponse(200, { ...list, version: 1, memberAddresses: [] });
        });
        const onUpdate = vi.fn();
        const user = userEvent.setup();
        render(<MemberListCard list={{ ...list, memberAddresses: ["a@example.com"] }} onUpdate={onUpdate} />);

        await user.click(screen.getByRole("button", { name: "Remove" }));

        expect(fetchMock).toHaveBeenCalled();
        expect(onUpdate).toHaveBeenCalledWith({ ...list, version: 1, memberAddresses: [] });
    });

    it("shows an error message when removing a member fails", async () => {
        mockFetch(() => jsonResponse(500, { message: "remove failed" }));
        const user = userEvent.setup();
        render(<MemberListCard list={{ ...list, memberAddresses: ["a@example.com"] }} onUpdate={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Remove" }));

        expect(await screen.findByText("remove failed")).toBeInTheDocument();
    });

    it("shows a generic error message when removing a member fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<MemberListCard list={{ ...list, memberAddresses: ["a@example.com"] }} onUpdate={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Remove" }));

        expect(await screen.findByText("Could not remove this member.")).toBeInTheDocument();
    });
});
