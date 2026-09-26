// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The inbox page's short-lived snapshot of each folder's listing (see `listSnapshots.ts`): a folder shown a moment ago - or Mail
// itself, coming back from another app - paints from it on the first frame and is revalidated behind it; a folder that was not
// shown has a skeleton. Also what the page fetches when the browser is idle after the list has loaded.
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "./testUtils.js";
import InboxPageBase from "../../apps/www/index.js";
import { withTestRouter } from "./routerTestUtils.js";
import { clearListSnapshots, listSnapshotKey, readListSnapshot } from "../../apps/shared/mail/listSnapshots.js";

// Rendered inside a router, as the app's shell does (see routerTestUtils.tsx).
const InboxPage = withTestRouter(InboxPageBase);

vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({
    getUnlockedKeys: vi.fn().mockReturnValue(undefined),
    unlockWithPassword: vi.fn(),
    subscribeKeySession: vi.fn(() => () => undefined),
}));
vi.mock("../../apps/shared/search/searchTier2.js", () => ({ searchLocalIndex: vi.fn().mockResolvedValue({ results: [] }) }));

// The reading pane is `LazyReadingPane`'s business; here it is a line of text naming what it was given.
const panes = vi.hoisted(() => ({ prefetchReadingPane: vi.fn() }));
vi.mock("../../apps/shared/components/mail/LazyReadingPane.js", () => ({
    LazyMessageDetailPane: ({ message }: any) => <p data-testid="detail-pane">{message ? `message:${message.uid}` : "no-message"}</p>,
    LazyConversationThreadPane: ({ conversation }: any) => <p data-testid="thread-pane">{conversation ? `thread:${conversation.conversationId}` : "no-thread"}</p>,
    prefetchReadingPane: panes.prefetchReadingPane,
}));
const compose = vi.hoisted(() => ({ prefetchComposeWindow: vi.fn() }));
vi.mock("../../apps/shared/components/mail/compose/ComposeContext.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../apps/shared/components/mail/compose/ComposeContext.js")>()),
    prefetchComposeWindow: compose.prefetchComposeWindow,
}));
const idle = vi.hoisted(() => ({ whenIdle: vi.fn() }));
vi.mock("@rapidrest/react/client", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidrest/react/client")>()),
    whenIdle: idle.whenIdle,
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
const inboxFolder = { uid: "f1", version: 0, mailboxUid: "mb1", name: "Inbox", type: "inbox", unreadCount: 0, totalCount: 2, syncKeyVersion: 0 };

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

function conversation(id: string, subject: string) {
    return {
        conversationId: id,
        subject,
        messageUids: [`m-${id}`],
        folderUids: ["f1"],
        messageCount: 1,
        unreadCount: 0,
        latestDate: "2026-01-01T00:00:00.000Z",
        participants: [{ address: "sender@example.com", displayName: "Sender One", type: "to" }],
        hasAttachments: false,
        flagged: false,
        latestMessageUid: `m-${id}`,
        latestFrom: { address: "sender@example.com", displayName: "Sender One", type: "to" },
        latestPreview: "Preview",
        latestFolderUid: "f1",
    };
}

/** A listing the test decides when to answer. */
function deferredJson() {
    let resolve!: (body: unknown) => void;
    const promise = new Promise<Response>((res) => {
        resolve = (body) => res(jsonResponse(200, body));
    });
    return { promise, resolve };
}

function mockInbox(listing: (url: string) => Response | Promise<Response>) {
    return mockFetch((url) => {
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
        if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
        if (url.startsWith("/api/mail/messages/conversations")) return listing(url);
        if (url.startsWith("/api/mail/messages")) return listing(url);
        if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
        throw new Error(`unexpected ${url}`);
    });
}

function storeArrangement(showAsConversations: boolean) {
    localStorage.setItem(
        "rapidmx:mail-list-preferences:mb1",
        JSON.stringify({ sortBy: "date", sortOrder: "desc", filter: "all", labelUids: [], showAsConversations }),
    );
}

beforeEach(() => {
    idle.whenIdle.mockImplementation(() => () => undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
    clearListSnapshots();
    panes.prefetchReadingPane.mockClear();
    compose.prefetchComposeWindow.mockClear();
});

describe("InboxPage: a folder shown a moment ago", () => {
    it("shows a skeleton, not the previous text, while a folder that was not shown loads", async () => {
        storeArrangement(false);
        const listing = deferredJson();
        mockInbox(() => listing.promise);
        render(<InboxPage userUid="u1" />);

        const status = await screen.findByText("Loading…");
        expect(status.closest("[role=status]")).toHaveAttribute("aria-busy", "true");
        await act(async () => listing.resolve([message("m1", "First subject")]));
        expect(await screen.findByText("First subject")).toBeInTheDocument();
        expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });

    it("paints the messages from the snapshot on the first frame, and folds the fresh listing in behind them", async () => {
        storeArrangement(false);
        mockInbox(() => jsonResponse(200, [message("m1", "First subject")]));
        const first = render(<InboxPage userUid="u1" />);
        await screen.findByText("First subject");
        await waitFor(() => expect(readListSnapshot(listSnapshotKey({ mailboxUid: "mb1", folderUid: "f1", conversations: false, filter: "all", labels: "", sort: "date:desc" }))).toBeDefined());
        first.unmount();

        // Back again, with the server slow: the rows are there at once, and no skeleton.
        const listing = deferredJson();
        mockInbox(() => listing.promise);
        render(<InboxPage userUid="u1" />);
        expect(await screen.findByText("First subject")).toBeInTheDocument();
        expect(screen.queryByText("Loading…")).not.toBeInTheDocument();

        // The fresh listing has a new message on top of the old one: folded in, nothing replaced.
        await act(async () => listing.resolve([message("m2", "Second subject"), message("m1", "First subject")]));
        expect(await screen.findByText("Second subject")).toBeInTheDocument();
        expect(screen.getByText("First subject")).toBeInTheDocument();
    });

    it("keeps a row the reader changed, takes a newer one, and keeps paging where it was when the fresh listing is a full page", async () => {
        storeArrangement(false);
        mockInbox(() => jsonResponse(200, [message("m1", "First subject", { version: 5 }), message("m2", "Second subject", { version: 1 })]));
        const first = render(<InboxPage userUid="u1" />);
        await screen.findByText("First subject");
        await waitFor(() => expect(readListSnapshot(listSnapshotKey({ mailboxUid: "mb1", folderUid: "f1", conversations: false, filter: "all", labels: "", sort: "date:desc" }))).toBeDefined());
        first.unmount();

        // A full page (50 rows): only the top of a longer folder. m1's copy in it is older than the one the page had, m2's is newer.
        const fresh = [
            message("m1", "First subject (older copy)", { version: 3 }),
            message("m2", "Second subject (newer copy)", { version: 2 }),
            ...Array.from({ length: 48 }, (_, i) => message(`n${i}`, `Newer message ${i}`)),
        ];
        const listing = deferredJson();
        mockInbox(() => listing.promise);
        render(<InboxPage userUid="u1" />);
        await screen.findByText("First subject");
        await act(async () => listing.resolve(fresh));

        expect(await screen.findByText("Second subject (newer copy)")).toBeInTheDocument();
        expect(screen.getByText("First subject")).toBeInTheDocument();
        expect(screen.queryByText("First subject (older copy)")).not.toBeInTheDocument();
        expect(screen.getByText("Newer message 0")).toBeInTheDocument();
    });

    it("does the same for a full page of conversations", async () => {
        storeArrangement(true);
        mockInbox(() => jsonResponse(200, [conversation("c1", "First conversation")]));
        const first = render(<InboxPage userUid="u1" />);
        await screen.findByText("First conversation");
        await waitFor(() =>
            expect(readListSnapshot(listSnapshotKey({ mailboxUid: "mb1", folderUid: "f1", conversations: true, filter: "all", labels: "", sort: "" }))).toBeDefined(),
        );
        first.unmount();

        const listing = deferredJson();
        mockInbox(() => listing.promise);
        render(<InboxPage userUid="u1" />);
        await screen.findByText("First conversation");
        await act(async () =>
            listing.resolve([conversation("c1", "First conversation"), ...Array.from({ length: 49 }, (_, i) => conversation(`x${i}`, `Newer conversation ${i}`))]),
        );
        expect(await screen.findByText("Newer conversation 0")).toBeInTheDocument();
        expect(screen.getByText("First conversation")).toBeInTheDocument();
    });

    it("puts the selection back when the folder is shown again, if that message is still there", async () => {
        storeArrangement(false);
        const user = userEvent.setup();
        mockInbox(() => jsonResponse(200, [message("m1", "First subject"), message("m2", "Second subject")]));
        const first = render(<InboxPage userUid="u1" />);
        await user.click(await screen.findByText("Second subject"));
        await waitFor(() => expect(screen.getByTestId("detail-pane")).toHaveTextContent("message:m2"));
        first.unmount();

        render(<InboxPage userUid="u1" />);
        await waitFor(() => expect(screen.getByTestId("detail-pane")).toHaveTextContent("message:m2"));
    });

    it("forgets a selection whose message is no longer in the folder", async () => {
        storeArrangement(false);
        const user = userEvent.setup();
        mockInbox(() => jsonResponse(200, [message("m1", "First subject"), message("m2", "Second subject")]));
        const first = render(<InboxPage userUid="u1" />);
        await user.click(await screen.findByText("Second subject"));
        await waitFor(() => expect(screen.getByTestId("detail-pane")).toHaveTextContent("message:m2"));
        first.unmount();

        // The message is gone from the folder by the time it is shown again (the stored copy still lists it).
        const listing = deferredJson();
        mockInbox(() => listing.promise);
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Second subject");
        await act(async () => listing.resolve([message("m1", "First subject")]));
        await waitFor(() => expect(screen.getByTestId("detail-pane")).toHaveTextContent("no-message"));
    });

    it("scrolls the list back to where it was left", async () => {
        // jsdom has no layout, so its scrollTop never holds a value; this one does.
        const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
        Object.defineProperty(Element.prototype, "scrollTop", {
            configurable: true,
            get() {
                return (this).__scrollTop ?? 0;
            },
            set(value: number) {
                (this).__scrollTop = value;
            },
        });
        try {
            await scrollsBack();
        } finally {
            Object.defineProperty(Element.prototype, "scrollTop", original!);
        }
    });

    async function scrollsBack() {
        storeArrangement(false);
        mockInbox(() => jsonResponse(200, [message("m1", "First subject")]));
        const first = render(<InboxPage userUid="u1" />);
        await screen.findByText("First subject");
        await waitFor(() => expect(readListSnapshot(listSnapshotKey({ mailboxUid: "mb1", folderUid: "f1", conversations: false, filter: "all", labels: "", sort: "date:desc" }))).toBeDefined());
        const list = document.querySelector<HTMLElement>('[class*="md:w-96"]')!;
        list.scrollTop = 240;
        fireEvent.scroll(list);
        first.unmount();

        const listing = deferredJson();
        mockInbox(() => listing.promise);
        render(<InboxPage userUid="u1" />);
        await screen.findByText("First subject");
        const again = document.querySelector<HTMLElement>('[class*="md:w-96"]')!;
        await waitFor(() => expect(again.scrollTop).toBe(240));
    }

    it("does the same for a list of conversations", async () => {
        storeArrangement(true);
        mockInbox(() => jsonResponse(200, [conversation("c1", "First conversation")]));
        const first = render(<InboxPage userUid="u1" />);
        await screen.findByText("First conversation");
        await waitFor(() =>
            expect(readListSnapshot(listSnapshotKey({ mailboxUid: "mb1", folderUid: "f1", conversations: true, filter: "all", labels: "", sort: "" }))).toBeDefined(),
        );
        first.unmount();

        const listing = deferredJson();
        mockInbox(() => listing.promise);
        render(<InboxPage userUid="u1" />);
        expect(await screen.findByText("First conversation")).toBeInTheDocument();
        expect(screen.queryByText("Loading…")).not.toBeInTheDocument();

        await act(async () => listing.resolve([conversation("c2", "Second conversation"), conversation("c1", "First conversation")]));
        expect(await screen.findByText("Second conversation")).toBeInTheDocument();
        expect(screen.getByText("First conversation")).toBeInTheDocument();
    });

    it("keeps nothing for a search's results", async () => {
        storeArrangement(false);
        const user = userEvent.setup();
        mockInbox((url) => (url.includes("/search") ? jsonResponse(200, { results: [] }) : jsonResponse(200, [message("m1", "First subject")])));
        render(<InboxPage userUid="u1" />);
        await screen.findByText("First subject");
        await waitFor(() => expect(readListSnapshot(listSnapshotKey({ mailboxUid: "mb1", folderUid: "f1", conversations: false, filter: "all", labels: "", sort: "date:desc" }))).toBeDefined());
        // Typing a search leaves the snapshot of the folder alone (a search is not a folder's listing).
        await user.type(screen.getByRole("searchbox"), "hello");
        expect(readListSnapshot(listSnapshotKey({ mailboxUid: "mb1", folderUid: "f1", conversations: false, filter: "all", labels: "", sort: "date:desc" }))).toBeDefined();
    });
});

describe("InboxPage: choosing another folder while searching", () => {
    it("clears the search, as choosing a folder used to by loading a page", async () => {
        storeArrangement(false);
        const user = userEvent.setup();
        const sentFolder = { ...inboxFolder, uid: "f2", name: "Sent Items", type: "sent_items" };
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, sentFolder]);
            if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
            if (url.startsWith("/api/mail/messages")) return jsonResponse(200, url.includes("folderUid=f2") ? [message("m9", "Sent subject", { folderUid: "f2" })] : [message("m1", "First subject")]);
            if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
            return jsonResponse(404, {});
        });
        // The folder link is only taken over (no page load, and the page kept) inside the router.
        render(<InboxPage userUid="u1" />);
        await screen.findByText("First subject");
        const search = screen.getByRole("searchbox");
        await user.type(search, "hello");
        expect(search).toHaveValue("hello");

        await user.click(await screen.findByRole("link", { name: /Sent Items/ }));
        await waitFor(() => expect(screen.getByRole("searchbox")).toHaveValue(""));
        expect(await screen.findByText("Sent subject")).toBeInTheDocument();
    });
});

describe("InboxPage: what it fetches when the browser is idle", () => {
    it("fetches the reading pane's and the compose window's code once the list is on screen", async () => {
        storeArrangement(false);
        const cancel = vi.fn();
        const works: (() => void)[] = [];
        idle.whenIdle.mockImplementation((work: () => void) => {
            works.push(work);
            return cancel;
        });
        const listing = deferredJson();
        mockInbox(() => listing.promise);
        const { unmount } = render(<InboxPage userUid="u1" />);
        await screen.findByText("Loading…");
        expect(panes.prefetchReadingPane).not.toHaveBeenCalled();

        await act(async () => listing.resolve([message("m1", "First subject")]));
        await screen.findByText("First subject");
        expect(works.length).toBeGreaterThan(0);
        works[works.length - 1]();
        expect(panes.prefetchReadingPane).toHaveBeenCalledTimes(1);
        expect(compose.prefetchComposeWindow).toHaveBeenCalledTimes(1);
        unmount();
        expect(cancel).toHaveBeenCalled();
    });
});
