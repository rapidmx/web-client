// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import EscrowScopesPage from "../../../../apps/admin/escrow-scopes/index.js";

const scope = (n: number) => ({
    uid: `es${n}`,
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    name: `Scope ${n}`,
    publicKey: {
        publicKey: "base64cert",
        type: "x509",
        fingerprint: "abc123",
        notBefore: 1735689600000,
        notAfter: 1767225600000,
    },
    holderUserUids: ["u1", "u2"],
    requiredHolders: 2,
    notifySubjectOnAccess: false,
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("EscrowScopesPage", () => {
    it("shows an empty state when there are no escrow scopes", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/escrow/scopes")) return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        render(<EscrowScopesPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("No escrow scopes yet.")).toBeInTheDocument();
    });

    it("lists escrow scopes with holder count, required holders, notify flag, and links to their detail pages", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/escrow/scopes")) {
                return jsonResponse(200, [scope(1), { ...scope(2), notifySubjectOnAccess: true }]);
            }
            throw new Error(`unexpected ${url}`);
        });
        render(<EscrowScopesPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        expect(await screen.findByText("Scope 1")).toBeInTheDocument();
        // Holder count (2) and required holders (2) both render "2" per row, twice over for two rows.
        expect(screen.getAllByText("2")).toHaveLength(4);
        expect(screen.getByText("No")).toBeInTheDocument();
        expect(screen.getByText("Yes")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "+ New escrow scope" })).toHaveAttribute(
            "href",
            "/admin/escrow-scopes/new",
        );
        expect(screen.getAllByRole("link", { name: "View" })[0]).toHaveAttribute("href", "/admin/escrow-scopes/es1");
    });

    it("shows an error message when the list fails to load", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(500, { message: "boom" });
        });
        render(<EscrowScopesPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when the list fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        render(<EscrowScopesPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("Could not load escrow scopes.")).toBeInTheDocument();
    });

    it("paginates: Next fetches the following page, Previous returns to the first", async () => {
        const fullPage = Array.from({ length: 25 }, (_, i) => scope(i));
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.includes("page=0")) return jsonResponse(200, fullPage);
            if (url.includes("page=1")) return jsonResponse(200, [scope(99)]);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<EscrowScopesPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        await screen.findByText("Scope 0");
        expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(await screen.findByText("Scope 99")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Previous" }));
        expect(await screen.findByText("Scope 0")).toBeInTheDocument();
    });
});
