// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import SettingsProfilePageBase from "../../../../apps/www/settings/profile/index.js";
import { withTestRouter } from "../../routerTestUtils.js";
import { getNotificationsSnapshot, resetNotifications } from "../../../../apps/shared/notifications/store.js";

// The Profile page's "Free/busy visibility": who may see when this mailbox is busy.

// Rendered inside a router, as the app's shell does (see routerTestUtils.tsx).
const SettingsProfilePage = withTestRouter(SettingsProfilePageBase);

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    accessRole: "owner" as const,
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "My Mail",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};

const isSave = (url: string, init?: RequestInit) => url === "/api/mail/mailboxes/mb1" && init?.method === "PUT";

function mockShell(saved: Record<string, unknown> = mailbox, onSave?: (body: any) => Response) {
    return mockFetch((url, init) => {
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (isSave(url, init)) {
            const body = JSON.parse(init.body as string);
            return onSave ? onSave(body) : jsonResponse(200, { ...saved, ...body, version: body.version + 1 });
        }
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [saved]);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

function saves(fetchMock: ReturnType<typeof mockFetch>): any[] {
    return fetchMock.mock.calls.filter(([url, init]: any) => isSave(url, init)).map(([, init]: any) => JSON.parse(init.body));
}

beforeEach(() => {
    resetNotifications();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("SettingsProfilePage free/busy visibility", () => {
    it("offers the four choices, by their plain names, and starts on the domain for a mailbox that says none", async () => {
        mockShell();
        render(<SettingsProfilePage userUid="u1" />);

        const select = await screen.findByLabelText("Free/busy visibility");
        expect(select).toHaveValue("domain");
        expect(within(select).getAllByRole("option").map((option) => [option.getAttribute("value"), option.textContent])).toEqual([
            ["domain", "Everyone on my domain"],
            ["shared", "Only people I've shared my calendar with"],
            ["nobody", "Nobody"],
            ["everyone", "Everyone on this server"],
        ]);
        expect(select).toBeEnabled();
        expect(screen.getByText("People with a mailbox on your domain can see when you are busy.")).toBeInTheDocument();
        expect(screen.getByText(/never the title, place or guests of an event/)).toBeInTheDocument();
    });

    it("starts on what the mailbox says, and explains the choice made", async () => {
        mockShell({ ...mailbox, freeBusyVisibility: "shared" });
        const user = userEvent.setup();
        render(<SettingsProfilePage userUid="u1" />);

        const select = await screen.findByLabelText("Free/busy visibility");
        expect(select).toHaveValue("shared");
        expect(screen.getByText("Only people you have given access to this mailbox or its calendars can see when you are busy.")).toBeInTheDocument();
        await user.selectOptions(select, "nobody");
        expect(screen.getByText("Nobody else can see when you are busy; people looking for a time see your availability as hidden.")).toBeInTheDocument();
        await user.selectOptions(select, "everyone");
        expect(screen.getByText("Anyone signed in to this server can see when you are busy.")).toBeInTheDocument();
    });

    it("saves the choice with the mailbox's version, like the neighbouring settings, and says so", async () => {
        const fetchMock = mockShell();
        const user = userEvent.setup();
        render(<SettingsProfilePage userUid="u1" />);

        await user.selectOptions(await screen.findByLabelText("Free/busy visibility"), "nobody");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(saves(fetchMock)).toEqual([{ uid: "mb1", version: 0, freeBusyVisibility: "nobody" }]);
        // Saving it again with nothing changed sends nothing, and the next change carries the version the save returned.
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(saves(fetchMock)).toHaveLength(1);
        await user.selectOptions(screen.getByLabelText("Free/busy visibility"), "everyone");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(saves(fetchMock)).toHaveLength(2));
        expect(saves(fetchMock)[1]).toEqual({ uid: "mb1", version: 1, freeBusyVisibility: "everyone" });
    });

    it("clears the saved message when the choice changes, and sends it together with a changed display name", async () => {
        const fetchMock = mockShell();
        const user = userEvent.setup();
        render(<SettingsProfilePage userUid="u1" />);

        const select = await screen.findByLabelText("Free/busy visibility");
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        await user.selectOptions(select, "shared");
        expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
        await user.clear(screen.getByLabelText("Display name"));
        await user.type(screen.getByLabelText("Display name"), "Jane");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await screen.findByText("Saved.");
        expect(saves(fetchMock)).toEqual([{ uid: "mb1", version: 0, displayName: "Jane", freeBusyVisibility: "shared" }]);
    });

    it("shows the server's refusal as a pop-up, and keeps the choice", async () => {
        mockShell(mailbox, () => jsonResponse(403, { message: "Only the mailbox's owner may change who sees its free/busy." }));
        const user = userEvent.setup();
        render(<SettingsProfilePage userUid="u1" />);

        await user.selectOptions(await screen.findByLabelText("Free/busy visibility"), "nobody");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(getNotificationsSnapshot().visible).toEqual([expect.objectContaining({ kind: "error", title: "Couldn't save your profile" })]));
        expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Free/busy visibility")).toHaveValue("nobody");
    });

    it("is shown but not offered on a mailbox shared with the reader, with why, and never sent", async () => {
        const fetchMock = mockShell({ ...mailbox, accessRole: "delegate", ownerUserUid: "someone-else", freeBusyVisibility: "shared" });
        const user = userEvent.setup();
        render(<SettingsProfilePage userUid="u1" />);

        const select = await screen.findByLabelText("Free/busy visibility");
        expect(select).toBeDisabled();
        expect(select).toHaveValue("shared");
        expect(screen.getByText("This mailbox is shared with you: only its owner can change who sees its free/busy times.")).toBeInTheDocument();

        // Another setting on the page still saves, without touching this one.
        await user.clear(screen.getByLabelText("Display name"));
        await user.type(screen.getByLabelText("Display name"), "Team");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await screen.findByText("Saved.");
        expect(saves(fetchMock)).toEqual([{ uid: "mb1", version: 0, displayName: "Team" }]);
    });
});
