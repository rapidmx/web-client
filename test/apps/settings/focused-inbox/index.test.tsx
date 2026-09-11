// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import SettingsFocusedInboxPage from "../../../../apps/www/settings/focused-inbox/index.js";

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

function override(n: number, classifyAs: "focused" | "other" = "other") {
    return {
        uid: `fio${n}`,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        senderAddress: `sender${n}@example.com`,
        classifyAs,
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

describe("SettingsFocusedInboxPage", () => {
    it("shows an empty state when there are no rules", async () => {
        mockShell((url) => (url.startsWith("/api/mail/focused-inbox-overrides") ? jsonResponse(200, []) : undefined));
        render(<SettingsFocusedInboxPage userUid="u1" />);
        expect(await screen.findByText("No rules yet.")).toBeInTheDocument();
    });

    it("lists existing rules with their sender and classification", async () => {
        mockShell((url) =>
            url.startsWith("/api/mail/focused-inbox-overrides")
                ? jsonResponse(200, [override(1, "other"), override(2, "focused")])
                : undefined,
        );
        render(<SettingsFocusedInboxPage userUid="u1" />);

        expect(await screen.findByText("sender1@example.com")).toBeInTheDocument();
        expect(screen.getByText("Always Other")).toBeInTheDocument();
        expect(screen.getByText("sender2@example.com")).toBeInTheDocument();
        expect(screen.getByText("Always Focused")).toBeInTheDocument();
    });

    it("shows an error message when the list fails to load", async () => {
        mockShell((url) => (url.startsWith("/api/mail/focused-inbox-overrides") ? jsonResponse(500, { message: "boom" }) : undefined));
        render(<SettingsFocusedInboxPage userUid="u1" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when the list fails with a non-API error", async () => {
        mockShell((url) => {
            if (url.startsWith("/api/mail/focused-inbox-overrides")) throw new TypeError("network down");
            return undefined;
        });
        render(<SettingsFocusedInboxPage userUid="u1" />);
        expect(await screen.findByText("Could not load your Focused Inbox rules.")).toBeInTheDocument();
    });

    it("adds a new rule and reloads the list", async () => {
        let created = false;
        const fetchMock = mockShell((url, init) => {
            if (url === "/api/mail/focused-inbox-overrides" && init?.method === "POST") {
                created = true;
                return jsonResponse(200, override(1, "other"));
            }
            if (url.startsWith("/api/mail/focused-inbox-overrides")) return jsonResponse(200, created ? [override(1, "other")] : []);
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsFocusedInboxPage userUid="u1" />);
        await screen.findByText("No rules yet.");

        await user.type(screen.getByLabelText("Sender address"), "sender1@example.com");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByText("sender1@example.com")).toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([url, init]: any) => url === "/api/mail/focused-inbox-overrides" && init?.method === "POST")).toBe(
            true,
        );
    });

    it("does not submit when the sender address is blank", async () => {
        const fetchMock = mockShell((url) =>
            url.startsWith("/api/mail/focused-inbox-overrides") ? jsonResponse(200, []) : undefined,
        );
        const user = userEvent.setup();
        render(<SettingsFocusedInboxPage userUid="u1" />);
        await screen.findByText("No rules yet.");

        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(fetchMock.mock.calls.some(([, init]: any) => init?.method === "POST")).toBe(false);
    });

    it("shows an error message when adding a rule fails", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/focused-inbox-overrides" && init?.method === "POST") return jsonResponse(400, { message: "invalid address" });
            if (url.startsWith("/api/mail/focused-inbox-overrides")) return jsonResponse(200, []);
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsFocusedInboxPage userUid="u1" />);
        await screen.findByText("No rules yet.");

        await user.type(screen.getByLabelText("Sender address"), "bad");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByText("invalid address")).toBeInTheDocument();
    });

    it("shows a generic error message when adding a rule fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/focused-inbox-overrides" && init?.method === "POST") throw new TypeError("network down");
            if (url.startsWith("/api/mail/focused-inbox-overrides")) return jsonResponse(200, []);
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsFocusedInboxPage userUid="u1" />);
        await screen.findByText("No rules yet.");

        await user.type(screen.getByLabelText("Sender address"), "sender1@example.com");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByText("Could not add this rule.")).toBeInTheDocument();
    });

    it("removes a rule", async () => {
        let deleted = false;
        const fetchMock = mockShell((url, init) => {
            if (url === "/api/mail/focused-inbox-overrides/fio1?version=0" && init?.method === "DELETE") {
                deleted = true;
                return new Response(null, { status: 204 });
            }
            if (url.startsWith("/api/mail/focused-inbox-overrides")) return jsonResponse(200, deleted ? [] : [override(1)]);
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsFocusedInboxPage userUid="u1" />);
        await screen.findByText("sender1@example.com");

        await user.click(screen.getByRole("button", { name: "Remove" }));

        await screen.findByText("No rules yet.");
        expect(fetchMock.mock.calls.some(([url, init]: any) => url === "/api/mail/focused-inbox-overrides/fio1?version=0" && init?.method === "DELETE")).toBe(
            true,
        );
    });

    it("shows an error message when removing a rule fails", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/focused-inbox-overrides/fio1?version=0" && init?.method === "DELETE") return jsonResponse(500, { message: "boom" });
            if (url.startsWith("/api/mail/focused-inbox-overrides")) return jsonResponse(200, [override(1)]);
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsFocusedInboxPage userUid="u1" />);
        await screen.findByText("sender1@example.com");

        await user.click(screen.getByRole("button", { name: "Remove" }));

        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when removing a rule fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/focused-inbox-overrides/fio1?version=0" && init?.method === "DELETE") throw new TypeError("network down");
            if (url.startsWith("/api/mail/focused-inbox-overrides")) return jsonResponse(200, [override(1)]);
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsFocusedInboxPage userUid="u1" />);
        await screen.findByText("sender1@example.com");

        await user.click(screen.getByRole("button", { name: "Remove" }));

        expect(await screen.findByText("Could not remove this rule.")).toBeInTheDocument();
    });

    it("selects Focused as the classification via the select input", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url === "/api/mail/focused-inbox-overrides" && init?.method === "POST") return jsonResponse(200, override(1, "focused"));
            if (url.startsWith("/api/mail/focused-inbox-overrides")) return jsonResponse(200, []);
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsFocusedInboxPage userUid="u1" />);
        await screen.findByText("No rules yet.");

        await user.type(screen.getByLabelText("Sender address"), "sender1@example.com");
        await user.selectOptions(screen.getByLabelText("Classify as"), "focused");
        await user.click(screen.getByRole("button", { name: "Add" }));

        const call = fetchMock.mock.calls.find(([url, init]: any) => url === "/api/mail/focused-inbox-overrides" && init?.method === "POST");
        expect(JSON.parse((call![1] as RequestInit).body as string).classifyAs).toBe("focused");
    });
});
