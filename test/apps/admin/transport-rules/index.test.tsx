// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import TransportRulesPage from "../../../../apps/admin/transport-rules/index.js";

const rule = (n: number, sequence: number) => ({
    uid: `tr${n}`,
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    name: `Rule ${n}`,
    enabled: true,
    sequence,
    stopProcessingRules: false,
    conditions: {},
    actions: [{ type: "reject" }],
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("TransportRulesPage", () => {
    it("shows an empty state when there are no transport rules", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/transport-rules")) return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        render(<TransportRulesPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("No transport rules yet.")).toBeInTheDocument();
    });

    it("lists transport rules sorted by sequence, with action count, and links to their detail pages", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/transport-rules")) {
                return jsonResponse(200, [{ ...rule(2, 5), enabled: false }, rule(1, 0)]);
            }
            throw new Error(`unexpected ${url}`);
        });
        render(<TransportRulesPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        const rows = await screen.findAllByRole("row");
        // rows[0] is the header row — the lower-sequence rule (Rule 1) must render first.
        expect(rows[1]).toHaveTextContent("Rule 1");
        expect(rows[2]).toHaveTextContent("Rule 2");
        expect(screen.getAllByText("1")).toHaveLength(2); // each rule has exactly 1 action
        expect(screen.getByText("Yes")).toBeInTheDocument();
        expect(screen.getByText("No")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "+ New transport rule" })).toHaveAttribute(
            "href",
            "/admin/transport-rules/new",
        );
        expect(screen.getAllByRole("link", { name: "View" })[0]).toHaveAttribute(
            "href",
            "/admin/transport-rules/tr1",
        );
    });

    it("shows an error message when the list fails to load", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(500, { message: "boom" });
        });
        render(<TransportRulesPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when the list fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        render(<TransportRulesPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("Could not load transport rules.")).toBeInTheDocument();
    });

    it("paginates: Next fetches the following page, Previous returns to the first", async () => {
        const fullPage = Array.from({ length: 25 }, (_, i) => rule(i, i));
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.includes("page=0")) return jsonResponse(200, fullPage);
            if (url.includes("page=1")) return jsonResponse(200, [rule(99, 99)]);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<TransportRulesPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        await screen.findByText("Rule 0");
        expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(await screen.findByText("Rule 99")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Previous" }));
        expect(await screen.findByText("Rule 0")).toBeInTheDocument();
    });
});
