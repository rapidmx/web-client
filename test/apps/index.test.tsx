// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockIntersectionObserver, mockLocation, mockMatchMedia } from "./testUtils.js";
import InboxPage from "../../apps/www/index.js";

// Tier 3 (`searchTier3.ts#searchEncryptedCandidates()`) does real WebCrypto decryption against real
// unlocked keys - already exercised end to end with real crypto in react-shared's own
// test/search/searchTier3.test.ts. Mocked here at the module boundary (same convention
// MessageDetailPane.test.tsx already uses for `evaluateMessageSecurity`/`getUnlockedKeys`) so these
// tests only verify `InboxContent`'s own concern: merging whatever Tier 3 returns with Tier 1's
// results, not re-proving decryption correctness.
const { searchEncryptedCandidates, getUnlockedKeys, unlockWithPassword } = vi.hoisted(() => ({
    searchEncryptedCandidates: vi.fn(),
    getUnlockedKeys: vi.fn(),
    unlockWithPassword: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/search/searchTier3.js", () => ({ searchEncryptedCandidates }));

// Tier 2 (the local encrypted index) is mocked at the same module boundary and for the same reason as
// Tier 3 above - its own real behavior (Worker/WASM/OPFS/FTS5) is exercised elsewhere
// (localIndexBlockCipher.test.ts for the crypto, and manual browser verification for the rest, per this
// feature's own implementation plan); these tests only verify InboxContent's merge/coverage-line logic.
const { searchLocalIndex } = vi.hoisted(() => ({ searchLocalIndex: vi.fn() }));
vi.mock("../../apps/shared/search/searchTier2.js", () => ({ searchLocalIndex }));
// unlockWithPassword is real UnlockPromptProvider's own dependency (mounted for real by the real
// AppShell this file renders through, via MailShell/KeyEnrollmentGate) - needed so the "unlock" tests
// below (list/search banners) can actually complete a real unlock, not just getUnlockedKeys' read side.
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys, unlockWithPassword }));

// evaluateMessageSecurity() does real WebCrypto decryption against real unlocked keys - already
// exercised end to end in react-shared's own test suite (see the Tier 3 comment above for the identical
// reasoning). Mocked here so the inbox-list decrypt tests below only verify InboxContent's own
// decryptEncryptedRows() orchestration (which rows it decrypts, how it renders the result), not
// re-proving decryption correctness.
const { evaluateMessageSecurity } = vi.hoisted(() => ({ evaluateMessageSecurity: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity }));

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
        onArchived,
        onLabelsChanged,
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
        onArchived?: (updated: Record<string, unknown>) => void;
        onLabelsChanged?: (updated: Record<string, unknown>) => void;
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
            {message && onArchived && (
                <button type="button" onClick={() => onArchived({ ...message, folderUid: "f-archive" })}>
                    simulate-archive
                </button>
            )}
            {message && onLabelsChanged && (
                <button type="button" onClick={() => onLabelsChanged({ ...message, labelUids: ["l1"] })}>
                    simulate-labels-changed
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
        if (url.match(/^\/api\/mail\/messages\/[^/]+\/raw$/)) {
            // Content doesn't matter - evaluateMessageSecurity() (what actually reads it) is mocked
            // separately per-test, so this only needs to satisfy getMessageRawContent()'s own res.ok/
            // res.text() contract.
            return new Response("raw-mime-placeholder", { status: 200 });
        }
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

// Every existing test predates Tier 3 and doesn't care about it - defaults its mock to "nothing to
// contribute" so `mergeSearchResults()` sees a real (empty) array rather than `undefined`, matching
// what the real `searchEncryptedCandidates()` returns when this mailbox has no unlocked keys. Tests
// that actually exercise Tier 3 override this per-test before rendering.
beforeEach(() => {
    searchEncryptedCandidates.mockResolvedValue([]);
    searchLocalIndex.mockResolvedValue({ results: [] });
});

afterEach(() => {
    vi.unstubAllGlobals();
    searchEncryptedCandidates.mockReset();
    searchLocalIndex.mockReset();
    getUnlockedKeys.mockReset();
    unlockWithPassword.mockReset();
    evaluateMessageSecurity.mockReset();
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

        it("removes the message from the list and clears the selection when it's archived", async () => {
            const first = messageFixture({ uid: "m1", subject: "First" });
            const second = messageFixture({ uid: "m2", subject: "Second" });
            mockShellAndInbox([first, second]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByText("First"));
            await user.click(await screen.findByRole("button", { name: "simulate-archive" }));

            // The archived message moved out of the currently-viewed folder — same reasoning as the
            // scheduled-send-cancel case above, removed from the list rather than patched in place.
            expect(screen.queryByText("First")).not.toBeInTheDocument();
            expect(screen.getByText("Second")).toBeInTheDocument();
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("no-message");
        });

        it("patches the message in place (does not remove it) when its labels change", async () => {
            const first = messageFixture({ uid: "m1", subject: "First" });
            const second = messageFixture({ uid: "m2", subject: "Second" });
            mockShellAndInbox([first, second]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByText("First"));
            await user.click(await screen.findByRole("button", { name: "simulate-labels-changed" }));

            // Changing labels never moves a message between folders - unlike archive/scheduled-send-cancel
            // above, it stays in the list.
            expect(screen.getByText("First")).toBeInTheDocument();
            expect(screen.getByText("Second")).toBeInTheDocument();
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

        it("parses an operator query into structured filter params, sent alongside the free-text remainder", async () => {
            const hit = messageFixture({ uid: "m2", subject: "Matched message", folderUid: "f2" });
            const fetchMock = mockSearch([hit], (url) =>
                url.includes("q=report")
                    ? jsonResponse(200, { results: [{ entityType: "message", entityUid: "m2", score: 1 }] })
                    : undefined,
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByPlaceholderText("Search all mail…");

            await user.type(screen.getByPlaceholderText("Search all mail…"), "from:alice@example.com has:attachment report");

            expect(await screen.findByText("Matched message")).toBeInTheDocument();
            const searchCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("/api/mail/search?"))!;
            const params = new URLSearchParams(searchCall[0].split("?")[1]);
            expect(params.get("q")).toBe("report");
            expect(params.get("from")).toBe("alice@example.com");
            expect(params.get("hasAttachment")).toBe("true");
        });

        it("renders a search hit's snippet in place of the plain body preview", async () => {
            const hit = messageFixture({ uid: "m2", subject: "Matched message", folderUid: "f2", bodyPreview: "plain preview" });
            mockSearch([hit], (url) =>
                url.includes("q=budget")
                    ? jsonResponse(200, {
                          results: [{ entityType: "message", entityUid: "m2", score: 1, snippet: "...the <b>budget</b> for..." }],
                      })
                    : undefined,
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByPlaceholderText("Search all mail…");

            await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");

            await screen.findByText("Matched message");
            expect(screen.getByText("...the <b>budget</b> for...")).toBeInTheDocument();
            expect(screen.queryByText("plain preview")).not.toBeInTheDocument();
        });

        it("falls back to the plain body preview when a search hit has no snippet", async () => {
            const hit = messageFixture({ uid: "m2", subject: "Matched message", folderUid: "f2", bodyPreview: "plain preview" });
            mockSearch([hit], (url) =>
                url.includes("q=budget") ? jsonResponse(200, { results: [{ entityType: "message", entityUid: "m2", score: 1 }] }) : undefined,
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByPlaceholderText("Search all mail…");

            await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");

            await screen.findByText("Matched message");
            expect(screen.getByText("plain preview")).toBeInTheDocument();
        });

        // Tier 3 (specs/search.md - server-assisted narrowing over encrypted mail) is mocked at the
        // module boundary (see the file-level `vi.mock("@rapidmx/react-shared/search/searchTier3.js")`
        // above) - real decryption is already covered end to end with real crypto in react-shared's own
        // test suite. These tests only verify InboxContent's own responsibility: merging whatever Tier 3
        // returns with Tier 1's results.
        describe("Tier 3 (encrypted candidate) merge", () => {
            it("surfaces a message that Tier 1 never returned at all, found only via a decrypted Tier 3 candidate", async () => {
                const tier3Hit = messageFixture({ uid: "m3", subject: "Encrypted match", folderUid: "f2" });
                mockSearch([tier3Hit], (url) => (url.includes("q=budget") ? jsonResponse(200, { results: [] }) : undefined));
                searchEncryptedCandidates.mockResolvedValue([
                    { entityType: "message", entityUid: "m3", score: 5, source: "candidate", metadataOnly: false, snippet: "…the budget…" },
                ]);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByPlaceholderText("Search all mail…");

                await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");

                expect(await screen.findByText("Encrypted match")).toBeInTheDocument();
                expect(screen.getByText("…the budget…")).toBeInTheDocument();
            });

            it("renders a uid returned by both tiers only once, preferring Tier 3's content-verified result", async () => {
                const hit = messageFixture({ uid: "m2", subject: "Matched message", folderUid: "f2", bodyPreview: "plain preview" });
                mockSearch([hit], (url) =>
                    url.includes("q=budget")
                        ? jsonResponse(200, { results: [{ entityType: "message", entityUid: "m2", score: 1, metadataOnly: true }] })
                        : undefined,
                );
                searchEncryptedCandidates.mockResolvedValue([
                    { entityType: "message", entityUid: "m2", score: 9, source: "candidate", metadataOnly: false, snippet: "verified snippet" },
                ]);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByPlaceholderText("Search all mail…");

                await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");

                await screen.findByText("Matched message");
                expect(screen.getAllByText("Matched message")).toHaveLength(1);
                expect(screen.getByText("verified snippet")).toBeInTheDocument();
                expect(screen.queryByText("plain preview")).not.toBeInTheDocument();
            });

            it("sorts merged results by normalized score, highest first", async () => {
                const lowScore = messageFixture({ uid: "m-low", subject: "Low score match", folderUid: "f2" });
                const highScore = messageFixture({ uid: "m-high", subject: "High score match", folderUid: "f2" });
                mockSearch([lowScore, highScore], (url) =>
                    url.includes("q=budget")
                        ? jsonResponse(200, {
                              results: [
                                  { entityType: "message", entityUid: "m-low", score: 1 },
                                  { entityType: "message", entityUid: "m-high", score: 10 },
                              ],
                          })
                        : undefined,
                );
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByPlaceholderText("Search all mail…");

                await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");

                await screen.findByText("Low score match");
                const rendered = screen.getAllByText(/score match/).map((el) => el.textContent);
                expect(rendered).toEqual(["High score match", "Low score match"]);
            });

            it("fetches Tier 3's candidate set only once per search, reusing it across a loadMore continuation", async () => {
                const firstHit = messageFixture({ uid: "m2", subject: "First match", folderUid: "f2" });
                mockSearch([firstHit], (url) =>
                    url.includes("q=budget") ? jsonResponse(200, { results: [{ entityType: "message", entityUid: "m2", score: 1 }] }) : undefined,
                );
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByPlaceholderText("Search all mail…");

                await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");
                await screen.findByText("First match");

                expect(searchEncryptedCandidates).toHaveBeenCalledTimes(1);
            });
        });

        describe("Tier 2 (local index) merge", () => {
            it("surfaces a message only Tier 2's local index found, not returned by Tier 1 at all", async () => {
                searchLocalIndex.mockResolvedValue({
                    results: [
                        {
                            entityType: "message",
                            entityUid: "m-local",
                            score: 5,
                            source: "local",
                            metadataOnly: false,
                            snippet: "…the budget…",
                        },
                    ],
                    coverage: { indexedFrom: "2025-06-01T00:00:00.000Z", indexedCount: 42, building: false },
                });
                mockFetch((url, init) => {
                    if (url.startsWith("/api/mail/search")) return jsonResponse(200, { results: [] });
                    if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                    if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, sentItemsFolder]);
                    if (url === "/api/mail/messages/m-local") {
                        return jsonResponse(200, messageFixture({ uid: "m-local", subject: "Local-only match", folderUid: "f2" }));
                    }
                    if (url.startsWith("/api/mail/messages")) return jsonResponse(200, []);
                    if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
                    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
                });
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByPlaceholderText("Search all mail…");

                await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");

                expect(await screen.findByText("Local-only match")).toBeInTheDocument();
                expect(screen.getByText("…the budget…")).toBeInTheDocument();
            });

            it("shows a coverage line naming how far back the local index reaches, and notes when it's still building", async () => {
                mockSearch([], (url) => (url.includes("q=budget") ? jsonResponse(200, { results: [] }) : undefined));
                searchLocalIndex.mockResolvedValue({
                    results: [],
                    coverage: { indexedFrom: "2025-06-01T00:00:00.000Z", indexedCount: 10, building: true },
                });
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByPlaceholderText("Search all mail…");

                await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");

                expect(await screen.findByText(/Local search covers messages back to/)).toBeInTheDocument();
                expect(screen.getByText(/still building/)).toBeInTheDocument();
            });

            it("shows no coverage line when Tier 2 has no coverage to report (not unlocked)", async () => {
                mockSearch([], (url) => (url.includes("q=budget") ? jsonResponse(200, { results: [] }) : undefined));
                searchLocalIndex.mockResolvedValue({ results: [] });
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByPlaceholderText("Search all mail…");

                await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");
                await screen.findByText(/No messages match/);

                expect(screen.queryByText(/Local search covers messages back to/)).not.toBeInTheDocument();
            });
        });

        describe("Progressive Results (skeletons, settled count, Search all mail)", () => {
            // A manually-resolved promise so a test can assert the "still in flight" interim state before
            // letting Tier 3 (the slowest tier) settle - vi.fn()'s default resolved-mock timing is too
            // fast (same microtask queue) to ever observe an interim state otherwise.
            function deferred<T>() {
                let resolve!: (value: T) => void;
                const promise = new Promise<T>((res) => {
                    resolve = res;
                });
                return { promise, resolve };
            }

            it("renders unconfirmed Tier 1 metadataOnly hits as skeletons and withholds the count, then resolves or prunes each once every tier reports", async () => {
                const pendingHit = messageFixture({ uid: "m-pending", subject: "[...]", folderUid: "f1" });
                const confirmedHit = messageFixture({ uid: "m-confirmed", subject: "[...]", folderUid: "f1" });
                mockFetch((url, init) => {
                    if (url.startsWith("/api/mail/search")) {
                        if (url.includes("q=budget")) {
                            return jsonResponse(200, {
                                results: [
                                    { entityType: "message", entityUid: "m-pending", score: 3, source: "server", metadataOnly: true },
                                    { entityType: "message", entityUid: "m-confirmed", score: 2, source: "server", metadataOnly: true },
                                ],
                            });
                        }
                        return jsonResponse(200, { results: [] });
                    }
                    if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                    if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                    if (url === "/api/mail/messages/m-pending") return jsonResponse(200, pendingHit);
                    if (url === "/api/mail/messages/m-confirmed") return jsonResponse(200, confirmedHit);
                    if (url.startsWith("/api/mail/messages")) return jsonResponse(200, []);
                    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
                });
                searchLocalIndex.mockResolvedValue({ results: [], hasMore: false });
                const tier3 = deferred<unknown[]>();
                searchEncryptedCandidates.mockReturnValue(tier3.promise);

                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByPlaceholderText("Search all mail…");

                await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");

                // Interim, before Tier 3 has reported: both hits are still unconfirmed metadataOnly
                // guesses, so both render as skeletons (no "Encrypted message" placeholder text yet) and
                // the count stays unsettled.
                await screen.findByText("2 of ??");
                expect(screen.queryByText("Encrypted message")).not.toBeInTheDocument();

                // Tier 3 confirms only m-confirmed - m-pending gets nothing back and must be pruned.
                tier3.resolve([
                    { entityType: "message", entityUid: "m-confirmed", score: 9, source: "candidate", metadataOnly: false, snippet: "…the budget…" },
                ]);

                expect(await screen.findByText("…the budget…")).toBeInTheDocument();
                expect(await screen.findByText("1 result")).toBeInTheDocument();
                // Only the confirmed hit's row remains - a second "Encrypted message" row would mean
                // m-pending survived instead of being pruned.
                expect(screen.getAllByText("Encrypted message")).toHaveLength(1);
            });

            it('"Search all mail" removes Tier 3\'s coverage-tightened bound and re-runs it', async () => {
                mockSearch([], (url) => (url.includes("q=budget") ? jsonResponse(200, { results: [] }) : undefined));
                searchLocalIndex.mockResolvedValue({
                    results: [],
                    coverage: { indexedFrom: "2025-06-01T00:00:00.000Z", indexedCount: 5, building: false },
                    hasMore: false,
                });
                searchEncryptedCandidates.mockResolvedValue([]);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByPlaceholderText("Search all mail…");

                await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");
                await screen.findByText("Search all mail");

                expect(searchEncryptedCandidates).toHaveBeenCalledTimes(1);
                const [firstParsed] = searchEncryptedCandidates.mock.calls[0] as [{ before?: Date }];
                expect(firstParsed.before).toEqual(new Date("2025-06-01T00:00:00.000Z"));

                await user.click(screen.getByText("Search all mail"));

                await waitFor(() => expect(searchEncryptedCandidates).toHaveBeenCalledTimes(2));
                const [secondParsed] = searchEncryptedCandidates.mock.calls[1] as [{ before?: Date }];
                expect(secondParsed.before).toBeUndefined();
                expect(screen.queryByText("Search all mail")).not.toBeInTheDocument();
            });
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

        it("shows an unlock banner while searching without unlocked keys, and includes Tier 3 results once unlocked", async () => {
            const hit = messageFixture({ uid: "m3", subject: "Encrypted match", folderUid: "f2" });
            mockSearch([hit], (url) => (url.includes("q=budget") ? jsonResponse(200, { results: [] }) : undefined));
            getUnlockedKeys.mockReturnValue(undefined);
            unlockWithPassword.mockImplementation(async () => {
                getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            });
            searchEncryptedCandidates.mockImplementation(async (_parsed: unknown, unlocked: unknown) =>
                unlocked
                    ? [{ entityType: "message", entityUid: "m3", score: 5, source: "candidate", metadataOnly: false, snippet: "…the budget…" }]
                    : [],
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByPlaceholderText("Search all mail…");

            await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");
            await screen.findByText("Unlock to include encrypted messages in these results");
            expect(screen.queryByText("Encrypted match")).not.toBeInTheDocument();

            await user.click(screen.getByText("Unlock to include encrypted messages in these results"));
            await screen.findByText("Unlock your mailbox");
            await user.type(screen.getByLabelText("Encryption password"), "a good password");
            await user.click(screen.getByRole("button", { name: "Unlock" }));

            expect(await screen.findByText("Encrypted match")).toBeInTheDocument();
            expect(screen.queryByText("Unlock to include encrypted messages in these results")).not.toBeInTheDocument();
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

        it("threads Tier 2's own offset and reuses Tier 3's cached candidate set (§8's composite cursor) across a loadMore continuation", async () => {
            const io = mockIntersectionObserver();
            searchLocalIndex.mockImplementation(async (_mailboxUid: string, _parsed: unknown, _unlocked: unknown, _limit: number, offset = 0) => ({
                results:
                    offset === 0
                        ? [{ entityType: "message", entityUid: "m-local-1", score: 5, source: "local", metadataOnly: false }]
                        : [{ entityType: "message", entityUid: "m-local-2", score: 4, source: "local", metadataOnly: false }],
                coverage: { indexedFrom: "2025-06-01T00:00:00.000Z", indexedCount: 2, building: false },
                hasMore: offset === 0,
            }));
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/search")) return jsonResponse(200, { results: [] });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url === "/api/mail/messages/m-local-1") return jsonResponse(200, messageFixture({ uid: "m-local-1", subject: "Local one" }));
                if (url === "/api/mail/messages/m-local-2") return jsonResponse(200, messageFixture({ uid: "m-local-2", subject: "Local two" }));
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, []);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByPlaceholderText("Search all mail…");

            await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");
            await screen.findByText("Local one");
            // Tier 3's candidate fetch already ran once for this search pass (the "no results" default
            // from beforeEach) - the assertion below on its call count is what proves loadMore() doesn't
            // trigger a second, redundant fetch.
            expect(searchEncryptedCandidates).toHaveBeenCalledTimes(1);

            io.trigger();

            expect(await screen.findByText("Local two")).toBeInTheDocument();
            expect(searchLocalIndex).toHaveBeenLastCalledWith("mb1", expect.objectContaining({ text: "budget" }), undefined, 50, 1);
            expect(searchEncryptedCandidates).toHaveBeenCalledTimes(1);
        });
    });

    describe("encrypted rows in the plain folder listing", () => {
        it("shows an unlock banner for an encrypted ('[...]') row, and decrypts it in place once unlocked", async () => {
            const encryptedMsg = messageFixture({ uid: "m-enc", subject: "[...]", bodyPreview: undefined });
            mockShellAndInbox([encryptedMsg]);
            getUnlockedKeys.mockReturnValue(undefined);
            unlockWithPassword.mockImplementation(async () => {
                getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            });
            evaluateMessageSecurity.mockResolvedValue({
                state: "encrypted_verified",
                subject: "Real decrypted subject",
                html: "<p>Real decrypted body content</p>",
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            expect(await screen.findByText("Encrypted message")).toBeInTheDocument();
            const unlockLink = screen.getByText("Unlock to show an encrypted message's subject");

            await user.click(unlockLink);
            await screen.findByText("Unlock your mailbox");
            await user.type(screen.getByLabelText("Encryption password"), "a good password");
            await user.click(screen.getByRole("button", { name: "Unlock" }));

            expect(await screen.findByText("Real decrypted subject")).toBeInTheDocument();
            expect(screen.getByText("Real decrypted body content")).toBeInTheDocument();
            expect(screen.queryByText("Encrypted message")).not.toBeInTheDocument();
            expect(screen.queryByText("Unlock to show an encrypted message's subject")).not.toBeInTheDocument();
        });

        it("uses the plural banner copy when more than one loaded row is encrypted", async () => {
            const encryptedMsgs = [
                messageFixture({ uid: "m-enc-1", subject: "[...]", bodyPreview: undefined }),
                messageFixture({ uid: "m-enc-2", subject: "[...]", bodyPreview: undefined }),
            ];
            mockShellAndInbox(encryptedMsgs);
            getUnlockedKeys.mockReturnValue(undefined);
            render(<InboxPage userUid="u1" />);

            expect(await screen.findByText("Unlock to show encrypted messages' subject")).toBeInTheDocument();
        });

        it("shows a decrypted subject with no preview override when the recovered content has no html body", async () => {
            const encryptedMsg = messageFixture({ uid: "m-enc", subject: "[...]", bodyPreview: undefined });
            mockShellAndInbox([encryptedMsg]);
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            evaluateMessageSecurity.mockResolvedValue({ state: "signed_verified", subject: "Subject only, no body" });
            render(<InboxPage userUid="u1" />);

            expect(await screen.findByText("Subject only, no body")).toBeInTheDocument();
        });

        it("auto-decrypts an encrypted row with no banner at all when already unlocked this session", async () => {
            const encryptedMsg = messageFixture({ uid: "m-enc", subject: "[...]", bodyPreview: undefined });
            mockShellAndInbox([encryptedMsg]);
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            evaluateMessageSecurity.mockResolvedValue({
                state: "encrypted_verified",
                subject: "Already unlocked subject",
                html: "<p>Already unlocked body</p>",
            });
            render(<InboxPage userUid="u1" />);

            expect(await screen.findByText("Already unlocked subject")).toBeInTheDocument();
            expect(screen.getByText("Already unlocked body")).toBeInTheDocument();
            expect(screen.queryByText(/Unlock to show/)).not.toBeInTheDocument();
        });

        it("leaves the row as its placeholder and shows no unlock banner when the mailbox has nothing encrypted to show", async () => {
            const plainMsg = messageFixture({ uid: "m1", subject: "Ordinary message" });
            mockShellAndInbox([plainMsg]);
            getUnlockedKeys.mockReturnValue(undefined);
            render(<InboxPage userUid="u1" />);

            expect(await screen.findByText("Ordinary message")).toBeInTheDocument();
            expect(screen.queryByText(/Unlock to show/)).not.toBeInTheDocument();
            expect(evaluateMessageSecurity).not.toHaveBeenCalled();
        });

        it("leaves an encrypted row as its placeholder when this device is unlocked but still can't recover anything (wrong/rotated key)", async () => {
            const encryptedMsg = messageFixture({ uid: "m-enc", subject: "[...]", bodyPreview: undefined });
            mockShellAndInbox([encryptedMsg]);
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", decryptError: "This device doesn't have the key needed." });
            render(<InboxPage userUid="u1" />);

            expect(await screen.findByText("Encrypted message")).toBeInTheDocument();
            expect(screen.queryByText(/Unlock to show/)).not.toBeInTheDocument();
        });

        it("leaves an encrypted row as its placeholder when fetching or decrypting it throws", async () => {
            const encryptedMsg = messageFixture({ uid: "m-enc", subject: "[...]", bodyPreview: undefined });
            mockShellAndInbox([encryptedMsg]);
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            evaluateMessageSecurity.mockRejectedValue(new Error("bad ciphertext"));
            render(<InboxPage userUid="u1" />);

            expect(await screen.findByText("Encrypted message")).toBeInTheDocument();
        });
    });
});
