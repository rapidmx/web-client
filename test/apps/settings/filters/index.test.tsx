// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import SettingsFiltersPage from "../../../../apps/www/settings/filters/index.js";

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "My Mail",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};

function rule(n: number, sequence: number) {
    return {
        uid: `mfr${n}`,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        name: `Rule ${n}`,
        enabled: true,
        sequence,
        stopProcessingRules: false,
        conditions: {},
        actions: [{ type: "delete" }],
    };
}

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

describe("SettingsFiltersPage", () => {
    it("shows an empty state when there are no mail filters", async () => {
        mockShell((url) => (url.startsWith("/api/mail/mail-filter-rules") ? jsonResponse(200, []) : undefined));
        render(<SettingsFiltersPage userUid="u1" />);
        expect(await screen.findByText("No mail filters yet.")).toBeInTheDocument();
    });

    it("lists mail filters sorted by sequence, with action count, and links to their detail pages", async () => {
        const fetchMock = mockShell((url) =>
            url.startsWith("/api/mail/mail-filter-rules")
                ? jsonResponse(200, [{ ...rule(2, 5), enabled: false }, rule(1, 0)])
                : undefined,
        );
        render(<SettingsFiltersPage userUid="u1" />);

        const rows = await screen.findAllByRole("row");
        // rows[0] is the header row — the lower-sequence rule (Rule 1) must render first.
        expect(rows[1]).toHaveTextContent("Rule 1");
        expect(rows[2]).toHaveTextContent("Rule 2");
        expect(screen.getAllByText("1")).toHaveLength(2); // each rule has exactly 1 action
        expect(screen.getByText("Yes")).toBeInTheDocument();
        expect(screen.getByText("No")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "+ New filter" })).toHaveAttribute(
            "href",
            "/settings/filters/new?mailboxUid=mb1",
        );
        expect(screen.getAllByRole("link", { name: "View" })[0]).toHaveAttribute(
            "href",
            "/settings/filters/mfr1?mailboxUid=mb1",
        );
        expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/mail/mail-filter-rules?limit=25&page=0&mailboxUid=mb1"))).toBe(
            true,
        );
    });

    it("shows an error message when the list fails to load", async () => {
        mockShell((url) => (url.startsWith("/api/mail/mail-filter-rules") ? jsonResponse(500, { message: "boom" }) : undefined));
        render(<SettingsFiltersPage userUid="u1" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when the list fails with a non-API error", async () => {
        mockShell((url) => {
            if (url.startsWith("/api/mail/mail-filter-rules")) throw new TypeError("network down");
            return undefined;
        });
        render(<SettingsFiltersPage userUid="u1" />);
        expect(await screen.findByText("Could not load mail filters.")).toBeInTheDocument();
    });
});
