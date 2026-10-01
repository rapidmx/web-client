// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// How the mail list copes with a server that is partly unwell or a list that changes under it: the "All mailboxes" views when one mailbox fails to
// answer a refresh, the conversations behind a "Select all" (a few requests at a time, a stale run dropped, one failure leaving the rest ticked, a
// reply that arrives while ticked), and what "Empty folder" says it is about to delete in the "All mailboxes" views.
import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "./testUtils.js";
import InboxPageBase from "../../apps/www/index.js";
import { withTestRouter } from "./routerTestUtils.js";
import { clearListSnapshots } from "../../apps/shared/mail/listSnapshots.js";
import { getNotificationsSnapshot } from "../../apps/shared/notifications/store.js";

// Rendered inside a router, as the app's shell does (see routerTestUtils.tsx).
const InboxPage = withTestRouter(InboxPageBase);

vi.mock("../../lib/crypto/keySession.js", () => ({
    getUnlockedKeys: vi.fn().mockReturnValue(undefined),
    unlockWithPassword: vi.fn(),
    subscribeKeySession: vi.fn(() => () => undefined),
}));
vi.mock("../../apps/shared/search/searchTier2.js", () => ({ searchLocalIndex: vi.fn().mockResolvedValue({ results: [] }) }));
vi.mock("../../apps/shared/components/mail/LazyReadingPane.js", () => ({
    LazyMessageDetailPane: () => <div data-testid="detail-pane" />,
    LazyConversationThreadPane: () => <div data-testid="thread-pane" />,
    prefetchReadingPane: vi.fn(),
}));
vi.mock("../../apps/shared/components/mail/compose/ComposeContext.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../apps/shared/components/mail/compose/ComposeContext.js")>()),
    prefetchComposeWindow: vi.fn(),
}));
vi.mock("@rapidrest/react/client", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidrest/react/client")>()),
    whenIdle: vi.fn(() => () => undefined),
}));

const mailbox = {
    uid: "mb1",
    version: 0,
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "My Mail",
    timezone: "UTC",
};
const sharedMailbox = { ...mailbox, uid: "mb2", ownerUserUid: undefined, displayName: "Support", primarySmtpAddress: "support@example.com" };
const folder = (uid: string, mailboxUid: string, name: string, type: string, totalCount = 0) => ({
    uid,
    version: 0,
    mailboxUid,
    name,
    type,
    unreadCount: 0,
    totalCount,
    syncKeyVersion: 0,
});
const FOLDERS: Record<string, unknown[]> = {
    mb1: [folder("f1", "mb1", "Inbox", "inbox"), folder("f6", "mb1", "Deleted Items", "deleted_items", 2)],
    mb2: [folder("f-shared-inbox", "mb2", "Inbox", "inbox"), folder("f-shared-deleted", "mb2", "Deleted Items", "deleted_items", 1)],
};

function message(uid: string, subject: string, overrides: Record<string, unknown> = {}) {
    return {
        uid,
        version: 0,
        folderUid: "f1",
        mailboxUid: "mb1",
        messageId: `${uid}@example.com`,
        subject,
        from: { address: "sender@example.com", displayName: "Sender One", type: "to" },
        recipients: [{ address: "u1@example.com", type: "to" }],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: "2026-01-01T00:00:00.000Z",
        bodyPreview: "Preview",
        flags: { read: true, flagged: false, answered: false, forwarded: false },
        importance: "normal",
        hasAttachments: false,
        ...overrides,
    };
}

function conversation(id: string, subject: string, messageUids: string[] = [`m-${id}`]) {
    return {
        conversationId: id,
        subject,
        messageUids,
        folderUids: ["f1"],
        messageCount: messageUids.length,
        unreadCount: 0,
        latestDate: "2026-01-01T00:00:00.000Z",
        participants: [{ address: "sender@example.com", displayName: "Sender One", type: "to" }],
        hasAttachments: false,
        flagged: false,
        latestMessageUid: messageUids[messageUids.length - 1],
        latestFrom: { address: "sender@example.com", displayName: "Sender One", type: "to" },
        latestPreview: "Preview",
        latestFolderUid: "f1",
    };
}

/** The server being talked to. Its tables are changed by the tests between requests. */
interface World {
    /** The messages each folder lists. */
    folders: Record<string, any[]>;
    /** The conversations each mailbox lists. */
    conversations: Record<string, any[]>;
    /** Folders whose listing answers 500. */
    failingFolders: Set<string>;
    /** Conversation ids whose messages answer 500. */
    failingThreads: Set<string>;
    /** Holds each conversation's messages until `release()`d, when set: the requests are queued here. */
    gate?: { held: { id: string; release: () => void }[] };
    /** The conversation requests that are open (sent, not yet answered), and the most there ever were at once. */
    open: number;
    peak: number;
    /** The conversation ids whose messages were fetched, in order. */
    fetched: string[];
}

function mockWorld(world: Partial<World> = {}) {
    const state: World = { folders: {}, conversations: {}, failingFolders: new Set(), failingThreads: new Set(), open: 0, peak: 0, fetched: [], ...world };
    const fetchMock = mockFetch(async (url, init) => {
        const parsed = new URL(url, "http://localhost");
        const path = parsed.pathname;
        const method = init?.method ?? "GET";
        if (path === "/api/mail/mailboxes/auto-provision") return jsonResponse(404, { message: "not enabled" });
        if (path.startsWith("/api/mail/mailboxes/") && path.endsWith("/access/me")) {
            return jsonResponse(200, { canRead: true, canCreate: false, canUpdate: true, canDelete: true, canManage: false });
        }
        if (path === "/api/mail/mailboxes") return jsonResponse(200, [mailbox, sharedMailbox]);
        if (path === "/api/mail/folders") return jsonResponse(200, FOLDERS[parsed.searchParams.get("mailboxUid") ?? "mb1"]);
        if (path === "/api/mail/labels") return jsonResponse(200, []);
        if (path === "/api/mail/attachments") return jsonResponse(200, []);
        if (path.startsWith("/api/mail/messages/conversations/")) {
            const id = decodeURIComponent(path.slice("/api/mail/messages/conversations/".length));
            const mailboxUid = parsed.searchParams.get("mailboxUid") ?? "mb1";
            state.fetched.push(id);
            state.open++;
            state.peak = Math.max(state.peak, state.open);
            try {
                if (state.gate) {
                    await new Promise<void>((resolve) => state.gate!.held.push({ id, release: resolve }));
                }
                if (state.failingThreads.has(id)) return jsonResponse(500, { message: "thread boom" });
                const thread = state.conversations[mailboxUid]?.find((c) => c.conversationId === id);
                return jsonResponse(
                    200,
                    thread ? thread.messageUids.map((uid: string) => message(uid, thread.subject, { conversationId: id, mailboxUid })) : [],
                );
            } finally {
                state.open--;
            }
        }
        if (path === "/api/mail/messages/conversations") return jsonResponse(200, state.conversations[parsed.searchParams.get("mailboxUid") ?? "mb1"] ?? []);
        if (path === "/api/mail/messages" && method === "PUT") {
            const updates = JSON.parse(init.body as string) as Record<string, unknown>[];
            return jsonResponse(200, updates.map((update) => ({ ...message(String(update.uid), "Updated"), ...update })));
        }
        if (path === "/api/mail/messages" && method === "DELETE") {
            const folderUid = parsed.searchParams.get("folderUid")!;
            state.folders[folderUid] = [];
            return new Response(null, { status: 204 });
        }
        if (path === "/api/mail/messages") {
            const folderUid = parsed.searchParams.get("folderUid") ?? "";
            if (state.failingFolders.has(folderUid)) return jsonResponse(500, { message: "mailbox boom" });
            return jsonResponse(200, state.folders[folderUid] ?? []);
        }
        throw new Error(`unexpected ${method} ${url}`);
    });
    return { fetchMock, state };
}

const bulkPuts = (fetchMock: ReturnType<typeof mockWorld>["fetchMock"]) =>
    fetchMock.mock.calls
        .filter(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT")
        .map(([, init]: [string, RequestInit]) => JSON.parse(init.body as string));

function at(search: string) {
    const location = mockLocation();
    (location as unknown as { search: string }).search = search;
}

function storeArrangement(showAsConversations: boolean, overrides: Record<string, unknown> = {}) {
    localStorage.setItem(
        "rapidmx:mail-list-preferences:mb1",
        JSON.stringify({ sortBy: "date", sortOrder: "desc", filter: "all", labelUids: [], showAsConversations, ...overrides }),
    );
}

/** The tab coming back to the front: what the list's quiet refresh listens for. */
function comeBack() {
    act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
    });
}

const ticked = () =>
    screen
        .queryAllByRole("checkbox")
        .filter((box) => (box as HTMLInputElement).checked)
        .map((box) => box.getAttribute("aria-label"));

beforeEach(() => {
    clearListSnapshots();
    localStorage.clear();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    mockLocation();
});

describe("InboxPage: an All mailboxes view when a mailbox fails to answer a refresh", () => {
    it("keeps that mailbox's rows (the other mailbox's fresh ones still land), where a first load without them shows what answered", async () => {
        at("?aggregate=inbox");
        storeArrangement(false);
        const { state } = mockWorld({
            folders: {
                f1: [message("m-own", "Own row", { receivedDate: "2026-01-01T00:00:00.000Z" })],
                "f-shared-inbox": [message("m-shared", "Shared row", { mailboxUid: "mb2", folderUid: "f-shared-inbox", receivedDate: "2026-01-02T00:00:00.000Z" })],
            },
        });
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Shared row");

        // The shared mailbox times out; mail arrives in the other one.
        state.failingFolders.add("f-shared-inbox");
        state.folders.f1.unshift(message("m-new", "Arrived", { receivedDate: "2026-01-03T00:00:00.000Z" }));
        comeBack();

        await screen.findByText("Arrived", {}, { timeout: 3000 });
        expect(screen.getByText("Shared row")).toBeInTheDocument();
        expect(screen.getByText("Own row")).toBeInTheDocument();
        // Newest first all the same.
        expect(screen.getAllByText(/Arrived|Shared row|Own row/).map((el) => el.textContent)).toEqual(["Arrived", "Shared row", "Own row"]);

        // Answering again, it is believed: what it no longer holds goes.
        state.failingFolders.clear();
        state.folders["f-shared-inbox"] = [];
        comeBack();
        await waitFor(() => expect(screen.queryByText("Shared row")).not.toBeInTheDocument(), { timeout: 3000 });
        expect(screen.getByText("Arrived")).toBeInTheDocument();
    });

    it("shows only what answered when the first load of the conversation list has a mailbox that fails (nothing of its is on screen to keep)", async () => {
        at("?aggregate=inbox");
        storeArrangement(true);
        mockWorld({ conversations: { mb1: [conversation("c-own", "Own thread")], mb2: [conversation("c-shared", "Shared thread")] } });
        const realFetch = globalThis.fetch;
        vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
            url.startsWith("/api/mail/messages/conversations?") && url.includes("mailboxUid=mb2") ? Promise.resolve(jsonResponse(500, { message: "boom" })) : realFetch(url, init),
        );
        render(<InboxPage userUid="u1" />);

        await screen.findByText("Own thread");
        expect(screen.queryByText("Shared thread")).not.toBeInTheDocument();
    });

    it("does the same for the conversation list", async () => {
        at("?aggregate=inbox");
        storeArrangement(true);
        const { state } = mockWorld({
            conversations: {
                mb1: [conversation("c-own", "Own thread")],
                mb2: [conversation("c-shared", "Shared thread")],
            },
        });
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Shared thread");

        // The shared mailbox's listing fails (whatever it answers with that is not a list), the other one has a new conversation.
        const realFetch = globalThis.fetch;
        vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
            url.startsWith("/api/mail/messages/conversations?") && url.includes("mailboxUid=mb2") ? Promise.resolve(jsonResponse(500, { message: "boom" })) : realFetch(url, init),
        );
        state.conversations.mb1.unshift(conversation("c-new", "Fresh thread"));
        comeBack();

        await screen.findByText("Fresh thread", {}, { timeout: 3000 });
        expect(screen.getByText("Shared thread")).toBeInTheDocument();
        expect(screen.getByText("Own thread")).toBeInTheDocument();
    });
});

describe("InboxPage: Select all on a conversation list", () => {
    const thread = (n: number) => conversation(`c${n}`, `Thread ${n}`);
    const threads = (count: number) => Array.from({ length: count }, (_, i) => thread(i + 1));
    /** Lets the requests that are open settle, for what they start next (or fail to) to show. */
    const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

    async function selectAll(user: ReturnType<typeof userEvent.setup>) {
        await user.click(screen.getByRole("button", { name: "Select" }));
        await user.click(screen.getByRole("button", { name: "Select all" }));
    }

    it("asks for the messages a few conversations at a time, not all of them at once", async () => {
        at("");
        storeArrangement(true);
        const { state } = mockWorld({ conversations: { mb1: threads(14) } });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Thread 14");

        await selectAll(user);
        await waitFor(() => expect(state.fetched).toHaveLength(14));
        expect(state.peak).toBeLessThanOrEqual(5);
        await waitFor(() => expect(ticked()).toHaveLength(14));
    });

    it("unticks only the conversations whose messages could not be loaded, with one pop-up", async () => {
        at("");
        storeArrangement(true);
        mockWorld({ conversations: { mb1: threads(6) }, failingThreads: new Set(["c2", "c5"]) });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Thread 6");

        await selectAll(user);

        await waitFor(() => expect(getNotificationsSnapshot().visible.some((n) => /Couldn't load the messages/.test(JSON.stringify(n)))).toBe(true));
        await waitFor(() => expect(ticked()).toHaveLength(4));
        expect(getNotificationsSnapshot().visible.filter((n) => /Couldn't load the messages/.test(JSON.stringify(n)))).toHaveLength(1);
        // The ones that arrived stay ticked and are acted on.
        expect(ticked().join(" ")).toContain("Thread 1");
        expect(ticked().join(" ")).not.toContain("Thread 2");
    });

    it("drops what a listing that has been replaced was still fetching, so the new listing asks again", async () => {
        at("");
        storeArrangement(true);
        const gate = { held: [] as { id: string; release: () => void }[] };
        const { state } = mockWorld({ conversations: { mb1: threads(8) }, gate });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Thread 8");

        await selectAll(user);
        // Five at a time: the other three wait their turn.
        await waitFor(() => expect(gate.held).toHaveLength(5));
        const first = [...gate.held];
        gate.held.length = 0;

        // The list is loaded again (another tab of it), and only then do the old answers arrive.
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        await user.click(await screen.findByRole("button", { name: /^Filter/ }));
        await user.click(await screen.findByRole("menuitemradio", { name: "Unread" }));
        await waitFor(() => expect(screen.getByRole("button", { name: "Filter: Unread" })).toBeInTheDocument());
        state.gate = undefined;
        act(() => first.forEach((held) => held.release()));
        await screen.findByText("Thread 8");
        await settle();
        // The three that had not been asked for are not asked for now: that listing is gone.
        expect(state.fetched).toHaveLength(5);
        const before = state.fetched.length;

        // Had the stale answers been kept, ticking all again would find them and ask for nothing.
        await selectAll(user);
        await waitFor(() => expect(state.fetched.length).toBeGreaterThan(before));
    });

    it("fetches again the messages of a ticked conversation that changed when the list refreshed (a reply arrived), so an action reaches it too", async () => {
        at("");
        storeArrangement(true);
        const { fetchMock, state } = mockWorld({ conversations: { mb1: [conversation("c1", "Thread 1", ["m-c1a"]), conversation("c2", "Thread 2", ["m-c2a"])] } });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Thread 2");
        await selectAll(user);
        await waitFor(() => expect(state.fetched).toEqual(["c1", "c2"]));
        await waitFor(() => expect(ticked()).toHaveLength(2));

        // A reply lands in the first one.
        state.conversations.mb1[0] = conversation("c1", "Thread 1", ["m-c1a", "m-c1b"]);
        comeBack();
        await waitFor(() => expect(state.fetched).toEqual(["c1", "c2", "c1"]), { timeout: 3000 });
        await waitFor(() => expect(ticked()).toHaveLength(2));

        await user.click(screen.getByRole("button", { name: "Delete" }));
        await waitFor(() => expect(bulkPuts(fetchMock).length).toBeGreaterThan(0));
        expect(
            bulkPuts(fetchMock)
                .flat()
                .map((update: { uid: string }) => update.uid)
                .sort(),
        ).toEqual(["m-c1a", "m-c1b", "m-c2a"]);
    });
});

describe("InboxPage: Empty folder in an All mailboxes view", () => {
    it("names the mailboxes whose folders it empties, and empties each of them", async () => {
        at("?aggregate=deleted_items");
        storeArrangement(false);
        const { fetchMock } = mockWorld({
            folders: {
                f6: [message("a", "Subject a", { folderUid: "f6" }), message("b", "Subject b", { folderUid: "f6" })],
                "f-shared-deleted": [message("c", "Subject c", { mailboxUid: "mb2", folderUid: "f-shared-deleted" })],
            },
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject c");

        await user.click(screen.getByRole("button", { name: "Empty Deleted Items" }));
        const dialog = await screen.findByRole("dialog", { name: "Empty Deleted Items" });
        expect(within(dialog).getByText("Permanently delete all 3 items in Deleted Items of: My Mail, Support (shared)? This can't be undone.")).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Delete all permanently" }));

        await waitFor(() =>
            expect(
                fetchMock.mock.calls
                    .filter(([url, init]: [string, RequestInit]) => url.startsWith("/api/mail/messages?") && init?.method === "DELETE")
                    .map(([url]: [string]) => url),
            ).toEqual(["/api/mail/messages?folderUid=f6", "/api/mail/messages?folderUid=f-shared-deleted"]),
        );
    });

    it("says nothing of mailboxes for a folder of one mailbox", async () => {
        at("?mailboxUid=mb1&folderUid=f6");
        storeArrangement(false);
        mockWorld({ folders: { f6: [message("a", "Subject a", { folderUid: "f6" }), message("b", "Subject b", { folderUid: "f6" })] } });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Subject a");

        await user.click(screen.getByRole("button", { name: "Empty Deleted Items" }));
        const dialog = await screen.findByRole("dialog", { name: "Empty Deleted Items" });
        expect(within(dialog).getByText("Permanently delete all 2 items in Deleted Items? This can't be undone.")).toBeInTheDocument();
    });
});
