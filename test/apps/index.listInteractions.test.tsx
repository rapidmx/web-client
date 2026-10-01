// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The mail list's own behaviour: its three independently scrolling columns with the toolbar, search box and tabs pinned above the rows, rows that
// collapse away (instead of the list reloading) when a message leaves it, and Shift/Ctrl/Cmd+click multi-select.
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "./testUtils.js";
import InboxPageBase from "../../apps/www/index.js";
import { withTestRouter } from "./routerTestUtils.js";
import { clearListSnapshots } from "../../apps/shared/mail/listSnapshots.js";
import { ROW_EXIT_MS } from "../../apps/shared/mail/rowExit.js";

// Rendered inside a router, as the app's shell does (see routerTestUtils.tsx).
const InboxPage = withTestRouter(InboxPageBase);

vi.mock("../../lib/crypto/keySession.js", () => ({
    getUnlockedKeys: vi.fn().mockReturnValue(undefined),
    unlockWithPassword: vi.fn(),
    subscribeKeySession: vi.fn(() => () => undefined),
}));
vi.mock("../../apps/shared/search/searchTier2.js", () => ({ searchLocalIndex: vi.fn().mockResolvedValue({ results: [] }) }));

// The reading panes are stand-ins that can report a message as moved away, the way the real ones do from their Move/Archive/Delete actions.
vi.mock("../../apps/shared/components/mail/LazyReadingPane.js", () => ({
    LazyMessageDetailPane: ({ message, onMoved }: any) => (
        <div>
            <p data-testid="detail-pane">{message ? `message:${message.uid}` : "no-message"}</p>
            {message && <button onClick={() => onMoved({ ...message, folderUid: "f6" })}>simulate-move</button>}
        </div>
    ),
    LazyConversationThreadPane: ({ conversation, onMessageRemoved }: any) => (
        <div>
            <p data-testid="thread-pane">{conversation ? `thread:${conversation.conversationId}` : "no-thread"}</p>
            {conversation && <button onClick={() => onMessageRemoved({ uid: "m-c1a" })}>simulate-message-removed</button>}
        </div>
    ),
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
const inboxFolder = { uid: "f1", version: 0, mailboxUid: "mb1", name: "Inbox", type: "inbox", unreadCount: 0, totalCount: 4, syncKeyVersion: 0 };
const deletedFolder = { ...inboxFolder, uid: "f6", name: "Deleted Items", type: "deleted_items", totalCount: 0 };

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

const SUBJECTS = ["First", "Second", "Third", "Fourth", "Fifth"];
const flatMessages = () => SUBJECTS.map((subject, index) => message(`m${index + 1}`, subject));
const conversationSubjects = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
const allConversations = () => conversationSubjects.map((subject, index) => conversation(`c${index + 1}`, subject, [`m-c${index + 1}`]));

/**
 * A mailbox whose Inbox holds `messages` / `conversations`; a bulk move (Delete) takes the messages out of what the server lists from then on, as the real
 * server would, so a refetch after it shows the truth.
 */
function mockMail(messages: any[] = flatMessages(), conversations: any[] = []) {
    const gone = new Set<string>();
    const listed = () => messages.filter((m) => !gone.has(m.uid));
    const listedConversations = () => conversations.filter((c) => !c.messageUids.every((uid: string) => gone.has(uid)));
    const fetchMock = mockFetch((url, init) => {
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, deletedFolder]);
        if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
        if (url.startsWith("/api/mail/messages/conversations/")) {
            const id = decodeURIComponent(url.slice("/api/mail/messages/conversations/".length).split("?")[0]);
            const thread = conversations.find((c) => c.conversationId === id);
            return jsonResponse(
                200,
                thread ? thread.messageUids.map((uid: string) => message(uid, thread.subject, { conversationId: id })) : [],
            );
        }
        if (url.startsWith("/api/mail/messages/conversations")) return jsonResponse(200, listedConversations());
        if (url.startsWith("/api/mail/messages") && init?.method === "PUT") {
            const updates = JSON.parse(init.body as string) as { uid: string; folderUid?: string }[];
            for (const update of updates) {
                if (update.folderUid) gone.add(update.uid);
            }
            return jsonResponse(
                200,
                updates.map((update) => ({ ...(messages.find((m) => m.uid === update.uid) ?? message(update.uid, "Moved")), ...update })),
            );
        }
        if (url.startsWith("/api/mail/messages")) return jsonResponse(200, listed());
        if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
    return fetchMock;
}

/** The listing calls of a mock, by kind. */
const conversationListings = (fetchMock: ReturnType<typeof mockMail>) =>
    fetchMock.mock.calls.filter(([url]: [string]) => url.startsWith("/api/mail/messages/conversations?")).length;
const bulkPuts = (fetchMock: ReturnType<typeof mockMail>) =>
    fetchMock.mock.calls
        .filter(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT")
        .map(([, init]: [string, RequestInit]) => JSON.parse(init.body as string));

function storeArrangement(showAsConversations: boolean, overrides: Record<string, unknown> = {}) {
    localStorage.setItem(
        "rapidmx:mail-list-preferences:mb1",
        JSON.stringify({ sortBy: "date", sortOrder: "desc", filter: "all", labelUids: [], showAsConversations, ...overrides }),
    );
}

/** A browser whose reader has asked for less motion (and is otherwise a desktop). */
function stubReducedMotion() {
    vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    }));
}

const rowOf = (subject: string) => screen.getByText(subject).closest("li") as HTMLElement;

/** Clicks `element` with the given modifier keys held ("Shift", "Control", "Meta"). */
async function clickWith(user: ReturnType<typeof userEvent.setup>, element: Element, ...keys: string[]) {
    for (const key of keys) await user.keyboard(`{${key}>}`);
    await user.click(element);
    for (const key of keys.reverse()) await user.keyboard(`{/${key}}`);
}

const ticked = () =>
    screen
        .queryAllByRole("checkbox")
        .filter((box) => (box as HTMLInputElement).checked)
        .map((box) => box.getAttribute("aria-label"));

beforeEach(() => {
    clearListSnapshots();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (Element.prototype as { animate?: unknown }).animate;
});

describe("InboxPage: columns that scroll by themselves", () => {
    it("keeps the toolbar, the search box and the tabs outside the list's scroller, which holds only the rows", async () => {
        storeArrangement(false, { filter: "focused" });
        mockMail();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("First");

        const column = screen.getByTestId("mail-list-column");
        const header = screen.getByTestId("mail-list-header");
        const scroller = screen.getByTestId("mail-list-scroll");
        // A column of the window's height that is not itself a scroller: a fixed header block, then the one scrolling child.
        expect(column.className).toContain("flex-col");
        expect(column.className).toContain("min-h-0");
        expect(column.className).not.toContain("overflow-y-auto");
        expect([...column.children]).toEqual([header, scroller]);
        for (const name of ["flex-1", "min-h-0", "overflow-y-auto"]) expect(scroller.className).toContain(name);
        expect(header.className).toContain("shrink-0");

        expect(within(header).getByRole("button", { name: "Select" })).toBeInTheDocument();
        expect(within(header).getByRole("searchbox", { name: "Search all mail" })).toBeInTheDocument();
        expect(within(header).getByRole("button", { name: "Focused" })).toBeInTheDocument();
        expect(within(header).queryByText("First")).not.toBeInTheDocument();
        expect(within(scroller).getByText("First")).toBeInTheDocument();
        expect(within(scroller).queryByRole("searchbox")).not.toBeInTheDocument();
    });

    it("keeps the selection bar pinned too while rows are being selected", async () => {
        storeArrangement(false);
        mockMail();
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("First");

        await user.click(screen.getByRole("button", { name: "Select" }));

        expect(within(screen.getByTestId("mail-list-header")).getByRole("button", { name: "Select all" })).toBeInTheDocument();
        expect(within(screen.getByTestId("mail-list-scroll")).queryByRole("button", { name: "Select all" })).not.toBeInTheDocument();
    });

    it("gives the folder sidebar and the content beside it the window's height, so each scrolls by itself", async () => {
        storeArrangement(false);
        mockMail();
        const { container } = render(<InboxPage userUid="u1" />);
        await screen.findByText("First");

        const height = "md:h-[calc(100dvh_-_var(--rr-header-h,4rem))]";
        expect(container.querySelector("aside")!.className).toContain(height);
        expect(screen.getByRole("main").className).toContain(height);
        expect(screen.getByRole("main").className).toContain("overflow-y-auto");
    });
});

describe("InboxPage: rows leaving the list", () => {
    function animating() {
        const animate = vi.fn();
        Element.prototype.animate = animate;
        return animate;
    }

    it("collapses a moved message's row, then drops it, without reloading the list", async () => {
        storeArrangement(false);
        const animate = animating();
        const fetchMock = mockMail();
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<InboxPage userUid="u1" />);
        await screen.findByText("First");
        const second = rowOf("Second");
        await user.click(screen.getByText("Second"));
        await screen.findByText("message:m2");
        const listings = fetchMock.mock.calls.length;

        await user.click(screen.getByRole("button", { name: "simulate-move" }));

        // On its way out: still listed, collapsing, hidden from assistive technology and out of reach of the pointer.
        expect(second).toBeInTheDocument();
        expect(second).toHaveAttribute("data-exiting", "true");
        expect(second).toHaveAttribute("aria-hidden", "true");
        expect(second).toHaveAttribute("inert");
        expect(second.className).toContain("pointer-events-none");
        expect(animate).toHaveBeenCalledTimes(1);
        expect(animate.mock.calls[0][1]).toMatchObject({ duration: ROW_EXIT_MS });
        expect(screen.getByTestId("detail-pane")).toHaveTextContent("no-message");
        await act(async () => {
            vi.advanceTimersByTime(ROW_EXIT_MS);
        });

        expect(second).not.toBeInTheDocument();
        expect(screen.getByText("Third")).toBeInTheDocument();
        expect(screen.getByText("First")).toBeInTheDocument();
        // Nothing was refetched to get there.
        expect(fetchMock.mock.calls.length).toBe(listings);
    });

    it("collapses every row of a bulk delete together", async () => {
        storeArrangement(false);
        animating();
        const fetchMock = mockMail();
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<InboxPage userUid="u1" />);
        await screen.findByText("First");
        await user.click(screen.getByRole("button", { name: "Select" }));
        await user.click(screen.getByRole("checkbox", { name: "Select First" }));
        await user.click(screen.getByRole("checkbox", { name: "Select Third" }));

        await user.click(screen.getByRole("button", { name: "Delete" }));

        await waitFor(() => expect(rowOf("First")).toHaveAttribute("data-exiting", "true"));
        expect(rowOf("Third")).toHaveAttribute("data-exiting", "true");
        expect(rowOf("Second")).not.toHaveAttribute("data-exiting");
        expect(bulkPuts(fetchMock)).toHaveLength(1);
        await act(async () => {
            vi.advanceTimersByTime(ROW_EXIT_MS);
        });
        expect(screen.queryByText("First")).not.toBeInTheDocument();
        expect(screen.queryByText("Third")).not.toBeInTheDocument();
        expect(screen.getByText("Second")).toBeInTheDocument();
    });

    it("removes the row at once when the reader prefers reduced motion", async () => {
        storeArrangement(false);
        const animate = animating();
        stubReducedMotion();
        mockMail();
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("First");
        await user.click(screen.getByText("Second"));
        await screen.findByText("message:m2");

        await user.click(screen.getByRole("button", { name: "simulate-move" }));

        expect(screen.queryByText("Second")).not.toBeInTheDocument();
        expect(animate).not.toHaveBeenCalled();
    });

    it("removes the row at once in a browser that cannot animate", async () => {
        storeArrangement(false);
        mockMail();
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("First");
        await user.click(screen.getByText("Second"));
        await screen.findByText("message:m2");

        await user.click(screen.getByRole("button", { name: "simulate-move" }));

        expect(screen.queryByText("Second")).not.toBeInTheDocument();
    });

    it("collapses a deleted conversation and then refreshes the list quietly, keeping the other rows", async () => {
        storeArrangement(true);
        animating();
        const fetchMock = mockMail([], allConversations());
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Alpha");
        const bravo = rowOf("Bravo");
        const charlie = rowOf("Charlie");
        await user.click(screen.getByRole("button", { name: "Select" }));
        await user.click(screen.getByRole("checkbox", { name: "Select conversation: Bravo" }));
        const listings = conversationListings(fetchMock);

        await user.click(screen.getByRole("button", { name: "Delete" }));

        await waitFor(() => expect(bravo).toHaveAttribute("data-exiting", "true"));
        expect(bravo).toHaveAttribute("aria-hidden", "true");
        expect(charlie).not.toHaveAttribute("data-exiting");
        // Still on screen, not yet refetched: the collapse comes first.
        expect(bravo).toBeInTheDocument();
        expect(conversationListings(fetchMock)).toBe(listings);
        await act(async () => {
            vi.advanceTimersByTime(ROW_EXIT_MS);
        });

        expect(bravo).not.toBeInTheDocument();
        await waitFor(() => expect(conversationListings(fetchMock)).toBe(listings + 1));
        // The same row elements throughout: the list never went back to its skeleton.
        expect(screen.getByText("Charlie").closest("li")).toBe(charlie);
        expect(screen.queryByRole("status", { busy: true })).not.toBeInTheDocument();
        expect(screen.getByText("Echo")).toBeInTheDocument();
    });

    it("refreshes the conversation list quietly, without removing rows, after a bulk action that only changes them", async () => {
        storeArrangement(true);
        const fetchMock = mockMail([], allConversations());
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Alpha");
        const alpha = rowOf("Alpha");
        await user.click(screen.getByRole("button", { name: "Select" }));
        await user.click(screen.getByRole("checkbox", { name: "Select conversation: Alpha" }));
        const listings = conversationListings(fetchMock);

        await user.click(screen.getByRole("button", { name: "Flag" }));

        await waitFor(() => expect(conversationListings(fetchMock)).toBe(listings + 1));
        expect(rowOf("Alpha")).toBe(alpha);
    });

    it("keeps a conversation that still has messages elsewhere when the pane moves one of them, and refreshes it", async () => {
        storeArrangement(true);
        animating();
        const fetchMock = mockMail([], [conversation("c1", "Alpha", ["m-c1a", "m-c1b"]), ...allConversations().slice(1)]);
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Alpha");
        const alpha = rowOf("Alpha");
        await user.click(screen.getByText("Alpha"));
        await screen.findByText("thread:c1");
        const listings = conversationListings(fetchMock);

        await user.click(screen.getByRole("button", { name: "simulate-message-removed" }));

        await waitFor(() => expect(conversationListings(fetchMock)).toBe(listings + 1));
        expect(rowOf("Alpha")).toBe(alpha);
        expect(alpha).not.toHaveAttribute("data-exiting");
    });

    it("drops the result of a bulk action that finished after another folder was opened", async () => {
        storeArrangement(true);
        animating();
        let releaseMove!: () => void;
        const held = new Promise<void>((resolve) => (releaseMove = resolve));
        const fetchMock = mockMail([], allConversations());
        const inner = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url === "/api/mail/messages" && init?.method === "PUT") await held;
            return inner(url, init);
        });
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Alpha");
        await user.click(screen.getByRole("button", { name: "Select" }));
        await user.click(screen.getByRole("checkbox", { name: "Select conversation: Alpha" }));
        await user.click(screen.getByRole("button", { name: "Delete" }));

        // The reader opens another folder while the move is on the wire: a different listing is loaded.
        fireEvent.click(screen.getAllByRole("link", { name: /Deleted Items/ })[0]);
        await act(async () => releaseMove());

        await waitFor(() => expect(bulkPuts(fetchMock)).toHaveLength(1));
        expect(document.querySelector("[data-exiting]")).toBeNull();
    });

    it("drops the collapse of rows when another listing was opened while they were leaving", async () => {
        storeArrangement(true);
        animating();
        const fetchMock = mockMail([], allConversations());
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Alpha");
        await user.click(screen.getByRole("button", { name: "Select" }));
        await user.click(screen.getByRole("checkbox", { name: "Select conversation: Alpha" }));
        await user.click(screen.getByRole("button", { name: "Delete" }));
        await waitFor(() => expect(rowOf("Alpha")).toHaveAttribute("data-exiting", "true"));

        // Another listing replaces this one inside the collapse window.
        fireEvent.click(screen.getAllByRole("link", { name: /Deleted Items/ })[0]);
        await waitFor(() => expect(conversationListings(fetchMock)).toBeGreaterThan(1));
        const listings = conversationListings(fetchMock);
        await act(async () => {
            vi.advanceTimersByTime(ROW_EXIT_MS);
        });

        // No quiet refresh of the conversation list for the listing that is gone.
        expect(conversationListings(fetchMock)).toBe(listings);
    });
});

describe("InboxPage: Shift+click and Ctrl+click", () => {
    async function renderFlat() {
        storeArrangement(false);
        const fetchMock = mockMail();
        const user = userEvent.setup();
        render(<InboxPage userUid="u1" />);
        await screen.findByText("First");
        return { user, fetchMock };
    }

    it("selects just the clicked row with Ctrl+click, entering select mode without opening it", async () => {
        const { user } = await renderFlat();

        await clickWith(user, screen.getByText("Second"), "Control");

        expect(ticked()).toEqual(["Select Second"]);
        expect(screen.getByTestId("detail-pane")).toHaveTextContent("no-message");
        await clickWith(user, screen.getByText("Fourth"), "Control");
        expect(ticked()).toEqual(["Select Second", "Select Fourth"]);
        // Ctrl+click on a selected row takes it out again.
        await clickWith(user, screen.getByText("Second"), "Control");
        expect(ticked()).toEqual(["Select Fourth"]);
    });

    it("treats Cmd+click like Ctrl+click", async () => {
        const { user } = await renderFlat();

        await clickWith(user, screen.getByText("Third"), "Meta");

        expect(ticked()).toEqual(["Select Third"]);
    });

    it("selects the rows between the last clicked row and the Shift+clicked one, in either direction", async () => {
        const { user } = await renderFlat();
        await clickWith(user, screen.getByText("Second"), "Control");

        await clickWith(user, screen.getByText("Fourth"), "Shift");
        expect(ticked()).toEqual(["Select Second", "Select Third", "Select Fourth"]);

        // The anchor stays on Second: a plain Shift+click replaces the range with the new one from it.
        await clickWith(user, screen.getByText("First"), "Shift");
        expect(ticked()).toEqual(["Select First", "Select Second"]);
    });

    it("adds to the selection with Ctrl+Shift+click instead of replacing it", async () => {
        const { user } = await renderFlat();
        await clickWith(user, screen.getByText("First"), "Control");
        await clickWith(user, screen.getByText("Fifth"), "Control");
        // Anchor: Fifth.
        await clickWith(user, screen.getByText("Third"), "Shift", "Control");

        expect(ticked()).toEqual(["Select First", "Select Third", "Select Fourth", "Select Fifth"]);
    });

    it("starts a range at the open message when nothing was clicked since", async () => {
        const { user } = await renderFlat();
        await user.click(screen.getByText("Second"));
        await screen.findByText("message:m2");

        await clickWith(user, screen.getByText("Fourth"), "Shift");

        expect(ticked()).toEqual(["Select Second", "Select Third", "Select Fourth"]);
    });

    it("selects just the clicked row when Shift+clicked with nothing open and nothing clicked before", async () => {
        const { user } = await renderFlat();

        await clickWith(user, screen.getByText("Fifth"), "Shift");

        expect(ticked()).toEqual(["Select Fifth"]);
    });

    it("re-spans from the row last clicked once a plain click in select mode has moved the anchor", async () => {
        const { user } = await renderFlat();
        await user.click(screen.getByRole("button", { name: "Select" }));
        await user.click(screen.getByRole("checkbox", { name: "Select Fourth" }));

        await clickWith(user, screen.getByRole("checkbox", { name: "Select Second" }), "Shift");

        expect(ticked()).toEqual(["Select Second", "Select Third", "Select Fourth"]);
    });

    it("keeps a plain click opening the message", async () => {
        const { user } = await renderFlat();

        await user.click(screen.getByText("Third"));

        expect(await screen.findByText("message:m3")).toBeInTheDocument();
        expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    });

    it("stops the browser selecting text when a row is Shift+clicked", async () => {
        await renderFlat();

        expect(fireEvent.mouseDown(screen.getByText("Second"), { shiftKey: true })).toBe(false);
        expect(fireEvent.mouseDown(screen.getByText("Second"))).toBe(true);
    });

    it("acts on the whole range, in the order the list shows it", async () => {
        const { user, fetchMock } = await renderFlat();
        await clickWith(user, screen.getByText("Second"), "Control");
        await clickWith(user, screen.getByText("Fourth"), "Shift");

        await user.click(screen.getByRole("button", { name: "Delete" }));

        await waitFor(() => expect(bulkPuts(fetchMock)).toHaveLength(1));
        expect(bulkPuts(fetchMock)[0].map((update: { uid: string }) => update.uid)).toEqual(["m2", "m3", "m4"]);
    });

    describe("in the conversation list", () => {
        async function renderThreads() {
            storeArrangement(true);
            const fetchMock = mockMail([], allConversations());
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Alpha");
            return { user, fetchMock };
        }
        const tickedConversations = () => ticked().map((label) => label!.replace("Select conversation: ", ""));

        it("selects just the Ctrl+clicked conversation and enters select mode", async () => {
            const { user } = await renderThreads();

            await clickWith(user, screen.getByText("Bravo"), "Control");
            await clickWith(user, screen.getByText("Delta"), "Control");

            expect(tickedConversations()).toEqual(["Bravo", "Delta"]);
            expect(screen.getByTestId("thread-pane")).toHaveTextContent("no-thread");
            await clickWith(user, screen.getByText("Bravo"), "Control");
            expect(tickedConversations()).toEqual(["Delta"]);
        });

        it("selects the conversations between the anchor and the Shift+clicked one, and acts on their messages", async () => {
            const { user, fetchMock } = await renderThreads();
            await clickWith(user, screen.getByText("Bravo"), "Control");

            await clickWith(user, screen.getByText("Delta"), "Shift");

            expect(tickedConversations()).toEqual(["Bravo", "Charlie", "Delta"]);
            await user.click(screen.getByRole("button", { name: "Delete" }));
            await waitFor(() => expect(bulkPuts(fetchMock)).toHaveLength(1));
            expect(bulkPuts(fetchMock)[0].map((update: { uid: string }) => update.uid)).toEqual(["m-c2", "m-c3", "m-c4"]);
        });

        it("starts a range at the open conversation, and extends a selection with Ctrl+Shift", async () => {
            const { user } = await renderThreads();
            await user.click(screen.getByText("Bravo"));
            await screen.findByText("thread:c2");

            await clickWith(user, screen.getByText("Charlie"), "Shift");
            expect(tickedConversations()).toEqual(["Bravo", "Charlie"]);

            await clickWith(user, screen.getByText("Echo"), "Shift", "Control");
            expect(tickedConversations()).toEqual(["Bravo", "Charlie", "Delta", "Echo"]);
        });

        it("honours Shift and Ctrl on a conversation's checkbox, and a plain click there still ticks it", async () => {
            const { user } = await renderThreads();
            await user.click(screen.getByRole("button", { name: "Select" }));
            await user.click(screen.getByRole("checkbox", { name: "Select conversation: Alpha" }));

            await clickWith(user, screen.getByRole("checkbox", { name: "Select conversation: Charlie" }), "Shift");
            expect(tickedConversations()).toEqual(["Alpha", "Bravo", "Charlie"]);

            await clickWith(user, screen.getByRole("checkbox", { name: "Select conversation: Echo" }), "Control");
            expect(tickedConversations()).toEqual(["Alpha", "Bravo", "Charlie", "Echo"]);
        });
    });
});
