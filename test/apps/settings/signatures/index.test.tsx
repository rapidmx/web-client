// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import SettingsSignaturesPage from "../../../../apps/www/settings/signatures/index.js";

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

function signature(n: number, overrides: Record<string, unknown> = {}) {
    return {
        uid: `sig${n}`,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        name: `Signature ${n}`,
        contentHtml: "<p>Hi</p>",
        isDefaultForNewMessages: false,
        isDefaultForReplyForward: false,
        ...overrides,
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

describe("SettingsSignaturesPage", () => {
    it("shows an empty state when there are no signatures", async () => {
        mockShell((url) => (url.startsWith("/api/mail/mail-signatures") ? jsonResponse(200, []) : undefined));
        render(<SettingsSignaturesPage userUid="u1" />);
        expect(await screen.findByText("No signatures yet.")).toBeInTheDocument();
    });

    it("lists signatures, marking which default(s) each one holds, and links to their detail pages", async () => {
        mockShell((url) =>
            url.startsWith("/api/mail/mail-signatures")
                ? jsonResponse(200, [
                      signature(1, { isDefaultForNewMessages: true, isDefaultForReplyForward: true }),
                      signature(2),
                  ])
                : undefined,
        );
        render(<SettingsSignaturesPage userUid="u1" />);

        expect(await screen.findByText("Signature 1")).toBeInTheDocument();
        expect(screen.getByText("Default for new messages · Default for replies/forwards")).toBeInTheDocument();
        expect(screen.getByText("Signature 2")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "+ New signature" })).toHaveAttribute(
            "href",
            "/settings/signatures/new?mailboxUid=mb1",
        );
        expect(screen.getAllByRole("link", { name: "Edit" })[0]).toHaveAttribute(
            "href",
            "/settings/signatures/sig1?mailboxUid=mb1",
        );
    });

    it("shows no default label at all for a signature that isn't a default for either context", async () => {
        mockShell((url) => (url.startsWith("/api/mail/mail-signatures") ? jsonResponse(200, [signature(1)]) : undefined));
        render(<SettingsSignaturesPage userUid="u1" />);

        await screen.findByText("Signature 1");
        expect(screen.queryByText(/Default for/)).not.toBeInTheDocument();
    });

    it("shows an error message when the list fails to load", async () => {
        mockShell((url) => (url.startsWith("/api/mail/mail-signatures") ? jsonResponse(500, { message: "boom" }) : undefined));
        render(<SettingsSignaturesPage userUid="u1" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when the list fails with a non-API error", async () => {
        mockShell((url) => {
            if (url.startsWith("/api/mail/mail-signatures")) throw new TypeError("network down");
            return undefined;
        });
        render(<SettingsSignaturesPage userUid="u1" />);
        expect(await screen.findByText("Could not load signatures.")).toBeInTheDocument();
    });
});
