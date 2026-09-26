// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "./testUtils.js";
import { clearMailboxUpdateAccessCache } from "../../apps/shared/mail/useMailboxUpdateAccess.js";
import { getNotificationsSnapshot } from "../../apps/shared/notifications/store.js";
import InboxPageBase from "../../apps/www/index.js";
import { withTestRouter } from "./routerTestUtils.js";

// Delete permanently (Delete on what is already in Deleted Items) and Empty folder, through the mail page: the confirmations, what is sent, what
// the list and the folder's count do afterwards, and what a server that refuses part of it looks like. The server is a stateful stand-in, so a
// reload after a delete shows what is really left. Search, decryption and the reading panes are stood in for as in the other page tests.
// Rendered inside a router, as the app's shell does (see routerTestUtils.tsx).
const InboxPage = withTestRouter(InboxPageBase);

const { searchEncryptedCandidates, getUnlockedKeys, unlockWithPassword, subscribeKeySession, searchLocalIndex, evaluateMessageSecurity } = vi.hoisted(() => ({
    searchEncryptedCandidates: vi.fn(),
    searchLocalIndex: vi.fn(),
    evaluateMessageSecurity: vi.fn(),
    getUnlockedKeys: vi.fn(),
    unlockWithPassword: vi.fn(),
    subscribeKeySession: vi.fn(() => () => undefined),
}));
vi.mock("@rapidmx/react-shared/search/searchTier3.js", () => ({ searchEncryptedCandidates }));
vi.mock("../../apps/shared/search/searchTier2.js", () => ({ searchLocalIndex }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys, unlockWithPassword, subscribeKeySession }));
vi.mock("@rapidmx/react-shared/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity }));
vi.mock("../../apps/shared/components/mail/LazyReadingPane.js", () => ({
    LazyMessageDetailPane: ({ message }: { message: { uid: string } | null }) => <div data-testid="detail-pane">{message ? `message:${message.uid}` : "no-message"}</div>,
    LazyConversationThreadPane: ({ conversation }: { conversation: { conversationId: string } | null }) => (
        <div data-testid="thread-pane">{conversation ? `thread:${conversation.conversationId}` : "no-thread"}</div>
    ),
    prefetchReadingPane: vi.fn(),
}));

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    accessRole: "owner",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "My Mail",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};

const FOLDER_TYPES = [
    ["f1", "Inbox", "inbox"],
    ["f5", "Junk Email", "junk"],
    ["f6", "Deleted Items", "deleted_items"],
] as const;

function message(uid: string, folderUid: string, overrides: Record<string, unknown> = {}) {
    return {
        uid,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid,
        mailboxUid: "mb1",
        messageId: `${uid}@example.com`,
        subject: `Subject ${uid}`,
        from: { address: "sender@example.com", displayName: "Sender One", type: "to" as const },
        recipients: [],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: "2026-01-01T00:00:00.000Z",
        bodyPreview: `Preview of ${uid}`,
        flags: { read: true, flagged: false, answered: false, forwarded: false },
        importance: "normal" as const,
        hasAttachments: false,
        ...overrides,
    };
}

type Fixture = ReturnType<typeof message>;

interface ServerOptions {
    messages: Fixture[];
    /** Messages the server refuses to purge, with its answer. */
    refuse?: Record<string, { status: number; message: string }>;
    /** How the whole-folder request (`DELETE /messages?folderUid=`) is answered instead of emptying the folder. */
    truncate?: { status: number; message: string };
    /** Folder counts to report instead of how many messages the folder really holds. */
    totals?: Record<string, number>;
    /** The mailbox as it is shared with the reader, and what they may do in it. */
    shared?: { canUpdate: boolean };
}

/** A server that keeps the messages it is told to keep and forgets the rest; the folder counts are what it holds. */
function mockServer(options: ServerOptions) {
    const messages = [...options.messages];
    const shared = options.shared;
    const fetchMock = mockFetch((url, init) => {
        const parsed = new URL(url, "http://localhost");
        const path = parsed.pathname;
        const method = init?.method ?? "GET";
        if (path === "/api/mail/mailboxes/auto-provision") return jsonResponse(404, { message: "not enabled" });
        if (path === "/api/mail/mailboxes/mb1/access/me") {
            return jsonResponse(200, { canRead: true, canCreate: false, canUpdate: !!shared?.canUpdate, canDelete: false, canManage: false });
        }
        if (path === "/api/mail/mailboxes") {
            return jsonResponse(200, [shared ? { ...mailbox, ownerUserUid: "someone-else", accessRole: "delegate" } : mailbox]);
        }
        if (path === "/api/mail/folders") {
            return jsonResponse(
                200,
                FOLDER_TYPES.map(([uid, name, type]) => ({
                    uid,
                    version: 0,
                    dateCreated: "2026-01-01T00:00:00.000Z",
                    dateModified: "2026-01-01T00:00:00.000Z",
                    mailboxUid: "mb1",
                    name,
                    type,
                    unreadCount: 0,
                    totalCount: options.totals?.[uid] ?? messages.filter((m) => m.folderUid === uid).length,
                })),
            );
        }
        if (path === "/api/mail/labels") return jsonResponse(200, []);
        if (path === "/api/mail/search") return jsonResponse(200, { results: [] });
        if (path === "/api/mail/attachments") return jsonResponse(200, []);
        if (path === "/api/mail/messages/conversations") {
            const folderUid = parsed.searchParams.get("folderUid");
            const inFolder = messages.filter((m) => m.folderUid === folderUid);
            const ids = [...new Set(inFolder.map((m) => (m as { conversationId?: string }).conversationId ?? m.uid))];
            return jsonResponse(
                200,
                ids.map((id) => {
                    const own = inFolder.filter((m) => ((m as { conversationId?: string }).conversationId ?? m.uid) === id);
                    return {
                        conversationId: id,
                        subject: `Thread ${id}`,
                        messageUids: own.map((m) => m.uid),
                        folderUids: [folderUid],
                        messageCount: own.length,
                        unreadCount: 0,
                        latestDate: "2026-01-01T00:00:00.000Z",
                        participants: [own[0].from],
                        hasAttachments: false,
                        flagged: false,
                        latestMessageUid: own[0].uid,
                        latestFrom: own[0].from,
                        latestPreview: "",
                        latestFolderUid: folderUid,
                    };
                }),
            );
        }
        if (path.startsWith("/api/mail/messages/conversations/")) {
            const id = decodeURIComponent(path.slice("/api/mail/messages/conversations/".length));
            return jsonResponse(200, messages.filter((m) => ((m as { conversationId?: string }).conversationId ?? m.uid) === id));
        }
        const single = path.match(/^\/api\/mail\/messages\/([^/]+)$/);
        if (single && method === "DELETE") {
            const uid = single[1];
            const refused = options.refuse?.[uid];
            if (refused) return jsonResponse(refused.status, { message: refused.message });
            messages.splice(
                messages.findIndex((m) => m.uid === uid),
                1,
            );
            return new Response(null, { status: 204 });
        }
        if (single) {
            const found = messages.find((m) => m.uid === single[1]);
            return found ? jsonResponse(200, found) : jsonResponse(404, { message: "not found" });
        }
        if (path === "/api/mail/messages" && method === "DELETE") {
            if (options.truncate) return jsonResponse(options.truncate.status, { message: options.truncate.message });
            const folderUid = parsed.searchParams.get("folderUid");
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].folderUid === folderUid) messages.splice(i, 1);
            }
            return new Response(null, { status: 204 });
        }
        if (path === "/api/mail/messages" && method === "PUT") {
            const updates = JSON.parse(init.body as string) as Record<string, unknown>[];
            for (const update of updates) {
                Object.assign(messages.find((m) => m.uid === update.uid)!, update);
            }
            return jsonResponse(
                200,
                updates.map((update) => messages.find((m) => m.uid === update.uid)),
            );
        }
        if (path === "/api/mail/messages") {
            const folderUid = parsed.searchParams.get("folderUid");
            return jsonResponse(
                200,
                parsed.searchParams.get("page") === "0" || !parsed.searchParams.has("page") ? messages.filter((m) => m.folderUid === folderUid) : [],
            );
        }
        throw new Error(`unexpected ${method} ${url}`);
    });
    return { fetchMock, messages };
}

function at(search: string) {
    const location = mockLocation();
    (location as unknown as { search: string }).search = search;
}

const inTrash = () => at("?mailboxUid=mb1&folderUid=f6");
const inJunk = () => at("?mailboxUid=mb1&folderUid=f5");

type Fetch = ReturnType<typeof mockFetch>;
const purges = (fetchMock: Fetch) =>
    fetchMock.mock.calls.filter(([url, init]: [string, RequestInit]) => init?.method === "DELETE" && url.includes("purge=true")).map(([url]: [string]) => url);
const emptyRequests = (fetchMock: Fetch) =>
    fetchMock.mock.calls.filter(([url, init]: [string, RequestInit]) => init?.method === "DELETE" && !url.includes("purge=true")).map(([url]: [string]) => url);
const moves = (fetchMock: Fetch) =>
    fetchMock.mock.calls.filter(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT");
const folderListings = (fetchMock: Fetch) => fetchMock.mock.calls.filter(([url]: [string]) => url.startsWith("/api/mail/folders")).length;
const titles = () => getNotificationsSnapshot().visible.map((entry) => entry.title);

/** Turns select mode on and ticks the rows by subject. */
async function tick(user: ReturnType<typeof userEvent.setup>, ...subjects: string[]) {
    await user.click(screen.getByRole("button", { name: "Select" }));
    for (const subject of subjects) {
        await user.click(await screen.findByRole("checkbox", { name: `Select ${subject}` }));
    }
}

const confirmButton = (dialog: HTMLElement, name: string) => within(dialog).getByRole("button", { name });

function flatLists(showAsConversations = false) {
    localStorage.setItem(
        "rapidmx:mail-list-preferences:mb1",
        JSON.stringify({ sortBy: "date", sortOrder: "desc", filter: "all", labelUids: [], showAsConversations }),
    );
}

beforeEach(() => {
    searchEncryptedCandidates.mockResolvedValue([]);
    searchLocalIndex.mockResolvedValue({ results: [], hasMore: false });
    flatLists();
});

afterEach(() => {
    vi.unstubAllGlobals();
    clearMailboxUpdateAccessCache();
    mockLocation();
});

describe("Delete in Deleted Items", () => {
    const three = () => [message("a", "f6"), message("b", "f6"), message("c", "f6")];

    it("says Delete permanently in the selection bar of Deleted Items, held until something is ticked", async () => {
        inTrash();
        mockServer({ messages: three() });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject a");

        await user.click(screen.getByRole("button", { name: "Select" }));

        const remove = await screen.findByRole("button", { name: "Delete permanently" });
        expect(remove).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
        await user.click(await screen.findByRole("checkbox", { name: "Select Subject a" }));
        expect(remove).toBeEnabled();
    });

    it("says plain Delete everywhere else - the Inbox, Junk Email - which still moves to Deleted Items", async () => {
        const { fetchMock } = mockServer({ messages: [message("a", "f1"), message("j", "f5")] });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject a");
        await tick(user, "Subject a");
        expect(screen.queryByRole("button", { name: "Delete permanently" })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Delete" }));

        await waitFor(() => expect(screen.queryByText("Subject a")).not.toBeInTheDocument());
        expect(JSON.parse(moves(fetchMock)[0][1].body as string)).toEqual([{ uid: "a", version: 0, folderUid: "f6" }]);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(purges(fetchMock)).toEqual([]);
    });

    it("keeps Delete a move in Junk Email", async () => {
        inJunk();
        const { fetchMock } = mockServer({ messages: [message("j", "f5")] });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject j");
        await tick(user, "Subject j");

        await user.click(screen.getByRole("button", { name: "Delete" }));

        await waitFor(() => expect(moves(fetchMock)).toHaveLength(1));
        expect(JSON.parse(moves(fetchMock)[0][1].body as string)).toEqual([{ uid: "j", version: 0, folderUid: "f6" }]);
        expect(purges(fetchMock)).toEqual([]);
    });

    it("asks first - and sends nothing when the reader cancels - then deletes the ticked messages for good, with no Undo", async () => {
        inTrash();
        const { fetchMock } = mockServer({ messages: three() });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject a");
        await tick(user, "Subject a", "Subject b");

        await user.click(screen.getByRole("button", { name: "Delete permanently" }));
        const dialog = await screen.findByRole("dialog", { name: "Delete permanently" });
        expect(within(dialog).getByText("Permanently delete 2 messages? This can't be undone.")).toBeInTheDocument();
        await user.click(confirmButton(dialog, "Cancel"));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(purges(fetchMock)).toEqual([]);
        expect(screen.getByText("Subject a")).toBeInTheDocument();
        expect(screen.getByText("2 selected")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Delete permanently" }));
        await user.click(confirmButton(await screen.findByRole("dialog"), "Delete permanently"));

        await waitFor(() => expect(screen.queryByText("Subject a")).not.toBeInTheDocument());
        expect(purges(fetchMock).sort()).toEqual(["/api/mail/messages/a?purge=true", "/api/mail/messages/b?purge=true"]);
        expect(screen.queryByText("Subject b")).not.toBeInTheDocument();
        expect(screen.getByText("Subject c")).toBeInTheDocument();
        // Never a move, and nothing to take back.
        expect(moves(fetchMock)).toEqual([]);
        await waitFor(() => expect(titles()).toContain("2 messages permanently deleted"));
        expect(getNotificationsSnapshot().visible.find((n) => n.title === "2 messages permanently deleted")!.actions).toEqual([]);
        await waitFor(() => expect(screen.getByText("0 selected")).toBeInTheDocument());
    });

    it("reads the folder's count back after the delete, so the count on the list follows", async () => {
        inTrash();
        const { fetchMock } = mockServer({ messages: three() });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject a");
        expect(await screen.findByText("3 items")).toBeInTheDocument();
        const before = folderListings(fetchMock);
        await tick(user, "Subject a");

        await user.click(screen.getByRole("button", { name: "Delete permanently" }));
        await user.click(confirmButton(await screen.findByRole("dialog"), "Delete permanently"));

        await waitFor(() => expect(folderListings(fetchMock)).toBeGreaterThan(before));
        // The count is on the list's own header, which select mode replaces.
        await user.click(await screen.findByRole("button", { name: "Cancel" }));
        expect(await screen.findByText("2 items")).toBeInTheDocument();
    });

    it("reports the message the server refused - a legal hold - beside the ones it deleted, and keeps that one listed", async () => {
        inTrash();
        const hold = "This action is blocked by an active legal hold: matter-1.";
        const { fetchMock } = mockServer({ messages: three(), refuse: { b: { status: 409, message: hold } } });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject a");
        await tick(user, "Subject a", "Subject b");

        await user.click(screen.getByRole("button", { name: "Delete permanently" }));
        await user.click(confirmButton(await screen.findByRole("dialog"), "Delete permanently"));

        await waitFor(() => expect(titles()).toContain("1 deleted, 1 could not be deleted"));
        const entry = getNotificationsSnapshot().visible.find((n) => n.title === "1 deleted, 1 could not be deleted")!;
        expect(entry.message).toBe(hold);
        expect(entry.details).toEqual([`Subject b: ${hold}`]);
        expect(purges(fetchMock)).toHaveLength(2);
        await waitFor(() => expect(screen.queryByText("Subject a")).not.toBeInTheDocument());
        expect(screen.getByText("Subject b")).toBeInTheDocument();
    });

    it("permanently deletes with the Delete key too, and the reading pane closes", async () => {
        inTrash();
        const { fetchMock } = mockServer({ messages: three() });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await user.click(await screen.findByText("Subject b"));
        await waitFor(() => expect(screen.getByTestId("detail-pane")).toHaveTextContent("message:b"));

        expect(fireEvent.keyDown(document.body, { key: "Delete" })).toBe(false);
        await user.click(confirmButton(await screen.findByRole("dialog"), "Delete permanently"));

        await waitFor(() => expect(purges(fetchMock)).toEqual(["/api/mail/messages/b?purge=true"]));
        await waitFor(() => expect(screen.queryByText("Subject b")).not.toBeInTheDocument());
        await waitFor(() => expect(screen.getByTestId("detail-pane")).toHaveTextContent("no-message"));
    });

    it("permanently deletes the open conversation with the Delete key - its messages in Deleted Items - and closes the thread", async () => {
        flatLists(true);
        inTrash();
        const { fetchMock } = mockServer({
            messages: [
                message("t1", "f6", { conversationId: "c1" }),
                message("t2", "f6", { conversationId: "c1" }),
                message("t3", "f1", { conversationId: "c1" }),
                message("other", "f6", { conversationId: "c2" }),
            ],
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await user.click(await screen.findByText("Thread c1"));
        await waitFor(() => expect(screen.getByTestId("thread-pane")).toHaveTextContent("thread:c1"));

        fireEvent.keyDown(document.body, { key: "Delete" });
        const dialog = await screen.findByRole("dialog", { name: "Delete permanently" });
        expect(within(dialog).getByText("Permanently delete 2 messages? This can't be undone.")).toBeInTheDocument();
        await user.click(confirmButton(dialog, "Delete permanently"));

        await waitFor(() => expect(purges(fetchMock).sort()).toEqual(["/api/mail/messages/t1?purge=true", "/api/mail/messages/t2?purge=true"]));
        await waitFor(() => expect(screen.getByTestId("thread-pane")).toHaveTextContent("no-thread"));
        await waitFor(() => expect(screen.queryByText("Thread c1")).not.toBeInTheDocument());
        expect(screen.getByText("Thread c2")).toBeInTheDocument();
    });

    it("permanently deletes a ticked conversation: every message of it in Deleted Items, and only those", async () => {
        flatLists(true);
        inTrash();
        const { fetchMock } = mockServer({
            messages: [
                message("t1", "f6", { conversationId: "c1" }),
                message("t2", "f6", { conversationId: "c1" }),
                message("t3", "f1", { conversationId: "c1" }),
                message("other", "f6", { conversationId: "c2" }),
            ],
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Thread c1");
        await user.click(screen.getByRole("button", { name: "Select" }));
        await user.click(await screen.findByRole("checkbox", { name: "Select conversation: Thread c1" }));
        await screen.findByText("1 conversation selected");

        await user.click(screen.getByRole("button", { name: "Delete permanently" }));
        const dialog = await screen.findByRole("dialog");
        await waitFor(() => expect(within(dialog).getByText("Permanently delete 2 messages? This can't be undone.")).toBeInTheDocument());
        await user.click(confirmButton(dialog, "Delete permanently"));

        await waitFor(() => expect(purges(fetchMock).sort()).toEqual(["/api/mail/messages/t1?purge=true", "/api/mail/messages/t2?purge=true"]));
        await waitFor(() => expect(screen.queryByText("Thread c1")).not.toBeInTheDocument());
        expect(screen.getByText("Thread c2")).toBeInTheDocument();
    });
});

describe("Empty folder", () => {
    const trash = () => [message("a", "f6"), message("b", "f6"), message("c", "f6")];
    const emptyButton = (name = "Empty Deleted Items") => screen.getByRole("button", { name });

    it("is offered at the top of Deleted Items with the count, and asks - naming the count - before emptying anything", async () => {
        inTrash();
        const { fetchMock } = mockServer({ messages: trash() });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject a");
        expect(await screen.findByText("3 items")).toBeInTheDocument();

        await user.click(emptyButton());

        const dialog = await screen.findByRole("dialog", { name: "Empty Deleted Items" });
        expect(within(dialog).getByText("Permanently delete all 3 items in Deleted Items? This can't be undone.")).toBeInTheDocument();
        await user.click(confirmButton(dialog, "Cancel"));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(emptyRequests(fetchMock)).toEqual([]);
        expect(screen.getByText("Subject a")).toBeInTheDocument();
    });

    it("empties the folder in one request, clears the list at once, says how many went, and reads the counts back", async () => {
        inTrash();
        const { fetchMock, messages } = mockServer({ messages: [...trash(), message("keep", "f1")] });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject a");
        await screen.findByText("3 items");
        const before = folderListings(fetchMock);
        await user.click(emptyButton());

        await user.click(confirmButton(await screen.findByRole("dialog"), "Delete all permanently"));

        await waitFor(() => expect(emptyRequests(fetchMock)).toEqual(["/api/mail/messages?folderUid=f6"]));
        await screen.findByText("No messages in this folder.");
        expect(screen.queryByText("Subject a")).not.toBeInTheDocument();
        expect(purges(fetchMock)).toEqual([]);
        // The Inbox was not touched.
        expect(messages.map((m) => m.uid)).toEqual(["keep"]);
        await waitFor(() => expect(titles()).toContain("3 messages permanently deleted"));
        await waitFor(() => expect(folderListings(fetchMock)).toBeGreaterThan(before));
        // Nothing left to empty: the count is gone and the button is held.
        await waitFor(() => expect(emptyButton()).toBeDisabled());
        expect(emptyButton()).toHaveAttribute("title", "This folder is already empty");
        expect(screen.queryByText(/\d+ items?$/)).not.toBeInTheDocument();
    });

    it("is offered for Junk Email too, and not for the Inbox", async () => {
        inJunk();
        const { fetchMock } = mockServer({ messages: [message("j", "f5"), message("k", "f5")] });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject j");
        expect(screen.queryByRole("button", { name: "Empty Deleted Items" })).not.toBeInTheDocument();

        await user.click(emptyButton("Empty Junk Email"));
        const dialog = await screen.findByRole("dialog", { name: "Empty Junk Email" });
        expect(within(dialog).getByText("Permanently delete all 2 items in Junk Email? This can't be undone.")).toBeInTheDocument();
        await user.click(confirmButton(dialog, "Delete all permanently"));

        await waitFor(() => expect(emptyRequests(fetchMock)).toEqual(["/api/mail/messages?folderUid=f5"]));
        await screen.findByText("No messages in this folder.");
    });

    it("is not offered in select mode, or over search results", async () => {
        at("?mailboxUid=mb1&folderUid=f6");
        mockServer({ messages: trash() });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject a");
        expect(emptyButton()).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Select" }));
        await waitFor(() => expect(screen.queryByRole("button", { name: "Empty Deleted Items" })).not.toBeInTheDocument());
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        await screen.findByRole("button", { name: "Empty Deleted Items" });

        await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");
        await waitFor(() => expect(screen.queryByRole("button", { name: "Empty Deleted Items" })).not.toBeInTheDocument());
    });

    it("is not offered in the Inbox", async () => {
        mockServer({ messages: [message("a", "f1")] });
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject a");
        expect(screen.queryByRole("button", { name: /^Empty / })).not.toBeInTheDocument();
    });

    it("is held, with the reason, when there is nothing in the folder", async () => {
        inTrash();
        mockServer({ messages: [message("keep", "f1")] });
        render(<InboxPage userUid="u1" />);
        await screen.findByText("No messages in this folder.");

        expect(emptyButton()).toBeDisabled();
        expect(emptyButton()).toHaveAttribute("title", "This folder is already empty");
    });

    it("is held, with the reason, for a mailbox shared with the reader view-only", async () => {
        inTrash();
        mockServer({ messages: trash(), shared: { canUpdate: false } });
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject a");

        await waitFor(() => expect(emptyButton()).toBeDisabled());
        expect(emptyButton()).toHaveAttribute("title", "This mailbox is shared with you view-only");
    });

    it("says all items when the folder's count is not known", async () => {
        inTrash();
        mockServer({ messages: trash(), totals: { f6: 0 } });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject a");

        await user.click(emptyButton());

        expect(await screen.findByText("Permanently delete all items in Deleted Items? This can't be undone.")).toBeInTheDocument();
    });

    it("deletes message by message when the server refuses the whole folder over a legal hold, and reports the message it kept", async () => {
        inTrash();
        const hold = "This action is blocked by an active legal hold: matter-1.";
        const { fetchMock, messages } = mockServer({
            messages: trash(),
            truncate: { status: 409, message: hold },
            refuse: { b: { status: 409, message: hold } },
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject a");
        await screen.findByText("3 items");
        await user.click(emptyButton());

        await user.click(confirmButton(await screen.findByRole("dialog"), "Delete all permanently"));

        await waitFor(() => expect(titles()).toContain("2 deleted, 1 could not be deleted"));
        expect(purges(fetchMock).sort()).toEqual(["/api/mail/messages/a?purge=true", "/api/mail/messages/b?purge=true", "/api/mail/messages/c?purge=true"]);
        expect(messages.map((m) => m.uid)).toEqual(["b"]);
        await waitFor(() => expect(screen.queryByText("Subject a")).not.toBeInTheDocument());
        expect(screen.getByText("Subject b")).toBeInTheDocument();
        // Something is left, so it can be tried again.
        await waitFor(() => expect(emptyButton()).toBeEnabled());
    });

    it("falls back the same way for a delegate who may delete but not empty a folder, and empties it that way", async () => {
        inTrash();
        const { fetchMock } = mockServer({ messages: trash(), truncate: { status: 403, message: "Forbidden" }, shared: { canUpdate: true } });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject a");
        await waitFor(() => expect(emptyButton()).toBeEnabled());
        await user.click(emptyButton());

        await user.click(confirmButton(await screen.findByRole("dialog"), "Delete all permanently"));

        await waitFor(() => expect(purges(fetchMock)).toHaveLength(3));
        await screen.findByText("No messages in this folder.");
        expect(titles()).toContain("3 messages permanently deleted");
    });

    it("says so when the server fails outright, and lists what is really still there", async () => {
        inTrash();
        mockServer({ messages: trash(), truncate: { status: 500, message: "Internal error" } });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject a");
        await user.click(emptyButton());

        await user.click(confirmButton(await screen.findByRole("dialog"), "Delete all permanently"));

        await waitFor(() => expect(titles()).toContain("Couldn't empty Deleted Items"));
        expect(await screen.findByText("Subject a")).toBeInTheDocument();
        expect(screen.getByText("Subject c")).toBeInTheDocument();
        expect(emptyButton()).toBeEnabled();
    });

    it("empties a folder listed as conversations too, closing the open thread", async () => {
        flatLists(true);
        inTrash();
        const { fetchMock } = mockServer({
            messages: [message("t1", "f6", { conversationId: "c1" }), message("t2", "f6", { conversationId: "c1" }), message("o", "f6", { conversationId: "c2" })],
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await user.click(await screen.findByText("Thread c1"));
        await waitFor(() => expect(screen.getByTestId("thread-pane")).toHaveTextContent("thread:c1"));
        await user.click(emptyButton());

        await user.click(confirmButton(await screen.findByRole("dialog"), "Delete all permanently"));

        await waitFor(() => expect(emptyRequests(fetchMock)).toEqual(["/api/mail/messages?folderUid=f6"]));
        await screen.findByText("No conversations in this folder.");
        await waitFor(() => expect(screen.getByTestId("thread-pane")).toHaveTextContent("no-thread"));
    });
});
