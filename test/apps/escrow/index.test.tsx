// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import MattersPage from "../../../apps/escrow/index.js";

const matter = (n: number, closed = false) => ({
    uid: `m${n}`,
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    name: `Matter ${n}`,
    escrowScopeId: "es1",
    custodianMailboxUids: ["mb1", "mb2"],
    dateRangeStart: "2025-01-01T00:00:00.000Z",
    dateRangeEnd: "2025-12-31T00:00:00.000Z",
    ...(closed ? { closedAt: "2026-02-01T00:00:00.000Z" } : {}),
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("MattersPage", () => {
    it("shows an empty state when there are no matters", async () => {
        mockFetch(() => jsonResponse(200, []));
        render(<MattersPage userUid="u1" authServerUrl="https://auth.example.com" />);
        expect(
            await screen.findByText(
                "No matters yet — either none exist under a scope you hold, or you don't currently hold any escrow scope.",
            ),
        ).toBeInTheDocument();
    });

    it("lists matters with custodian count, date range, status, and links to their detail pages", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/escrow/matters")) return jsonResponse(200, [matter(1), matter(2, true)]);
            throw new Error(`unexpected ${url}`);
        });
        render(<MattersPage userUid="u1" authServerUrl="https://auth.example.com" />);

        expect(await screen.findByText("Matter 1")).toBeInTheDocument();
        expect(screen.getByText("Matter 2")).toBeInTheDocument();
        expect(screen.getByText("Open")).toBeInTheDocument();
        expect(screen.getByText("Closed")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "+ New matter" })).toHaveAttribute("href", "/escrow/matters/new");
        expect(screen.getAllByRole("link", { name: "View" })[0]).toHaveAttribute("href", "/escrow/matters/m1");
    });

    it("shows an error message when the list fails to load", async () => {
        // The shell's own reachability probe (limit=1) succeeds; only the content's own list=25 fetch fails.
        mockFetch((url) => {
            if (url.includes("limit=1&")) return jsonResponse(200, []);
            return jsonResponse(500, { message: "boom" });
        });
        render(<MattersPage userUid="u1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when the list fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url.includes("limit=1&")) return jsonResponse(200, []);
            throw new TypeError("network down");
        });
        render(<MattersPage userUid="u1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("Could not load matters.")).toBeInTheDocument();
    });

    it("paginates: Next fetches the following page, Previous returns to the first", async () => {
        const fullPage = Array.from({ length: 25 }, (_, i) => matter(i));
        mockFetch((url) => {
            if (url.includes("page=0")) return jsonResponse(200, fullPage);
            if (url.includes("page=1")) return jsonResponse(200, [matter(99)]);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<MattersPage userUid="u1" authServerUrl="https://auth.example.com" />);

        await screen.findByText("Matter 0");
        expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(await screen.findByText("Matter 99")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Previous" }));
        expect(await screen.findByText("Matter 0")).toBeInTheDocument();
    });
});
