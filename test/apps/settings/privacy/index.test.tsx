// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import SettingsPrivacyPage from "../../../../apps/www/settings/privacy/index.js";

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

function exportRequest(overrides: Record<string, unknown> = {}) {
    return {
        uid: "der1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        requestedByUserUid: "u1",
        format: "json" as const,
        status: "pending" as const,
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

describe("SettingsPrivacyPage", () => {
    it("shows an empty state when there are no export requests", async () => {
        mockShell((url) => (url === "/api/mail/data-export-requests" ? jsonResponse(200, []) : undefined));
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByText("No export requests yet.")).toBeInTheDocument();
    });

    it("lists existing export requests, with a Download link only once ready", async () => {
        mockShell((url) =>
            url === "/api/mail/data-export-requests"
                ? jsonResponse(200, [exportRequest({ uid: "der1", status: "pending" }), exportRequest({ uid: "der2", status: "ready" })])
                : undefined,
        );
        render(<SettingsPrivacyPage userUid="u1" />);

        expect(await screen.findByText("pending")).toBeInTheDocument();
        expect(screen.getByText("ready")).toBeInTheDocument();
        const downloadLinks = screen.getAllByRole("link", { name: "Download" });
        expect(downloadLinks).toHaveLength(1);
        expect(downloadLinks[0]).toHaveAttribute("href", "/api/mail/data-export-requests/der2/download");
    });

    it("shows the failure reason for a failed request", async () => {
        mockShell((url) =>
            url === "/api/mail/data-export-requests"
                ? jsonResponse(200, [exportRequest({ status: "failed", errorMessage: "The requested mailbox no longer exists." })])
                : undefined,
        );
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByText(/The requested mailbox no longer exists\./)).toBeInTheDocument();
    });

    it("shows the server's own message when loading export requests fails", async () => {
        mockShell((url) => (url === "/api/mail/data-export-requests" ? jsonResponse(500, { message: "server unavailable" }) : undefined));
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByText("server unavailable")).toBeInTheDocument();
    });

    it("shows a generic message when loading export requests fails with a non-API error", async () => {
        mockShell((url) => {
            if (url === "/api/mail/data-export-requests") throw new TypeError("network down");
            return undefined;
        });
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByText("Could not load your export requests.")).toBeInTheDocument();
    });

    it("requests an export and reloads the list", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url === "/api/mail/data-export-requests" && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            if (url === "/api/mail/data-export-requests" && init?.method === "POST") return jsonResponse(200, exportRequest());
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsPrivacyPage userUid="u1" />);
        await screen.findByText("No export requests yet.");

        await user.selectOptions(screen.getByLabelText("Export format"), "mbox");
        await user.click(screen.getByRole("button", { name: "Request export" }));

        const postCall = await vi.waitFor(() => {
            const call = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
            expect(call).toBeDefined();
            return call!;
        });
        expect(JSON.parse(postCall[1]!.body as string)).toEqual({ format: "mbox" });
    });

    it("shows the server's own message when requesting an export fails", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/data-export-requests" && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            if (url === "/api/mail/data-export-requests" && init?.method === "POST") {
                return jsonResponse(403, { message: "caller is not this mailbox's owner" });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsPrivacyPage userUid="u1" />);
        await screen.findByText("No export requests yet.");

        await user.click(screen.getByRole("button", { name: "Request export" }));

        expect(await screen.findByText("caller is not this mailbox's owner")).toBeInTheDocument();
    });

    it("shows a generic message when requesting an export fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/data-export-requests" && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            if (url === "/api/mail/data-export-requests" && init?.method === "POST") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsPrivacyPage userUid="u1" />);
        await screen.findByText("No export requests yet.");

        await user.click(screen.getByRole("button", { name: "Request export" }));

        expect(await screen.findByText("Could not start this export.")).toBeInTheDocument();
    });
});
