// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockIntersectionObserver, mockLocation, mockMatchMedia } from "./testUtils.js";
import InboxPage from "../../apps/www/index.js";

// `MessageDetailPane`'s own exhaustive rendering (header fields, attachments, back link, iframe,
// formatting) is tested in its own `MessageDetailPane.test.tsx` — mocked here to a thin stand-in so this
// file only exercises `InboxPage`/`InboxContent`'s own concerns: the message list, loading/error/empty
// states, and the desktop-vs-mobile selection branch.
vi.mock("../../apps/shared/components/mail/MessageDetailPane.js", () => ({
    default: ({
        message,
        isSentItems,
        onRecalled,
        isOutbox,
        draftsFolderUid,
        onScheduledSendCanceled,
        isInbox,
        onClassified,
        onReceiptHandled,
    }: {
        message: Record<string, unknown> | null;
        isSentItems?: boolean;
        onRecalled?: (updated: Record<string, unknown>) => void;
        isOutbox?: boolean;
        draftsFolderUid?: string;
        onScheduledSendCanceled?: (updated: Record<string, unknown>) => void;
        isInbox?: boolean;
        onClassified?: (updated: Record<string, unknown>) => void;
        onReceiptHandled?: (updated: Record<string, unknown>) => void;
    }) => (
        <div data-testid="detail-pane">
            {message ? `message:${message.uid}` : "no-message"} sentItems:{String(!!isSentItems)} outbox:{String(!!isOutbox)}{" "}
            inbox:{String(!!isInbox)} draftsFolderUid:{draftsFolderUid ?? "unset"}
            {message && onRecalled && (
                <button type="button" onClick={() => onRecalled({ ...message, recallRequestedAt: "2026-01-02T00:00:00.000Z" })}>
                    simulate-recall
                </button>
            )}
            {message && onScheduledSendCanceled && (
                <button
                    type="button"
                    onClick={() => onScheduledSendCanceled({ ...message, folderUid: draftsFolderUid, scheduledSendTime: undefined })}
                >
                    simulate-cancel-scheduled-send
                </button>
            )}
            {message && onClassified && (
                <button type="button" onClick={() => onClassified({ ...message, inferenceClassification: "other" })}>
                    simulate-classify
                </button>
            )}
            {message && onReceiptHandled && (
                <button type="button" onClick={() => onReceiptHandled({ ...message, deliveryReceiptPending: false })}>
                    simulate-receipt-handled
                </button>
            )}
        </div>
    ),
}));

// `ConversationThreadPane`'s own exhaustive rendering (fetching every message, expand/collapse,
// lazy attachment/mark-read) is tested in its own `ConversationThreadPane.test.tsx` — mocked here for
// the same reason `MessageDetailPane` is: this file only exercises `InboxContent`'s own concerns, here
// the "By date"/"By conversation" toggle and conversation-list selection wiring.
vi.mock("../../apps/shared/components/mail/ConversationThreadPane.js", () => ({
    default: ({ conversation }: { conversation: { conversationId: string } | null }) => (
        <div data-testid="thread-pane">{conversation ? `conversation:${conversation.conversationId}` : "no-conversation"}</div>
    ),
}));

const mailbox = {
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
};
const inboxFolder = {
    uid: "f1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    name: "Inbox",
    type: "inbox" as const,
    unreadCount: 0,
    totalCount: 2,
};
const sentItemsFolder = { ...inboxFolder, uid: "f2", name: "Sent Items", type: "sent_items" as const };
const outboxFolder = { ...inboxFolder, uid: "f3", name: "Outbox", type: "outbox" as const };
const draftsFolder = { ...inboxFolder, uid: "f4", name: "Drafts", type: "drafts" as const };

function messageFixture(overrides: Record<string, unknown> = {}) {
    return {
        uid: "m1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        messageId: "abc@example.com",
        subject: "Hello there",
        from: { address: "sender@example.com", displayName: "Sender One", type: "to" as const },
        recipients: [{ address: "u1@example.com", displayName: "Me", type: "to" as const }],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: "2026-01-01T00:00:00.000Z",
        bodyPreview: "Hi there, just checking in.",
        flags: { read: false, flagged: false, answered: false, forwarded: false },
        importance: "normal" as const,
        hasAttachments: false,
        ...overrides,
    };
}

function conversationFixture(overrides: Record<string, unknown> = {}) {
    return {
        conversationId: "c1",
        subject: "Hello there",
        messageUids: ["m1"],
        folderUids: ["f1"],
        messageCount: 1,
        unreadCount: 0,
        latestDate: "2026-01-01T00:00:00.000Z",
        participants: [{ address: "sender@example.com", displayName: "Sender One", type: "to" as const }],
        hasAttachments: false,
        ...overrides,
    };
}

function mockShellAndInbox(
    messages: unknown[],
    extra?: (url: string, init?: RequestInit) => Response | undefined,
    conversations: unknown[] = [],
) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
        if (url.startsWith("/api/mail/messages/conversations")) return jsonResponse(200, conversations);
        if (url.startsWith("/api/mail/messages/")) {
            const method = init?.method ?? "GET";
            const uid = url.split("/api/mail/messages/")[1];
            if (method === "PUT") {
                const body = JSON.parse(init.body as string);
                const existing = messages.find((m: any) => m.uid === uid) as any;
                return jsonResponse(200, { ...existing, flags: { ...existing.flags, ...body.flags } });
            }
            if (method === "GET") {
                const existing = messages.find((m: any) => m.uid === uid);
                return existing ? jsonResponse(200, existing) : jsonResponse(404, { message: "not found" });
            }
        }
        if (url.startsWith("/api/mail/messages")) return jsonResponse(200, messages);
        if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("InboxPage", () => {
    it("shows a message when no mailbox is available yet", async () => {
        mockFetch((url) => {
            // Checked before the general "/api/mail/mailboxes" prefix below, which would otherwise also
            // match this sub-path and hand `MailboxProvisioning` the mailbox list as if it were its own
            // response shape. 404 matches this feature's real default (disabled unless configured).
            if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, []);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        render(<InboxPage userUid="u1" />);
        expect(await screen.findByText("No mailbox available")).toBeInTheDocument();
        expect(screen.getByText("Ask an administrator to create one for you.")).toBeInTheDocument();
        expect(screen.queryByRole("navigation", { name: "Apps" })).not.toBeInTheDocument();
    });

    it("shows a loading indicator while messages are being fetched", async () => {
        let resolveMessages: ((value: unknown[]) => void) | undefined;
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
            if (url.startsWith("/api/mail/messages")) {
                return new Promise((resolve) => {
                    resolveMessages = (value) => resolve(jsonResponse(200, value));
                });
            }
            throw new Error(`unexpected ${url}`);
        });
        render(<InboxPage userUid="u1" />);
        expect(await screen.findByText("Loading…")).toBeInTheDocument();
        resolveMessages!([]);
        expect(await screen.findByText("No messages in this folder.")).toBeInTheDocument();
    });

    it("shows an empty-state message when the folder has no messages", async () => {
        mockShellAndInbox([]);
        render(<InboxPage userUid="u1" />);
        expect(await screen.findByText("No messages in this folder.")).toBeInTheDocument();
    });

    it("shows an error message when loading messages fails", async () => {
        mockShellAndInbox([], (url) => (url.startsWith("/api/mail/messages") ? jsonResponse(500, { message: "boom" }) : undefined));
        render(<InboxPage userUid="u1" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading messages fails with a non-API error", async () => {
        mockShellAndInbox([], (url) => {
            if (url.startsWith("/api/mail/messages")) throw new TypeError("network down");
            return undefined;
        });
        render(<InboxPage userUid="u1" />);
        expect(await screen.findByText("Could not load messages.")).toBeInTheDocument();
    });

    it("lists messages and shows the detail pane with no message selected", async () => {
        mockShellAndInbox([messageFixture()]);
        render(<InboxPage userUid="u1" />);
        expect(await screen.findByText("Hello there")).toBeInTheDocument();
        expect(screen.getByTestId("detail-pane")).toHaveTextContent("no-message");
    });

    it("falls back to the raw address and '(no subject)' in the message list row", async () => {
        const msg = messageFixture({
            subject: "",
            from: { address: "sender@example.com", type: "to" as const },
        });
        mockShellAndInbox([msg]);
        render(<InboxPage userUid="u1" />);

        expect(await screen.findByText("sender@example.com")).toBeInTheDocument();
        expect(screen.getByText("(no subject)")).toBeInTheDocument();
    });

    describe("Focused/Other", () => {
        it("passes isInbox to the detail pane when the active folder is the Inbox", async () => {
            mockShellAndInbox([messageFixture()]);
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("inbox:true");
        });

        it("does not pass isInbox, and shows no sub-tabs, for a non-Inbox folder", async () => {
            window.history.pushState(null, "", "/?mailboxUid=mb1&folderUid=f2");
            mockFetch((url) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, sentItemsFolder]);
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, [messageFixture({ folderUid: "f2" })]);
                throw new Error(`unexpected ${url}`);
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("inbox:false");
            expect(screen.queryByRole("button", { name: "Focused" })).not.toBeInTheDocument();
        });

        it("filters the message list by Focused/Other, defaulting to All", async () => {
            const focused = messageFixture({ uid: "m1", subject: "Focused message" });
            const other = messageFixture({ uid: "m2", subject: "Other message", inferenceClassification: "other" });
            mockShellAndInbox([focused, other]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            expect(await screen.findByText("Focused message")).toBeInTheDocument();
            expect(screen.getByText("Other message")).toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Focused" }));
            expect(screen.getByText("Focused message")).toBeInTheDocument();
            expect(screen.queryByText("Other message")).not.toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Other" }));
            expect(screen.queryByText("Focused message")).not.toBeInTheDocument();
            expect(screen.getByText("Other message")).toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "All" }));
            expect(screen.getByText("Focused message")).toBeInTheDocument();
            expect(screen.getByText("Other message")).toBeInTheDocument();
        });

        it("shows a filtered-empty-state message distinct from the folder-empty message", async () => {
            const focused = messageFixture({ uid: "m1", subject: "Focused message" });
            mockShellAndInbox([focused]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Focused message");

            await user.click(screen.getByRole("button", { name: "Other" }));
            expect(screen.getByText("No messages here.")).toBeInTheDocument();
        });

        it("patches the reclassified message and leaves the rest of the list untouched", async () => {
            const msg = messageFixture();
            const other = messageFixture({ uid: "m2", subject: "Untouched message" });
            mockShellAndInbox([msg, other]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByText("Hello there"));
            await user.click(screen.getByText("simulate-classify"));

            await user.click(screen.getByRole("button", { name: "Other" }));
            expect(screen.getByText("Hello there")).toBeInTheDocument();
            expect(screen.queryByText("Untouched message")).not.toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Focused" }));
            expect(screen.getByText("Untouched message")).toBeInTheDocument();
        });
    });

    describe("receipts", () => {
        it("patches the handled message and leaves the rest of the list untouched", async () => {
            const msg = messageFixture({ deliveryReceiptPending: true });
            const other = messageFixture({ uid: "m2", subject: "Untouched message" });
            mockShellAndInbox([msg, other]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByText("Hello there"));
            await user.click(screen.getByText("simulate-receipt-handled"));

            // No visible change to assert on the patched message itself — this confirms the callback is
            // wired through and the untouched-message branch of the list patch leaves `other` intact.
            expect(screen.getByText("Hello there")).toBeInTheDocument();
            expect(screen.getByText("Untouched message")).toBeInTheDocument();
        });
    });

    describe("on desktop", () => {
        it("selects a message in place, marks it read, and passes it to the detail pane", async () => {
            const msg = messageFixture();
            const fetchMock = mockShellAndInbox([msg]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByText("Hello there"));

            expect(await screen.findByTestId("detail-pane")).toHaveTextContent("message:m1");
            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1", expect.objectContaining({ method: "PUT" })),
            );
        });

        it("passes isSentItems=false for a message in a non-Sent-Items folder", async () => {
            const msg = messageFixture();
            mockShellAndInbox([msg]);
            render(<InboxPage userUid="u1" />);

            await screen.findByText("Hello there");
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("sentItems:false");
        });

        it("passes isSentItems=true for a message in the selected Sent Items folder", async () => {
            window.history.pushState(null, "", "/?mailboxUid=mb1&folderUid=f2");
            const msg = messageFixture({ folderUid: "f2" });
            mockFetch((url) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, sentItemsFolder]);
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, [msg]);
                throw new Error(`unexpected ${url}`);
            });
            render(<InboxPage userUid="u1" />);

            await screen.findByText("Hello there");
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("sentItems:true");
            window.history.pushState(null, "", "/");
        });

        it("patches the recalled message into the list via onRecalled", async () => {
            const msg = messageFixture();
            mockShellAndInbox([msg]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByText("Hello there"));
            await user.click(await screen.findByRole("button", { name: "simulate-recall" }));

            expect(await screen.findByTestId("detail-pane")).toHaveTextContent("message:m1");
            // A second selection round-trip proves the update landed in `messages` state itself (the
            // patched copy persists), not just in the already-rendered detail pane's own local props.
            await user.click(screen.getByText("Hello there"));
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("message:m1");
        });

        it("leaves other messages in the list untouched when patching the recalled one", async () => {
            const first = messageFixture({ uid: "m1", subject: "First" });
            const second = messageFixture({ uid: "m2", subject: "Second" });
            mockShellAndInbox([first, second]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByText("First"));
            await user.click(await screen.findByRole("button", { name: "simulate-recall" }));

            // "Second" surviving unchanged proves the recall patch's own `.map()` correctly left the
            // non-matching message alone — the same class of gap the mark-as-read patch above already
            // guards against, for this separate update path.
            expect(screen.getByText("Second")).toBeInTheDocument();
        });

        it("passes isOutbox=false and no draftsFolderUid for a message in a non-Outbox folder", async () => {
            const msg = messageFixture();
            mockShellAndInbox([msg]);
            render(<InboxPage userUid="u1" />);

            await screen.findByText("Hello there");
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("outbox:false");
        });

        it("passes isOutbox=true and the resolved Drafts folder uid for a message in the selected Outbox folder", async () => {
            window.history.pushState(null, "", "/?mailboxUid=mb1&folderUid=f3");
            const msg = messageFixture({ folderUid: "f3" });
            mockFetch((url) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, outboxFolder, draftsFolder]);
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, [msg]);
                throw new Error(`unexpected ${url}`);
            });
            render(<InboxPage userUid="u1" />);

            await screen.findByText("Hello there");
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("outbox:true");
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("draftsFolderUid:f4");
            window.history.pushState(null, "", "/");
        });

        it("removes the message from the list and clears the selection when a scheduled send is canceled", async () => {
            const first = messageFixture({ uid: "m1", subject: "First" });
            const second = messageFixture({ uid: "m2", subject: "Second" });
            mockShellAndInbox([first, second]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByText("First"));
            await user.click(await screen.findByRole("button", { name: "simulate-cancel-scheduled-send" }));

            // The canceled message moved out of the currently-viewed folder — unlike a recall, it's
            // removed from the list entirely, matching what a real folder switch would show.
            expect(screen.queryByText("First")).not.toBeInTheDocument();
            expect(screen.getByText("Second")).toBeInTheDocument();
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("no-message");
        });

        it("leaves other messages in the list untouched when marking one of several read", async () => {
            const first = messageFixture({ uid: "m1", subject: "First" });
            const second = messageFixture({ uid: "m2", subject: "Second" });
            mockShellAndInbox([first, second]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByText("First"));

            expect(await screen.findByTestId("detail-pane")).toHaveTextContent("message:m1");
            // "Second" surviving in the list, unchanged, is what proves the read-marking update's
            // `.map()` correctly left the non-matching message alone rather than only ever exercising
            // the branch that replaces the one being marked read.
            expect(screen.getByText("Second")).toBeInTheDocument();
        });

        it("does not re-mark an already-read message as read", async () => {
            const msg = messageFixture({ flags: { read: true, flagged: false, answered: false, forwarded: false } });
            const fetchMock = mockShellAndInbox([msg]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByText("Hello there"));
            await screen.findByTestId("detail-pane");

            expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit)?.method === "PUT")).toBe(false);
        });

        it("swallows a failed mark-as-read update rather than blocking selection", async () => {
            const msg = messageFixture();
            mockShellAndInbox([msg], (url, init) => {
                if (url === "/api/mail/messages/m1" && (init?.method ?? "GET") === "PUT") {
                    return jsonResponse(500, { message: "boom" });
                }
                return undefined;
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByText("Hello there"));

            expect(await screen.findByTestId("detail-pane")).toHaveTextContent("message:m1");
        });
    });

    describe("on mobile", () => {
        it("navigates to the message detail route instead of selecting in place", async () => {
            mockMatchMedia(true);
            const msg = messageFixture();
            const fetchMock = mockShellAndInbox([msg]);
            const location = mockLocation();
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByText("Hello there"));

            expect(location.href).toBe("/messages/m1");
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("no-message");
            expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit)?.method === "PUT")).toBe(false);
        });
    });

    describe("By conversation", () => {
        it("switches to the conversation list, replacing the per-folder message list, and shows the informational note", async () => {
            mockShellAndInbox([messageFixture()], undefined, [conversationFixture()]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");

            await user.click(screen.getByRole("button", { name: "By conversation" }));

            expect(await screen.findByText(/Showing every conversation in this mailbox/)).toBeInTheDocument();
            expect(screen.getByTestId("thread-pane")).toHaveTextContent("no-conversation");
        });

        it("selects a conversation in place on desktop", async () => {
            mockShellAndInbox([], undefined, [conversationFixture()]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByRole("button", { name: "By conversation" }));
            await user.click(await screen.findByText("Hello there"));

            expect(await screen.findByTestId("thread-pane")).toHaveTextContent("conversation:c1");
        });

        it("navigates to the latest message's detail route instead of selecting in place on mobile", async () => {
            mockMatchMedia(true);
            mockShellAndInbox([], undefined, [conversationFixture({ messageUids: ["m1", "m2"] })]);
            const location = mockLocation();
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByRole("button", { name: "By conversation" }));
            await user.click(await screen.findByText("Hello there"));

            expect(location.href).toBe("/messages/m2");
            expect(screen.getByTestId("thread-pane")).toHaveTextContent("no-conversation");
        });

        it("shows an empty state when the mailbox has no conversations", async () => {
            mockShellAndInbox([], undefined, []);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByRole("button", { name: "By conversation" }));

            expect(await screen.findByText("No conversations in this mailbox.")).toBeInTheDocument();
        });

        it("shows an error message when loading conversations fails", async () => {
            mockShellAndInbox([], (url) =>
                url.startsWith("/api/mail/messages/conversations") ? jsonResponse(500, { message: "boom" }) : undefined,
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByRole("button", { name: "By conversation" }));

            expect(await screen.findByText("boom")).toBeInTheDocument();
        });

        it("shows a generic error message when loading conversations fails with a non-API error", async () => {
            mockShellAndInbox([], (url) => {
                if (url.startsWith("/api/mail/messages/conversations")) throw new TypeError("network down");
                return undefined;
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByRole("button", { name: "By conversation" }));

            expect(await screen.findByText("Could not load conversations.")).toBeInTheDocument();
        });

        it("switching back to 'By date' re-fetches the per-folder message list and drops the conversation selection", async () => {
            mockShellAndInbox([messageFixture()], undefined, [conversationFixture()]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");

            await user.click(screen.getByRole("button", { name: "By conversation" }));
            await user.click(await screen.findByText("Hello there"));
            expect(await screen.findByTestId("thread-pane")).toHaveTextContent("conversation:c1");

            await user.click(screen.getByRole("button", { name: "By date" }));

            expect(await screen.findByTestId("detail-pane")).toHaveTextContent("no-message");
            expect(screen.queryByText(/Showing every conversation in this mailbox/)).not.toBeInTheDocument();
        });
    });

    describe("search", () => {
        function mockSearch(
            messages: Record<string, unknown>[],
            searchImpl: (url: string) => Response | Promise<Response> | undefined,
        ) {
            return mockFetch((url, init) => {
                if (url.startsWith("/api/mail/search")) {
                    const found = searchImpl(url);
                    if (found) return found;
                }
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, sentItemsFolder]);
                if (url.startsWith("/api/mail/messages/")) {
                    const uid = url.split("/api/mail/messages/")[1].split("?")[0];
                    const found = messages.find((m: any) => m.uid === uid);
                    return found ? jsonResponse(200, found) : jsonResponse(404, { message: "not found" });
                }
                if (url.startsWith("/api/mail/messages")) {
                    // Mirrors the real endpoint's `folderUid` scoping - this list is never mailbox-wide, unlike
                    // `/mail/search`, so a message from another folder must not leak into the initial listing.
                    const folderUid = new URL(url, "http://localhost").searchParams.get("folderUid");
                    return jsonResponse(200, messages.filter((m: any) => m.folderUid === folderUid));
                }
                if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
        }

        it("searches all mail and shows matching messages, hiding the Focused/Other sub-tabs", async () => {
            const inboxMsg = messageFixture({ uid: "m1", subject: "Folder message" });
            const hit = messageFixture({ uid: "m2", subject: "Matched message", folderUid: "f2" });
            mockSearch([inboxMsg, hit], (url) =>
                url.includes("q=budget") ? jsonResponse(200, { results: [{ entityType: "message", entityUid: "m2", score: 1 }] }) : undefined,
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Folder message");
            expect(screen.getByRole("button", { name: "Focused" })).toBeInTheDocument();

            await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");

            expect(await screen.findByText("Matched message")).toBeInTheDocument();
            expect(screen.queryByText("Folder message")).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Focused" })).not.toBeInTheDocument();
        });

        it("uses a search hit's own folder, not the sidebar's selected folder, to resolve isSentItems", async () => {
            const hit = messageFixture({ uid: "m2", subject: "Matched message", folderUid: "f2" });
            mockSearch([hit], (url) =>
                url.includes("q=budget") ? jsonResponse(200, { results: [{ entityType: "message", entityUid: "m2", score: 1 }] }) : undefined,
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByPlaceholderText("Search all mail…");

            await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");
            await user.click(await screen.findByText("Matched message"));

            expect(screen.getByTestId("detail-pane")).toHaveTextContent("sentItems:true");
        });

        it("shows a not-found message distinct from the folder-empty state when a search has no hits", async () => {
            mockSearch([messageFixture()], (url) => (url.includes("q=nothing") ? jsonResponse(200, { results: [] }) : undefined));
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");

            await user.type(screen.getByPlaceholderText("Search all mail…"), "nothing");

            expect(await screen.findByText('No messages match "nothing".')).toBeInTheDocument();
        });

        it("drops a search hit that no longer resolves to a real message", async () => {
            mockSearch([messageFixture()], (url) =>
                url.includes("q=stale")
                    ? jsonResponse(200, { results: [{ entityType: "message", entityUid: "gone", score: 1 }] })
                    : undefined,
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");

            await user.type(screen.getByPlaceholderText("Search all mail…"), "stale");

            expect(await screen.findByText('No messages match "stale".')).toBeInTheDocument();
        });

        it("shows an error message when the search itself fails", async () => {
            mockSearch([messageFixture()], (url) => (url.includes("q=boom") ? jsonResponse(500, { message: "boom" }) : undefined));
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");

            await user.type(screen.getByPlaceholderText("Search all mail…"), "boom");

            expect(await screen.findByText("boom")).toBeInTheDocument();
        });

        it("shows a generic error message when the search itself fails with a non-API error", async () => {
            mockSearch([messageFixture()], (url) => {
                if (url.includes("q=boom")) throw new TypeError("network down");
                return undefined;
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");

            await user.type(screen.getByPlaceholderText("Search all mail…"), "boom");

            expect(await screen.findByText("Search failed.")).toBeInTheDocument();
        });

        it("clearing the search box returns to the normal folder listing", async () => {
            const inboxMsg = messageFixture({ uid: "m1", subject: "Folder message" });
            const hit = messageFixture({ uid: "m2", subject: "Matched message", folderUid: "f2" });
            mockSearch([inboxMsg, hit], (url) =>
                url.includes("q=budget") ? jsonResponse(200, { results: [{ entityType: "message", entityUid: "m2", score: 1 }] }) : undefined,
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Folder message");

            const searchBox = screen.getByPlaceholderText("Search all mail…");
            await user.type(searchBox, "budget");
            await screen.findByText("Matched message");

            await user.clear(searchBox);

            expect(await screen.findByText("Folder message")).toBeInTheDocument();
            expect(screen.queryByText("Matched message")).not.toBeInTheDocument();
        });
    });

    describe("infinite scroll", () => {
        it("loads the next page of the folder listing when the sentinel intersects, appending to the list", async () => {
            const firstPage = Array.from({ length: 50 }, (_, i) => messageFixture({ uid: `m${i}`, subject: `Message ${i}` }));
            const io = mockIntersectionObserver();
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/messages")) {
                    if (url.includes("page=1")) return jsonResponse(200, [messageFixture({ uid: "m99", subject: "Message 99" })]);
                    return jsonResponse(200, firstPage);
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Message 0");

            io.trigger();

            expect(await screen.findByText("Message 99")).toBeInTheDocument();
            expect(screen.getByText("Message 0")).toBeInTheDocument();
        });

        it("ignores a second sentinel trigger while a page load is already in flight", async () => {
            const firstPage = Array.from({ length: 50 }, (_, i) => messageFixture({ uid: `m${i}`, subject: `Message ${i}` }));
            const io = mockIntersectionObserver();
            let pageOneRequests = 0;
            let resolvePageOne: ((value: Response) => void) | undefined;
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/messages")) {
                    if (url.includes("page=1")) {
                        pageOneRequests += 1;
                        return new Promise((resolve) => {
                            resolvePageOne = resolve;
                        });
                    }
                    return jsonResponse(200, firstPage);
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Message 0");

            io.trigger();
            // Waiting for the "Loading more…" sentinel text ensures a render has actually landed with
            // `loadingMore: true` before the second trigger - `loadMoreRef` now points to a closure that
            // observes that, which is what lets this second call hit the early-return guard at all (two
            // triggers fired back-to-back in the same tick would both still close over the pre-render
            // `loadingMore: false` and issue two real fetches, proving nothing about the guard itself).
            await screen.findByText("Loading more…");
            io.trigger();
            resolvePageOne!(jsonResponse(200, [messageFixture({ uid: "m99", subject: "Message 99" })]));

            expect(await screen.findByText("Message 99")).toBeInTheDocument();
            expect(pageOneRequests).toBe(1);
        });

        it("shows an error message when loading more fails", async () => {
            const firstPage = Array.from({ length: 50 }, (_, i) => messageFixture({ uid: `m${i}`, subject: `Message ${i}` }));
            const io = mockIntersectionObserver();
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/messages")) {
                    if (url.includes("page=1")) return jsonResponse(500, { message: "boom" });
                    return jsonResponse(200, firstPage);
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Message 0");

            io.trigger();

            expect(await screen.findByText("boom")).toBeInTheDocument();
        });

        it("shows a generic error message when loading more fails with a non-API error", async () => {
            const firstPage = Array.from({ length: 50 }, (_, i) => messageFixture({ uid: `m${i}`, subject: `Message ${i}` }));
            const io = mockIntersectionObserver();
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/messages")) {
                    if (url.includes("page=1")) throw new TypeError("network down");
                    return jsonResponse(200, firstPage);
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Message 0");

            io.trigger();

            expect(await screen.findByText("Could not load more messages.")).toBeInTheDocument();
        });

        it("does nothing when the sentinel reports it is not intersecting", async () => {
            const firstPage = Array.from({ length: 50 }, (_, i) => messageFixture({ uid: `m${i}`, subject: `Message ${i}` }));
            const io = mockIntersectionObserver();
            let pageOneRequests = 0;
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/messages")) {
                    if (url.includes("page=1")) {
                        pageOneRequests += 1;
                        return jsonResponse(200, [messageFixture({ uid: "m99", subject: "Message 99" })]);
                    }
                    return jsonResponse(200, firstPage);
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Message 0");

            io.trigger(false);

            // No `await` to wait on here, by design - asserting nothing ever loads is a "stays absent"
            // check, so give the (would-be) fetch every chance to fire before checking it never did.
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(pageOneRequests).toBe(0);
            expect(screen.queryByText("Message 99")).not.toBeInTheDocument();
        });

        it("loads the next page of search results via cursor when the sentinel intersects", async () => {
            const messages = [
                messageFixture({ uid: "m1", subject: "First hit" }),
                messageFixture({ uid: "m2", subject: "Second hit" }),
            ];
            const io = mockIntersectionObserver();
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/search")) {
                    if (url.includes("cursor=c1")) return jsonResponse(200, { results: [{ entityType: "message", entityUid: "m2", score: 1 }] });
                    return jsonResponse(200, { results: [{ entityType: "message", entityUid: "m1", score: 1 }], nextCursor: "c1" });
                }
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/messages/")) {
                    const uid = url.split("/api/mail/messages/")[1].split("?")[0];
                    const found = messages.find((m: any) => m.uid === uid);
                    return found ? jsonResponse(200, found) : jsonResponse(404, { message: "not found" });
                }
                // The plain (non-search) folder listing is deliberately empty here, distinct from both search
                // hits below - if it returned either "hit" fixture, the assertions after typing a search query
                // could pass just from this initial load, without proving the search round-trip actually ran.
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, []);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("No messages in this folder.");

            await user.type(screen.getByPlaceholderText("Search all mail…"), "hit");
            await screen.findByText("First hit");

            io.trigger();

            expect(await screen.findByText("Second hit")).toBeInTheDocument();
        });
    });
});
