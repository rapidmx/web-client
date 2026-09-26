// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import ConversationThreadPane from "../../../apps/shared/components/mail/ConversationThreadPane.js";
import { clearResolvedFolders } from "../../../apps/shared/mail/folderOfType.js";
import { getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";

// The More actions menu and Report junk button on the cards of a thread: the real thread pane around real message cards, so what a card's action
// does to the thread (the card leaves it, the caller is told) is what the reader gets. The body's frame, the compose window and the crypto are
// stand-ins, as in the card's own tests.
vi.mock("../../../apps/shared/components/mail/reading/MessageBody.js", () => ({
    default: (props: Record<string, any>) => <div data-testid="body">body of {props.messageUid}</div>,
    BodySkeleton: () => <div data-testid="body-skeleton" />,
}));
vi.mock("../../../apps/shared/components/mail/compose/ComposeContext.js", () => ({ useCompose: () => ({ openCompose: vi.fn() }), prefetchComposeWindow: vi.fn() }));
vi.mock("../../../apps/shared/components/mail/compose/quotedBody.js", () => ({ loadOriginalMessage: vi.fn(), prefetchOriginalMessage: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys: vi.fn(), subscribeKeySession: () => () => undefined }));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({ useUnlockPrompt: () => ({ requestUnlock: vi.fn() }) }));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => ({ moveLocalEntity: vi.fn(), removeLocalEntity: vi.fn() }));

function folder(uid: string, type: string, mailboxUid = "mb1") {
    return { uid, version: 0, dateCreated: "", dateModified: "", mailboxUid, name: type, type, unreadCount: 0, totalCount: 0 };
}

const FOLDERS = [folder("f1", "inbox"), folder("f-junk", "junk"), folder("f-trash", "deleted_items"), folder("f-sent", "sent_items"), folder("f-drafts", "drafts")];

function message(uid: string, sender: string, overrides: Record<string, unknown> = {}) {
    return {
        uid,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        messageId: `${uid}@example.com`,
        subject: "Project Zeus",
        from: { address: `${sender.toLowerCase()}@example.com`, displayName: sender, type: "to" as const },
        recipients: [],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: `2026-01-0${uid.slice(1)}T00:00:00.000Z`,
        bodyPreview: `Preview of ${uid}`,
        flags: { read: true, flagged: false, answered: false, forwarded: false },
        importance: "normal" as const,
        hasAttachments: false,
        ...overrides,
    };
}

function conversation() {
    return { conversationId: "c1", subject: "Project Zeus", messageCount: 2 };
}

function renderThread(thread: unknown[], extra: (url: string, init?: RequestInit) => Response | undefined, props: Partial<React.ComponentProps<typeof ConversationThreadPane>> = {}) {
    const fetchMock = mockFetch((url, init) => {
        const custom = extra(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/messages/conversations/")) return jsonResponse(200, thread);
        return jsonResponse(500, { message: `unexpected ${init?.method ?? "GET"} ${url}` });
    });
    const onMessagePatched = vi.fn();
    const onMessageRemoved = vi.fn();
    render(
        <ConversationThreadPane
            conversation={conversation()}
            mailboxUid="mb1"
            selectedUid="m1"
            folders={FOLDERS as never}
            onMessagePatched={onMessagePatched}
            onMessageRemoved={onMessageRemoved}
            {...props}
        />,
    );
    return { fetchMock, onMessagePatched, onMessageRemoved };
}

/** The card of the message from `sender`, by the buttons it holds. */
async function cardOf(sender: string) {
    const body = await screen.findByText(`body of ${sender}`);
    return within(body.closest(".rounded-lg")!);
}

afterEach(() => {
    clearResolvedFolders();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("a message card in a thread", () => {
    // The thread lists newest first: m2 above m1.
    const THREAD = [message("m1", "Alice"), message("m2", "Bob")];

    it("has the Report junk button and the More actions menu on each expanded card", async () => {
        renderThread(THREAD, () => undefined);
        await screen.findAllByText(/^body of m/);
        expect(screen.getAllByRole("button", { name: "Report junk" })).toHaveLength(2);
        expect(screen.getAllByRole("button", { name: "More actions" })).toHaveLength(2);
    });

    it("takes the card out of the thread and tells the caller when it is reported as junk, leaving the other cards", async () => {
        const { fetchMock, onMessageRemoved } = renderThread(THREAD, (url, init) =>
            url === "/api/mail/messages/m1/report" && init?.method === "POST"
                ? jsonResponse(200, { uid: "m1", kind: "junk", moved: true, folderUid: "f-junk", learned: true })
                : undefined,
        );
        const user = userEvent.setup();
        const card = await cardOf("m1");

        await user.click(card.getByRole("button", { name: "Report junk" }));

        await waitFor(() => expect(onMessageRemoved).toHaveBeenCalledWith(expect.objectContaining({ uid: "m1", folderUid: "f-junk" })));
        expect(JSON.parse(fetchMock.mock.calls.find(([url, init]) => url === "/api/mail/messages/m1/report" && init?.method === "POST")![1].body as string)).toEqual({ kind: "junk" });
        await waitFor(() => expect(screen.queryByText("body of m1")).not.toBeInTheDocument());
        expect(screen.getByText("body of m2")).toBeInTheDocument();
        expect(getNotificationsSnapshot().visible).toEqual([expect.objectContaining({ kind: "success", title: "Reported as junk" })]);
    });

    it("takes the card out of the thread when it is deleted from the menu", async () => {
        const moved = { ...message("m2", "Bob"), version: 1, folderUid: "f-trash" };
        const { onMessageRemoved } = renderThread(THREAD, (url, init) => (url === "/api/mail/messages/m2" && init?.method === "PUT" ? jsonResponse(200, moved) : undefined));
        const user = userEvent.setup();
        const card = await cardOf("m2");
        await user.click(card.getByRole("button", { name: "More actions" }));
        await user.click(screen.getByRole("menuitem", { name: /^Delete/ }));
        await waitFor(() => expect(onMessageRemoved).toHaveBeenCalledWith(moved));
        await waitFor(() => expect(screen.queryByText("body of m2")).not.toBeInTheDocument());
    });

    it("deletes a card that is in Deleted Items for good, after asking, and takes it out of the thread", async () => {
        const trashed = message("m2", "Bob", { folderUid: "f-trash" });
        const { fetchMock, onMessageRemoved } = renderThread([message("m1", "Alice"), trashed], (url, init) => (url === "/api/mail/messages/m2?purge=true" && init?.method === "DELETE" ? new Response(null, { status: 204 }) : undefined));
        const user = userEvent.setup();
        const card = await cardOf("m2");
        await user.click(card.getByRole("button", { name: "More actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Delete permanently" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Delete permanently" })).getByRole("button", { name: "Delete permanently" }));
        await waitFor(() => expect(onMessageRemoved).toHaveBeenCalledWith(trashed));
        expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/mail/messages/m2?purge=true" && init?.method === "DELETE")).toBe(true);
        await waitFor(() => expect(screen.queryByText("body of m2")).not.toBeInTheDocument());
        expect(screen.getByText("body of m1")).toBeInTheDocument();
    });

    it("hands the caller the message and the copy it replaces when it is flagged from the menu, and the card stays", async () => {
        const flagged = { ...message("m2", "Bob"), version: 1, flags: { read: true, flagged: true, answered: false, forwarded: false } };
        const { onMessagePatched } = renderThread(THREAD, (url, init) => (url === "/api/mail/messages/m2" && init?.method === "PUT" ? jsonResponse(200, flagged) : undefined));
        const user = userEvent.setup();
        const card = await cardOf("m2");
        await user.click(card.getByRole("button", { name: "More actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Flag" }));
        await waitFor(() => expect(onMessagePatched).toHaveBeenCalledWith(flagged, expect.objectContaining({ uid: "m2", version: 0 })));
        expect(screen.getByText("body of m2")).toBeInTheDocument();
        await user.click(card.getByRole("button", { name: "More actions" }));
        expect(await screen.findByRole("menuitem", { name: "Unflag" })).toBeInTheDocument();
    });

    it("does not offer Report junk on the card of a message the reader sent, in the same thread", async () => {
        renderThread([message("m1", "Alice"), message("m2", "Bob", { folderUid: "f-sent" })], () => undefined);
        const sent = await cardOf("m2");
        const received = await cardOf("m1");
        expect(sent.queryByRole("button", { name: "Report junk" })).not.toBeInTheDocument();
        expect(received.getByRole("button", { name: "Report junk" })).toBeInTheDocument();
    });

    it("reports a message found by a search over several mailboxes by its uid alone: the server files it in ITS mailbox's Junk, not the open mailbox's", async () => {
        const other = message("m1", "Alice", { mailboxUid: "mb2", folderUid: "g1" });
        const { fetchMock, onMessageRemoved } = renderThread(
            [other],
            (url, init) =>
                url === "/api/mail/messages/m1/report" && init?.method === "POST"
                    ? jsonResponse(200, { uid: "m1", kind: "junk", moved: true, folderUid: "g-junk", learned: false, learnSkipped: "disabled" })
                    : undefined,
            { conversation: { conversationId: "c1", subject: "Project Zeus", messageCount: 1 } },
        );
        const user = userEvent.setup();
        const card = await cardOf("m1");
        await user.click(card.getByRole("button", { name: "Report junk" }));
        await waitFor(() => expect(onMessageRemoved).toHaveBeenCalledWith(expect.objectContaining({ uid: "m1", mailboxUid: "mb2", folderUid: "g-junk" })));
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/mail/folders"))).toBe(false);
    });

    it("moves a message found by a search over several mailboxes into ITS mailbox's Junk, not the open mailbox's, on a server without the report route", async () => {
        const other = message("m1", "Alice", { mailboxUid: "mb2", folderUid: "g1" });
        const moved = { ...other, version: 1, folderUid: "g-junk" };
        const { fetchMock, onMessageRemoved } = renderThread(
            [other],
            (url, init) => {
                if (url === "/api/mail/messages/m1/report") return jsonResponse(404, { message: "Not found" });
                if (url === "/api/mail/folders?limit=200&page=0&mailboxUid=mb2") return jsonResponse(200, [folder("g1", "inbox", "mb2"), folder("g-junk", "junk", "mb2")]);
                if (url === "/api/mail/messages/m1" && init?.method === "PUT") return jsonResponse(200, moved);
                return undefined;
            },
            { conversation: { conversationId: "c1", subject: "Project Zeus", messageCount: 1 } },
        );
        const user = userEvent.setup();
        const card = await cardOf("m1");
        await user.click(card.getByRole("button", { name: "Report junk" }));
        await waitFor(() => expect(onMessageRemoved).toHaveBeenCalledWith(moved));
        expect(JSON.parse(fetchMock.mock.calls.find(([url, init]) => url === "/api/mail/messages/m1" && init?.method === "PUT")![1].body as string).folderUid).toBe("g-junk");
    });
});
