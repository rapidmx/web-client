// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import DistributionListsPage from "../../../../apps/admin/distribution-lists/index.js";

const list = {
    uid: "team@example.com",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    primarySmtpAddress: "team@example.com",
    name: "Team",
    memberAddresses: ["a@example.com", "b@example.com"],
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("DistributionListsPage", () => {
    it("shows an empty state when there are no distribution lists", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/distribution-lists")) return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        render(<DistributionListsPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("No distribution lists yet.")).toBeInTheDocument();
    });

    it("lists distribution lists with their member count and links to their detail pages", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/distribution-lists")) return jsonResponse(200, [list]);
            throw new Error(`unexpected ${url}`);
        });
        render(<DistributionListsPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        expect(await screen.findByText("team@example.com")).toBeInTheDocument();
        expect(screen.getByText("Team")).toBeInTheDocument();
        expect(screen.getByText("2")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "+ New distribution list" })).toHaveAttribute(
            "href",
            "/admin/distribution-lists/new",
        );
        expect(screen.getByRole("link", { name: "View" })).toHaveAttribute(
            "href",
            "/admin/distribution-lists/team%40example.com",
        );
    });

    it("shows an error message when the list fails to load", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(500, { message: "boom" });
        });
        render(<DistributionListsPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when the list fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        render(<DistributionListsPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("Could not load distribution lists.")).toBeInTheDocument();
    });

    it("paginates: Next fetches the following page, Previous returns to the first", async () => {
        const fullPage = Array.from({ length: 25 }, (_, i) => ({
            ...list,
            uid: `list${i}@example.com`,
            primarySmtpAddress: `list${i}@example.com`,
        }));
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.includes("page=0")) return jsonResponse(200, fullPage);
            if (url.includes("page=1")) {
                return jsonResponse(200, [{ ...list, uid: "list99@example.com", primarySmtpAddress: "list99@example.com" }]);
            }
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<DistributionListsPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        await screen.findByText("list0@example.com");
        expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(await screen.findByText("list99@example.com")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Previous" }));
        expect(await screen.findByText("list0@example.com")).toBeInTheDocument();
    });
});
