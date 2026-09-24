// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import SettingsProfilePageRouted from "../../../../apps/www/settings/profile/index.js";

// The device's zone, fixed so the tests don't depend on the machine they run on.
const device = vi.hoisted(() => ({ zone: "Asia/Tokyo" }));
vi.mock("@rapidmx/react-shared/util/timeZone.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/util/timeZone.js")>()),
    deviceTimeZone: () => device.zone,
}));

// The page's own component: what a test renders is the page, not the client-side router around it (see `routedPage()`).
const SettingsProfilePage = SettingsProfilePageRouted.page;

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "My Mail",
    timezone: "Europe/Paris",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};

const isSave = (url: string, init?: RequestInit) => url === "/api/mail/mailboxes/mb1" && init?.method === "PUT";

/** Serves `saved` as the caller's only mailbox; a save answers with `onSave`'s result (default: the mailbox with its version bumped). */
function mockShell(saved = mailbox, onSave?: (body: any) => Response) {
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

/** The bodies of every save the page sent. */
function saves(fetchMock: ReturnType<typeof mockFetch>): any[] {
    return fetchMock.mock.calls.filter(([url, init]: any) => isSave(url, init)).map(([, init]: any) => JSON.parse(init.body));
}

beforeEach(() => {
    device.zone = "Asia/Tokyo";
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("SettingsProfilePage", () => {
    it("seeds the display name and time zone from the mailbox", async () => {
        mockShell();
        render(<SettingsProfilePage userUid="u1" />);

        expect(await screen.findByLabelText("Display name")).toHaveValue("My Mail");
        expect(screen.getByLabelText("Time zone")).toHaveValue("Europe/Paris");
        expect(screen.queryByText(/no time zone chosen yet/)).not.toBeInTheDocument();
        // Says what each is for.
        expect(screen.getByText(/The sender name on mail you send/)).toBeInTheDocument();
        expect(screen.getByText(/How calendar times and reminders are shown and scheduled/)).toBeInTheDocument();
    });

    describe("time zone", () => {
        it("starts on the device's zone, with a note, when the mailbox still has the server's placeholder UTC", async () => {
            mockShell({ ...mailbox, timezone: "UTC" });
            render(<SettingsProfilePage userUid="u1" />);

            expect(await screen.findByLabelText("Time zone")).toHaveValue("Asia/Tokyo");
            expect(screen.getByText(/Your mailbox has no time zone chosen yet; this device.s is preselected/)).toBeInTheDocument();
            // Already the device's zone: nothing to offer.
            expect(screen.queryByRole("button", { name: /Use this device/ })).not.toBeInTheDocument();
        });

        it("saves the preselected device zone, and only that, when Save is pressed - and drops the note", async () => {
            const fetchMock = mockShell({ ...mailbox, timezone: "UTC" });
            const user = userEvent.setup();
            render(<SettingsProfilePage userUid="u1" />);
            await screen.findByLabelText("Time zone");

            // Unsaved until Save.
            expect(saves(fetchMock)).toEqual([]);
            await user.click(screen.getByRole("button", { name: "Save" }));

            expect(await screen.findByText("Saved.")).toBeInTheDocument();
            expect(saves(fetchMock)).toEqual([{ uid: "mb1", version: 0, timezone: "Asia/Tokyo" }]);
            expect(screen.queryByText(/no time zone chosen yet/)).not.toBeInTheDocument();
        });

        it("keeps UTC when the device is on UTC too", async () => {
            device.zone = "UTC";
            mockShell({ ...mailbox, timezone: "UTC" });
            render(<SettingsProfilePage userUid="u1" />);

            expect(await screen.findByLabelText("Time zone")).toHaveValue("UTC");
            expect(screen.queryByText(/no time zone chosen yet/)).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: /Use this device/ })).not.toBeInTheDocument();
        });

        it("keeps a zone that was chosen, even when it differs from the device's", async () => {
            mockShell();
            render(<SettingsProfilePage userUid="u1" />);

            expect(await screen.findByLabelText("Time zone")).toHaveValue("Europe/Paris");
        });

        it("offers to use the device's zone whenever the selection differs, and hides that once it is selected", async () => {
            mockShell();
            const user = userEvent.setup();
            render(<SettingsProfilePage userUid="u1" />);
            await screen.findByLabelText("Time zone");

            await user.click(screen.getByRole("button", { name: "Use this device’s time zone (Asia/Tokyo)" }));
            expect(screen.getByLabelText("Time zone")).toHaveValue("Asia/Tokyo");
            expect(screen.queryByRole("button", { name: /Use this device/ })).not.toBeInTheDocument();

            await user.selectOptions(screen.getByLabelText("Time zone"), "America/New_York");
            expect(screen.getByRole("button", { name: /Use this device/ })).toBeInTheDocument();
        });

        it("lists a saved zone this browser doesn't know, so the select can show it", async () => {
            mockShell({ ...mailbox, timezone: "Mars/Olympus_Mons" });
            render(<SettingsProfilePage userUid="u1" />);

            expect(await screen.findByLabelText("Time zone")).toHaveValue("Mars/Olympus_Mons");
        });
    });

    describe("display name validation", () => {
        async function submitWith(name: string) {
            const fetchMock = mockShell();
            const user = userEvent.setup();
            render(<SettingsProfilePage userUid="u1" />);
            const input = await screen.findByLabelText("Display name");
            await user.clear(input);
            if (name) {
                await user.click(input);
                await user.paste(name);
            }
            await user.click(screen.getByRole("button", { name: "Save" }));
            return { fetchMock, user, input };
        }

        it.each([
            ["is empty", ""],
            ["is only spaces", "   "],
        ])("refuses a name that %s, beside the field, and sends nothing", async (_label, name) => {
            const { fetchMock } = await submitWith(name);

            expect(await screen.findByText("Enter a display name.")).toBeInTheDocument();
            expect(screen.getByLabelText("Display name")).toHaveAttribute("aria-invalid", "true");
            expect(saves(fetchMock)).toEqual([]);
            expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
        });

        it.each([
            ["an @", "jane@example.com"],
            ["a fullwidth @", "jane＠example.com"],
            ["a small @", "jane﹫example.com"],
        ])("refuses a name with %s, without sending", async (_label, name) => {
            const { fetchMock } = await submitWith(name);

            expect(await screen.findByText(/can't contain "@"/)).toBeInTheDocument();
            expect(saves(fetchMock)).toEqual([]);
        });

        it("refuses a name longer than 255 characters, and accepts exactly 255", async () => {
            const { fetchMock, user } = await submitWith("x".repeat(256));
            expect(await screen.findByText("A display name can be at most 255 characters.")).toBeInTheDocument();
            expect(saves(fetchMock)).toEqual([]);

            const input = screen.getByLabelText("Display name");
            await user.clear(input);
            await user.click(input);
            await user.paste("x".repeat(255));
            await user.click(screen.getByRole("button", { name: "Save" }));
            expect(await screen.findByText("Saved.")).toBeInTheDocument();
            expect(saves(fetchMock)).toHaveLength(1);
        });

        it("takes the message away as soon as the name is edited", async () => {
            const { user, input } = await submitWith("");
            await screen.findByText("Enter a display name.");

            await user.type(input, "Jane");
            expect(screen.queryByText("Enter a display name.")).not.toBeInTheDocument();
            expect(input).not.toHaveAttribute("aria-invalid");
        });
    });

    describe("saving", () => {
        it("sends only the display name when only it changed, trimmed, with the mailbox's version", async () => {
            const fetchMock = mockShell();
            const user = userEvent.setup();
            render(<SettingsProfilePage userUid="u1" />);
            const input = await screen.findByLabelText("Display name");

            await user.clear(input);
            await user.type(input, "  Jane Doe  ");
            await user.click(screen.getByRole("button", { name: "Save" }));

            expect(await screen.findByText("Saved.")).toBeInTheDocument();
            expect(saves(fetchMock)).toEqual([{ uid: "mb1", version: 0, displayName: "Jane Doe" }]);
            expect(input).toHaveValue("Jane Doe");
        });

        it("sends only the time zone when only it changed", async () => {
            const fetchMock = mockShell();
            const user = userEvent.setup();
            render(<SettingsProfilePage userUid="u1" />);
            await screen.findByLabelText("Time zone");

            await user.selectOptions(screen.getByLabelText("Time zone"), "America/New_York");
            await user.click(screen.getByRole("button", { name: "Save" }));

            expect(await screen.findByText("Saved.")).toBeInTheDocument();
            expect(saves(fetchMock)).toEqual([{ uid: "mb1", version: 0, timezone: "America/New_York" }]);
        });

        it("sends both when both changed", async () => {
            const fetchMock = mockShell();
            const user = userEvent.setup();
            render(<SettingsProfilePage userUid="u1" />);
            const input = await screen.findByLabelText("Display name");

            await user.clear(input);
            await user.type(input, "Jane");
            await user.click(screen.getByRole("button", { name: /Use this device/ }));
            await user.click(screen.getByRole("button", { name: "Save" }));

            expect(await screen.findByText("Saved.")).toBeInTheDocument();
            expect(saves(fetchMock)).toEqual([{ uid: "mb1", version: 0, displayName: "Jane", timezone: "Asia/Tokyo" }]);
        });

        it("sends nothing when nothing changed, and just says Saved.", async () => {
            const fetchMock = mockShell();
            const user = userEvent.setup();
            render(<SettingsProfilePage userUid="u1" />);
            await screen.findByLabelText("Display name");

            await user.click(screen.getByRole("button", { name: "Save" }));

            expect(await screen.findByText("Saved.")).toBeInTheDocument();
            expect(saves(fetchMock)).toEqual([]);
        });

        it("measures changes against what was last saved, and sends the version the previous save returned", async () => {
            const fetchMock = mockShell();
            const user = userEvent.setup();
            render(<SettingsProfilePage userUid="u1" />);
            const input = await screen.findByLabelText("Display name");

            await user.clear(input);
            await user.type(input, "Jane");
            await user.click(screen.getByRole("button", { name: "Save" }));
            await screen.findByText("Saved.");

            // Saved already: pressing Save again sends nothing.
            await user.click(screen.getByRole("button", { name: "Save" }));
            expect(saves(fetchMock)).toHaveLength(1);

            await user.selectOptions(screen.getByLabelText("Time zone"), "America/New_York");
            await user.click(screen.getByRole("button", { name: "Save" }));
            await vi.waitFor(() => expect(saves(fetchMock)).toHaveLength(2));
            expect(saves(fetchMock)).toEqual([
                { uid: "mb1", version: 0, displayName: "Jane" },
                { uid: "mb1", version: 1, timezone: "America/New_York" },
            ]);
        });

        it("hides Saved. again once anything is edited", async () => {
            mockShell();
            const user = userEvent.setup();
            render(<SettingsProfilePage userUid="u1" />);
            await screen.findByLabelText("Display name");
            await user.click(screen.getByRole("button", { name: "Save" }));
            await screen.findByText("Saved.");

            await user.type(screen.getByLabelText("Display name"), "!");
            expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
        });

        it("shows the error pop-up, and not Saved., when the server refuses", async () => {
            mockShell(mailbox, () => jsonResponse(400, { message: "boom" }));
            const user = userEvent.setup();
            render(<SettingsProfilePage userUid="u1" />);
            const input = await screen.findByLabelText("Display name");

            await user.clear(input);
            await user.type(input, "Jane");
            await user.click(screen.getByRole("button", { name: "Save" }));

            // A pop-up (see `NotificationCenter`): the server's message under a title saying what failed.
            expect(await screen.findByText("boom")).toBeInTheDocument();
            expect(screen.getByText("Couldn't save your profile")).toBeInTheDocument();
            expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
        });

        it("keeps the edit unsaved after a failure, so the next Save sends it again with the same version", async () => {
            let fail = true;
            const fetchMock = mockShell(mailbox, (body) =>
                fail ? jsonResponse(500, { message: "boom" }) : jsonResponse(200, { ...mailbox, ...body, version: body.version + 1 }),
            );
            const user = userEvent.setup();
            render(<SettingsProfilePage userUid="u1" />);
            const input = await screen.findByLabelText("Display name");

            await user.clear(input);
            await user.type(input, "Jane");
            await user.click(screen.getByRole("button", { name: "Save" }));
            await screen.findByText("boom");

            fail = false;
            await user.click(screen.getByRole("button", { name: "Save" }));
            expect(await screen.findByText("Saved.")).toBeInTheDocument();
            expect(saves(fetchMock)).toEqual([
                { uid: "mb1", version: 0, displayName: "Jane" },
                { uid: "mb1", version: 0, displayName: "Jane" },
            ]);
        });

        it("shows a generic error message when saving fails with a non-API error", async () => {
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (isSave(url, init)) throw new TypeError("network down");
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<SettingsProfilePage userUid="u1" />);
            const input = await screen.findByLabelText("Display name");

            await user.clear(input);
            await user.type(input, "Jane");
            await user.click(screen.getByRole("button", { name: "Save" }));

            expect(await screen.findByText("Couldn't save your profile")).toBeInTheDocument();
            expect(screen.getByText("The server couldn't be reached. Check your connection and try again.")).toBeInTheDocument();
        });
    });
});
