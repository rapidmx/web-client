// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import DomainsListPage from "../../../../apps/admin/domains/index.js";

const domain = {
    uid: "example.com",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    name: "example.com",
    enabled: true,
    verified: false,
    verificationToken: "tok123",
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("DomainsListPage", () => {
    it("shows an empty state when there are no domains", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/domains")) return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        render(<DomainsListPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("No domains configured yet.")).toBeInTheDocument();
    });

    it("lists domains with their enabled/verified state and links to their detail pages", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/domains")) {
                return jsonResponse(200, [
                    domain,
                    { ...domain, uid: "example.org", name: "example.org", enabled: false, verified: true },
                ]);
            }
            throw new Error(`unexpected ${url}`);
        });
        render(<DomainsListPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        expect(await screen.findByText("example.com")).toBeInTheDocument();
        expect(screen.getByText("example.org")).toBeInTheDocument();
        expect(screen.getByText("Yes")).toBeInTheDocument();
        expect(screen.getByText("No")).toBeInTheDocument();
        expect(screen.getByText("Unverified")).toBeInTheDocument();
        // "Verified" also names the table's own column header, so this domain's badge is the second match.
        expect(screen.getAllByText("Verified")).toHaveLength(2);
        expect(screen.getByRole("link", { name: "+ New domain" })).toHaveAttribute("href", "/admin/domains/new");
        expect(screen.getAllByRole("link", { name: "View" })[0]).toHaveAttribute(
            "href",
            "/admin/domains/example.com",
        );
    });

    it("shows an error message when the domain list fails to load", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(500, { message: "boom" });
        });
        render(<DomainsListPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when the domain list fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        render(<DomainsListPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("Could not load domains.")).toBeInTheDocument();
    });

    it("paginates: Next fetches the following page, Previous returns to the first", async () => {
        const fullPage = Array.from({ length: 25 }, (_, i) => ({ ...domain, uid: `d${i}.com`, name: `d${i}.com` }));
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.includes("page=0")) return jsonResponse(200, fullPage);
            if (url.includes("page=1")) return jsonResponse(200, [{ ...domain, uid: "d99.com", name: "d99.com" }]);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<DomainsListPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        await screen.findByText("d0.com");
        expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(await screen.findByText("d99.com")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Previous" }));
        expect(await screen.findByText("d0.com")).toBeInTheDocument();
    });
});
