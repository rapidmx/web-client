// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import SettingsAutoReplyPageRouted from "../../../../apps/www/settings/auto-reply/index.js";

// The page's own component: what a test renders is the page, not the client-side router around it (see `routedPage()`).
const SettingsAutoReplyPage = SettingsAutoReplyPageRouted.page;

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
    it("passes the server's plugin nav through to the settings sections and app rail", async () => {
        mockShell(mailbox());
        render(
            <SettingsAutoReplyPage
                userUid="u1"
                pluginNav={{
                    settingsSections: [{ id: "reminders", href: "/settings/reminders", label: "Reminders" }],
                    appRail: [{ id: "notes", href: "/notes", label: "Notes" }],
                }}
            />,
        );

        const sections = within(await screen.findByRole("navigation", { name: "Settings sections" }));
        expect(sections.getByRole("link", { name: "Reminders" })).toHaveAttribute("href", "/settings/reminders?mailboxUid=mb1");
        expect(sections.getByRole("link", { name: "Automatic Replies" })).toHaveAttribute("aria-current", "page");
        expect(within(screen.getByRole("navigation", { name: "Apps" })).getByRole("link", { name: "Notes" })).toHaveAttribute("href", "/notes");
    });

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

    it("saves with oofStartTime/oofEndTime sent as null when both are left blank, clearing any saved window", async () => {
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
        expect(body.oofStartTime).toBeNull();
        expect(body.oofEndTime).toBeNull();
    });

    it("clears a previously saved window by sending null, and sends the version the previous save returned on the next save", async () => {
        let saves = 0;
        const fetchMock = mockShell(
            mailbox({ oofEnabled: true, oofStartTime: "2026-06-01T09:00:00.000Z", oofEndTime: "2026-06-08T09:00:00.000Z" }),
            (url, init) => {
                if (url === "/api/mail/mailboxes/mb1" && init?.method === "PUT") {
                    saves++;
                    return jsonResponse(200, mailbox({ oofEnabled: true, version: saves }));
                }
                return undefined;
            },
        );
        const user = userEvent.setup();
        render(<SettingsAutoReplyPage userUid="u1" />);

        fireEvent.change(await screen.findByLabelText("Automatic reply start"), { target: { value: "" } });
        fireEvent.change(screen.getByLabelText("Automatic reply end"), { target: { value: "" } });
        await user.click(screen.getByRole("button", { name: "Save" }));
        await screen.findByText("Saved.");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(saves).toBe(2));

        const bodies = fetchMock.mock.calls
            .filter(([url, init]) => url === "/api/mail/mailboxes/mb1" && (init as RequestInit)?.method === "PUT")
            .map(([, init]) => JSON.parse((init as RequestInit).body as string));
        expect(bodies[0]).toMatchObject({ version: 0, oofStartTime: null, oofEndTime: null });
        expect(bodies[1]).toMatchObject({ version: 1 });
    });

    it("shows an API error message when saving fails", async () => {
        mockShell(mailbox(), (url, init) =>
            url === "/api/mail/mailboxes/mb1" && init?.method === "PUT" ? jsonResponse(500, { message: "boom" }) : undefined,
        );
        const user = userEvent.setup();
        render(<SettingsAutoReplyPage userUid="u1" />);

        await screen.findByRole("checkbox", { name: "Automatic replies are on" });
        await user.click(screen.getByRole("button", { name: "Save" }));

        // A pop-up (see `NotificationCenter`): the server's message under a title saying what failed.
        expect(await screen.findByText("boom")).toBeInTheDocument();
        expect(screen.getByText("Couldn't save the automatic reply settings")).toBeInTheDocument();
        expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
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

        expect(await screen.findByText("Couldn't save the automatic reply settings")).toBeInTheDocument();
        expect(screen.getByText("The server couldn't be reached. Check your connection and try again.")).toBeInTheDocument();
    });
});
