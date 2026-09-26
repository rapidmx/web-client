// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import SettingsBlockedSendersPageBase from "../../../../apps/www/settings/blocked-senders/index.js";
import { withTestRouter } from "../../routerTestUtils.js";
import { clearMailboxUpdateAccessCache } from "../../../../apps/shared/mail/useMailboxUpdateAccess.js";
import { getNotificationsSnapshot } from "../../../../apps/shared/notifications/store.js";

// Rendered inside a router, as the app's shell does (see routerTestUtils.tsx).
const SettingsBlockedSendersPage = withTestRouter(SettingsBlockedSendersPageBase);

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    accessRole: "owner",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: ["me@example.com"],
    displayName: "My Mail",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
    blockedSenders: ["spam@bad.example", "@junk.example"],
    safeSenders: ["friend@good.example"],
};

type Extra = (url: string, init?: RequestInit) => Response | undefined;

function mockShell(mailboxes: Record<string, unknown>[] = [mailbox], extra?: Extra) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes?")) return jsonResponse(200, mailboxes);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

const change = (blockedSenders: string[], safeSenders: string[], entry = "x", changed = true) => jsonResponse(200, { entry, changed, blockedSenders, safeSenders });

const section = async (name: string) => within(await screen.findByRole("region", { name }));

afterEach(() => {
    clearMailboxUpdateAccessCache();
    vi.unstubAllGlobals();
});

describe("SettingsBlockedSendersPage", () => {
    it("lists both lists of the selected mailbox, domains first, with their counts and what a domain covers", async () => {
        mockShell();
        render(<SettingsBlockedSendersPage userUid="u1" />);

        const blocked = await section("Blocked senders");
        const entries = within(blocked.getByRole("list", { name: "Blocked senders" })).getAllByRole("listitem");
        expect(entries.map((item) => item.textContent)).toEqual(["@junk.exampleEveryone at junk.exampleRemove", "spam@bad.exampleRemove"]);
        expect(blocked.getByText("2 of 1,000")).toBeInTheDocument();
        const safe = await section("Safe senders");
        expect(safe.getByText("friend@good.example")).toBeInTheDocument();
        expect(safe.getByText("1 of 1,000")).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 1, name: "Blocked and safe senders" })).toBeInTheDocument();
        expect(screen.getByText("My Mail")).toBeInTheDocument();
        // Its own settings entry, next to Mail Filters.
        expect(screen.getAllByRole("link", { name: "Blocked & Safe Senders" })[0]).toHaveAttribute("href", "/settings/blocked-senders?mailboxUid=mb1");
    });

    it("says so for a list with nothing on it, and reads a mailbox from before the lists as empty ones", async () => {
        mockShell([{ ...mailbox, blockedSenders: [], safeSenders: undefined }]);
        render(<SettingsBlockedSendersPage userUid="u1" />);
        expect(await (await section("Blocked senders")).findByText("No blocked senders.")).toBeInTheDocument();
        expect((await section("Safe senders")).getByText("No safe senders.")).toBeInTheDocument();
    });

    it("says a server without the lists cannot do this yet, and offers no forms", async () => {
        const { blockedSenders, safeSenders, ...old } = mailbox;
        mockShell([old]);
        render(<SettingsBlockedSendersPage userUid="u1" />);
        expect(await screen.findByText("This server does not support blocked and safe senders yet.")).toBeInTheDocument();
        expect(screen.queryByRole("region", { name: "Blocked senders" })).not.toBeInTheDocument();
    });

    it("blocks an address: the server's answer is the new list, the field is emptied, and a status says what was done", async () => {
        const fetchMock = mockShell([mailbox], (url, init) =>
            url === "/api/mail/mailboxes/mb1/blocked-senders" && init?.method === "POST"
                ? change(["new@bad.example", "spam@bad.example", "@junk.example"], ["friend@good.example"], "new@bad.example")
                : undefined,
        );
        const user = userEvent.setup();
        render(<SettingsBlockedSendersPage userUid="u1" />);
        const blocked = await section("Blocked senders");

        await user.type(await blocked.findByLabelText("Add a blocked sender"), "  New@Bad.Example ");
        await user.click(blocked.getByRole("button", { name: "Block" }));

        await waitFor(() => expect(blocked.getByText("3 of 1,000")).toBeInTheDocument());
        const post = fetchMock.mock.calls.find(([url, init]) => url === "/api/mail/mailboxes/mb1/blocked-senders" && init?.method === "POST")!;
        expect(JSON.parse(post[1].body as string)).toEqual({ entry: "new@bad.example" });
        expect(blocked.getByText("new@bad.example")).toBeInTheDocument();
        expect(blocked.getByLabelText("Add a blocked sender")).toHaveValue("");
        expect(blocked.getByRole("status")).toHaveTextContent("Blocked new@bad.example.");
    });

    it("takes a domain typed as example.com as the entry @example.com, and submits with Enter", async () => {
        const fetchMock = mockShell([mailbox], (url, init) =>
            url === "/api/mail/mailboxes/mb1/safe-senders" && init?.method === "POST" ? change([], ["@example.org", "friend@good.example"], "@example.org") : undefined,
        );
        const user = userEvent.setup();
        render(<SettingsBlockedSendersPage userUid="u1" />);
        const safe = await section("Safe senders");

        await user.type(await safe.findByLabelText("Add a safe sender"), "Example.org{Enter}");

        await waitFor(() => expect(safe.getByText("@example.org")).toBeInTheDocument());
        const post = fetchMock.mock.calls.find(([url, init]) => url === "/api/mail/mailboxes/mb1/safe-senders" && init?.method === "POST")!;
        expect(JSON.parse(post[1].body as string)).toEqual({ entry: "@example.org" });
        expect(safe.getByRole("status")).toHaveTextContent("Trusted @example.org.");
        // Adding it to Safe senders took it off Blocked senders (the answer carries both lists).
        expect((await section("Blocked senders")).getByText("0 of 1,000")).toBeInTheDocument();
    });

    it("explains an entry that moved from the other list", async () => {
        mockShell([mailbox], (url, init) =>
            url === "/api/mail/mailboxes/mb1/blocked-senders" && init?.method === "POST"
                ? change(["friend@good.example", "spam@bad.example", "@junk.example"], [], "friend@good.example")
                : undefined,
        );
        const user = userEvent.setup();
        render(<SettingsBlockedSendersPage userUid="u1" />);
        const blocked = await section("Blocked senders");
        await user.type(await blocked.findByLabelText("Add a blocked sender"), "friend@good.example");
        await user.click(blocked.getByRole("button", { name: "Block" }));
        await waitFor(() => expect(blocked.getByRole("status")).toHaveTextContent("Blocked friend@good.example. It was on your safe senders and was moved here."));
        expect((await section("Safe senders")).getByText("No safe senders.")).toBeInTheDocument();
    });

    it("says an entry is already on the list when the server changed nothing", async () => {
        mockShell([mailbox], (url, init) =>
            url === "/api/mail/mailboxes/mb1/blocked-senders" && init?.method === "POST" ? change(mailbox.blockedSenders, mailbox.safeSenders, "spam@bad.example", false) : undefined,
        );
        const user = userEvent.setup();
        render(<SettingsBlockedSendersPage userUid="u1" />);
        const blocked = await section("Blocked senders");
        await user.type(await blocked.findByLabelText("Add a blocked sender"), "spam@bad.example");
        await user.click(blocked.getByRole("button", { name: "Block" }));
        await waitFor(() => expect(blocked.getByRole("status")).toHaveTextContent("spam@bad.example is already on this list."));
    });

    it.each([
        ["", "Type an email address"],
        ["ann <ann@example.com>", "without a name or angle brackets"],
        ["ann@example.com bob@example.com", "one address or domain at a time"],
        ["localhost", "not a domain"],
        ["a@@b", "not an email address"],
    ])("explains what is wrong with %j, sends nothing, and clears the message as soon as the reader types again", async (typed, message) => {
        const fetchMock = mockShell();
        const user = userEvent.setup();
        render(<SettingsBlockedSendersPage userUid="u1" />);
        const blocked = await section("Blocked senders");
        const field = await blocked.findByLabelText("Add a blocked sender");

        if (typed) {
            await user.type(field, typed);
        }
        await user.click(blocked.getByRole("button", { name: "Block" }));

        const alert = await blocked.findByRole("alert");
        expect(alert).toHaveTextContent(message);
        expect(field).toHaveAttribute("aria-invalid", "true");
        expect(field.getAttribute("aria-describedby")).toContain(alert.id);
        expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes("-senders") && init?.method === "POST")).toBe(false);
        await user.type(field, "x");
        expect(blocked.queryByRole("alert")).not.toBeInTheDocument();
        expect(field).not.toHaveAttribute("aria-invalid");
    });

    it("does not let the reader block their own address or alias, but lets them trust it", async () => {
        const fetchMock = mockShell([mailbox], (url, init) =>
            url === "/api/mail/mailboxes/mb1/safe-senders" && init?.method === "POST" ? change([], ["me@example.com"], "me@example.com") : undefined,
        );
        const user = userEvent.setup();
        render(<SettingsBlockedSendersPage userUid="u1" />);
        const blocked = await section("Blocked senders");
        await user.type(await blocked.findByLabelText("Add a blocked sender"), "ME@example.com");
        await user.click(blocked.getByRole("button", { name: "Block" }));
        expect(await blocked.findByRole("alert")).toHaveTextContent("That is one of your own addresses");
        expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes("blocked-senders") && init?.method === "POST")).toBe(false);

        const safe = await section("Safe senders");
        await user.type(safe.getByLabelText("Add a safe sender"), "me@example.com");
        await user.click(safe.getByRole("button", { name: "Trust" }));
        await waitFor(() => expect(safe.getByText("me@example.com")).toBeInTheDocument());
    });

    it("knows the addresses of every mailbox the reader has, and copes with one that lists no aliases", async () => {
        const { aliasAddresses, ...bare } = mailbox;
        mockShell([mailbox, { ...bare, uid: "mb2", displayName: "Other", primarySmtpAddress: "other@example.com" }]);
        const user = userEvent.setup();
        render(<SettingsBlockedSendersPage userUid="u1" />);
        const blocked = await section("Blocked senders");
        await user.type(await blocked.findByLabelText("Add a blocked sender"), "other@example.com");
        await user.click(blocked.getByRole("button", { name: "Block" }));
        expect(await blocked.findByRole("alert")).toHaveTextContent("That is one of your own addresses");
    });

    it("removes an entry with its own button, sends the entry URL-encoded, and puts the focus on the list's heading", async () => {
        const fetchMock = mockShell([mailbox], (url, init) =>
            url === "/api/mail/mailboxes/mb1/blocked-senders/%40junk.example" && init?.method === "DELETE"
                ? change(["spam@bad.example"], ["friend@good.example"], "@junk.example")
                : undefined,
        );
        const user = userEvent.setup();
        render(<SettingsBlockedSendersPage userUid="u1" />);
        const blocked = await section("Blocked senders");

        await user.click(await blocked.findByRole("button", { name: "Remove @junk.example from blocked senders" }));

        await waitFor(() => expect(blocked.queryByText("@junk.example")).not.toBeInTheDocument());
        expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/mail/mailboxes/mb1/blocked-senders/%40junk.example" && init?.method === "DELETE")).toBe(true);
        expect(blocked.getByText("1 of 1,000")).toBeInTheDocument();
        expect(blocked.getByRole("status")).toHaveTextContent("Removed @junk.example.");
        expect(blocked.getByRole("heading", { name: "Blocked senders" })).toHaveFocus();
    });

    it("removes a safe sender", async () => {
        mockShell([mailbox], (url, init) =>
            url === "/api/mail/mailboxes/mb1/safe-senders/friend%40good.example" && init?.method === "DELETE" ? change(mailbox.blockedSenders, [], "friend@good.example") : undefined,
        );
        const user = userEvent.setup();
        render(<SettingsBlockedSendersPage userUid="u1" />);
        const safe = await section("Safe senders");
        await user.click(await safe.findByRole("button", { name: "Remove friend@good.example from safe senders" }));
        await waitFor(() => expect(safe.getByText("No safe senders.")).toBeInTheDocument());
    });

    it.each([
        ["blocking", "Blocked senders", "Add a blocked sender", "Block", "Couldn't block this sender"],
        ["trusting", "Safe senders", "Add a safe sender", "Trust", "Couldn't add this safe sender"],
    ])("keeps the list and shows the server's own words when %s is refused", async (_what, name, label, button, title) => {
        mockShell([mailbox], (url, init) =>
            init?.method === "POST" && url.includes("-senders") ? jsonResponse(403, { message: "Only the mailbox's owner can change its blocked and safe senders." }) : undefined,
        );
        const user = userEvent.setup();
        render(<SettingsBlockedSendersPage userUid="u1" />);
        const list = await section(name);
        await user.type(await list.findByLabelText(label), "ann@example.com");
        await user.click(list.getByRole("button", { name: button }));
        await waitFor(() => expect(getNotificationsSnapshot().visible.map((popup) => popup.title)).toContain(title));
        expect(getNotificationsSnapshot().visible.find((popup) => popup.title === title)!.message).toContain("Only the mailbox's owner");
        // What was typed stays, to try again; the list is what it was.
        expect(list.getByLabelText(label)).toHaveValue("ann@example.com");
        expect(list.queryByRole("status")).toHaveTextContent("");
        await waitFor(() => expect(list.getByRole("button", { name: button })).toBeEnabled());
    });

    it.each([
        ["Blocked senders", "Remove spam@bad.example from blocked senders", "Couldn't unblock this sender"],
        ["Safe senders", "Remove friend@good.example from safe senders", "Couldn't remove this safe sender"],
    ])("says what could not be removed from %s", async (name, button, title) => {
        mockShell([mailbox], (url, init) => (init?.method === "DELETE" ? jsonResponse(500, { message: "boom" }) : undefined));
        const user = userEvent.setup();
        render(<SettingsBlockedSendersPage userUid="u1" />);
        const list = await section(name);
        await user.click(await list.findByRole("button", { name: button }));
        await waitFor(() => expect(getNotificationsSnapshot().visible.map((popup) => popup.title)).toContain(title));
        expect(list.getByRole("button", { name: button })).toBeInTheDocument();
    });

    it("stops taking entries at the 1,000-entry cap and says so, while still listing and removing", async () => {
        const many = Array.from({ length: 1000 }, (_, i) => `u${i}@bad.example`);
        mockShell([{ ...mailbox, blockedSenders: many }]);
        render(<SettingsBlockedSendersPage userUid="u1" />);
        const blocked = await section("Blocked senders");
        expect(await blocked.findByText("1,000 of 1,000")).toBeInTheDocument();
        expect(blocked.getByLabelText("Add a blocked sender")).toBeDisabled();
        expect(blocked.getByRole("button", { name: "Block" })).toBeDisabled();
        expect(blocked.getByText("This list is full: it holds 1,000 senders. Remove one to add another.")).toBeInTheDocument();
        expect(blocked.getByRole("button", { name: "Remove u0@bad.example from blocked senders" })).toBeEnabled();
        // The other list has room.
        expect((await section("Safe senders")).getByLabelText("Add a safe sender")).toBeEnabled();
    });

    it("holds the forms while a change is on the wire", async () => {
        let answer: (response: Response) => void = () => undefined;
        mockShell([mailbox], (url, init) => (init?.method === "POST" && url.includes("-senders") ? ((new Promise((resolve) => (answer = resolve)) as unknown) as Response) : undefined));
        const user = userEvent.setup();
        render(<SettingsBlockedSendersPage userUid="u1" />);
        const blocked = await section("Blocked senders");
        await user.type(await blocked.findByLabelText("Add a blocked sender"), "ann@example.com");
        await user.click(blocked.getByRole("button", { name: "Block" }));
        await waitFor(() => expect(blocked.getByLabelText("Add a blocked sender")).toBeDisabled());
        expect(blocked.getByRole("button", { name: /Remove spam@bad.example/ })).toBeDisabled();
        answer(jsonResponse(200, { entry: "ann@example.com", changed: true, blockedSenders: ["ann@example.com"], safeSenders: [] }));
        await waitFor(() => expect(blocked.getByLabelText("Add a blocked sender")).toBeEnabled());
    });

    describe("in a mailbox shared with the reader", () => {
        const shared = { ...mailbox, uid: "mb1", accessRole: "delegate", ownerUserUid: "u2" };
        const access = (canUpdate: boolean): Extra => (url) =>
            url === "/api/mail/mailboxes/mb1/access/me" ? jsonResponse(200, { canRead: true, canCreate: false, canUpdate, canDelete: false, canManage: false }) : undefined;

        it("shows the lists read-only, saying why, to a reader with view-only access", async () => {
            mockShell([shared], access(false));
            render(<SettingsBlockedSendersPage userUid="u1" />);
            expect(await screen.findByText("You have view-only access to this mailbox, so you can see these lists but not change them.")).toBeInTheDocument();
            const blocked = await section("Blocked senders");
            expect(blocked.getByText("spam@bad.example")).toBeInTheDocument();
            expect(blocked.queryByLabelText("Add a blocked sender")).not.toBeInTheDocument();
            expect(blocked.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
            expect((await section("Safe senders")).queryByRole("button", { name: "Trust" })).not.toBeInTheDocument();
        });

        it("offers the forms to a reader who may update it, and says only its owner or someone with full access can change the lists", async () => {
            mockShell([shared], access(true));
            render(<SettingsBlockedSendersPage userUid="u1" />);
            const blocked = await section("Blocked senders");
            expect(await blocked.findByLabelText("Add a blocked sender")).toBeEnabled();
            expect(screen.getByText(/Only this mailbox’s owner, or someone with full access to it, can change these lists/)).toBeInTheDocument();
            expect(screen.queryByText(/view-only access/)).not.toBeInTheDocument();
        });

        it("does not say that of the reader's own mailbox", async () => {
            mockShell();
            render(<SettingsBlockedSendersPage userUid="u1" />);
            await section("Blocked senders");
            expect(screen.queryByText(/someone with full access/)).not.toBeInTheDocument();
            expect(screen.queryByText(/view-only access/)).not.toBeInTheDocument();
        });
    });
});
