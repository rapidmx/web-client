// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import SettingsReadReceiptsPageRouted from "../../../../apps/www/settings/read-receipts/index.js";

// The page's own component: what a test renders is the page, not the client-side router around it (see `routedPage()`).
const SettingsReadReceiptsPage = SettingsReadReceiptsPageRouted.page;

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
    alwaysRequestReceiptInternal: true,
    alwaysRequestReceiptExternal: false,
    autoSendReceiptsInternal: true,
    autoSendReceiptsExternal: false,
};

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

describe("SettingsReadReceiptsPage", () => {
    it("seeds every checkbox from the mailbox's current settings", async () => {
        mockShell();
        render(<SettingsReadReceiptsPage userUid="u1" />);

        expect(await screen.findByText("From internal recipients (mail to this organization)")).toBeInTheDocument();
        expect(screen.getByLabelText("From internal recipients (mail to this organization)")).toBeChecked();
        expect(screen.getByLabelText("From external recipients")).not.toBeChecked();
        expect(screen.getByLabelText("From internal senders")).toBeChecked();
        expect(screen.getByLabelText("From external senders")).not.toBeChecked();
    });

    it("defaults every checkbox to its documented server-side default when the mailbox predates these fields", async () => {
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
            if (url.startsWith("/api/mail/mailboxes")) {
                const {
                    alwaysRequestReceiptInternal,
                    alwaysRequestReceiptExternal,
                    autoSendReceiptsInternal,
                    autoSendReceiptsExternal,
                    ...rest
                } = mailbox;
                return jsonResponse(200, [rest]);
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        render(<SettingsReadReceiptsPage userUid="u1" />);

        expect(await screen.findByLabelText("From internal recipients (mail to this organization)")).toBeChecked();
        expect(screen.getByLabelText("From external recipients")).not.toBeChecked();
        expect(screen.getByLabelText("From internal senders")).toBeChecked();
        expect(screen.getByLabelText("From external senders")).not.toBeChecked();
        expect(screen.getByLabelText("From federated recipients (partner organizations)")).not.toBeChecked();
        expect(screen.getByLabelText("From federated senders (partner organizations)")).not.toBeChecked();
    });

    it("saves every toggle", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url === "/api/mail/mailboxes/mb1" && init?.method === "PUT") {
                return jsonResponse(200, { ...mailbox, alwaysRequestReceiptExternal: true, autoSendReceiptsExternal: true });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsReadReceiptsPage userUid="u1" />);
        await screen.findByLabelText("From internal recipients (mail to this organization)");

        await user.click(screen.getByLabelText("From internal recipients (mail to this organization)"));
        await user.click(screen.getByLabelText("From external recipients"));
        await user.click(screen.getByLabelText("From internal senders"));
        await user.click(screen.getByLabelText("From external senders"));
        await user.click(screen.getByLabelText("From federated recipients (partner organizations)"));
        await user.click(screen.getByLabelText("From federated senders (partner organizations)"));
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        const call = fetchMock.mock.calls.find(([url, init]: any) => url === "/api/mail/mailboxes/mb1" && init?.method === "PUT")!;
        const body = JSON.parse((call[1] as RequestInit).body as string);
        expect(body).toMatchObject({
            alwaysRequestReceiptInternal: false,
            alwaysRequestReceiptExternal: true,
            autoSendReceiptsInternal: false,
            autoSendReceiptsExternal: true,
            alwaysRequestReceiptFederated: true,
            autoSendReceiptsFederated: true,
            version: 0,
        });
    });

    it("seeds the federated checkboxes from the mailbox, and sends the version the previous save returned on the next save", async () => {
        let saves = 0;
        const federatedMailbox = { ...mailbox, alwaysRequestReceiptFederated: true, autoSendReceiptsFederated: true };
        const fetchMock = mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
            if (url === "/api/mail/mailboxes/mb1" && init?.method === "PUT") {
                saves++;
                return jsonResponse(200, { ...federatedMailbox, version: saves });
            }
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [federatedMailbox]);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<SettingsReadReceiptsPage userUid="u1" />);

        expect(await screen.findByLabelText("From federated recipients (partner organizations)")).toBeChecked();
        expect(screen.getByLabelText("From federated senders (partner organizations)")).toBeChecked();
        await user.click(screen.getByRole("button", { name: "Save" }));
        await screen.findByText("Saved.");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(saves).toBe(2));

        const versions = fetchMock.mock.calls
            .filter(([url, init]: any) => url === "/api/mail/mailboxes/mb1" && init?.method === "PUT")
            .map(([, init]: any) => JSON.parse(init.body).version);
        expect(versions).toEqual([0, 1]);
    });

    it("shows an error message when saving fails", async () => {
        mockShell((url, init) => (url === "/api/mail/mailboxes/mb1" && init?.method === "PUT" ? jsonResponse(400, { message: "boom" }) : undefined));
        const user = userEvent.setup();
        render(<SettingsReadReceiptsPage userUid="u1" />);
        await screen.findByLabelText("From internal recipients (mail to this organization)");

        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when saving fails with a non-API error", async () => {
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
            if (url === "/api/mail/mailboxes/mb1" && init?.method === "PUT") throw new TypeError("network down");
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<SettingsReadReceiptsPage userUid="u1" />);
        await screen.findByLabelText("From internal recipients (mail to this organization)");

        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Could not save read receipt settings.")).toBeInTheDocument();
    });
});
