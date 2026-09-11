// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import DistributionListDetailPage from "../../../../apps/admin/distribution-lists/[uid].js";

const list = {
    uid: "team@example.com",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    primarySmtpAddress: "team@example.com",
    name: "Team",
    description: "Everyone on the team",
    ownerUserUid: "u1",
    aliasAddresses: ["alt@example.com"],
    memberAddresses: ["a@example.com"],
    restrictSenders: true,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("DistributionListDetailPage", () => {
    it("renders list details and the member list card", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/distribution-lists/team%40example.com") return jsonResponse(200, list);
            throw new Error(`unexpected ${url}`);
        });
        render(<DistributionListDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "team@example.com" }} />);

        expect(await screen.findByRole("heading", { name: "team@example.com" })).toBeInTheDocument();
        expect(screen.getByText("Team")).toBeInTheDocument();
        expect(screen.getByText("Everyone on the team")).toBeInTheDocument();
        expect(screen.getByText("u1")).toBeInTheDocument();
        expect(screen.getByText("alt@example.com")).toBeInTheDocument();
        expect(screen.getByText("Only members may send")).toBeInTheDocument();
        expect(screen.getByText("Members")).toBeInTheDocument();
        expect(screen.getByText("a@example.com")).toBeInTheDocument();
    });

    it("shows 'None' for owner, alias addresses, and description when unset, and 'No' for restrictSenders", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/distribution-lists/team%40example.com") {
                return jsonResponse(200, {
                    ...list,
                    description: undefined,
                    ownerUserUid: undefined,
                    aliasAddresses: [],
                    restrictSenders: false,
                });
            }
            throw new Error(`unexpected ${url}`);
        });
        render(<DistributionListDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "team@example.com" }} />);

        await screen.findByRole("heading", { name: "team@example.com" });
        expect(screen.getAllByText("None")).toHaveLength(3);
        expect(screen.getByText("No")).toBeInTheDocument();
    });

    it("reflects a member added via MemberListCard back into the page's own state", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/distribution-lists/team%40example.com" && (init?.method ?? "GET") === "GET") {
                return jsonResponse(200, list);
            }
            if (url === "/api/mail/distribution-lists/team%40example.com" && init?.method === "PUT") {
                return jsonResponse(200, { ...list, version: 1, memberAddresses: ["a@example.com", "new@example.com"] });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<DistributionListDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "team@example.com" }} />);

        await screen.findByText("a@example.com");
        await user.type(screen.getByPlaceholderText("Member address to add"), "new@example.com");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByText("new@example.com")).toBeInTheDocument();
    });

    it("shows an error message when the list fails to load", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(404, { message: "not found" });
        });
        render(<DistributionListDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "team@example.com" }} />);
        expect(await screen.findByText("not found")).toBeInTheDocument();
    });

    it("shows a generic error message when loading the list fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        render(<DistributionListDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "team@example.com" }} />);
        expect(await screen.findByText("Could not load this distribution list.")).toBeInTheDocument();
    });

    it("falls back to 'Distribution list not found.' when the load succeeds with no list and no error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/distribution-lists/team%40example.com") return jsonResponse(200, null);
            throw new Error(`unexpected ${url}`);
        });
        render(<DistributionListDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid: "team@example.com" }} />);
        expect(await screen.findByText("Distribution list not found.")).toBeInTheDocument();
    });
});
