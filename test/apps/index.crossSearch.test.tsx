// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockIntersectionObserver, mockLocation } from "./testUtils.js";
import { SEARCH_LIMITS } from "../../apps/shared/search/crossMailboxSearch.js";
import InboxPageRouted from "../../apps/www/index.js";

// Search over several mailboxes (the "All mailboxes" views, and a folder's search widened to every mailbox): the same per-mailbox Tier 1 / 2 / 3
// pipeline `index.test.tsx` covers for one mailbox, fanned out and merged. The tiers' own workings are mocked at the module boundary for the reason
// given there; what is under test is the fan-out, the merge, the notices and the per-mailbox actions.
const InboxPage = InboxPageRouted.page;

const { searchEncryptedCandidates, getUnlockedKeys, unlockWithPassword, subscribeKeySession, keySessionListeners, searchLocalIndex, evaluateMessageSecurity } =
    vi.hoisted(() => {
        const keySessionListeners = new Set<(event: { mailboxUid: string; state: "unlocked" | "locked" }) => void>();
        return {
            searchEncryptedCandidates: vi.fn(),
            searchLocalIndex: vi.fn(),
            evaluateMessageSecurity: vi.fn(),
            getUnlockedKeys: vi.fn(),
            unlockWithPassword: vi.fn(),
            keySessionListeners,
            subscribeKeySession: vi.fn((listener: (event: { mailboxUid: string; state: "unlocked" | "locked" }) => void) => {
                keySessionListeners.add(listener);
                return () => keySessionListeners.delete(listener);
            }),
        };
    });
vi.mock("@rapidmx/react-shared/search/searchTier3.js", () => ({ searchEncryptedCandidates }));
vi.mock("../../apps/shared/search/searchTier2.js", () => ({ searchLocalIndex }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys, unlockWithPassword, subscribeKeySession }));
vi.mock("@rapidmx/react-shared/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity }));

// The reading panes are stand-ins that say what the page handed them: which message or thread, whose mailbox, whose folders.
vi.mock("../../apps/shared/components/mail/LazyReadingPane.js", () => ({
    LazyMessageDetailPane: ({ message, folders, labels }: { message: { uid: string; mailboxUid: string } | null; folders: { uid: string }[]; labels: { name: string }[] }) => (
        <div data-testid="detail-pane">
            {message ? `message:${message.uid} mailbox:${message.mailboxUid}` : "no-message"} folders:{folders.map((f) => f.uid).join("/")} labels:
            {labels.map((l) => l.name).join("/")}
        </div>
    ),
    LazyConversationThreadPane: ({
        conversation,
        mailboxUid,
        folders,
        labels,
        selectedUid,
        onLabelCreated,
    }: {
        conversation: { conversationId: string } | null;
        mailboxUid: string;
        folders: { uid: string }[];
        labels: { name: string }[];
        selectedUid: string | null;
        onLabelCreated: (label: { uid: string; name: string }) => void;
    }) => (
        <div data-testid="thread-pane">
            {conversation ? `thread:${conversation.conversationId} at:${selectedUid} mailbox:${mailboxUid}` : "no-thread"} folders:
            {folders.map((f) => f.uid).join("/")} labels:{labels.map((l) => l.name).join("/")}
            <button type="button" onClick={() => onLabelCreated({ uid: "l-new", name: "Made here" })}>
                simulate-label-created
            </button>
        </div>
    ),
    prefetchReadingPane: vi.fn(),
}));

const DEFAULT_LIMITS = { ...SEARCH_LIMITS };
const KEYS = [{ publicKey: "AAAA", type: "x509", useType: "encrypt" as const, fingerprint: "ff", notBefore: 0, notAfter: 9_000_000_000_000 }];

function mailboxFixture(uid: string, overrides: Record<string, unknown> = {}) {
    return {
        uid,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        primarySmtpAddress: `${uid}@example.com`,
        aliasAddresses: [],
        displayName: uid,
        timezone: "UTC",
        quotaBytes: 1_000_000_000,
        usedBytes: 0,
        ...overrides,
    };
}

/** The caller's own mailbox, and two shared ones - "Sales" sorts before "Support". */
const own = mailboxFixture("mb1", { ownerUserUid: "u1", accessRole: "owner", displayName: "My Mail" });
const support = mailboxFixture("mb2", { accessRole: "delegate", displayName: "Support" });
const sales = mailboxFixture("mb3", { accessRole: "delegate", displayName: "Sales" });

function foldersOf(mailboxUid: string) {
    return (["inbox", "sent_items", "archive", "deleted_items"] as const).map((type) => ({
        uid: `${mailboxUid}-${type}`,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid,
        name: type,
        type,
        unreadCount: 0,
        totalCount: 0,
    }));
}

function messageFixture(uid: string, mailboxUid: string, overrides: Record<string, unknown> = {}) {
    return {
        uid,
        version: 1,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: `${mailboxUid}-sent_items`,
        mailboxUid,
        messageId: `${uid}@example.com`,
        subject: uid,
        from: { address: `${uid}@sender.example`, displayName: `From ${uid}`, type: "to" as const },
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

function hit(entityUid: string, score: number, extra: Record<string, unknown> = {}) {
    return { entityType: "message", entityUid, score, ...extra };
}

type SearchPage = { results: unknown[]; nextCursor?: string };
/** A search endpoint that answers from a table keyed `mailboxUid|cursor` (no cursor is the first page); an absent entry is an empty page. */
function pages(table: Record<string, SearchPage | Response | (() => Response | Promise<Response>)>) {
    return (mailboxUid: string, params: URLSearchParams): Response | Promise<Response> => {
        const entry = table[`${mailboxUid}|${params.get("cursor") ?? ""}`] ?? { results: [] };
        if (typeof entry === "function") return entry();
        return entry instanceof Response ? entry.clone() : jsonResponse(200, entry);
    };
}

interface MailOptions {
    mailboxes?: Record<string, unknown>[];
    /** Mailboxes whose folders cannot be listed. */
    foldersDenied?: string[];
    messages?: Record<string, unknown>[];
    search?: (mailboxUid: string, params: URLSearchParams) => Response | Promise<Response>;
    /** A mailbox's conversation, keyed `mailboxUid|conversationId`. */
    conversations?: Record<string, unknown[]>;
    /** Overrides a single message's GET; `call` counts from 1. */
    onMessage?: (uid: string, call: number) => Response | Promise<Response> | undefined;
    /** Where the bulk update (a move) goes. */
    onBulkUpdate?: (updates: Record<string, unknown>[]) => void;
    labels?: Record<string, unknown[]>;
}

function mockMail(options: MailOptions = {}) {
    const mailboxes = options.mailboxes ?? [own, support];
    const messages = options.messages ?? [];
    const calls: Record<string, number> = {};
    return mockFetch((url, init) => {
        const parsed = new URL(url, "http://localhost");
        const path = parsed.pathname;
        const mailboxUid = parsed.searchParams.get("mailboxUid") ?? "";
        if (path === "/api/mail/mailboxes/auto-provision") return jsonResponse(404, { message: "not enabled" });
        if (path === "/api/mail/mailboxes") return jsonResponse(200, mailboxes);
        if (path === "/api/mail/folders") {
            return options.foldersDenied?.includes(mailboxUid) ? jsonResponse(403, { message: "no access" }) : jsonResponse(200, foldersOf(mailboxUid));
        }
        if (path === "/api/mail/labels") return jsonResponse(200, options.labels?.[mailboxUid] ?? []);
        if (path === "/api/mail/search") return (options.search ?? pages({}))(mailboxUid, parsed.searchParams);
        if (path.startsWith("/api/mail/messages/conversations/")) {
            const id = decodeURIComponent(path.slice("/api/mail/messages/conversations/".length));
            return jsonResponse(200, options.conversations?.[`${mailboxUid}|${id}`] ?? []);
        }
        if (path === "/api/mail/attachments") return jsonResponse(200, []);
        const single = path.match(/^\/api\/mail\/messages\/([^/]+)(\/raw)?$/);
        if (single) {
            const uid = single[1];
            if (single[2]) return new Response("raw-mime-placeholder", { status: 200 });
            calls[uid] = (calls[uid] ?? 0) + 1;
            const custom = options.onMessage?.(uid, calls[uid]);
            if (custom) return custom;
            const found = messages.find((m) => m.uid === uid);
            return found ? jsonResponse(200, found) : jsonResponse(404, { message: "not found" });
        }
        if (path === "/api/mail/messages") {
            if ((init?.method ?? "GET") === "PUT") {
                const updates = JSON.parse(init.body as string) as Record<string, unknown>[];
                options.onBulkUpdate?.(updates);
                return jsonResponse(
                    200,
                    updates.map((update) => ({ ...(messages.find((m) => m.uid === update.uid) as object), ...update })),
                );
            }
            const folderUid = parsed.searchParams.get("folderUid");
            return jsonResponse(200, messages.filter((m) => m.folderUid === folderUid));
        }
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

function searchCalls(fetchMock: ReturnType<typeof mockFetch>): URLSearchParams[] {
    return fetchMock.mock.calls
        .map(([url]: [string]) => url)
        .filter((url: string) => url.startsWith("/api/mail/search?"))
        .map((url: string) => new URLSearchParams(url.split("?")[1]));
}

const searchedMailboxes = (fetchMock: ReturnType<typeof mockFetch>) => [...new Set(searchCalls(fetchMock).map((p) => p.get("mailboxUid")))].sort();

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function at(search: string) {
    const location = mockLocation();
    (location as any).search = search;
}

function emitKeySession(event: { mailboxUid: string; state: "unlocked" | "locked" }) {
    for (const listener of [...keySessionListeners]) {
        listener(event);
    }
}

async function searchFor(user: ReturnType<typeof userEvent.setup>, text: string) {
    await user.type(await screen.findByPlaceholderText("Search all mail…"), text);
}

/** The subjects of the rows on screen, in order. */
const rowSubjects = (names: RegExp) => screen.getAllByText(names).map((el) => el.textContent);

beforeEach(() => {
    searchEncryptedCandidates.mockResolvedValue([]);
    searchLocalIndex.mockResolvedValue({ results: [], hasMore: false });
    // Flat lists, whichever way a never-arranged mailbox would open - the conversation arrangement has tests of its own below.
    for (const uid of ["mb1", "mb2", "mb3"]) {
        localStorage.setItem(
            `rapidmx:mail-list-preferences:${uid}`,
            JSON.stringify({ sortBy: "date", sortOrder: "desc", filter: "all", labelUids: [], showAsConversations: false }),
        );
    }
});

afterEach(() => {
    vi.unstubAllGlobals();
    Object.assign(SEARCH_LIMITS, DEFAULT_LIMITS);
    keySessionListeners.clear();
    searchEncryptedCandidates.mockReset();
    searchLocalIndex.mockReset();
    getUnlockedKeys.mockReset();
    unlockWithPassword.mockReset();
    evaluateMessageSecurity.mockReset();
    mockLocation();
});

describe("searching all mailboxes", () => {
    it("enables the search box in the All mailboxes view and searches every mailbox, merging the hits by relevance with each row's mailbox", async () => {
        at("?aggregate=inbox");
        const fetchMock = mockMail({
            messages: [
                messageFixture("a", "mb1", { subject: "Alpha" }),
                messageFixture("b", "mb1", { subject: "Bravo" }),
                messageFixture("c", "mb2", { subject: "Charlie" }),
            ],
            search: pages({ "mb1|": { results: [hit("a", 5), hit("b", 1)] }, "mb2|": { results: [hit("c", 9)] } }),
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);

        const box = await screen.findByPlaceholderText("Search all mail…");
        expect(box).toBeEnabled();
        await user.type(box, "budget");
        await screen.findByText("3 results");

        // One ranking across the mailboxes' hits (9, 5, 1 pooled), not each mailbox's best first.
        expect(rowSubjects(/^(Alpha|Bravo|Charlie)$/)).toEqual(["Charlie", "Alpha", "Bravo"]);
        expect(within(screen.getByText("Charlie").closest("li")!).getByText("Support")).toBeInTheDocument();
        expect(within(screen.getByText("Alpha").closest("li")!).getByText("My Mail")).toBeInTheDocument();
        expect(screen.getByTestId("search-scope")).toHaveTextContent("All mailboxes");
        expect(screen.queryByText(/Showing the most recent mail from each mailbox/)).not.toBeInTheDocument();

        // Every mailbox got its own Tier 1 request - with the query's own filters - for its share of a page.
        expect(searchedMailboxes(fetchMock)).toEqual(["mb1", "mb2"]);
        expect(searchCalls(fetchMock).every((p) => p.get("limit") === "25")).toBe(true);
        // ... and its own Tier 2 and Tier 3, with that mailbox's own keys.
        expect([...new Set(searchLocalIndex.mock.calls.map((c) => c[0]))].sort()).toEqual(["mb1", "mb2"]);
        expect([...new Set(searchEncryptedCandidates.mock.calls.map((c) => c[3].mailboxUid))].sort()).toEqual(["mb1", "mb2"]);
    });

    it("keeps the operators of the query working across mailboxes", async () => {
        at("?aggregate=inbox");
        const fetchMock = mockMail({ messages: [messageFixture("a", "mb1")], search: pages({ "mb1|": { results: [hit("a", 1)] } }) });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);

        await searchFor(user, "from:alice@example.com has:attachment report");
        await screen.findByText("1 result");

        const finalQuery = searchCalls(fetchMock).filter((params) => params.get("q") === "report");
        expect(finalQuery.length).toBeGreaterThan(0);
        for (const params of finalQuery) {
            expect(params.get("from")).toBe("alice@example.com");
            expect(params.get("hasAttachment")).toBe("true");
        }
    });

    it("asks only the mailbox that has the folder an in: operator names", async () => {
        at("?aggregate=inbox");
        const fetchMock = mockMail({
            mailboxes: [own, support, sales],
            messages: [messageFixture("c", "mb2", { subject: "Charlie" })],
            search: pages({ "mb2|": { results: [hit("c", 1)] } }),
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        // Pasted, not typed: the query is whole from its first character, so no shorter one is searched on the way.
        await user.click(await screen.findByPlaceholderText("Search all mail…"));
        await user.paste("in:mb2-inbox budget");
        await screen.findByText("1 result");

        expect(searchedMailboxes(fetchMock)).toEqual(["mb2"]);
        expect(searchCalls(fetchMock).every((params) => params.get("in") === "mb2-inbox")).toBe(true);
        expect(searchLocalIndex.mock.calls.map((c) => c[0])).toEqual(["mb2"]);
        // One mailbox was asked and it is all of the ones that could answer: nothing was left out.
        expect(screen.queryByText(/Searched \d+ of \d+ mailboxes/)).not.toBeInTheDocument();
    });

    it("asks every mailbox about an in: folder none of them has", async () => {
        at("?aggregate=inbox");
        const fetchMock = mockMail({ mailboxes: [own, support] });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await user.click(await screen.findByPlaceholderText("Search all mail…"));
        await user.paste("in:nowhere budget");
        await screen.findByText("0 results");

        expect(searchedMailboxes(fetchMock)).toEqual(["mb1", "mb2"]);
    });

    it("keeps a conversation id found in two mailboxes as two conversations, and opens each in its own mailbox", async () => {
        at("?aggregate=inbox");
        localStorage.setItem(
            "rapidmx:mail-list-preferences:mb1",
            JSON.stringify({ sortBy: "date", sortOrder: "desc", filter: "all", labelUids: [], showAsConversations: true }),
        );
        const fetchMock = mockMail({
            messages: [
                messageFixture("a", "mb1", { subject: "Budget thread", conversationId: "c1" }),
                messageFixture("c", "mb2", { subject: "Budget thread", conversationId: "c1" }),
            ],
            search: pages({ "mb1|": { results: [hit("a", 5)] }, "mb2|": { results: [hit("c", 9)] } }),
            labels: { mb2: [{ uid: "l2", name: "Support label" }] },
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await searchFor(user, "budget");
        await screen.findByText("2 results");

        const groups = document.querySelectorAll('[data-search-group="c1"]');
        expect(groups).toHaveLength(2);
        // Ranked order: the Support hit (9) first.
        expect(within(groups[0] as HTMLElement).getByText("Support")).toBeInTheDocument();
        expect(within(groups[1] as HTMLElement).getByText("My Mail")).toBeInTheDocument();
        for (const group of groups) {
            expect(group).toHaveTextContent("1 matching message");
        }

        await user.click(within(groups[0] as HTMLElement).getByRole("button", { name: /Budget thread/ }));

        // The thread pane is the hit's mailbox's: its conversation, its folders and its labels - not the primary mailbox's.
        const pane = screen.getByTestId("thread-pane");
        expect(pane).toHaveTextContent("thread:c1 at:c mailbox:mb2");
        expect(pane).toHaveTextContent("folders:mb2-inbox/mb2-sent_items/mb2-archive/mb2-deleted_items");
        await waitFor(() => expect(pane).toHaveTextContent("labels:Support label"));
        expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/mail\/labels\?.*mailboxUid=mb2/), expect.anything());

        // A label made from that pane is Support's: it joins the labels the pane shows, not the open mailbox's.
        await user.click(within(pane).getByRole("button", { name: "simulate-label-created" }));
        expect(pane).toHaveTextContent("labels:Support label/Made here");
    });

    it("opens a hit in its own mailbox's context: its folders and its labels", async () => {
        at("?aggregate=inbox");
        const fetchMock = mockMail({
            messages: [messageFixture("c", "mb2", { subject: "Charlie" })],
            search: pages({ "mb2|": { results: [hit("c", 9)] } }),
            labels: { mb2: [{ uid: "l2", name: "Support label" }] },
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await searchFor(user, "budget");

        await user.click(await screen.findByText("Charlie"));

        const pane = screen.getByTestId("detail-pane");
        expect(pane).toHaveTextContent("message:c mailbox:mb2");
        expect(pane).toHaveTextContent("folders:mb2-inbox/mb2-sent_items/mb2-archive/mb2-deleted_items");
        await waitFor(() => expect(pane).toHaveTextContent("labels:Support label"));
        expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/mail\/labels\?.*mailboxUid=mb2/), expect.anything());
    });

    it("searches only the mailboxes whose folders can be read, and says nothing is missing", async () => {
        at("?aggregate=inbox");
        const fetchMock = mockMail({
            mailboxes: [own, support, sales],
            foldersDenied: ["mb3"],
            messages: [messageFixture("a", "mb1", { subject: "Alpha" })],
            search: pages({ "mb1|": { results: [hit("a", 1)] } }),
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await searchFor(user, "budget");
        await screen.findByText("1 result");

        expect(searchedMailboxes(fetchMock)).toEqual(["mb1", "mb2"]);
        expect(screen.queryByText(/Some results may be missing/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Searched \d+ of \d+ mailboxes/)).not.toBeInTheDocument();
    });

    it("searches at most the configured number of mailboxes, the reader's own first, and says how many were left out", async () => {
        SEARCH_LIMITS.maxMailboxes = 2;
        at("?aggregate=inbox");
        const fetchMock = mockMail({
            mailboxes: [own, support, sales],
            messages: [messageFixture("a", "mb1", { subject: "Alpha" })],
            search: pages({ "mb1|": { results: [hit("a", 1)] } }),
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await searchFor(user, "budget");
        await screen.findByText("1 result");

        // Own first, then the shared ones by name: Sales (mb3) is in, Support (mb2) is left out.
        expect(searchedMailboxes(fetchMock)).toEqual(["mb1", "mb3"]);
        expect(screen.getByText("Searched 2 of 3 mailboxes - the most that are searched at once.")).toBeInTheDocument();
    });

    it("keeps the other mailboxes' results and says which mailbox could not be searched, and why", async () => {
        SEARCH_LIMITS.tier1TimeoutMs = 50;
        at("?aggregate=inbox");
        const fetchMock = mockMail({
            mailboxes: [own, support, sales],
            messages: [messageFixture("a", "mb1", { subject: "Alpha" })],
            search: pages({
                "mb1|": { results: [hit("a", 1)] },
                "mb2|": jsonResponse(403, { message: "no" }),
                "mb3|": () => new Promise<Response>(() => undefined),
            }),
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await searchFor(user, "budget");

        expect(await screen.findByText("Some results may be missing: Support (access denied), Sales (timed out) could not be searched.")).toBeInTheDocument();
        await screen.findByText("1 result");
        expect(screen.getByText("Alpha")).toBeInTheDocument();
        expect(screen.queryByText("Search failed.")).not.toBeInTheDocument();
        // A mailbox that failed takes no part in the rest of the search.
        expect([...new Set(searchEncryptedCandidates.mock.calls.map((c) => c[3].mailboxUid))]).toEqual(["mb1"]);
        expect(searchedMailboxes(fetchMock)).toEqual(["mb1", "mb2", "mb3"]);
    });

    it("fails the search only when not one mailbox could be searched", async () => {
        at("?aggregate=inbox");
        mockMail({ search: pages({ "mb1|": jsonResponse(500, { message: "boom" }), "mb2|": jsonResponse(500, { message: "boom" }) }) });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await searchFor(user, "budget");

        expect(await screen.findByText("Search failed.")).toBeInTheDocument();
        expect(screen.getByText(/My Mail \(server error\)/)).toBeInTheDocument();
        expect(screen.getByText(/Support \(server error\)/)).toBeInTheDocument();
    });

    it("says which mailbox's encrypted mail could not be searched when only its Tier 3 pass fails, keeping everything else", async () => {
        SEARCH_LIMITS.tier3TimeoutMs = 50;
        at("?aggregate=inbox");
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        searchEncryptedCandidates.mockImplementation(async (_parsed: unknown, _unlocked: unknown, _limit: number, options: { mailboxUid: string }) => {
            if (options.mailboxUid === "mb2") return new Promise(() => undefined);
            if (options.mailboxUid === "mb3") throw new TypeError("network down");
            return [];
        });
        mockMail({
            mailboxes: [own, support, sales],
            messages: [messageFixture("a", "mb1", { subject: "Alpha" }), messageFixture("c", "mb2", { subject: "Charlie" })],
            search: pages({ "mb1|": { results: [hit("a", 1)] }, "mb2|": { results: [hit("c", 2)] } }),
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await searchFor(user, "budget");

        expect(
            await screen.findByText("Some results may be missing: Sales (encrypted mail: network error), Support (encrypted mail: timed out) could not be searched."),
        ).toBeInTheDocument();
        await screen.findByText("2 results");
        expect(screen.getByText("Alpha")).toBeInTheDocument();
        expect(screen.getByText("Charlie")).toBeInTheDocument();
    });

    it("shows a hit an encrypted mailbox's Tier 1 only guessed at as a skeleton until that mailbox's own Tier 3 has answered, and withholds the count until every mailbox has", async () => {
        at("?aggregate=inbox");
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        const tier3 = { mb1: deferred<unknown[]>(), mb2: deferred<unknown[]>() };
        searchEncryptedCandidates.mockImplementation((_parsed: unknown, _unlocked: unknown, _limit: number, options: { mailboxUid: "mb1" | "mb2" }) => tier3[options.mailboxUid].promise);
        mockMail({
            messages: [
                messageFixture("a", "mb1", { subject: "Alpha" }),
                messageFixture("c", "mb2", { subject: "Charlie" }),
                messageFixture("d", "mb2", { subject: "Delta" }),
            ],
            search: pages({
                "mb1|": { results: [hit("a", 1, { metadataOnly: true })] },
                "mb2|": { results: [hit("c", 1, { metadataOnly: true }), hit("d", 2)] },
            }),
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await searchFor(user, "budget");

        // Tier 1 and 2 are in from both mailboxes: the real hit shows, the two guesses are skeletons, and there is no hard count yet.
        expect(await screen.findByText("Delta")).toBeInTheDocument();
        await screen.findByText("3 of ??");
        expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
        expect(screen.queryByText("Charlie")).not.toBeInTheDocument();

        // My Mail's Tier 3 confirms its guess; Support's has not answered, so Support's stays a skeleton and the count stays unsettled.
        await act(async () => tier3.mb1.resolve([hit("a", 3, { source: "candidate", metadataOnly: false })]));
        expect(await screen.findByText("Alpha")).toBeInTheDocument();
        expect(screen.queryByText("Charlie")).not.toBeInTheDocument();
        expect(screen.getByText(/of \?\?/)).toBeInTheDocument();

        // Support's finds nothing to confirm Charlie: it is pruned and the count settles.
        await act(async () => tier3.mb2.resolve([]));
        await screen.findByText("2 results");
        expect(screen.queryByText("Charlie")).not.toBeInTheDocument();
    });

    it("bounds each mailbox's Tier 3 to what its own local index leaves uncovered, and 'Search older encrypted mail' removes the bounds of every mailbox", async () => {
        at("?aggregate=inbox");
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        // Only My Mail has a finished local index (the one the open mailbox builds).
        searchLocalIndex.mockImplementation(async (mailboxUid: string) =>
            mailboxUid === "mb1"
                ? {
                      results: [],
                      hasMore: false,
                      coverage: {
                          indexedFrom: "2025-06-01T00:00:00.000Z",
                          indexedUntil: "2026-01-01T00:00:00.000Z",
                          indexedCount: 5,
                          building: false,
                          complete: true,
                      },
                  }
                : { results: [], hasMore: false },
        );
        mockMail();
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await searchFor(user, "budget");
        await screen.findByRole("button", { name: "Search older encrypted mail" });

        // (Only what was asked for the query as typed: a slow machine can run the search for a shorter one first.)
        const windowsOf = (mailboxUid: string) =>
            searchEncryptedCandidates.mock.calls
                .filter((c) => c[0].text === "budget" && c[3].mailboxUid === mailboxUid)
                .map((c) => ({ before: c[0].before?.toISOString(), after: c[0].after?.toISOString() }));
        await waitFor(() => expect(windowsOf("mb1")).toHaveLength(2));
        // My Mail: the mail older than its index and the mail newer than its build pass. Support: everything, it has no index.
        expect(windowsOf("mb1")).toEqual([
            { before: "2025-06-01T00:00:00.000Z", after: undefined },
            { before: undefined, after: "2026-01-01T00:00:00.000Z" },
        ]);
        expect(windowsOf("mb2")).toEqual([{ before: undefined, after: undefined }]);
        // "All mail" already means every mailbox here, so the button says what it adds - and the per-mailbox one is not offered.
        expect(screen.queryByRole("button", { name: "Search all mail" })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Search older encrypted mail" }));

        // Only My Mail's window changed; Support's was already the whole range, so its answer is reused.
        await waitFor(() => expect(windowsOf("mb1")).toHaveLength(3));
        expect(windowsOf("mb1")[2]).toEqual({ before: undefined, after: undefined });
        expect(windowsOf("mb2")).toHaveLength(1);
        await waitFor(() => expect(screen.queryByRole("button", { name: "Search older encrypted mail" })).not.toBeInTheDocument());
    });

    it("hands each mailbox's own unlocked keys to its own Tier 2 and Tier 3, and says which unlocked mailboxes have no local index", async () => {
        at("?aggregate=inbox");
        const unlockedMb2 = { masterKey: new Uint8Array(32) };
        getUnlockedKeys.mockImplementation((uid: string) => (uid === "mb2" ? unlockedMb2 : undefined));
        mockMail({ mailboxes: [own, { ...support, keys: KEYS }] });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await searchFor(user, "budget");
        await screen.findByText("0 results");

        expect(searchLocalIndex).toHaveBeenCalledWith("mb1", expect.anything(), undefined, 25, 0);
        expect(searchLocalIndex).toHaveBeenCalledWith("mb2", expect.anything(), unlockedMb2, 25, 0);
        expect(searchEncryptedCandidates).toHaveBeenCalledWith(expect.anything(), undefined, 200, { mailboxUid: "mb1" });
        expect(searchEncryptedCandidates).toHaveBeenCalledWith(expect.anything(), unlockedMb2, 200, { mailboxUid: "mb2" });
        expect(
            screen.getByText(/There is no local index on this device for Support: its encrypted mail is searched through the server instead/),
        ).toBeInTheDocument();
    });

    it("offers to unlock the reader's own locked mailboxes, says a shared one can only be unlocked by its owner, and includes what unlocking finds", async () => {
        at("?aggregate=inbox");
        const second = mailboxFixture("mb2", { ownerUserUid: "u1", accessRole: "owner", displayName: "Side Mail", dateCreated: "2026-02-01T00:00:00.000Z", keys: KEYS });
        const shared = { ...sales, keys: KEYS };
        getUnlockedKeys.mockReturnValue(undefined);
        unlockWithPassword.mockImplementation(async (uid: string) => {
            getUnlockedKeys.mockImplementation((asked: string) => (asked === uid ? { masterKey: new Uint8Array(32) } : undefined));
            return { unopenableKeys: [] };
        });
        searchEncryptedCandidates.mockImplementation(async (_parsed: unknown, unlocked: unknown, _limit: number, options: { mailboxUid: string }) =>
            unlocked && options.mailboxUid === "mb2" ? [hit("e", 5, { source: "candidate", metadataOnly: false })] : [],
        );
        mockMail({ mailboxes: [own, second, shared], messages: [messageFixture("e", "mb2", { subject: "Encrypted match" })] });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await searchFor(user, "budget");

        await screen.findByText("Unlock to include encrypted messages from Side Mail");
        expect(screen.getByText("Encrypted messages in Sales are not included: only the mailbox’s owner can unlock them.")).toBeInTheDocument();
        expect(screen.queryByText("Encrypted match")).not.toBeInTheDocument();

        await user.click(screen.getByText("Unlock to include encrypted messages from Side Mail"));
        await screen.findByText("Unlock your mailbox");
        await user.type(screen.getByLabelText("Encryption password"), "a good password");
        await user.click(screen.getByRole("button", { name: "Unlock" }));

        expect(await screen.findByText("Encrypted match")).toBeInTheDocument();
        expect(unlockWithPassword.mock.calls[0][0]).toBe("mb2");
        expect(screen.queryByText("Unlock to include encrypted messages from Side Mail")).not.toBeInTheDocument();
        // Nothing of the reader's own is left to unlock, so only the note about the shared one remains.
        expect(screen.getByText(/Encrypted messages in Sales are not included/)).toBeInTheDocument();
    });

    it("leaves the search as it was when the unlock prompt is dismissed", async () => {
        at("?aggregate=inbox");
        getUnlockedKeys.mockReturnValue(undefined);
        mockMail({ mailboxes: [own, { ...mailboxFixture("mb2", { ownerUserUid: "u1", displayName: "Side Mail", keys: KEYS }) }] });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await searchFor(user, "budget");
        await user.click(await screen.findByText("Unlock to include encrypted messages from Side Mail"));
        await screen.findByText("Unlock your mailbox");

        await user.click(screen.getByRole("button", { name: "Cancel" }));

        await waitFor(() => expect(screen.queryByText("Unlock your mailbox")).not.toBeInTheDocument());
        expect(screen.getByText("Unlock to include encrypted messages from Side Mail")).toBeInTheDocument();
    });

    it("decrypts the rows of every mailbox whose keys are unlocked, not just the open one's", async () => {
        at("?aggregate=inbox");
        getUnlockedKeys.mockImplementation((uid: string) => (uid === "mb2" ? { masterKey: new Uint8Array(32) } : undefined));
        evaluateMessageSecurity.mockResolvedValue({ subject: "Real subject", html: "<p>Real body</p>" });
        mockMail({
            messages: [
                messageFixture("e1", "mb2", { subject: "[...]" }),
                messageFixture("e2", "mb2", { subject: "[...]" }),
                messageFixture("e3", "mb1", { subject: "[...]" }),
            ],
            search: pages({ "mb1|": { results: [hit("e3", 1)] }, "mb2|": { results: [hit("e1", 2), hit("e2", 1)] } }),
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await searchFor(user, "budget");

        await waitFor(() => expect(screen.getAllByText("Real subject")).toHaveLength(2));
        // My Mail's is locked: its row stays what it was.
        expect(screen.getByText("Encrypted message")).toBeInTheDocument();
    });

    it("re-runs the search without a searched mailbox's decrypted hits when that mailbox is locked, and ignores an unrelated one", async () => {
        at("?aggregate=inbox");
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        mockMail({ mailboxes: [own, support, sales] });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await searchFor(user, "budget");
        await screen.findByText("0 results");
        await settle();
        const before = searchLocalIndex.mock.calls.length;

        act(() => emitKeySession({ mailboxUid: "elsewhere", state: "locked" }));
        act(() => emitKeySession({ mailboxUid: "mb2", state: "unlocked" }));
        await settle();
        expect(searchLocalIndex.mock.calls.length).toBe(before);

        getUnlockedKeys.mockReturnValue(undefined);
        act(() => emitKeySession({ mailboxUid: "mb2", state: "locked" }));

        await waitFor(() => expect(searchLocalIndex.mock.calls.length).toBeGreaterThan(before));
    });

    it("stops fanning out to further mailboxes when the query changes, and ignores what an older query's mailbox answers late", async () => {
        SEARCH_LIMITS.concurrency = 1;
        at("?aggregate=inbox");
        const oldAnswer = deferred<Response>();
        const fetchMock = mockMail({
            messages: [messageFixture("old", "mb1", { subject: "Old hit" }), messageFixture("new", "mb1", { subject: "New hit" })],
            search: (mailboxUid, params) => {
                if (mailboxUid === "mb1" && params.get("q") === "budget") return oldAnswer.promise;
                return jsonResponse(200, { results: mailboxUid === "mb1" ? [hit("new", 1)] : [] });
            },
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await searchFor(user, "budget");
        // The first query is asking My Mail; with one mailbox at a time, Support has not been asked yet.
        await waitFor(() => expect(searchCalls(fetchMock).some((p) => p.get("q") === "budget")).toBe(true));

        await user.type(screen.getByPlaceholderText("Search all mail…"), "2");
        expect(await screen.findByText("New hit")).toBeInTheDocument();
        await screen.findByText("1 result");

        await act(async () => oldAnswer.resolve(jsonResponse(200, { results: [hit("old", 9)] })));
        await settle();

        expect(screen.queryByText("Old hit")).not.toBeInTheDocument();
        expect(screen.getByText("New hit")).toBeInTheDocument();
        // The superseded search never got to Support.
        expect(searchCalls(fetchMock).filter((p) => p.get("q") === "budget" && p.get("mailboxUid") === "mb2")).toHaveLength(0);
        expect(searchCalls(fetchMock).filter((p) => p.get("q") === "budget2" && p.get("mailboxUid") === "mb2")).toHaveLength(1);
    });

    it("does not let a slow interim reveal overwrite the fuller list a later one has already shown", async () => {
        at("?aggregate=inbox");
        const slowMessage = deferred<Response>();
        const supportAnswer = deferred<Response>();
        const fetchMock = mockMail({
            messages: [messageFixture("a", "mb1", { subject: "Alpha" }), messageFixture("c", "mb2", { subject: "Charlie" })],
            search: (mailboxUid) => (mailboxUid === "mb2" ? supportAnswer.promise : jsonResponse(200, { results: [hit("a", 1)] })),
            // The first time My Mail's hit is fetched (for the reveal made as My Mail answers) the answer is held back.
            onMessage: (uid, call) => (uid === "a" && call === 1 ? slowMessage.promise : undefined),
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await searchFor(user, "budget");
        await waitFor(() => expect(fetchMock.mock.calls.some(([url]: [string]) => url === "/api/mail/messages/a")).toBe(true));

        await act(async () => supportAnswer.resolve(jsonResponse(200, { results: [hit("c", 2)] })));
        await screen.findByText("Charlie");
        await screen.findByText("2 results");

        // The held-back reveal only ever knew My Mail's hit: were it applied now, Charlie would vanish.
        await act(async () => slowMessage.resolve(jsonResponse(200, messageFixture("a", "mb1", { subject: "Alpha" }))));
        await settle();
        expect(screen.getByText("Alpha")).toBeInTheDocument();
        expect(screen.getByText("Charlie")).toBeInTheDocument();
    });

    describe("paging", () => {
        it("pages each mailbox from its own cursor, leaving one with nothing more alone", async () => {
            at("?aggregate=inbox");
            const io = mockIntersectionObserver();
            const fetchMock = mockMail({
                messages: [messageFixture("a", "mb1", { subject: "Alpha" }), messageFixture("b", "mb1", { subject: "Bravo" }), messageFixture("c", "mb2", { subject: "Charlie" })],
                search: pages({
                    "mb1|": { results: [hit("a", 5)], nextCursor: "n1" },
                    "mb1|n1": { results: [hit("b", 4)] },
                    "mb2|": { results: [hit("c", 9)] },
                }),
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");
            await screen.findByText("Charlie");
            await screen.findByText("2 results");
            expect(screen.getByTestId("load-more-sentinel")).toBeInTheDocument();

            act(() => io.trigger());

            expect(await screen.findByText("Bravo")).toBeInTheDocument();
            // The first page's rows stay where they were; the next page is appended.
            expect(rowSubjects(/^(Alpha|Bravo|Charlie)$/)).toEqual(["Charlie", "Alpha", "Bravo"]);
            const mb1Pages = searchCalls(fetchMock).filter((p) => p.get("mailboxUid") === "mb1");
            expect(mb1Pages.map((p) => p.get("cursor"))).toEqual([null, "n1"]);
            // Support had nothing more, so it was not asked again - and with nothing more anywhere, the sentinel is gone.
            expect(searchCalls(fetchMock).filter((p) => p.get("mailboxUid") === "mb2")).toHaveLength(1);
            await waitFor(() => expect(screen.queryByTestId("load-more-sentinel")).not.toBeInTheDocument());
        });

        it("goes on with the mailboxes that answer when one fails to give its next page, and says which", async () => {
            at("?aggregate=inbox");
            const io = mockIntersectionObserver();
            const fetchMock = mockMail({
                messages: [messageFixture("a", "mb1", { subject: "Alpha" }), messageFixture("b", "mb1", { subject: "Bravo" }), messageFixture("c", "mb2", { subject: "Charlie" })],
                search: pages({
                    "mb1|": { results: [hit("a", 5)], nextCursor: "n1" },
                    "mb1|n1": { results: [hit("b", 4)] },
                    "mb2|": { results: [hit("c", 9)], nextCursor: "n2" },
                    "mb2|n2": jsonResponse(500, { message: "boom" }),
                }),
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");
            await screen.findByText("2 results");

            act(() => io.trigger());

            expect(await screen.findByText("Bravo")).toBeInTheDocument();
            expect(screen.getByText("Some results may be missing: Support (server error) could not be searched.")).toBeInTheDocument();
            // Support is given up on for this search; nothing more is asked of it.
            await waitFor(() => expect(screen.queryByTestId("load-more-sentinel")).not.toBeInTheDocument());
            expect(searchCalls(fetchMock).filter((p) => p.get("mailboxUid") === "mb2")).toHaveLength(2);
        });

        it("fails a page, with Retry, when not one mailbox answers", async () => {
            at("?aggregate=inbox");
            const io = mockIntersectionObserver();
            let failing = true;
            mockMail({
                messages: [messageFixture("a", "mb1", { subject: "Alpha" }), messageFixture("b", "mb1", { subject: "Bravo" }), messageFixture("c", "mb2", { subject: "Charlie" })],
                search: (mailboxUid, params) => {
                    if (params.get("cursor")) return failing ? jsonResponse(500, { message: "boom" }) : jsonResponse(200, { results: [hit("b", 4)] });
                    return jsonResponse(200, mailboxUid === "mb1" ? { results: [hit("a", 5)], nextCursor: "n1" } : { results: [hit("c", 9)], nextCursor: "n2" });
                },
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");
            await screen.findByText("2 results");

            act(() => io.trigger());

            expect(await screen.findByText("boom")).toBeInTheDocument();
            expect(screen.queryByText(/Some results may be missing/)).not.toBeInTheDocument();
            failing = false;
            await user.click(screen.getByRole("button", { name: "Retry" }));
            expect(await screen.findByText("Bravo")).toBeInTheDocument();
        });

        it("keeps at most the row cap across all mailboxes: the first page is cut to it, and an appended page stops at it", async () => {
            SEARCH_LIMITS.maxRows = 3;
            at("?aggregate=inbox");
            mockMail({
                messages: ["a", "b", "c", "d"].map((uid, i) => messageFixture(uid, i % 2 === 0 ? "mb1" : "mb2", { subject: `Row ${uid}` })),
                search: pages({
                    "mb1|": { results: [hit("a", 4), hit("c", 2)], nextCursor: "n1" },
                    "mb2|": { results: [hit("b", 3), hit("d", 1)] },
                }),
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");

            expect(await screen.findByText("Showing the most recent 3 messages", { exact: false })).toBeInTheDocument();
            expect(rowSubjects(/^Row [a-d]$/)).toEqual(["Row a", "Row b", "Row c"]);
            expect(screen.queryByTestId("load-more-sentinel")).not.toBeInTheDocument();
        });

        it("stops appending pages at the row cap", async () => {
            SEARCH_LIMITS.maxRows = 3;
            at("?aggregate=inbox");
            const io = mockIntersectionObserver();
            mockMail({
                messages: ["a", "b", "c", "d"].map((uid, i) => messageFixture(uid, i === 1 ? "mb2" : "mb1", { subject: `Row ${uid}` })),
                search: pages({
                    "mb1|": { results: [hit("a", 4)], nextCursor: "n1" },
                    "mb1|n1": { results: [hit("c", 2), hit("d", 1)], nextCursor: "n2" },
                    "mb2|": { results: [hit("b", 3)] },
                }),
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");
            await screen.findByText("2 results");

            act(() => io.trigger());

            expect(await screen.findByText("Showing the most recent 3 messages", { exact: false })).toBeInTheDocument();
            expect(rowSubjects(/^Row [a-d]$/)).toEqual(["Row a", "Row b", "Row c"]);
        });
    });

    it("pages a mailbox's Tier 3 candidates from the cache: what the first page did not hold arrives with the next", async () => {
        at("?aggregate=inbox");
        const io = mockIntersectionObserver();
        // Twenty-six candidates for a share of a page of 25 (two mailboxes): one is left for the next page.
        searchEncryptedCandidates.mockImplementation(async (_parsed: unknown, _unlocked: unknown, _limit: number, options: { mailboxUid: string }) =>
            options.mailboxUid === "mb1"
                ? Array.from({ length: 26 }, (_, i) => hit(`t${i}`, 26 - i, { source: "candidate", metadataOnly: false }))
                : [],
        );
        const fetchMock = mockMail({ messages: [messageFixture("t0", "mb1", { subject: "First" }), messageFixture("t25", "mb1", { subject: "Last" })] });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await searchFor(user, "budget");
        await screen.findByText("First");
        await screen.findByText("1 result");
        expect(screen.queryByText("Last")).not.toBeInTheDocument();
        expect(screen.getByTestId("load-more-sentinel")).toBeInTheDocument();

        act(() => io.trigger());

        expect(await screen.findByText("Last")).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByTestId("load-more-sentinel")).not.toBeInTheDocument());
        // The candidates were decrypted once: the second page is a slice of the first search's answer.
        expect(searchEncryptedCandidates.mock.calls.filter((c) => c[0].text === "budget" && c[3].mailboxUid === "mb1")).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/t25", expect.anything());
    });

    describe("acting on the results", () => {
        function bulkUpdates() {
            const updates: Record<string, unknown>[] = [];
            return { updates, onBulkUpdate: (batch: Record<string, unknown>[]) => void updates.push(...batch) };
        }
        const fixtures = [messageFixture("a", "mb1", { subject: "Alpha" }), messageFixture("c", "mb2", { subject: "Charlie" })];
        const twoHits = pages({ "mb1|": { results: [hit("a", 1)] }, "mb2|": { results: [hit("c", 2)] } });

        it("lets rows be ticked in the results, archives each hit into its own mailbox's Archive, and offers Move to and labels only where they can apply", async () => {
            at("?aggregate=inbox");
            const { updates, onBulkUpdate } = bulkUpdates();
            mockMail({ messages: fixtures, search: twoHits, onBulkUpdate });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");
            await screen.findByText("2 results");

            await user.click(screen.getByRole("button", { name: "Select" }));
            await user.click(await screen.findByRole("checkbox", { name: "Select Alpha" }));
            await user.click(screen.getByRole("checkbox", { name: "Select Charlie" }));

            // A folder belongs to one mailbox, so with both mailboxes ticked there is no one folder to move to; My Mail's labels are not Support's.
            expect(screen.getByRole("button", { name: "Move to" })).toBeDisabled();
            expect(screen.getByRole("button", { name: "Move to" })).toHaveAttribute("title", expect.stringContaining("different mailboxes"));
            expect(screen.getByRole("button", { name: "Apply label" })).toBeDisabled();

            // With only one mailbox's rows ticked they are back: My Mail's are the open mailbox's, whose labels are loaded.
            await user.click(screen.getByRole("checkbox", { name: "Select Charlie" }));
            expect(screen.getByRole("button", { name: "Move to" })).toBeEnabled();
            expect(screen.getByRole("button", { name: "Apply label" })).toBeEnabled();
            // Support's alone can be moved (into Support's folders) but not labelled.
            await user.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
            await user.click(screen.getByRole("checkbox", { name: "Select Charlie" }));
            expect(screen.getByRole("button", { name: "Move to" })).toBeEnabled();
            expect(screen.getByRole("button", { name: "Apply label" })).toBeDisabled();

            // Both again, then archive: each into its own mailbox's Archive.
            await user.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
            await user.click(screen.getByRole("button", { name: "Archive" }));

            await waitFor(() => expect(updates).toHaveLength(2));
            expect(Object.fromEntries(updates.map((u) => [u.uid, u.folderUid]))).toEqual({ a: "mb1-archive", c: "mb2-archive" });
            await waitFor(() => expect(screen.queryByText("Charlie")).not.toBeInTheDocument());
        });

        it("deletes each ticked hit into its own mailbox's Deleted Items", async () => {
            at("?aggregate=inbox");
            const { updates, onBulkUpdate } = bulkUpdates();
            mockMail({ messages: fixtures, search: twoHits, onBulkUpdate });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");
            await screen.findByText("2 results");

            await user.click(screen.getByRole("button", { name: "Select" }));
            await user.click(await screen.findByRole("button", { name: "Select all" }));
            await user.click(screen.getByRole("button", { name: "Delete" }));

            await waitFor(() => expect(updates).toHaveLength(2));
            expect(Object.fromEntries(updates.map((u) => [u.uid, u.folderUid]))).toEqual({ a: "mb1-deleted_items", c: "mb2-deleted_items" });
        });

        it("marks rows read across mailboxes from the selection bar", async () => {
            at("?aggregate=inbox");
            const { updates, onBulkUpdate } = bulkUpdates();
            mockMail({ messages: fixtures.map((m) => ({ ...m, flags: { ...(m.flags as object), read: false } })), search: twoHits, onBulkUpdate });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");
            await screen.findByText("2 results");

            await user.click(screen.getByRole("button", { name: "Select" }));
            await user.click(await screen.findByRole("button", { name: "Select all" }));
            await user.click(screen.getByRole("button", { name: "Mark read" }));

            await waitFor(() => expect(updates.map((u) => u.uid).sort()).toEqual(["a", "c"]));
        });

        it("deletes the open message from the keyboard into its own mailbox's Deleted Items", async () => {
            at("?aggregate=inbox");
            const { updates, onBulkUpdate } = bulkUpdates();
            mockMail({ messages: fixtures, search: twoHits, onBulkUpdate });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");
            await user.click(await screen.findByText("Charlie"));
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("message:c mailbox:mb2");

            fireEvent.keyDown(document.body, { key: "Delete" });

            await waitFor(() => expect(updates).toEqual([expect.objectContaining({ uid: "c", folderUid: "mb2-deleted_items" })]));
            await waitFor(() => expect(screen.queryByText("Charlie")).not.toBeInTheDocument());
        });

        it("deletes the open thread of a hit from another mailbox: that mailbox's conversation, into that mailbox's Deleted Items", async () => {
            at("?aggregate=inbox");
            localStorage.setItem(
                "rapidmx:mail-list-preferences:mb1",
                JSON.stringify({ sortBy: "date", sortOrder: "desc", filter: "all", labelUids: [], showAsConversations: true }),
            );
            const { updates, onBulkUpdate } = bulkUpdates();
            const inThread = [
                messageFixture("a", "mb1", { subject: "Alpha", conversationId: "c1" }),
                messageFixture("c", "mb2", { subject: "Charlie", conversationId: "c1" }),
                messageFixture("c2", "mb2", { subject: "Charlie again", conversationId: "c1", folderUid: "mb2-inbox" }),
            ];
            const fetchMock = mockMail({
                messages: inThread,
                search: twoHits,
                conversations: { "mb1|c1": [inThread[0]], "mb2|c1": [inThread[1], inThread[2]] },
                onBulkUpdate,
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");
            await user.click(await screen.findByRole("button", { name: /Charlie/ }));
            expect(screen.getByTestId("thread-pane")).toHaveTextContent("thread:c1 at:c mailbox:mb2");

            fireEvent.keyDown(document.body, { key: "Delete" });

            // Every message of Support's conversation - in whichever of its folders - into Support's Deleted Items; My Mail's is left alone.
            await waitFor(() => expect(updates.map((u) => u.uid).sort()).toEqual(["c", "c2"]));
            expect(updates.every((u) => u.folderUid === "mb2-deleted_items")).toBe(true);
            expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/mail\/messages\/conversations\/c1\?.*mailboxUid=mb2/), expect.anything());
            await waitFor(() => expect(screen.getByTestId("thread-pane")).toHaveTextContent("no-thread"));
        });

        it("leaves select mode when the search is cleared, since the listing it came from has no selection", async () => {
            at("?aggregate=inbox");
            mockMail({ messages: fixtures, search: twoHits });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");
            await screen.findByText("2 results");
            await user.click(screen.getByRole("button", { name: "Select" }));
            await screen.findByText("0 selected");

            await user.clear(screen.getByPlaceholderText("Search all mail…"));

            await waitFor(() => expect(screen.queryByText("0 selected")).not.toBeInTheDocument());
            expect(screen.getByRole("button", { name: "Select" })).toBeDisabled();
            expect(screen.getByRole("button", { name: "Select" })).toHaveAttribute("title", "Open a mailbox's own folder to select messages");
        });
    });

    describe("from a mailbox's own folder", () => {
        const folderView = "?mailboxUid=mb1&folderUid=mb1-inbox";

        it("still fails the whole search when the one mailbox's Tier 3 fails, and the whole page when its next page fails", async () => {
            at(folderView);
            const io = mockIntersectionObserver();
            searchEncryptedCandidates.mockRejectedValueOnce(new Error("no candidates"));
            let secondPage = false;
            mockMail({
                messages: [messageFixture("a", "mb1", { subject: "Alpha" }), messageFixture("b", "mb1", { subject: "Bravo" })],
                search: (_mailboxUid, params) => {
                    if (params.get("cursor")) {
                        secondPage = true;
                        return jsonResponse(500, { message: "boom" });
                    }
                    return jsonResponse(200, { results: [hit("a", 1)], nextCursor: "n1" });
                },
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");
            expect(await screen.findByText("Search failed.")).toBeInTheDocument();

            // A search whose Tier 3 answers, but whose next page fails, keeps the first page and offers Retry.
            await user.clear(screen.getByPlaceholderText("Search all mail…"));
            await screen.findByText("No messages in this folder.");
            await user.type(screen.getByPlaceholderText("Search all mail…"), "again");
            await screen.findByText("Alpha");
            await screen.findByText("1 result");
            act(() => io.trigger());
            expect(await screen.findByText("boom")).toBeInTheDocument();
            expect(secondPage).toBe(true);
            expect(screen.getByText("Alpha")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
        });
        const table = pages({ "mb1|": { results: [hit("a", 1)] }, "mb2|": { results: [hit("c", 2)] } });
        const messages = [messageFixture("a", "mb1", { subject: "Alpha" }), messageFixture("c", "mb2", { subject: "Charlie" })];

        it("searches only that mailbox, as it always has, and offers to widen the search to every mailbox", async () => {
            at(folderView);
            const fetchMock = mockMail({ messages, search: table });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");
            await screen.findByText("1 result");

            expect(searchedMailboxes(fetchMock)).toEqual(["mb1"]);
            // The whole page, not a share of it.
            expect(searchCalls(fetchMock).every((p) => p.get("limit") === "50")).toBe(true);
            expect(screen.queryByTestId("search-scope")).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Search all mail" })).toBeInTheDocument();
            expect(screen.queryByText("Charlie")).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Search all mailboxes" })).toBeInTheDocument();
        });

        it("widens the search to every mailbox on request, and narrows it back", async () => {
            at(folderView);
            const fetchMock = mockMail({ messages, search: table });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");
            await screen.findByText("1 result");

            await user.click(screen.getByRole("button", { name: "Search all mailboxes" }));

            expect(await screen.findByText("Charlie")).toBeInTheDocument();
            await screen.findByText("2 results");
            expect(screen.getByTestId("search-scope")).toHaveTextContent("All mailboxes");
            expect(searchedMailboxes(fetchMock)).toEqual(["mb1", "mb2"]);
            // Each row says whose it is.
            expect(within(screen.getByText("Charlie").closest("li")!).getByText("Support")).toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Search this mailbox only" }));

            await waitFor(() => expect(screen.queryByText("Charlie")).not.toBeInTheDocument());
            expect(screen.getByText("Alpha")).toBeInTheDocument();
            expect(screen.queryByTestId("search-scope")).not.toBeInTheDocument();
        });

        it("goes back to the open mailbox for the next search once the box is emptied", async () => {
            at(folderView);
            const fetchMock = mockMail({ messages, search: table });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");
            await user.click(await screen.findByRole("button", { name: "Search all mailboxes" }));
            await screen.findByText("2 results");

            await user.clear(screen.getByPlaceholderText("Search all mail…"));
            // Back in the folder listing (which holds none of these), the search is over.
            await screen.findByText("No messages in this folder.");
            const mb2Before = searchCalls(fetchMock).filter((p) => p.get("mailboxUid") === "mb2").length;
            await user.type(screen.getByPlaceholderText("Search all mail…"), "again");
            await screen.findByText("1 result");

            expect(searchCalls(fetchMock).filter((p) => p.get("mailboxUid") === "mb2")).toHaveLength(mb2Before);
            expect(screen.getByRole("button", { name: "Search all mailboxes" })).toBeInTheDocument();
        });

        it("acts on a widened search's hit from another mailbox in that mailbox, with the open mailbox's own filter and sort left as they were", async () => {
            at(folderView);
            const { updates, onBulkUpdate } = (() => {
                const collected: Record<string, unknown>[] = [];
                return { updates: collected, onBulkUpdate: (batch: Record<string, unknown>[]) => void collected.push(...batch) };
            })();
            mockMail({ messages, search: table, onBulkUpdate });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");
            await user.click(await screen.findByRole("button", { name: "Search all mailboxes" }));
            await user.click(await screen.findByText("Charlie"));

            fireEvent.keyDown(document.body, { key: "Delete" });

            await waitFor(() => expect(updates).toEqual([expect.objectContaining({ uid: "c", folderUid: "mb2-deleted_items" })]));
        });

        it("offers no widening to a reader with one mailbox", async () => {
            at(folderView);
            mockMail({ mailboxes: [own], messages, search: table });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");
            await screen.findByText("1 result");

            expect(screen.queryByRole("button", { name: "Search all mailboxes" })).not.toBeInTheDocument();
        });

        it("offers no widening in the All mailboxes view, which is already all of them", async () => {
            at("?aggregate=inbox");
            mockMail({ messages, search: table });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await searchFor(user, "budget");
            await screen.findByText("2 results");

            expect(screen.queryByRole("button", { name: /^Search (all mailboxes|this mailbox only)$/ })).not.toBeInTheDocument();
        });
    });
});
