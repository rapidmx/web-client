// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import SettingsAutoReplyPage from "../../../../apps/www/settings/auto-reply/index.js";

function mailbox(overrides: Record<string, unknown> = {}) {
    return {
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
        oofEnabled: false,
        oofMessage: "",
        ...overrides,
    };
}

function mockShell(mb: ReturnType<typeof mailbox>, extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mb]);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("SettingsAutoReplyPage", () => {
    it("renders with the toggle off and no message/date fields when the mailbox has automatic replies disabled", async () => {
        mockShell(mailbox());
        render(<SettingsAutoReplyPage userUid="u1" />);

        expect(await screen.findByRole("heading", { name: "Automatic Replies" })).toBeInTheDocument();
        expect(screen.getByRole("checkbox", { name: "Automatic replies are on" })).not.toBeChecked();
        expect(screen.queryByLabelText("Automatic reply message")).not.toBeInTheDocument();
    });

    it("defaults to disabled/empty when the mailbox response omits oofEnabled/oofMessage entirely (an older fixture shape)", async () => {
        const legacyMailbox = mailbox();
        delete (legacyMailbox as { oofEnabled?: boolean }).oofEnabled;
        delete (legacyMailbox as { oofMessage?: string }).oofMessage;
        mockShell(legacyMailbox);
        render(<SettingsAutoReplyPage userUid="u1" />);

        expect(await screen.findByRole("checkbox", { name: "Automatic replies are on" })).not.toBeChecked();
        expect(screen.queryByLabelText("Automatic reply message")).not.toBeInTheDocument();
    });

    it("renders pre-filled from a mailbox with automatic replies already enabled", async () => {
        mockShell(
            mailbox({
                oofEnabled: true,
                oofMessage: "I'm out until Monday.",
                oofStartTime: "2026-06-01T09:00:00.000Z",
                oofEndTime: "2026-06-08T09:00:00.000Z",
            }),
        );
        render(<SettingsAutoReplyPage userUid="u1" />);

        expect(await screen.findByRole("checkbox", { name: "Automatic replies are on" })).toBeChecked();
        expect(screen.getByLabelText("Automatic reply message")).toHaveValue("I'm out until Monday.");
        expect(screen.getByLabelText("Automatic reply start")).toHaveValue("2026-06-01T09:00");
        expect(screen.getByLabelText("Automatic reply end")).toHaveValue("2026-06-08T09:00");
    });

    it("shows/hides the message and date fields as the toggle is switched", async () => {
        mockShell(mailbox());
        const user = userEvent.setup();
        render(<SettingsAutoReplyPage userUid="u1" />);

        const toggle = await screen.findByRole("checkbox", { name: "Automatic replies are on" });
        await user.click(toggle);
        expect(screen.getByLabelText("Automatic reply message")).toBeInTheDocument();

        await user.click(toggle);
        expect(screen.queryByLabelText("Automatic reply message")).not.toBeInTheDocument();
    });

    it("saves the toggle, message, and both dates, and shows a confirmation", async () => {
        const fetchMock = mockShell(mailbox(), (url, init) =>
            url === "/api/mail/mailboxes/mb1" && init?.method === "PUT" ? jsonResponse(200, mailbox({ oofEnabled: true })) : undefined,
        );
        const user = userEvent.setup();
        render(<SettingsAutoReplyPage userUid="u1" />);

        await user.click(await screen.findByRole("checkbox", { name: "Automatic replies are on" }));
        await user.type(screen.getByLabelText("Automatic reply message"), "On vacation");
        fireEvent.change(screen.getByLabelText("Automatic reply start"), { target: { value: "2026-06-01T09:00" } });
        fireEvent.change(screen.getByLabelText("Automatic reply end"), { target: { value: "2026-06-08T09:00" } });
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        const call = fetchMock.mock.calls.find(([url, init]) => url === "/api/mail/mailboxes/mb1" && (init as RequestInit)?.method === "PUT");
        expect(call).toBeDefined();
        const body = JSON.parse((call![1] as RequestInit).body as string);
        expect(body).toEqual(
            expect.objectContaining({
                uid: "mb1",
                version: 0,
                oofEnabled: true,
                oofMessage: "On vacation",
                oofStartTime: "2026-06-01T09:00:00.000Z",
                oofEndTime: "2026-06-08T09:00:00.000Z",
            }),
        );
    });

    it("saves with oofStartTime/oofEndTime left undefined when both are left blank", async () => {
        const fetchMock = mockShell(mailbox(), (url, init) =>
            url === "/api/mail/mailboxes/mb1" && init?.method === "PUT" ? jsonResponse(200, mailbox({ oofEnabled: true })) : undefined,
        );
        const user = userEvent.setup();
        render(<SettingsAutoReplyPage userUid="u1" />);

        await user.click(await screen.findByRole("checkbox", { name: "Automatic replies are on" }));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await screen.findByText("Saved.");
        const call = fetchMock.mock.calls.find(([url, init]) => url === "/api/mail/mailboxes/mb1" && (init as RequestInit)?.method === "PUT");
        const body = JSON.parse((call![1] as RequestInit).body as string);
        expect(body.oofStartTime).toBeUndefined();
        expect(body.oofEndTime).toBeUndefined();
    });

    it("shows an API error message when saving fails", async () => {
        mockShell(mailbox(), (url, init) =>
            url === "/api/mail/mailboxes/mb1" && init?.method === "PUT" ? jsonResponse(500, { message: "boom" }) : undefined,
        );
        const user = userEvent.setup();
        render(<SettingsAutoReplyPage userUid="u1" />);

        await screen.findByRole("checkbox", { name: "Automatic replies are on" });
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when saving fails with a non-API error", async () => {
        mockShell(mailbox(), (url, init) => {
            if (url === "/api/mail/mailboxes/mb1" && init?.method === "PUT") {
                throw new TypeError("network down");
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsAutoReplyPage userUid="u1" />);

        await screen.findByRole("checkbox", { name: "Automatic replies are on" });
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Could not save automatic reply settings.")).toBeInTheDocument();
    });
});
