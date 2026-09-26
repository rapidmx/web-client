// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockIntersectionObserver, mockLocation, mockMatchMedia } from "./testUtils.js";
import { getNotificationsSnapshot } from "../../apps/shared/notifications/store.js";
import { clearInviteCache } from "../../apps/shared/components/mail/invite/inviteStore.js";
import InboxPageRouted from "../../apps/www/index.js";

// The page's own component: what a test renders is the page, not the client-side router around it (see `routedPage()`).
const InboxPage = InboxPageRouted.page;

// Tier 3 (`searchTier3.ts#searchEncryptedCandidates()`) does real WebCrypto decryption against real
// unlocked keys - already exercised end to end with real crypto in react-shared's own
// test/search/searchTier3.test.ts. Mocked here at the module boundary (same convention
// MessageDetailPane.test.tsx already uses for `evaluateMessageSecurity`/`getUnlockedKeys`) so these
// tests only verify `InboxContent`'s own concern: merging whatever Tier 3 returns with Tier 1's
// results, not re-proving decryption correctness.
const { searchEncryptedCandidates, getUnlockedKeys, unlockWithPassword, subscribeKeySession, keySessionListeners } = vi.hoisted(() => {
    // A real-enough session event bus: `InboxContent` subscribes on mount, and the "keys locked" tests
    // below fire events through `emitKeySession()`.
    const keySessionListeners = new Set<(event: { mailboxUid: string; state: "unlocked" | "locked" }) => void>();
    return {
        searchEncryptedCandidates: vi.fn(),
        getUnlockedKeys: vi.fn(),
        unlockWithPassword: vi.fn(),
        keySessionListeners,
        subscribeKeySession: vi.fn((listener: (event: { mailboxUid: string; state: "unlocked" | "locked" }) => void) => {
            keySessionListeners.add(listener);
            return () => keySessionListeners.delete(listener);
        }),
    };
});

function emitKeySession(event: { mailboxUid: string; state: "unlocked" | "locked" }) {
    for (const listener of [...keySessionListeners]) {
        listener(event);
    }
}
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
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys, unlockWithPassword, subscribeKeySession }));

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
        folders,
        onMoved,
        onFolderCreated,
        onReceiptHandled,
        onArchived,
        onLabelsChanged,
        labels,
        onLabelCreated,
        threadHeader,
    }: {
        message: Record<string, unknown> | null;
        // What the thread hands an expanded card: the sender button that collapses it (the pane draws it), and the body it controls.
        threadHeader?: { bodyId: string; unread: boolean; onToggle: () => void; buttonRef: (node: HTMLButtonElement | null) => void };
        isSentItems?: boolean;
        onRecalled?: (updated: Record<string, unknown>) => void;
        isOutbox?: boolean;
        draftsFolderUid?: string;
        onScheduledSendCanceled?: (updated: Record<string, unknown>) => void;
        folders?: { uid: string; name: string }[];
        onMoved?: (updated: Record<string, unknown>) => void;
        onFolderCreated?: (folder: Record<string, unknown>) => void;
        onReceiptHandled?: (updated: Record<string, unknown>) => void;
        onArchived?: (updated: Record<string, unknown>) => void;
        onLabelsChanged?: (updated: Record<string, unknown>) => void;
        labels?: { uid: string; name: string }[];
        onLabelCreated?: (label: { uid: string; name: string }) => void;
    }) => (
        <div data-testid="detail-pane">
            {threadHeader && (
                <h2>
                    <button type="button" ref={threadHeader.buttonRef} aria-expanded="true" aria-controls={threadHeader.bodyId} onClick={threadHeader.onToggle}>
                        {String((message?.from as { displayName?: string } | undefined)?.displayName ?? message?.uid)}
                    </button>
                </h2>
            )}
            {message ? `message:${message.uid}` : "no-message"} sentItems:{String(!!isSentItems)} outbox:{String(!!isOutbox)}{" "}
            draftsFolderUid:{draftsFolderUid ?? "unset"} folders:{(folders ?? []).map((f) => f.name).join("/")} labels:
            {(labels ?? []).map((l) => l.name).join("/")}
            {onLabelCreated && (
                <button type="button" onClick={() => onLabelCreated({ uid: "l-new", name: "Made here" })}>
                    simulate-label-created
                </button>
            )}
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
            {message && onMoved && (
                <button type="button" onClick={() => onMoved({ ...message, folderUid: "f7" })}>
                    simulate-move
                </button>
            )}
            {onFolderCreated && (
                <button
                    type="button"
                    onClick={() => onFolderCreated({ uid: "f-new", name: "Made here", type: "user", mailboxUid: "mb1" })}
                >
                    simulate-folder-created
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

// The inbox renders the reading pane through `LazyReadingPane` (a chunk loaded on demand, with an empty state of its own; see its test
// file). Here it is the stand-ins above, present from the first render, so these tests see what `InboxContent` hands the pane.
vi.mock("../../apps/shared/components/mail/LazyReadingPane.js", async () => ({
    LazyMessageDetailPane: (await import("../../apps/shared/components/mail/MessageDetailPane.js")).default,
    LazyConversationThreadPane: (await import("../../apps/shared/components/mail/ConversationThreadPane.js")).default,
    prefetchReadingPane: vi.fn(),
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
        flagged: false,
        latestMessageUid: "m1",
        latestFrom: { address: "sender@example.com", displayName: "Sender One", type: "to" as const },
        latestPreview: "Hi there, just checking in.",
        latestFolderUid: "f1",
        ...overrides,
    };
}

/** Mirrors `@rapidmx/restapi`'s own named message filters, so a test that clicks a Filter/Focused/Other
 * option sees the list the real server would have returned rather than the unfiltered page. */
function matchesListFilter(message: any, filter: string): boolean {
    switch (filter) {
        case "unread":
            return !message.flags.read;
        case "read":
            return !!message.flags.read;
        case "flagged":
            return !!message.flags.flagged;
        case "hasAttachments":
            return !!message.hasAttachments;
        case "focused":
            return message.inferenceClassification !== "other";
        case "other":
            return message.inferenceClassification === "other";
        default:
            return true;
    }
}

const IMPORTANCE_RANK: Record<string, number> = { low: 0, normal: 1, high: 2 };

/** The same sort keys, applied the same way - so a test can assert the order a chosen sort produces. */
function sortValue(message: any, sortBy: string): string | number {
    switch (sortBy) {
        case "sentDate":
            return new Date(message.sentDate).getTime();
        case "from":
            return String(message.from.address).toLowerCase();
        case "subject":
            return String(message.subject).toLowerCase();
        case "importance":
            return IMPORTANCE_RANK[message.importance] ?? 1;
        case "flagged":
            return message.flags.flagged ? 1 : 0;
        default:
            return new Date(message.receivedDate).getTime();
    }
}

/** Applies a listing URL's own `filter`/`sortBy`/`sortOrder` to a fixture array, the way the server does
 * (over the whole folder, not just the page). Paging is deliberately not applied - the existing
 * infinite-scroll tests drive their own per-page responses through `mockShellAndInbox`'s `extra` hook. */
function applyListParams(messages: unknown[], url: string): unknown[] {
    const params = new URLSearchParams(url.split("?")[1] ?? "");
    const filter = params.get("filter");
    let result = filter ? messages.filter((m) => matchesListFilter(m, filter)) : [...messages];
    // `?labelUids=a,b` is ORed across the set and ANDed with `filter`, as the server does it.
    const labelUids = params.get("labelUids")?.split(",") ?? [];
    if (labelUids.length > 0) {
        result = result.filter((m) =>
            ((m as { labelUids?: string[] }).labelUids ?? []).some((uid) => labelUids.includes(uid)),
        );
    }
    const sortBy = params.get("sortBy");
    if (!sortBy) {
        return result;
    }
    const direction = params.get("sortOrder") === "asc" ? 1 : -1;
    return result.sort((a, b) => {
        const left = sortValue(a, sortBy);
        const right = sortValue(b, sortBy);
        return left === right ? 0 : (left < right ? -1 : 1) * direction;
    });
}

function labelFixture(uid: string, name: string) {
    return {
        uid,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        name,
        color: "#ff0000",
    };
}

const LABELS = [labelFixture("l1", "Invoices"), labelFixture("l2", "Travel")];

function mockShellAndInbox(
    messages: unknown[],
    extra?: (url: string, init?: RequestInit) => Response | undefined,
    conversations: unknown[] = [],
    conversationMessages: Record<string, unknown[]> = {},
    labels: unknown[] = LABELS,
) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
        if (url.startsWith("/api/mail/labels")) return jsonResponse(200, labels);
        if (url.startsWith("/api/mail/messages/conversations/")) {
            const id = decodeURIComponent(url.slice("/api/mail/messages/conversations/".length).split("?")[0]);
            return jsonResponse(200, conversationMessages[id] ?? []);
        }
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
        if (url.startsWith("/api/mail/messages")) {
            if ((init?.method ?? "GET") === "PUT") {
                // The bulk update endpoint: every element is applied in order and echoed back.
                const updates = JSON.parse(init.body as string) as Record<string, unknown>[];
                return jsonResponse(
                    200,
                    updates.map((update) => {
                        const existing = messages.find((m: any) => m.uid === update.uid) as any;
                        return { ...existing, ...update, flags: { ...existing.flags, ...(update.flags as object) } };
                    }),
                );
            }
            return jsonResponse(200, applyListParams(messages, url));
        }
        if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

/** Opens one of the list toolbar's menus by the prefix of its button's accessible name ("Filter", "Sort",
 * "Move to"), which also carries the current selection. */
async function openListMenu(user: ReturnType<typeof userEvent.setup>, prefix: string) {
    await user.click(await screen.findByRole("button", { name: new RegExp(`^${prefix}`) }));
}

/** Picks one option out of an open menu. */
async function chooseMenuItem(user: ReturnType<typeof userEvent.setup>, role: string, name: RegExp | string) {
    await user.click(await screen.findByRole(role, { name }));
}

/** Turns "Show as conversations" (the Sort menu's arrangement item) on or off. */
async function toggleConversations(user: ReturnType<typeof userEvent.setup>) {
    await openListMenu(user, "Sort");
    await chooseMenuItem(user, "menuitemcheckbox", /^Show as conversations/);
}

/** Turns select mode on and ticks the given rows by their subject. */
async function selectRows(user: ReturnType<typeof userEvent.setup>, ...subjects: string[]) {
    await user.click(screen.getByRole("button", { name: "Select" }));
    for (const subject of subjects) {
        await user.click(await screen.findByRole("checkbox", { name: `Select ${subject}` }));
    }
}

// Every existing test predates Tier 3 and doesn't care about it - defaults its mock to "nothing to
// contribute" so `mergeSearchResults()` sees a real (empty) array rather than `undefined`, matching
// what the real `searchEncryptedCandidates()` returns when this mailbox has no unlocked keys. Tests
// that actually exercise Tier 3 override this per-test before rendering.
beforeEach(() => {
    searchEncryptedCandidates.mockResolvedValue([]);
    searchLocalIndex.mockResolvedValue({ results: [] });
    // Every test below this line was written against the flat, unfiltered list, which is what an
    // unconfigured mailbox used to open on; the defaults are now Focused + conversations
    // (`listPreferences.ts`). Storing the old arrangement for each mailbox these tests use keeps them
    // exercising the flat list they are about, and leaves the defaults themselves to the
    // "opens a never-arranged mailbox" tests, which store nothing.
    for (const uid of ["mb1", "mb2", "mbA", "mbB"]) {
        localStorage.setItem(
            `rapidmx:mail-list-preferences:${uid}`,
            JSON.stringify({ sortBy: "date", sortOrder: "desc", filter: "all", labelUids: [], showAsConversations: false }),
        );
    }
});

afterEach(() => {
    vi.unstubAllGlobals();
    clearInviteCache();
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

    it("finds a folder the sidebar lacks when a message on screen lives in it - the Outbox and Sent Items are made by the server on first use", async () => {
        // The server lists only the Inbox when the page loads, and has made Sent Items by the time the page asks again.
        let listings = 0;
        mockShellAndInbox([messageFixture({ folderUid: "f2" })], (url) =>
            url.startsWith("/api/mail/folders") ? jsonResponse(200, listings++ === 0 ? [inboxFolder] : [inboxFolder, sentItemsFolder]) : undefined,
        );
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Sender One");
        expect(await screen.findByRole("link", { name: /Sent Items/ }, { timeout: 4_000 })).toBeInTheDocument();
        expect(listings).toBeGreaterThan(1);
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

    it("shows the sender's address beside their name in each row, and just the address for a sender with no name", async () => {
        mockShellAndInbox([
            messageFixture(),
            messageFixture({ uid: "m2", subject: "No name", from: { address: "anon@example.org", type: "to" as const } }),
        ]);
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Hello there");

        expect(screen.getByText("Sender One <sender@example.com>", { selector: ".sr-only" })).toBeInTheDocument();
        expect(screen.getByText("Sender One")).toBeInTheDocument();
        expect(screen.getByText("anon@example.org", { selector: ".sr-only" })).toBeInTheDocument();
    });

    it("marks a row that has an attachment", async () => {
        mockShellAndInbox([messageFixture({ hasAttachments: true })]);
        render(<InboxPage userUid="u1" />);
        await screen.findByText("Hello there");
        expect(screen.getByLabelText("Has attachments")).toBeInTheDocument();
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
        it("hands the reading pane the mailbox's folders, for its own Move to prompt", async () => {
            mockShellAndInbox([messageFixture()]);
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("folders:Inbox");
        });

        it("shows no sub-tabs for a non-Inbox folder", async () => {
            window.history.pushState(null, "", "/?mailboxUid=mb1&folderUid=f2");
            mockFetch((url) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, sentItemsFolder]);
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, [messageFixture({ folderUid: "f2" })]);
                throw new Error(`unexpected ${url}`);
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("folders:Inbox/Sent Items");
            // The folder in the address is read in an effect, after the first render: until then the shell is on the Inbox (and every
            // list this mock serves shows the same message), so the folder being Sent Items - not the message being listed - is what says the
            // tabs have been taken away.
            await waitFor(() => expect(screen.getByRole("link", { name: /^Sent Items/ })).toHaveClass("bg-primary/10"));
            expect(screen.queryByRole("button", { name: "Focused" })).not.toBeInTheDocument();
        });

        it("offers only Focused and Other as tabs - the whole Inbox is the Filter menu's All", async () => {
            mockShellAndInbox([messageFixture({ uid: "m1", subject: "Focused message" })]);
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Focused message");

            expect(screen.getByRole("button", { name: "Focused" })).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Other" })).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "All" })).not.toBeInTheDocument();
        });

        it("keeps listing everything for a mailbox that remembered the All filter", async () => {
            // "All" left the tab row, not the filter vocabulary - a stored `all` still lists the whole
            // Inbox (with neither tab pressed) rather than being migrated into one of the two halves.
            const fetchMock = mockShellAndInbox([
                messageFixture({ uid: "m1", subject: "Focused message" }),
                messageFixture({ uid: "m2", subject: "Other message", inferenceClassification: "other" }),
            ]);
            localStorage.setItem(
                "rapidmx:mail-list-preferences:mb1",
                JSON.stringify({ sortBy: "date", sortOrder: "desc", filter: "all", showAsConversations: false }),
            );
            render(<InboxPage userUid="u1" />);

            expect(await screen.findByText("Focused message")).toBeInTheDocument();
            expect(screen.getByText("Other message")).toBeInTheDocument();
            expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("filter=all"), expect.anything());
            expect(screen.getByRole("button", { name: "Focused" })).toHaveAttribute("aria-pressed", "false");
            expect(screen.getByRole("button", { name: "Other" })).toHaveAttribute("aria-pressed", "false");
        });

        it("filters the message list by Focused/Other, and back to everything from the Filter menu", async () => {
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

            await openListMenu(user, "Filter");
            await chooseMenuItem(user, "menuitemradio", "All");
            expect(await screen.findByText("Focused message")).toBeInTheDocument();
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

        it("takes a moved message out of the list, leaving the rest of it listed", async () => {
            const msg = messageFixture();
            const other = messageFixture({ uid: "m2", subject: "Untouched message" });
            mockShellAndInbox([msg, other]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByText("Hello there"));
            await user.click(screen.getByText("simulate-move"));

            // It left the folder being listed, so it leaves the list too - the same rule Archive follows.
            expect(screen.queryByText("Hello there")).not.toBeInTheDocument();
            expect(screen.getByText("Untouched message")).toBeInTheDocument();
        });

        it("adds a folder created from the reading pane to the ones its own prompt offers", async () => {
            mockShellAndInbox([messageFixture()]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await user.click(await screen.findByText("Hello there"));

            await user.click(screen.getByText("simulate-folder-created"));

            expect(screen.getByTestId("detail-pane")).toHaveTextContent("folders:Inbox/Made here");
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

    describe("meeting requests", () => {
        const invite = {
            method: "REQUEST",
            uid: "ical-1",
            sequence: 0,
            summary: "Video Test",
            startDate: "2026-06-16T13:00:00.000Z",
            endDate: "2026-06-16T14:00:00.000Z",
            allDay: false,
            attendees: [],
            recurring: false,
            isOrganizer: false,
            onCalendar: false,
            outdated: false,
            canRespond: true,
            canAdd: false,
            canRemove: false,
            canPropose: true,
            canAcceptProposal: false,
            conflicts: [],
            schedule: [],
        };
        const rows = () => [
            messageFixture({ uid: "m1", subject: "Video Test", meetingMethod: "REQUEST" }),
            messageFixture({ uid: "m2", subject: "Just a note" }),
            messageFixture({ uid: "m3", subject: "Their answer", meetingMethod: "REPLY" }),
        ];
        function mockWithInvites() {
            return mockShellAndInbox(rows(), (url, init) => {
                if (url.endsWith("/respond")) return jsonResponse(200, { ...invite, response: JSON.parse(init!.body as string).responseStatus });
                if (url.includes("/calendar-events/invite/")) return jsonResponse(200, invite);
                return undefined;
            });
        }
        const inviteCalls = (fetchMock: ReturnType<typeof mockFetch>) => fetchMock.mock.calls.filter(([url]) => String(url).includes("/calendar-events/invite/"));

        it("draws an RSVP chip under a meeting request only, and asks the server about no other row", async () => {
            const fetchMock = mockWithInvites();
            render(<InboxPage userUid="u1" />);

            const rsvp = await screen.findByRole("button", { name: "RSVP to Video Test" });
            expect(screen.getAllByRole("button", { name: /RSVP/ })).toHaveLength(1);
            expect(rsvp.closest("[data-invite-chip]")).toHaveTextContent("No conflicts");
            expect(screen.getByText("Just a note")).toBeInTheDocument();
            expect(inviteCalls(fetchMock).map(([url]) => url)).toEqual(["/api/mail/calendar-events/invite/m1"]);
            // The chip sits with its row, beside the button that opens it (a button can't hold a button).
            expect(rsvp.closest("[data-message-uid]")).toHaveAttribute("data-message-uid", "m1");
            expect(rsvp.closest("[data-row-open]")).toBeNull();
        });

        it("answers from the chip without opening the row, and the list then shows the answer", async () => {
            const fetchMock = mockWithInvites();
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByRole("button", { name: "RSVP to Video Test" }));
            const dialog = await screen.findByRole("dialog", { name: "RSVP: Video Test" });
            expect(screen.getByText(/no-message/)).toBeInTheDocument();
            await user.click(within(dialog).getByRole("button", { name: "Tentative" }));

            await waitFor(() => expect(screen.queryByRole("dialog", { name: "RSVP: Video Test" })).not.toBeInTheDocument());
            expect(screen.getByRole("button", { name: "RSVP to Video Test" }).closest("[data-invite-chip]")).toHaveTextContent("Tentative");
            // Neither the RSVP button nor the answer opened the message.
            expect(screen.getByText(/no-message/)).toBeInTheDocument();
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/invite/m1/respond", expect.objectContaining({ method: "POST" }));
        });

        it("draws the chip on a conversation's own row too, asking once, and answers from it without opening the conversation", async () => {
            localStorage.setItem(
                "rapidmx:mail-list-preferences:mb1",
                JSON.stringify({ sortBy: "date", sortOrder: "desc", filter: "all", labelUids: [], showAsConversations: true }),
            );
            const fetchMock = mockShellAndInbox(
                [],
                (url, init) => {
                    if (url.endsWith("/respond")) return jsonResponse(200, { ...invite, response: JSON.parse(init!.body as string).responseStatus });
                    if (url.includes("/calendar-events/invite/")) return jsonResponse(200, invite);
                    return undefined;
                },
                [
                    conversationFixture({ conversationId: "c1", subject: "Video Test", latestMessageUid: "m1", latestMeetingMethod: "REQUEST", latestMeetingResponse: null }),
                    conversationFixture({ conversationId: "c2", subject: "Just a note", latestMessageUid: "m2", latestMeetingMethod: null, latestMeetingResponse: null }),
                ],
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByRole("button", { name: "RSVP to Video Test" }));
            expect(screen.getAllByRole("button", { name: /RSVP/ })).toHaveLength(1);
            await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Accept" }));

            await waitFor(() => expect(screen.getByRole("button", { name: "RSVP to Video Test" }).closest("[data-invite-chip]")).toHaveTextContent("Accepted"));
            expect(inviteCalls(fetchMock).map(([url]) => url)).toEqual(["/api/mail/calendar-events/invite/m1", "/api/mail/calendar-events/invite/m1/respond"]);
            expect(screen.queryByText(/message:m1/)).not.toBeInTheDocument();
        });

        it("keeps a finger on the chip from swiping the row on a phone", async () => {
            mockMatchMedia(true);
            const fetchMock = mockWithInvites();
            render(<InboxPage userUid="u1" />);
            const rsvp = await screen.findByRole("button", { name: "RSVP to Video Test" });
            const row = rsvp.closest("[data-message-uid]") as HTMLElement;

            // The same drag on the row's own open button does start a swipe...
            const open = within(row).getByText("Video Test").closest("[data-row-open]")!;
            fireEvent.touchStart(open, { touches: [{ clientX: 300, clientY: 100 }] });
            fireEvent.touchMove(open, { touches: [{ clientX: 150, clientY: 102 }] });
            fireEvent.touchMove(open, { touches: [{ clientX: 60, clientY: 104 }] });
            expect(row).toHaveAttribute("data-swiping", "true");
            fireEvent.touchCancel(open);
            await waitFor(() => expect(row).not.toHaveAttribute("data-swiping"));

            // ...and on the chip it does not.
            fireEvent.touchStart(rsvp, { touches: [{ clientX: 300, clientY: 100 }] });
            fireEvent.touchMove(rsvp, { touches: [{ clientX: 150, clientY: 102 }] });
            fireEvent.touchMove(rsvp, { touches: [{ clientX: 60, clientY: 104 }] });
            fireEvent.touchEnd(rsvp);
            expect(row).not.toHaveAttribute("data-swiping");
            expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/mail/messages" && init?.method === "PUT")).toBe(false);
            expect(screen.getByText("Video Test", { selector: "div" })).toBeInTheDocument();
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

        it("shows what each message in the Outbox is doing - sending, retrying, why it wasn't sent, scheduled - and nothing of the kind in other folders", async () => {
            window.history.pushState(null, "", "/?mailboxUid=mb1&folderUid=f3");
            const soon = new Date(Date.now() + 60_000).toISOString();
            const later = new Date(Date.now() + 3_600_000).toISOString();
            const modified = new Date().toISOString();
            const rows = [
                messageFixture({ uid: "o1", subject: "Going out", folderUid: "f3", dateModified: modified, scheduledSendTime: modified }),
                messageFixture({ uid: "o2", subject: "Trying again", folderUid: "f3", scheduledSendAttempts: 1, scheduledSendTime: soon }),
                messageFixture({ uid: "o3", subject: "Refused", folderUid: "f3", scheduledSendError: "Some recipients were refused." }),
                messageFixture({ uid: "o4", subject: "Later", folderUid: "f3", scheduledSendTime: later }),
            ];
            mockFetch((url) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, outboxFolder, draftsFolder]);
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, rows);
                throw new Error(`unexpected ${url}`);
            });
            render(<InboxPage userUid="u1" />);

            await screen.findByText("Going out");
            const status = (subject: string) => screen.getByText(subject).closest("li")!.querySelector('[data-testid="outbox-row-status"]')!;
            expect(status("Going out")).toHaveAttribute("data-state", "sending");
            expect(status("Going out")).toHaveTextContent("Sending…");
            expect(status("Trying again")).toHaveTextContent(/^Retrying \(attempt 2, .+\)$/);
            expect(status("Refused")).toHaveAttribute("data-state", "failed");
            expect(status("Refused")).toHaveTextContent("Not sent: Some recipients were refused.");
            expect(status("Refused").className).toContain("text-danger");
            expect(status("Later")).toHaveTextContent(/^Scheduled for /);
            window.history.pushState(null, "", "/");
        });

        it("has no such line for a message outside the Outbox", async () => {
            mockShellAndInbox([messageFixture({ uid: "m1", subject: "Just mail" })]);
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Just mail");
            expect(screen.queryByTestId("outbox-row-status")).not.toBeInTheDocument();
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

    describe("conversations", () => {
        /** One message's header inside the *thread pane* - the list's own child row shows the same
         * sender, so the two are told apart by the header's `aria-controls`. */
        const threadHeader = (name: RegExp) =>
            screen.getAllByRole("button", { name }).find((button) => button.getAttribute("aria-controls")?.startsWith("thread-message-"));

        /** The thread's own messages, oldest first, as `listConversationMessages()` answers with. */
        const threadMessages = () => [
            messageFixture({
                uid: "m1",
                subject: "First",
                bodyPreview: "The opening message",
                from: { address: "older@example.com", displayName: "Older Sender", type: "to" },
                flags: { read: true, flagged: false, answered: false, forwarded: false },
            }),
            messageFixture({
                uid: "m2",
                subject: "Second",
                bodyPreview: "The most recent reply",
                from: { address: "newer@example.com", displayName: "Newer Sender", type: "to" },
                flags: { read: true, flagged: false, answered: false, forwarded: false },
            }),
        ];

        const thread = () =>
            conversationFixture({
                subject: "Thread subject",
                messageUids: ["m1", "m2"],
                messageCount: 2,
                unreadCount: 1,
                latestMessageUid: "m2",
                latestPreview: "The most recent reply",
                hasAttachments: true,
                flagged: true,
            });

        it("opens a mailbox nobody has arranged yet on Focused, shown as conversations", async () => {
            // Nothing stored: this is the very first time this mailbox is opened - see
            // `DEFAULT_MAIL_LIST_PREFERENCES`. (Every other test in this file stores the flat, unfiltered
            // arrangement in `beforeEach`.)
            localStorage.clear();
            const fetchMock = mockShellAndInbox([messageFixture({ subject: "Flat row" })], undefined, [thread()]);
            render(<InboxPage userUid="u1" />);

            expect(await screen.findByText("Thread subject")).toBeInTheDocument();
            expect(screen.queryByText("Flat row")).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Focused" })).toHaveAttribute("aria-pressed", "true");
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining("/api/mail/messages/conversations?mailboxUid=mb1&folderUid=f1&filter=focused"),
                expect.anything(),
            );
        });

        it("still honours a mailbox arranged as a flat, unfiltered list", async () => {
            // What `beforeEach` stores - asserted here rather than left implicit in every other test.
            const fetchMock = mockShellAndInbox([messageFixture({ subject: "Flat row" })], undefined, [thread()]);
            render(<InboxPage userUid="u1" />);

            expect(await screen.findByText("Flat row")).toBeInTheDocument();
            expect(screen.queryByText("Thread subject")).not.toBeInTheDocument();
            expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("filter=all"), expect.anything());
        });

        describe("select mode", () => {
            /** Turns on select mode and ticks the seeded conversation. */
            async function selectThread(user: ReturnType<typeof userEvent.setup>) {
                await user.click(screen.getByRole("button", { name: "Select" }));
                await user.click(await screen.findByRole("checkbox", { name: "Select conversation: Thread subject" }));
            }

            it("ticks a whole conversation and acts on every message of it in this folder", async () => {
                const unread = threadMessages().map((m) => ({ ...m, flags: { ...m.flags, read: false } }));
                // A message of the same conversation in another folder (the Sent Items copy of a reply):
                // the list only showed this folder's half, and neither does the selection.
                const sentCopy = messageFixture({ uid: "m3", folderUid: "f-sent", subject: "Sent copy" });
                // Also handed to the mock as the folder's own messages, so the bulk PUT it answers can echo
                // them back - without that the action fails and this would prove the failure path instead.
                const fetchMock = mockShellAndInbox([...unread, sentCopy], undefined, [thread()], {
                    c1: [...unread, sentCopy],
                });
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);
                await screen.findByText("Thread subject");

                await selectThread(user);
                expect(await screen.findByText("1 conversation selected")).toBeInTheDocument();
                await user.click(screen.getByRole("button", { name: "Mark read" }));

                const bulk = fetchMock.mock.calls.find(
                    ([url, init]: any[]) => url === "/api/mail/messages" && init?.method === "PUT",
                );
                expect(JSON.parse(bulk![1].body as string).map((u: any) => u.uid)).toEqual(["m1", "m2"]);
                // A conversation row summarizes its messages, so the list is reloaded rather than patched.
                await waitFor(() =>
                    expect(
                        fetchMock.mock.calls.filter(([url]: any[]) =>
                            String(url).includes("/api/mail/messages/conversations?"),
                        ).length,
                    ).toBeGreaterThan(1),
                );
                expect(await screen.findByText("0 conversations selected")).toBeInTheDocument();
                expect(getNotificationsSnapshot().visible).toEqual([]);
            });

            it("ticks the conversation a row's own button would otherwise open", async () => {
                mockShellAndInbox([], undefined, [thread()], { c1: threadMessages() });
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);
                await screen.findByText("Thread subject");
                await user.click(screen.getByRole("button", { name: "Select" }));

                await user.click(screen.getByText("Thread subject"));

                expect(await screen.findByText("1 conversation selected")).toBeInTheDocument();
                expect(screen.getByRole("checkbox", { name: "Select conversation: Thread subject" })).toBeChecked();
            });

            it("selects every listed conversation at once, and clears them again", async () => {
                mockShellAndInbox([], undefined, [thread()], { c1: threadMessages() });
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);
                await screen.findByText("Thread subject");
                await user.click(screen.getByRole("button", { name: "Select" }));

                await user.click(screen.getByRole("button", { name: "Select all" }));
                expect(await screen.findByText("1 conversation selected")).toBeInTheDocument();

                await user.click(screen.getByRole("button", { name: "Clear" }));
                expect(await screen.findByText("0 conversations selected")).toBeInTheDocument();
            });

            it("unticks a conversation whose messages can't be loaded, and says so", async () => {
                mockShellAndInbox(
                    [],
                    (url) =>
                        url.startsWith("/api/mail/messages/conversations/")
                            ? jsonResponse(500, { message: "thread boom" })
                            : undefined,
                    [thread()],
                );
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);
                await screen.findByText("Thread subject");

                await selectThread(user);

                expect(await screen.findByText("thread boom")).toBeInTheDocument();
                await waitFor(() =>
                    expect(screen.getByRole("checkbox", { name: "Select conversation: Thread subject" })).not.toBeChecked(),
                );
            });

            it("says so generically when loading a ticked conversation's messages fails with a non-API error", async () => {
                mockShellAndInbox(
                    [],
                    (url) => {
                        if (url.startsWith("/api/mail/messages/conversations/")) {
                            throw new TypeError("network down");
                        }
                        return undefined;
                    },
                    [thread()],
                );
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);
                await screen.findByText("Thread subject");

                await selectThread(user);

                expect(await screen.findByText("Couldn't load the messages in one of those conversations")).toBeInTheDocument();
                expect(screen.getByText("The server couldn't be reached. Check your connection and try again.")).toBeInTheDocument();
            });

            it("unticks a conversation ticked twice, and fetches its messages only once", async () => {
                const fetchMock = mockShellAndInbox([], undefined, [thread()], { c1: threadMessages() });
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);
                await screen.findByText("Thread subject");
                await selectThread(user);
                await screen.findByText("1 conversation selected");

                await user.click(screen.getByRole("checkbox", { name: "Select conversation: Thread subject" }));
                expect(await screen.findByText("0 conversations selected")).toBeInTheDocument();
                await user.click(screen.getByRole("checkbox", { name: "Select conversation: Thread subject" }));
                await screen.findByText("1 conversation selected");

                expect(
                    fetchMock.mock.calls.filter(([url]: any[]) =>
                        String(url).startsWith("/api/mail/messages/conversations/"),
                    ).length,
                ).toBe(1);
            });

            it("leaves select mode and drops the selection on Cancel", async () => {
                mockShellAndInbox([], undefined, [thread()], { c1: threadMessages() });
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);
                await screen.findByText("Thread subject");
                await selectThread(user);
                await screen.findByText("1 conversation selected");

                await user.click(screen.getByRole("button", { name: "Cancel" }));

                expect(screen.queryByRole("checkbox", { name: "Select conversation: Thread subject" })).not.toBeInTheDocument();
                expect(screen.getByRole("button", { name: "Select" })).toBeInTheDocument();
            });

            it("reloads the conversation list and says so when a bulk action is rejected", async () => {
                mockShellAndInbox(
                    [],
                    (url, init) =>
                        url === "/api/mail/messages" && init?.method === "PUT"
                            ? jsonResponse(409, { message: "version conflict" })
                            : undefined,
                    [thread()],
                    { c1: threadMessages() },
                );
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);
                await screen.findByText("Thread subject");
                await selectThread(user);
                await screen.findByText("1 conversation selected");

                await user.click(screen.getByRole("button", { name: "Mark read" }));

                expect(await screen.findByText(/version conflict/)).toBeInTheDocument();
                expect(await screen.findByText("0 conversations selected")).toBeInTheDocument();
            });
        });

        it("replaces the flat list with conversations, scoped to the selected folder and the current filter", async () => {
            const fetchMock = mockShellAndInbox([messageFixture({ subject: "Flat row" })], undefined, [thread()]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Flat row");

            await toggleConversations(user);

            expect(await screen.findByText("Thread subject")).toBeInTheDocument();
            expect(screen.getByText("The most recent reply")).toBeInTheDocument();
            expect(screen.getByText("2 messages")).toBeInTheDocument();
            expect(screen.getByText("1 unread")).toBeInTheDocument();
            expect(screen.getByLabelText("Has attachments")).toBeInTheDocument();
            expect(screen.getByLabelText("Flagged")).toBeInTheDocument();
            expect(screen.queryByText("Flat row")).not.toBeInTheDocument();
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining("/api/mail/messages/conversations?mailboxUid=mb1&folderUid=f1&filter=all"),
                expect.anything(),
            );
        });

        it("expands a conversation into its own messages and collapses it again", async () => {
            mockShellAndInbox([], undefined, [thread()], {
                c1: [
                    messageFixture({ uid: "m1", subject: "First", bodyPreview: "The opening message", flags: { read: true, flagged: false, answered: false, forwarded: false } }),
                    messageFixture({ uid: "m2", subject: "Second", bodyPreview: "The most recent reply" }),
                ],
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await toggleConversations(user);

            await user.click(await screen.findByRole("button", { name: "Expand conversation: Thread subject" }));

            expect(await screen.findByText("The opening message")).toBeInTheDocument();
            const chevron = screen.getByRole("button", { name: "Collapse conversation: Thread subject" });
            expect(chevron).toHaveAttribute("aria-expanded", "true");

            await user.click(chevron);
            expect(screen.getByRole("button", { name: "Expand conversation: Thread subject" })).toHaveAttribute(
                "aria-expanded",
                "false",
            );
        });

        it("fetches a conversation's messages only once, however often it is re-expanded", async () => {
            const fetchMock = mockShellAndInbox([], undefined, [thread()], {
                c1: [messageFixture({ uid: "m1", bodyPreview: "The opening message" })],
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await toggleConversations(user);

            await user.click(await screen.findByRole("button", { name: "Expand conversation: Thread subject" }));
            await screen.findByText("The opening message");
            await user.click(screen.getByRole("button", { name: "Collapse conversation: Thread subject" }));
            await user.click(screen.getByRole("button", { name: "Expand conversation: Thread subject" }));

            const childRequests = fetchMock.mock.calls.filter(([url]: [string]) =>
                String(url).startsWith("/api/mail/messages/conversations/"),
            );
            expect(childRequests).toHaveLength(1);
        });

        it("shows an error on the row when a conversation's messages can't be loaded", async () => {
            mockShellAndInbox([], (url) =>
                url.startsWith("/api/mail/messages/conversations/") ? jsonResponse(500, { message: "thread boom" }) : undefined,
                [thread()],
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await toggleConversations(user);

            await user.click(await screen.findByRole("button", { name: "Expand conversation: Thread subject" }));

            // On the row (it belongs to it), not a pop-up: the pop-up region's own alert is empty.
            expect(await screen.findByText("thread boom")).toHaveAttribute("role", "alert");
            expect(getNotificationsSnapshot().visible).toEqual([]);
        });

        it("shows a generic error on the row when loading a conversation's messages fails with a non-API error", async () => {
            mockShellAndInbox([], (url) => {
                if (url.startsWith("/api/mail/messages/conversations/")) throw new TypeError("network down");
                return undefined;
            }, [thread()]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await toggleConversations(user);

            await user.click(await screen.findByRole("button", { name: "Expand conversation: Thread subject" }));

            expect(await screen.findByText("Could not load this conversation's messages.")).toHaveAttribute("role", "alert");
        });

        it("opens the whole thread at its latest message when the parent row is clicked", async () => {
            mockShellAndInbox([], undefined, [thread()], { c1: threadMessages() });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await toggleConversations(user);

            await user.click(await screen.findByText("Thread subject"));

            // The newest message is the only one expanded; the one before it is a collapsed summary.
            const panes = await screen.findAllByTestId("detail-pane");
            expect(panes).toHaveLength(1);
            expect(panes[0]).toHaveTextContent("message:m2");
            expect(threadHeader(/^Older Sender/)).toHaveAttribute("aria-expanded", "false");
        });

        it("opens the thread at the child message that was clicked, expanding the run from it", async () => {
            const fetchMock = mockShellAndInbox([], undefined, [thread()], { c1: threadMessages() });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await toggleConversations(user);
            await user.click(await screen.findByRole("button", { name: "Expand conversation: Thread subject" }));

            await user.click(await screen.findByText("The opening message"));

            await waitFor(() => expect(screen.getAllByTestId("detail-pane")).toHaveLength(2));
            // The pane reads newest first, so the opened message is the *last* of the expanded run.
            expect(screen.getAllByTestId("detail-pane")[0]).toHaveTextContent("message:m2");
            expect(screen.getAllByTestId("detail-pane")[1]).toHaveTextContent("message:m1");
            // The thread scrolls to and focuses the message it opened at.
            expect(document.activeElement).toBe(threadHeader(/^Older Sender/));
            // The thread pane loads the thread itself rather than the individual message the row stands for.
            const refetches = fetchMock.mock.calls.filter(
                ([url, init]: [string, RequestInit]) => url === "/api/mail/messages/m1" && (init?.method ?? "GET") === "GET",
            );
            expect(refetches).toHaveLength(0);
        });

        it("adds a label created from a message in the thread to the ones the menus offer", async () => {
            mockShellAndInbox([], undefined, [thread()], { c1: threadMessages() });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await toggleConversations(user);
            await user.click(await screen.findByText("Thread subject"));
            await screen.findByTestId("detail-pane");

            await user.click(screen.getByRole("button", { name: "simulate-label-created" }));

            expect(screen.getByTestId("detail-pane")).toHaveTextContent("labels:Invoices/Travel/Made here");
        });

        it("keeps the list in step with what an action in the thread did to a message", async () => {
            mockShellAndInbox([], undefined, [thread()], { c1: threadMessages() });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await toggleConversations(user);
            await user.click(await screen.findByRole("button", { name: "Expand conversation: Thread subject" }));
            await user.click(await screen.findByText("The opening message"));
            await waitFor(() => expect(screen.getAllByTestId("detail-pane")).toHaveLength(2));

            // Archiving from inside the thread takes the message out of the thread and out of the list.
            // The oldest of the run is the last entry now that the pane reads newest first.
            await user.click(screen.getAllByRole("button", { name: "simulate-archive" })[1]);

            await waitFor(() => expect(screen.getAllByTestId("detail-pane")).toHaveLength(1));
            expect(threadHeader(/^Older Sender/)).toBeUndefined();
            // ...and out of the list's own rows, which the flat list would show after switching back.
            expect(screen.getAllByTestId("detail-pane")[0]).toHaveTextContent("message:m2");
        });

        it("marks an opened child message read and stops showing it as unread in the list", async () => {
            const child = messageFixture({ uid: "m1", subject: "First", bodyPreview: "The opening message" });
            mockShellAndInbox([child], undefined, [thread()], { c1: [child] });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await toggleConversations(user);
            await user.click(await screen.findByRole("button", { name: "Expand conversation: Thread subject" }));
            const row = await screen.findByText("The opening message");
            expect(row.closest("li")).toHaveAttribute("data-unread", "true");

            await user.click(row);

            await waitFor(() => expect(screen.getByText("The opening message").closest("li")).not.toHaveAttribute("data-unread"));
        });

        it("navigates to the message's page with its conversation, which shows the whole thread, instead of opening it in place on mobile", async () => {
            mockMatchMedia(true);
            mockShellAndInbox([], undefined, [thread()]);
            const location = mockLocation();
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await toggleConversations(user);

            await user.click(await screen.findByText("Thread subject"));

            expect(location.href).toBe("/messages/m2?conversation=c1");
        });

        describe("swiping a conversation row on a phone", () => {
            const archiveFolder = { ...inboxFolder, uid: "f8", name: "Archive", type: "archive" as const };
            const swipeRow = (row: HTMLElement, fromX: number, toX: number) => {
                fireEvent.touchStart(row, { touches: [{ clientX: fromX, clientY: 100 }] });
                fireEvent.touchMove(row, { touches: [{ clientX: (fromX + toX) / 2, clientY: 102 }] });
                fireEvent.touchMove(row, { touches: [{ clientX: toX, clientY: 104 }] });
                fireEvent.touchEnd(row);
            };
            function mockThread(messages: any[], before?: (url: string, init?: RequestInit) => Response | undefined) {
                return mockShellAndInbox(
                    messages,
                    (url, init) => {
                        const custom = before?.(url, init);
                        if (custom) return custom;
                        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, archiveFolder]);
                        if (url === "/api/mail/messages" && init?.method === "PUT") {
                            return jsonResponse(
                                200,
                                (JSON.parse(init.body as string) as any[]).map((update) => ({ ...messages.find((m) => m.uid === update.uid), ...update })),
                            );
                        }
                        return undefined;
                    },
                    [thread()],
                    { c1: messages },
                );
            }
            const bulkPut = (fetchMock: ReturnType<typeof mockThread>) =>
                fetchMock.mock.calls.find(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT");

            it("archives every message of the conversation in this folder when swiped from right to left", async () => {
                mockMatchMedia(true);
                const messages = threadMessages();
                const fetchMock = mockThread(messages);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);

                swipeRow((await screen.findByText("Thread subject")).closest("[data-message-uid]") as HTMLElement, 300, 60);

                await waitFor(() => expect(bulkPut(fetchMock)).toBeDefined());
                expect(JSON.parse(bulkPut(fetchMock)![1].body as string)).toEqual([
                    { uid: "m1", version: 0, folderUid: "f8" },
                    { uid: "m2", version: 0, folderUid: "f8" },
                ]);
            });

            it("asks for a folder for the whole conversation when swiped from left to right", async () => {
                mockMatchMedia(true);
                const messages = threadMessages();
                const fetchMock = mockThread(messages);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);

                swipeRow((await screen.findByText("Thread subject")).closest("[data-message-uid]") as HTMLElement, 40, 300);

                const dialog = await screen.findByRole("dialog", { name: "Move 2 messages to" });
                expect(bulkPut(fetchMock)).toBeUndefined();
                await user.click(within(dialog).getByRole("button", { name: /^Archive/ }));
                await waitFor(() => expect(bulkPut(fetchMock)).toBeDefined());
                expect(JSON.parse(bulkPut(fetchMock)![1].body as string).map((update: { uid: string }) => update.uid)).toEqual(["m1", "m2"]);
            });

            const conversationLoadFailed = (url: string) =>
                url.startsWith("/api/mail/messages/conversations/c1") ? jsonResponse(500, { message: "The server is unavailable." }) : undefined;
            const failedToLoad = () =>
                getNotificationsSnapshot().visible.some((item) => item.kind === "error" && item.title === "Couldn't load the messages in that conversation");
            const panelsOf = (row: HTMLElement) => row.querySelector("[data-swipe-panel]");

            it("puts the row back, and says why, when the messages of a conversation swiped to archive can't be loaded", async () => {
                mockMatchMedia(true);
                const fetchMock = mockThread(threadMessages(), conversationLoadFailed);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);
                const row = (await screen.findByText("Thread subject")).closest("[data-message-uid]") as HTMLElement;

                swipeRow(row, 300, 60);
                // On its way out while the messages are fetched...
                expect(panelsOf(row)).not.toBeNull();

                await waitFor(() => expect(failedToLoad()).toBe(true));
                // ...and back once they can't be.
                await waitFor(() => expect(panelsOf(row)).toBeNull());
                expect(bulkPut(fetchMock)).toBeUndefined();
                expect(screen.getByText("Thread subject")).toBeInTheDocument();
            });

            it("closes the folder prompt, and says why, when the messages of a conversation swiped to move can't be loaded", async () => {
                mockMatchMedia(true);
                const fetchMock = mockThread(threadMessages(), conversationLoadFailed);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);

                swipeRow((await screen.findByText("Thread subject")).closest("[data-message-uid]") as HTMLElement, 40, 300);
                const dialog = await screen.findByRole("dialog", { name: "Move 2 messages to" });
                await user.click(within(dialog).getByRole("button", { name: /^Archive/ }));

                await waitFor(() => expect(failedToLoad()).toBe(true));
                await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
                expect(bulkPut(fetchMock)).toBeUndefined();
                expect(screen.getByText("Thread subject")).toBeInTheDocument();
            });

            it("puts the row back without an error when none of the conversation's messages are in this folder", async () => {
                mockMatchMedia(true);
                const elsewhere = threadMessages().map((message) => ({ ...message, folderUid: "f-elsewhere" }));
                const fetchMock = mockThread(elsewhere);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);
                const row = (await screen.findByText("Thread subject")).closest("[data-message-uid]") as HTMLElement;

                swipeRow(row, 300, 60);
                expect(panelsOf(row)).not.toBeNull();

                await waitFor(() => expect(panelsOf(row)).toBeNull());
                expect(bulkPut(fetchMock)).toBeUndefined();
                expect(failedToLoad()).toBe(false);
            });
        });

        it("pages through conversations when the sentinel intersects", async () => {
            const firstPage = Array.from({ length: 50 }, (_, i) =>
                conversationFixture({ conversationId: `c${i}`, subject: `Thread ${i}`, latestMessageUid: `m${i}` }),
            );
            const io = mockIntersectionObserver();
            mockShellAndInbox([], (url) =>
                url.includes("/api/mail/messages/conversations?") && url.includes("page=1")
                    ? jsonResponse(200, [conversationFixture({ conversationId: "c-late", subject: "Thread on page two", latestMessageUid: "m-late" })])
                    : undefined,
                firstPage,
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await toggleConversations(user);
            await screen.findByText("Thread 0");

            io.trigger();

            expect(await screen.findByText("Thread on page two")).toBeInTheDocument();
        });

        it("drops a conversation page that lands after the listing has been restarted", async () => {
            const firstPage = Array.from({ length: 50 }, (_, i) =>
                conversationFixture({ conversationId: `c${i}`, subject: `Thread ${i}`, latestMessageUid: `m${i}` }),
            );
            const io = mockIntersectionObserver();
            const latePages: { promise: Promise<Response>; resolve: (value: Response) => void }[] = [];
            mockShellAndInbox([], (url) => {
                if (!url.includes("/api/mail/messages/conversations?") || !url.includes("page=1")) return undefined;
                let resolve!: (value: Response) => void;
                const promise = new Promise<Response>((res) => {
                    resolve = res;
                });
                latePages.push({ promise, resolve });
                return promise as unknown as Response;
            }, firstPage);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await toggleConversations(user);
            await screen.findByText("Thread 0");

            io.trigger();
            await waitFor(() => expect(latePages).toHaveLength(1));
            // A filter change restarts the listing, so the page still in flight belongs to a list that is
            // no longer on screen.
            await openListMenu(user, "Filter");
            await chooseMenuItem(user, "menuitemradio", "Unread");
            await screen.findByText("Thread 0");

            latePages[0].resolve(jsonResponse(200, [conversationFixture({ conversationId: "c-late", subject: "Thread from the old list", latestMessageUid: "m-late" })]));
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
            });

            expect(screen.queryByText("Thread from the old list")).not.toBeInTheDocument();
        });

        it("shows an empty state when the folder has no conversations", async () => {
            mockShellAndInbox([], undefined, []);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await toggleConversations(user);

            expect(await screen.findByText("No conversations in this folder.")).toBeInTheDocument();
        });

        it("shows an error message when loading conversations fails", async () => {
            mockShellAndInbox([], (url) =>
                url.startsWith("/api/mail/messages/conversations") ? jsonResponse(500, { message: "boom" }) : undefined,
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await toggleConversations(user);

            expect(await screen.findByText("boom")).toBeInTheDocument();
        });

        it("shows a generic error message when loading conversations fails with a non-API error", async () => {
            mockShellAndInbox([], (url) => {
                if (url.startsWith("/api/mail/messages/conversations")) throw new TypeError("network down");
                return undefined;
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await toggleConversations(user);

            expect(await screen.findByText("Could not load conversations.")).toBeInTheDocument();
        });

        it("keeps the search box, and Select, while conversations are shown", async () => {
            mockShellAndInbox([messageFixture()], undefined, [thread()]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");
            expect(screen.getByLabelText("Search all mail")).toBeInTheDocument();

            await toggleConversations(user);

            await screen.findByText("Thread subject");
            expect(screen.getByLabelText("Search all mail")).toBeInTheDocument();
            // Select mode over conversations ticks whole conversations - see the "select mode over
            // conversations" tests below.
            expect(screen.getByRole("button", { name: "Select" })).toBeEnabled();
        });

        describe("searching while the list is arranged by conversation", () => {
            const inConversation = (overrides: Record<string, unknown>) => messageFixture({ conversationId: "c1", ...overrides });
            const budget1 = () => inConversation({ uid: "m1", subject: "Budget draft", bodyPreview: "First budget note" });
            const budget2 = () => inConversation({ uid: "m3", subject: "Re: Budget draft", bodyPreview: "Second budget note" });
            const other = () => messageFixture({ uid: "m4", conversationId: "c2", subject: "Budget review", bodyPreview: "Different thread" });
            // Not a hit, but in c1 - it must not be listed among the results.
            const unrelated = () => inConversation({ uid: "m2", subject: "Re: Budget draft", bodyPreview: "Lunch on Friday" });

            function mockSearching() {
                const everything = [budget1(), unrelated(), budget2(), other()];
                return mockShellAndInbox(
                    everything,
                    (url) =>
                        url.startsWith("/api/mail/search")
                            ? jsonResponse(200, {
                                  results: ["m1", "m3", "m4"].map((uid, index) => ({ entityType: "message", entityUid: uid, score: 3 - index })),
                              })
                            : undefined,
                    [
                        conversationFixture({ conversationId: "c1", subject: "Budget draft", messageUids: ["m1", "m2", "m3"], messageCount: 3, latestMessageUid: "m3" }),
                        conversationFixture({ conversationId: "c2", subject: "Budget review", messageUids: ["m4"], latestMessageUid: "m4" }),
                    ],
                    { c1: [budget1(), unrelated(), budget2()], c2: [other()] },
                );
            }

            it("groups the matches under their conversation, listing only the messages that match", async () => {
                mockSearching();
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);
                await screen.findByText("Budget draft");

                await user.type(screen.getByLabelText("Search all mail"), "budget");

                const first = await screen.findByText("2 matching messages");
                expect(first.closest("[data-search-group]")).toHaveAttribute("data-search-group", "c1");
                expect(screen.getByText("1 matching message").closest("[data-search-group]")).toHaveAttribute("data-search-group", "c2");
                const group = first.closest("[data-search-group]") as HTMLElement;
                expect(within(group).getByText("First budget note")).toBeInTheDocument();
                expect(within(group).getByText("Second budget note")).toBeInTheDocument();
                expect(screen.queryByText("Lunch on Friday")).not.toBeInTheDocument();
                expect(screen.getByText("Different thread")).toBeInTheDocument();
                // Results, not conversation rows: no expand chevrons.
                expect(screen.queryByRole("button", { name: /Expand conversation/ })).not.toBeInTheDocument();
            });

            it("opens the whole thread in the reading pane, positioned at the message that was picked", async () => {
                const fetchMock = mockSearching();
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);
                await screen.findByText("Budget draft");
                await user.type(screen.getByLabelText("Search all mail"), "budget");

                await user.click(await screen.findByText("Second budget note"));

                await waitFor(() =>
                    expect(fetchMock.mock.calls.some(([url]: [string]) => url.startsWith("/api/mail/messages/conversations/c1?"))).toBe(true),
                );
                // The pane holds the thread, not just the one message: all three of c1's, the unrelated one included.
                expect(await screen.findByText("3 messages")).toBeInTheDocument();
                expect(screen.queryByText("Select a conversation to read it.")).not.toBeInTheDocument();
                expect(screen.getByText("Second budget note").closest("li")).toHaveAttribute("data-message-uid", "m3");
            });

            it("treats a matching message that belongs to no conversation, and has no subject, as a thread of its own", async () => {
                const lone = messageFixture({ uid: "m7", subject: undefined, conversationId: undefined, bodyPreview: "Figures attached" });
                const fetchMock = mockShellAndInbox(
                    [lone],
                    (url) =>
                        url.startsWith("/api/mail/search")
                            ? jsonResponse(200, { results: [{ entityType: "message", entityUid: "m7", score: 1 }] })
                            : undefined,
                    [],
                    { m7: [lone] },
                );
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);
                await user.type(await screen.findByLabelText("Search all mail"), "figures");

                const group = (await screen.findByText("1 matching message")).closest("[data-search-group]") as HTMLElement;
                expect(group).toHaveAttribute("data-search-group", "m7");
                expect(group.firstElementChild).toHaveTextContent("(no subject)");
                await user.click(within(group).getByText("Figures attached"));

                // The message is its own thread: asked for by its uid, and headed "(no subject)" while it loads.
                await waitFor(() =>
                    expect(fetchMock.mock.calls.some(([url]: [string]) => url.startsWith("/api/mail/messages/conversations/m7?"))).toBe(true),
                );
                expect(await screen.findByText("1 message")).toBeInTheDocument();
                expect(screen.getAllByText("(no subject)").length).toBeGreaterThan(1);
            });

            it("brings the conversations back when the search is cleared", async () => {
                mockSearching();
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);
                await screen.findByText("Budget draft");
                await user.type(screen.getByLabelText("Search all mail"), "budget");
                await screen.findByText("2 matching messages");

                await user.clear(screen.getByLabelText("Search all mail"));

                expect(await screen.findByRole("button", { name: /Expand conversation: Budget draft/ })).toBeInTheDocument();
                expect(screen.queryByText("2 matching messages")).not.toBeInTheDocument();
            });

            it("opens the thread on the phone's message page, with the conversation", async () => {
                mockMatchMedia(true);
                mockSearching();
                const location = mockLocation();
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);
                await screen.findByText("Budget draft");
                await user.type(screen.getByLabelText("Search all mail"), "budget");

                await user.click(await screen.findByText("Second budget note"));

                expect(location.href).toBe("/messages/m3?conversation=c1");
            });
        });

        describe("the search box on a phone", () => {
            it("is in the shell's header row, beside the folders button, in either arrangement", async () => {
                mockMatchMedia(true);
                mockShellAndInbox([messageFixture()], undefined, [thread()]);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                const search = await screen.findByLabelText("Search all mail");
                expect(screen.getByRole("button", { name: "Open folders" }).parentElement).toContainElement(search);
                // Only the one, and not in the list as it is on a desktop.
                expect(screen.getAllByLabelText("Search all mail")).toHaveLength(1);

                await toggleConversations(user);
                await screen.findByText("Thread subject");
                expect(screen.getByLabelText("Search all mail")).toBeInTheDocument();
            });

            it("lists messages while it holds a query, and brings the conversations back when it is cleared", async () => {
                mockMatchMedia(true);
                mockShellAndInbox(
                    [messageFixture({ uid: "m9", subject: "Hit subject" })],
                    (url) => (url.startsWith("/api/mail/search") ? jsonResponse(200, { results: [] }) : undefined),
                    [thread()],
                );
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);
                await screen.findByText("Thread subject");

                await user.type(screen.getByLabelText("Search all mail"), "hit");
                await screen.findByText(/No messages match/);
                expect(screen.queryByText("Thread subject")).not.toBeInTheDocument();

                await user.clear(screen.getByLabelText("Search all mail"));
                expect(await screen.findByText("Thread subject")).toBeInTheDocument();
            });

            it("is in the list, not the header row, on a desktop - conversations included", async () => {
                mockShellAndInbox([messageFixture()], undefined, [thread()]);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByText("Hello there");
                await toggleConversations(user);
                await screen.findByText("Thread subject");
                expect(screen.getByLabelText("Search all mail")).toBeInTheDocument();
                expect(screen.queryByRole("button", { name: "Open folders" })?.parentElement).not.toContainElement(screen.getByLabelText("Search all mail"));
            });
        });

        it("keeps the sort keys a thread has a value for, and says why the other two are unavailable", async () => {
            mockShellAndInbox([], undefined, [thread()]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await toggleConversations(user);
            await screen.findByText("Thread subject");

            await openListMenu(user, "Sort");

            // A conversation row carries a subject, a latest sender, a latest date and a flag...
            expect(await screen.findByRole("menuitemradio", { name: /^Subject/ })).toBeEnabled();
            expect(screen.getByRole("menuitemradio", { name: /^From/ })).toBeEnabled();
            expect(screen.getByRole("menuitemradio", { name: /^Flag status/ })).toBeEnabled();
            // ...but no sent date and no importance of its own, and the menu says so on each row.
            expect(screen.getByRole("menuitemradio", { name: /^Date sent/ })).toBeDisabled();
            expect(screen.getByText("A thread has no sent date")).toBeInTheDocument();
            expect(screen.getByRole("menuitemradio", { name: /^Importance/ })).toBeDisabled();
            expect(screen.getByText("A thread has no importance")).toBeInTheDocument();
            expect(
                screen.getByText(
                    "Conversations are ordered within the rows loaded so far - the server pages them by latest activity.",
                ),
            ).toBeInTheDocument();
        });

        it("orders the conversation rows by the arrangement the reader picked, both ways", async () => {
            // The endpoint pages by latest activity and takes no sort parameters, so this is the client's
            // own ordering of the rows it has - deliberately handed to it out of order to prove it happens.
            const older = conversationFixture({
                conversationId: "c2",
                subject: "Older thread",
                latestDate: "2026-01-01T00:00:00.000Z",
                latestMessageUid: "m9",
                messageUids: ["m9"],
            });
            const newer = { ...thread(), latestDate: "2026-03-01T00:00:00.000Z" };
            mockShellAndInbox([], undefined, [older, newer]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await toggleConversations(user);
            await screen.findByText("Thread subject");

            const rowSubjects = () =>
                screen
                    .getAllByRole("button", { name: /conversation:/ })
                    .map((button) => button.getAttribute("aria-label") ?? "");
            expect(rowSubjects()[0]).toContain("Thread subject");

            await openListMenu(user, "Sort");
            await chooseMenuItem(user, "menuitemradio", "Oldest on top");

            await waitFor(() => expect(rowSubjects()[0]).toContain("Older thread"));
        });

        it("reads a conversation's own messages in the same order sense as the rows", async () => {
            mockShellAndInbox([], undefined, [thread()], { c1: threadMessages() });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await toggleConversations(user);
            await screen.findByText("Thread subject");

            await user.click(screen.getByRole("button", { name: /^Expand conversation:/ }));
            await screen.findByText("The opening message");

            // `listConversationMessages()` answers oldest first; "Newest on top" reverses that for display.
            const senders = () => screen.getAllByText(/Sender$/).map((node) => node.textContent);
            expect(senders()[0]).toBe("Newer Sender");

            await openListMenu(user, "Sort");
            await chooseMenuItem(user, "menuitemradio", "Oldest on top");

            await waitFor(() => expect(senders()[0]).toBe("Older Sender"));
        });

        it("clears a conversation row's unread count as its messages are read in the thread pane", async () => {
            const unread = { read: false, flagged: false, answered: false, forwarded: false };
            const messages = threadMessages().map((message) => ({ ...message, flags: unread }));
            // A second, fully-read conversation, so the row the read message isn't in is left alone.
            const other = conversationFixture({ conversationId: "c2", subject: "Another thread", messageUids: ["m9"] });
            const fetchMock = mockShellAndInbox(messages, undefined, [{ ...thread(), unreadCount: 2 }, other], {
                c1: messages,
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await toggleConversations(user);
            await screen.findByText("Thread subject");
            expect(screen.getByText("2 unread")).toBeInTheDocument();

            // Opening the oldest message expands the whole run, so both of them are marked read.
            await user.click(screen.getByRole("button", { name: "Expand conversation: Thread subject" }));
            await user.click((await screen.findAllByText("Older Sender"))[0]);

            await waitFor(() => expect(screen.queryByText(/unread/)).not.toBeInTheDocument());
            // Driven by what the reading pane reported, not by re-listing the folder.
            expect(
                fetchMock.mock.calls.filter((call) => String(call[0]).includes("/messages/conversations?")),
            ).toHaveLength(1);
        });

        it("moves a conversation's unread count back up when a read it made is refused", async () => {
            const unread = { read: false, flagged: false, answered: false, forwarded: false };
            const messages = threadMessages().map((message) => ({ ...message, flags: unread }));
            mockShellAndInbox(messages, (url, init) => (url.startsWith("/api/mail/messages/m") && init?.method === "PUT" ? jsonResponse(409, { message: "no" }) : undefined), [
                { ...thread(), unreadCount: 2 },
            ], { c1: messages });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await toggleConversations(user);
            await screen.findByText("Thread subject");
            expect(screen.getByText("2 unread")).toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Expand conversation: Thread subject" }));
            await user.click((await screen.findAllByText("Older Sender"))[0]);

            // Both were marked read at once, then both were put back.
            await waitFor(() => expect(screen.getByText("2 unread")).toBeInTheDocument());
        });

        it("switching conversations back off re-fetches the per-folder message list", async () => {
            mockShellAndInbox([messageFixture({ subject: "Flat row" })], undefined, [thread()]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Flat row");
            await toggleConversations(user);
            await screen.findByText("Thread subject");

            await toggleConversations(user);

            expect(await screen.findByText("Flat row")).toBeInTheDocument();
            expect(screen.queryByText("Thread subject")).not.toBeInTheDocument();
        });

        describe("keyboard shortcuts", () => {
            const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) => fireEvent.keyDown(target, { key, ...init });
            const CTRL = { ctrlKey: true };
            const deletedFolder = { ...inboxFolder, uid: "f6", name: "Deleted Items", type: "deleted_items" as const };
            const unread = () => threadMessages().map((m) => ({ ...m, flags: { ...m.flags, read: false } }));
            const otherThread = () =>
                conversationFixture({
                    conversationId: "c2",
                    subject: "Other thread",
                    messageUids: ["m3"],
                    latestMessageUid: "m3",
                    unreadCount: 0,
                    latestPreview: "Another one",
                });
            const otherMessages = () => [messageFixture({ uid: "m3", subject: "Other", flags: { read: true, flagged: false, answered: false, forwarded: false } })];
            /** The list of conversations, with Deleted Items present so a delete has somewhere to go, and every message the bulk update echoes. */
            function mockThreads(
                extra?: (url: string, init?: RequestInit) => Response | undefined,
                thread1: ReturnType<typeof threadMessages> = threadMessages(),
            ) {
                const messages = [...thread1, ...otherMessages()];
                return mockShellAndInbox(
                    messages,
                    (url, init) => {
                        const custom = extra?.(url, init);
                        if (custom) return custom;
                        if (url === "/api/mail/folders" && init?.method === "POST") return jsonResponse(200, { ...deletedFolder });
                        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, deletedFolder]);
                        return undefined;
                    },
                    [thread(), otherThread()],
                    { c1: thread1, c2: otherMessages() },
                );
            }
            const bulkPuts = (fetchMock: ReturnType<typeof vi.fn>) =>
                fetchMock.mock.calls
                    .filter(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT")
                    .map(([, init]: [string, RequestInit]) => JSON.parse(init.body as string));
            // The thread pane shows its subject card at once, from the list row, while its messages are still loading - so "open" also waits for an
            // expanded message to be there.
            const openConversation = async (subject: string) => {
                const heading = await screen.findByRole("heading", { level: 1, name: subject });
                await screen.findAllByTestId("detail-pane");
                return heading;
            };

            async function renderConversations() {
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await toggleConversations(user);
                await screen.findByText("Thread subject");
                return user;
            }

            it("opens the neighbouring conversation with the arrow keys and j/k", async () => {
                mockThreads();
                await renderConversations();

                expect(press("ArrowDown")).toBe(false);
                expect(await openConversation("Thread subject")).toBeInTheDocument();
                press("j");
                expect(await openConversation("Other thread")).toBeInTheDocument();
                press("ArrowUp");
                expect(await openConversation("Thread subject")).toBeInTheDocument();
                press("k");
                expect(await openConversation("Thread subject")).toBeInTheDocument();
                // The focus follows, on the row's own button.
                expect(document.activeElement).toHaveAttribute("data-row-open");
            });

            it("jumps to the next and previous conversation with unread mail", async () => {
                mockThreads();
                await renderConversations();

                expect(press(".", CTRL)).toBe(false);
                expect(await openConversation("Thread subject")).toBeInTheDocument();
                // Nothing unread after it.
                expect(press(".", CTRL)).toBe(false);
                press("j");
                expect(await openConversation("Other thread")).toBeInTheDocument();
                press(",", CTRL);
                expect(await openConversation("Thread subject")).toBeInTheDocument();
            });

            it("deletes the whole open conversation - its messages in this folder - and closes it", async () => {
                const fetchMock = mockThreads();
                const user = await renderConversations();
                await user.click(screen.getByText("Thread subject"));
                await openConversation("Thread subject");

                expect(press("d", CTRL)).toBe(false);

                await waitFor(() => expect(bulkPuts(fetchMock)).toContainEqual([
                    { uid: "m1", version: 0, folderUid: "f6" },
                    { uid: "m2", version: 0, folderUid: "f6" },
                ]));
                expect(await screen.findByText("Select a conversation to read it.")).toBeInTheDocument();
            });

            it("marks the whole open conversation unread with Ctrl+U - every one of its messages that is read", async () => {
                const fetchMock = mockThreads();
                const user = await renderConversations();
                await user.click(screen.getByText("Thread subject"));
                await openConversation("Thread subject");

                expect(press("u", CTRL)).toBe(false);

                await waitFor(() =>
                    expect(bulkPuts(fetchMock).some((puts: any[]) => puts.length === 2 && puts.every((p) => p.flags.read === false))).toBe(true),
                );
            });

            it("marks the whole open conversation read with Ctrl+Q", async () => {
                const fetchMock = mockThreads(undefined, unread());
                const user = await renderConversations();
                await user.click(screen.getByText("Thread subject"));
                await openConversation("Thread subject");

                expect(press("q", CTRL)).toBe(false);

                await waitFor(() =>
                    expect(bulkPuts(fetchMock).some((puts: any[]) => puts.length === 2 && puts.every((p) => p.flags.read === true))).toBe(true),
                );
            });

            it("flags the whole open conversation with Insert", async () => {
                const fetchMock = mockThreads();
                const user = await renderConversations();
                await user.click(screen.getByText("Other thread"));
                await openConversation("Other thread");

                expect(press("Insert")).toBe(false);

                await waitFor(() => expect(bulkPuts(fetchMock).some((puts: any[]) => puts.length === 1 && puts[0].flags.flagged === true)).toBe(true));
            });

            it("uses the messages of a conversation the reader already ticked, rather than fetching it again", async () => {
                const fetchMock = mockThreads();
                const user = await renderConversations();
                // Ticking it in select mode fetches its messages; leaving select mode keeps them.
                await user.click(screen.getByRole("button", { name: "Select" }));
                await user.click(await screen.findByRole("checkbox", { name: "Select conversation: Thread subject" }));
                await screen.findByText("1 conversation selected");
                const fetchesOf = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/mail/messages/conversations/c1")).length;
                const afterTick = fetchesOf();
                press("Escape");
                await user.click(screen.getByText("Thread subject"));
                await openConversation("Thread subject");
                const afterOpen = fetchesOf();
                expect(afterOpen).toBeGreaterThan(afterTick);

                expect(press("d", CTRL)).toBe(false);

                await waitFor(() => expect(bulkPuts(fetchMock)).toContainEqual([
                    { uid: "m1", version: 0, folderUid: "f6" },
                    { uid: "m2", version: 0, folderUid: "f6" },
                ]));
                // The keyboard's Delete asked for nothing more.
                expect(fetchesOf()).toBe(afterOpen);
            });

            it("says why, and keeps the conversation open, when its messages can't be loaded for a keyboard action", async () => {
                let calls = 0;
                mockThreads((url) =>
                    url.startsWith("/api/mail/messages/conversations/c1") && ++calls > 1 ? jsonResponse(500, { message: "thread boom" }) : undefined,
                );
                const user = await renderConversations();
                await user.click(screen.getByText("Thread subject"));
                await openConversation("Thread subject");

                press("d", CTRL);

                expect(await screen.findByText("thread boom")).toBeInTheDocument();
                expect(getNotificationsSnapshot().visible).toMatchObject([
                    { kind: "error", title: "Couldn't load the messages in that conversation", message: "thread boom" },
                ]);
                expect(screen.getByRole("heading", { level: 1, name: "Thread subject" })).toBeInTheDocument();
            });

            it("says so, generically, when they can't be loaded for a reason of no interest", async () => {
                let calls = 0;
                mockThreads((url) => {
                    if (url.startsWith("/api/mail/messages/conversations/c1") && ++calls > 1) {
                        throw new TypeError("network down");
                    }
                    return undefined;
                });
                const user = await renderConversations();
                await user.click(screen.getByText("Thread subject"));
                await openConversation("Thread subject");

                press("d", CTRL);

                expect(await screen.findByText("Couldn't load the messages in that conversation")).toBeInTheDocument();
            });

            it("closes the conversation with Escape and opens the selected message on its own page with Enter", async () => {
                const location = mockLocation();
                mockThreads();
                const user = await renderConversations();
                await user.click(screen.getByText("Thread subject"));
                await openConversation("Thread subject");

                expect(press("Enter")).toBe(false);
                expect(location.href).toBe("/messages/m2");

                expect(press("Escape")).toBe(false);
                expect(await screen.findByText("Select a conversation to read it.")).toBeInTheDocument();
            });
        });
    });

    describe("sort and filter", () => {
        it("asks the server to sort the whole folder, and remembers the choice per mailbox", async () => {
            const fetchMock = mockShellAndInbox([
                messageFixture({ uid: "m1", subject: "Zebra" }),
                messageFixture({ uid: "m2", subject: "Apple" }),
            ]);
            const user = userEvent.setup();
            const { unmount } = render(<InboxPage userUid="u1" />);
            await screen.findByText("Zebra");

            await openListMenu(user, "Sort");
            await chooseMenuItem(user, "menuitemradio", "Subject");

            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("sortBy=subject"), expect.anything()),
            );
            expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("sortOrder=asc"), expect.anything());
            const rows = screen.getAllByText(/^(Zebra|Apple)$/).map((node) => node.textContent);
            expect(rows).toEqual(["Apple", "Zebra"]);

            unmount();
            render(<InboxPage userUid="u1" />);
            expect(await screen.findByRole("button", { name: "Sort: Subject" })).toBeInTheDocument();
            expect((await screen.findAllByText(/^(Zebra|Apple)$/)).map((node) => node.textContent)).toEqual(["Apple", "Zebra"]);
        });

        it("reverses the order without changing the key", async () => {
            const fetchMock = mockShellAndInbox([messageFixture()]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");

            await openListMenu(user, "Sort");
            await chooseMenuItem(user, "menuitemradio", "Oldest on top");

            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith(
                    expect.stringContaining("sortBy=date&sortOrder=asc"),
                    expect.anything(),
                ),
            );
        });

        it("asks the server to filter the whole folder, and remembers that too", async () => {
            const fetchMock = mockShellAndInbox([
                messageFixture({ uid: "m1", subject: "Unread one" }),
                messageFixture({ uid: "m2", subject: "Already read", flags: { read: true, flagged: false, answered: false, forwarded: false } }),
            ]);
            const user = userEvent.setup();
            const { unmount } = render(<InboxPage userUid="u1" />);
            await screen.findByText("Already read");

            await openListMenu(user, "Filter");
            await chooseMenuItem(user, "menuitemradio", "Unread");

            await waitFor(() => expect(screen.queryByText("Already read")).not.toBeInTheDocument());
            expect(screen.getByText("Unread one")).toBeInTheDocument();
            expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("filter=unread"), expect.anything());
            expect(screen.getByRole("button", { name: "Filter: Unread" })).toBeInTheDocument();

            unmount();
            render(<InboxPage userUid="u1" />);
            expect(await screen.findByRole("button", { name: "Filter: Unread" })).toBeInTheDocument();
        });

        it("drives the Focused/Other tabs from the same server-side filter", async () => {
            const fetchMock = mockShellAndInbox([
                messageFixture({ uid: "m1", subject: "Focused message" }),
                messageFixture({ uid: "m2", subject: "Other message", inferenceClassification: "other" }),
            ]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Focused message");

            await user.click(screen.getByRole("button", { name: "Other" }));

            await waitFor(() => expect(screen.queryByText("Focused message")).not.toBeInTheDocument());
            expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("filter=other"), expect.anything());
            expect(screen.getByRole("button", { name: "Other" })).toHaveAttribute("aria-pressed", "true");
            // The Filter menu tells the same truth as the tab row.
            await openListMenu(user, "Filter");
            expect(screen.getByRole("menuitemradio", { name: "Other" })).toHaveAttribute("aria-checked", "true");
        });

        it("stops applying a remembered Focused/Other filter outside an Inbox", async () => {
            const location = mockLocation();
            (location as any).search = "?mailboxUid=mb1&folderUid=f2";
            const fetchMock = mockFetch((url) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, sentItemsFolder]);
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, [messageFixture({ folderUid: "f2" })]);
                throw new Error(`unexpected ${url}`);
            });
            localStorage.setItem(
                "rapidmx:mail-list-preferences:mb1",
                JSON.stringify({ sortBy: "date", sortOrder: "desc", filter: "focused", showAsConversations: false }),
            );
            render(<InboxPage userUid="u1" />);

            await screen.findByText("Hello there");
            expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("filter=all"), expect.anything());
            expect(screen.queryByRole("button", { name: "Focused" })).not.toBeInTheDocument();
            mockLocation();
        });

        it("filters an aggregate view server-side per mailbox, but leaves the sort keys alone", async () => {
            const location = mockLocation();
            (location as any).search = "?aggregate=inbox";
            const fetchMock = mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, [messageFixture()]);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");

            await openListMenu(user, "Filter");
            await chooseMenuItem(user, "menuitemradio", "Flagged");

            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("filter=flagged"), expect.anything()));
            await openListMenu(user, "Sort");
            expect(screen.getByRole("menuitemradio", { name: "Subject" })).toBeDisabled();
            expect(
                screen.getByText("This view merges the newest mail from every mailbox and is always listed by date."),
            ).toBeInTheDocument();
            mockLocation();
        });

        it("disables Filter and the sort keys while searching", async () => {
            mockShellAndInbox([messageFixture()], (url) =>
                url.startsWith("/api/mail/search") ? jsonResponse(200, { results: [] }) : undefined,
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");

            await user.type(screen.getByPlaceholderText("Search all mail…"), "hit");
            await screen.findByText(/No messages match/);

            expect(screen.getByRole("button", { name: "Filter" })).toBeDisabled();
            await openListMenu(user, "Sort");
            expect(screen.getByRole("menuitemradio", { name: "Subject" })).toBeDisabled();
            expect(screen.getByText("Search results are ranked by relevance rather than sorted.")).toBeInTheDocument();
        });
    });

    describe("filtering by label", () => {
        it("narrows the list to the labels picked in the Filter menu, and remembers them", async () => {
            const fetchMock = mockShellAndInbox([
                messageFixture({ uid: "m1", subject: "Labelled", labelUids: ["l2"] }),
                messageFixture({ uid: "m2", subject: "Plain" }),
            ]);
            const user = userEvent.setup();
            const { unmount } = render(<InboxPage userUid="u1" />);
            await screen.findByText("Plain");
            const listings = () =>
                fetchMock.mock.calls.filter(
                    ([url, init]: [string, RequestInit]) =>
                        String(url).startsWith("/api/mail/messages?") && (init?.method ?? "GET") === "GET",
                ).length;
            const before = listings();

            await openListMenu(user, "Filter");
            await chooseMenuItem(user, "menuitem", /^Labels/);
            await chooseMenuItem(user, "menuitemcheckbox", "Invoices");
            await chooseMenuItem(user, "menuitemcheckbox", "Travel");
            await chooseMenuItem(user, "menuitem", "Apply labels");

            // The picks are applied in one go, so two labels are one extra listing, not two.
            await waitFor(() => expect(listings()).toBe(before + 1));
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining("&labelUids=l1%2Cl2"),
                expect.anything(),
            );
            // Filtered by the server, so the message carrying neither label is gone from the list.
            await waitFor(() => expect(screen.queryByText("Plain")).not.toBeInTheDocument());
            expect(screen.getByText("Labelled")).toBeInTheDocument();
            expect(await screen.findByRole("button", { name: "Filter: 2 labels" })).toBeInTheDocument();

            unmount();
            render(<InboxPage userUid="u1" />);
            expect(await screen.findByRole("button", { name: "Filter: 2 labels" })).toBeInTheDocument();
        });

        it("asks the server for conversations with any of the chosen labels", async () => {
            const fetchMock = mockShellAndInbox([messageFixture()], undefined, []);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");
            await toggleConversations(user);
            await screen.findByText("No conversations in this folder.");

            await openListMenu(user, "Filter");
            await chooseMenuItem(user, "menuitem", /^Labels/);
            await chooseMenuItem(user, "menuitemcheckbox", "Invoices");
            await chooseMenuItem(user, "menuitemcheckbox", "Travel");
            await chooseMenuItem(user, "menuitem", "Apply labels");

            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith(
                    expect.stringContaining(
                        "/api/mail/messages/conversations?mailboxUid=mb1&folderUid=f1&filter=all&page=0&limit=50&labelUids=l1%2Cl2",
                    ),
                    expect.anything(),
                ),
            );
        });

        it("adds a label created from the Filter menu to the ones it offers", async () => {
            mockShellAndInbox([messageFixture()], (url, init) =>
                url === "/api/mail/labels" && init?.method === "POST"
                    ? jsonResponse(200, labelFixture("l3", "Receipts"))
                    : undefined,
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");

            await openListMenu(user, "Filter");
            await chooseMenuItem(user, "menuitem", /^Labels/);
            await chooseMenuItem(user, "menuitem", "New label…");
            const dialog = await screen.findByRole("dialog", { name: "New label" });
            await user.type(within(dialog).getByLabelText("Name"), "Receipts");
            await user.click(within(dialog).getByRole("button", { name: "Create" }));
            await waitFor(() => expect(screen.queryByRole("dialog", { name: "New label" })).not.toBeInTheDocument());

            await openListMenu(user, "Filter");
            await chooseMenuItem(user, "menuitem", /^Labels/);
            expect(await screen.findByRole("menuitemcheckbox", { name: "Receipts" })).toBeInTheDocument();
        });

        it("adds a label created from the reading pane to the ones it offers", async () => {
            mockShellAndInbox([messageFixture()]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await user.click(await screen.findByText("Hello there"));

            expect(screen.getByTestId("detail-pane")).toHaveTextContent("labels:Invoices/Travel");
            await user.click(screen.getByText("simulate-label-created"));

            expect(screen.getByTestId("detail-pane")).toHaveTextContent("labels:Invoices/Travel/Made here");
        });

        it("offers the open mailbox's own labels even while a message of another one is selected", async () => {
            const fetchMock = mockShellAndInbox([messageFixture()]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");

            await openListMenu(user, "Filter");
            await chooseMenuItem(user, "menuitem", /^Labels/);

            expect(await screen.findByRole("menuitemcheckbox", { name: "Invoices" })).toBeInTheDocument();
            expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/mail/labels?"), expect.anything());
        });
    });

    describe("what one view costs", () => {
        it("asks for the open mailbox's labels once, not once per list", async () => {
            const fetchMock = mockShellAndInbox([messageFixture()]);
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");

            // Both the toolbar's own label menu and the reading pane's read the open mailbox's labels; one
            // request answers both.
            await waitFor(() =>
                expect(fetchMock.mock.calls.filter(([url]: any[]) => String(url).startsWith("/api/mail/labels")).length).toBe(1),
            );
        });

        it("still asks for a selected message's own mailbox's labels when that is another mailbox", async () => {
            // A search hit from a shared mailbox: its labels are a different list and must be fetched.
            const shared = { ...mailbox, uid: "mb2", ownerUserUid: "u2", displayName: "Support" };
            const hit = messageFixture({ uid: "s1", subject: "Shared hit", mailboxUid: "mb2", folderUid: "f-shared" });
            const fetchMock = mockFetch((url) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox, shared]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/labels") && url.includes("mailboxUid=mb2")) {
                    return jsonResponse(200, [labelFixture("l9", "Shared label")]);
                }
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, LABELS);
                if (url.startsWith("/api/mail/messages/conversations")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages/")) return jsonResponse(200, hit);
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, [hit]);
                if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
                throw new Error(`unexpected ${url}`);
            });
            const user = userEvent.setup();
            // Two mailboxes open on All Mailboxes; this is about the primary mailbox's own Inbox, where a hit from the other one can be selected.
            (mockLocation() as any).search = "?mailboxUid=mb1";
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Shared hit");

            await user.click(screen.getByText("Shared hit"));

            await waitFor(() =>
                expect(fetchMock.mock.calls.some(([url]: any[]) => String(url).includes("/api/mail/labels?") && String(url).includes("mailboxUid=mb2"))).toBe(
                    true,
                ),
            );
            expect(await screen.findByTestId("detail-pane")).toHaveTextContent("labels:Shared label");
        });

        it("adds a label created from a message of another mailbox to that mailbox's labels, not the open mailbox's", async () => {
            const shared = { ...mailbox, uid: "mb2", ownerUserUid: "u2", displayName: "Support" };
            const hit = messageFixture({ uid: "s1", subject: "Shared hit", mailboxUid: "mb2", folderUid: "f-shared" });
            const own = messageFixture({ uid: "m1", subject: "My own mail" });
            mockFetch((url) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox, shared]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/labels") && url.includes("mailboxUid=mb2")) return jsonResponse(200, [labelFixture("l9", "Shared label")]);
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, LABELS);
                if (url.startsWith("/api/mail/messages/conversations")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages/s1")) return jsonResponse(200, hit);
                if (url.startsWith("/api/mail/messages/m1")) return jsonResponse(200, own);
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, [hit, own]);
                if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
                throw new Error(`unexpected ${url}`);
            });
            const user = userEvent.setup();
            // Two mailboxes open on All Mailboxes; this is about the primary mailbox's own Inbox, where a hit from the other one can be selected.
            (mockLocation() as any).search = "?mailboxUid=mb1";
            render(<InboxPage userUid="u1" />);
            await user.click(await screen.findByText("Shared hit"));
            await waitFor(() => expect(screen.getByTestId("detail-pane")).toHaveTextContent("labels:Shared label"));

            await user.click(screen.getByRole("button", { name: "simulate-label-created" }));

            expect(screen.getByTestId("detail-pane")).toHaveTextContent("labels:Shared label/Made here");
            // The open mailbox's own labels are untouched: its message still offers exactly the ones it had.
            await user.click(screen.getByText("My own mail"));
            await waitFor(() => expect(screen.getByTestId("detail-pane")).toHaveTextContent("message:m1"));
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("labels:Invoices/Travel");
            expect(screen.getByTestId("detail-pane")).not.toHaveTextContent("Made here");
        });

        it("does not let a slow answer about one shared mailbox's labels replace another's, once the reader has moved on", async () => {
            const sharedA = { ...mailbox, uid: "mb2", ownerUserUid: "u2", displayName: "Support" };
            const sharedB = { ...mailbox, uid: "mb3", ownerUserUid: "u3", displayName: "Sales" };
            const hitA = messageFixture({ uid: "sa", subject: "Support hit", mailboxUid: "mb2", folderUid: "f-a" });
            const hitB = messageFixture({ uid: "sb", subject: "Sales hit", mailboxUid: "mb3", folderUid: "f-b" });
            let answerA: (response: Response) => void = () => undefined;
            const fetchMock = mockFetch((url) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox, sharedA, sharedB]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/labels") && url.includes("mailboxUid=mb2")) return new Promise<Response>((resolve) => (answerA = resolve));
                if (url.startsWith("/api/mail/labels") && url.includes("mailboxUid=mb3")) return jsonResponse(200, [labelFixture("l3", "Sales label")]);
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, LABELS);
                if (url.startsWith("/api/mail/messages/conversations")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages/sa")) return jsonResponse(200, hitA);
                if (url.startsWith("/api/mail/messages/sb")) return jsonResponse(200, hitB);
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, [hitA, hitB]);
                if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
                throw new Error(`unexpected ${url}`);
            });
            const user = userEvent.setup();
            // Two mailboxes open on All Mailboxes; this is about the primary mailbox's own Inbox, where a hit from the other one can be selected.
            (mockLocation() as any).search = "?mailboxUid=mb1";
            render(<InboxPage userUid="u1" />);
            await user.click(await screen.findByText("Support hit"));
            await waitFor(() => expect(fetchMock.mock.calls.some(([url]: any[]) => String(url).includes("mailboxUid=mb2") && String(url).startsWith("/api/mail/labels"))).toBe(true));

            await user.click(screen.getByText("Sales hit"));
            await waitFor(() => expect(screen.getByTestId("detail-pane")).toHaveTextContent("labels:Sales label"));
            answerA(jsonResponse(200, [labelFixture("l2", "Support label")]));
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(screen.getByTestId("detail-pane")).toHaveTextContent("labels:Sales label");
            expect(screen.getByTestId("detail-pane")).not.toHaveTextContent("Support label");
        });

        it("hides the Labels control when another mailbox's labels can't be loaded", async () => {
            const shared = { ...mailbox, uid: "mb2", ownerUserUid: "u2", displayName: "Support" };
            const hit = messageFixture({ uid: "s1", subject: "Shared hit", mailboxUid: "mb2", folderUid: "f-shared" });
            mockFetch((url) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox, shared]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/labels") && url.includes("mailboxUid=mb2")) {
                    return jsonResponse(500, { message: "labels boom" });
                }
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, LABELS);
                if (url.startsWith("/api/mail/messages/conversations")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages/")) return jsonResponse(200, hit);
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, [hit]);
                if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
                throw new Error(`unexpected ${url}`);
            });
            const user = userEvent.setup();
            // Two mailboxes open on All Mailboxes; this is about the primary mailbox's own Inbox, where a hit from the other one can be selected.
            (mockLocation() as any).search = "?mailboxUid=mb1";
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Shared hit");

            await user.click(screen.getByText("Shared hit"));

            // No labels rather than this mailbox's own, which belong to a different mailbox entirely.
            expect(await screen.findByTestId("detail-pane")).toHaveTextContent("labels:");
            expect(screen.getByTestId("detail-pane")).not.toHaveTextContent("labels:Invoices");
        });

        it("lists nothing until the shell has resolved which folder to list", async () => {
            // The folder list never arrives: a listing request now would be answered for the whole mailbox
            // and thrown away the moment the Inbox did arrive.
            const fetchMock = mockFetch((url) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return new Promise<Response>(() => undefined);
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, LABELS);
                throw new Error(`unexpected ${url}`);
            });
            render(<InboxPage userUid="u1" />);

            expect(await screen.findByText(/Loading your mailbox/)).toBeInTheDocument();
            expect(
                fetchMock.mock.calls.filter(([url]: any[]) => String(url).startsWith("/api/mail/messages")),
            ).toHaveLength(0);
        });

        it("lists a merged view once every mailbox's folders are known, and only then", async () => {
            // An aggregate view has no folder of its own but is built from every mailbox's folders, which
            // arrive after this list's first render - listing before that was the second of two identical
            // requests per view.
            const location = mockLocation();
            (location as any).search = "?aggregate=inbox";
            let resolveFolders: ((response: Response) => void) | undefined;
            const fetchMock = mockFetch((url) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return new Promise<Response>((resolve) => (resolveFolders = resolve));
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, LABELS);
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, [messageFixture({ subject: "Merged row" })]);
                throw new Error(`unexpected ${url}`);
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText(/^Loading/);
            expect(fetchMock.mock.calls.filter(([url]: any[]) => String(url).startsWith("/api/mail/messages"))).toHaveLength(0);

            await act(async () => {
                resolveFolders!(jsonResponse(200, [inboxFolder]));
            });

            expect(await screen.findByText("Merged row")).toBeInTheDocument();
            expect(fetchMock.mock.calls.filter(([url]: any[]) => String(url).startsWith("/api/mail/messages"))).toHaveLength(1);
            mockLocation();
        });

        it("lists a conversation view once the folder is known, and only then", async () => {
            localStorage.clear();
            let resolveFolders: ((response: Response) => void) | undefined;
            const fetchMock = mockFetch((url) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return new Promise<Response>((resolve) => (resolveFolders = resolve));
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, LABELS);
                if (url.startsWith("/api/mail/messages/conversations")) return jsonResponse(200, []);
                throw new Error(`unexpected ${url}`);
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText(/Loading your mailbox/);

            await act(async () => {
                resolveFolders!(jsonResponse(200, [inboxFolder]));
            });

            await screen.findByText("No conversations in this folder.");
            const conversationCalls = fetchMock.mock.calls.filter(([url]: any[]) =>
                String(url).startsWith("/api/mail/messages/conversations"),
            );
            expect(conversationCalls).toHaveLength(1);
            expect(String(conversationCalls[0][0])).toContain("folderUid=f1");
        });
    });

    describe("the Select toggle", () => {
        it("is enabled as soon as the folder has listed rows", async () => {
            mockShellAndInbox([messageFixture()]);
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");

            expect(screen.getByRole("button", { name: "Select" })).toBeEnabled();
        });

        it("is held while the folder is still loading, and says why", async () => {
            // The listing never resolves, so the list stays in its loading state.
            // Never resolves, so the list stays in its loading state for as long as the test needs it.
            const pending = new Promise<Response>(() => undefined);
            mockShellAndInbox([], (url) => (url.startsWith("/api/mail/messages?") ? (pending as never) : undefined));
            render(<InboxPage userUid="u1" />);

            const select = await screen.findByRole("button", { name: "Select" });
            await waitFor(() => expect(select).toBeDisabled());
            expect(select).toHaveAttribute("title", "Wait for this folder to finish loading");
        });

        it("is held for a folder with nothing in it, and says why", async () => {
            mockShellAndInbox([]);
            render(<InboxPage userUid="u1" />);
            await screen.findByText("No messages in this folder.");

            const select = screen.getByRole("button", { name: "Select" });
            expect(select).toBeDisabled();
            expect(select).toHaveAttribute("title", "There is nothing here to select");
        });

        it("is held for a conversation list with nothing in it too", async () => {
            mockShellAndInbox([messageFixture()], undefined, []);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");

            await toggleConversations(user);

            await screen.findByText("No conversations in this folder.");
            expect(screen.getByRole("button", { name: "Select" })).toBeDisabled();
        });
    });

    describe("select mode and bulk actions", () => {
        const junkFolder = { ...inboxFolder, uid: "f5", name: "Junk Email", type: "junk" as const };
        const deletedFolder = { ...inboxFolder, uid: "f6", name: "Deleted Items", type: "deleted_items" as const };
        const userFolder = { ...inboxFolder, uid: "f7", name: "Project X", type: "user" as const };
        const archiveFolder = { ...inboxFolder, uid: "f8", name: "Archive", type: "archive" as const };

        /** The inbox plus the folders the bulk actions target - `mockShellAndInbox` only has an Inbox. */
        function mockSelectable(
            messages: unknown[],
            folders: unknown[] = [inboxFolder, junkFolder, deletedFolder, userFolder],
            extra?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
        ) {
            return mockFetch((url, init) => {
                const custom = extra?.(url, init);
                if (custom) return custom;
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) {
                    if ((init?.method ?? "GET") === "POST") {
                        return jsonResponse(200, { ...inboxFolder, uid: "f-new", ...JSON.parse(init.body as string) });
                    }
                    return jsonResponse(200, folders);
                }
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, LABELS);
                if (url.startsWith("/api/mail/messages/conversations")) return jsonResponse(200, []);
                if (url.match(/^\/api\/mail\/messages\/[^/]+\/archive$/)) {
                    const uid = url.split("/")[4];
                    const existing = messages.find((m: any) => m.uid === uid) as any;
                    return jsonResponse(200, { ...existing, folderUid: "f8" });
                }
                if (url.startsWith("/api/mail/messages/")) {
                    const uid = url.split("/api/mail/messages/")[1].split("?")[0];
                    const existing = messages.find((m: any) => m.uid === uid) as any;
                    if ((init?.method ?? "GET") === "PUT") {
                        const body = JSON.parse(init.body as string);
                        return jsonResponse(200, { ...existing, ...body, flags: { ...existing.flags, ...body.flags } });
                    }
                    return existing ? jsonResponse(200, existing) : jsonResponse(404, { message: "not found" });
                }
                if (url.startsWith("/api/mail/messages")) {
                    if ((init?.method ?? "GET") === "PUT") {
                        const updates = JSON.parse(init.body as string) as Record<string, unknown>[];
                        return jsonResponse(
                            200,
                            updates.map((update) => {
                                const existing = messages.find((m: any) => m.uid === update.uid) as any;
                                return { ...existing, ...update, flags: { ...existing.flags, ...(update.flags as object) } };
                            }),
                        );
                    }
                    return jsonResponse(200, applyListParams(messages, url));
                }
                if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
        }

        const twoMessages = () => [
            messageFixture({ uid: "m1", subject: "First" }),
            messageFixture({ uid: "m2", subject: "Second" }),
        ];

        it("replaces the toolbar with a selection header, counting what is ticked", async () => {
            mockSelectable(twoMessages());
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");

            await user.click(screen.getByRole("button", { name: "Select" }));

            expect(screen.getByText("0 selected")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: /^Sort: / })).not.toBeInTheDocument();
            await user.click(screen.getByRole("checkbox", { name: "Select First" }));
            expect(screen.getByText("1 selected")).toBeInTheDocument();
        });

        it("ticks a row by clicking it rather than opening it", async () => {
            mockSelectable(twoMessages());
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await user.click(screen.getByRole("button", { name: "Select" }));

            await user.click(screen.getByText("First"));

            expect(screen.getByText("1 selected")).toBeInTheDocument();
            expect(screen.getByRole("checkbox", { name: "Select First" })).toBeChecked();
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("no-message");

            await user.click(screen.getByText("First"));
            expect(screen.getByText("0 selected")).toBeInTheDocument();
        });

        it("selects every listed row and marks the whole selection read in one request", async () => {
            const fetchMock = mockSelectable(twoMessages());
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await user.click(screen.getByRole("button", { name: "Select" }));

            await user.click(screen.getByRole("button", { name: "Select all" }));
            expect(screen.getByText("2 selected")).toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: "Mark read" }));

            await waitFor(() => expect(screen.getByText("0 selected")).toBeInTheDocument());
            const bulk = fetchMock.mock.calls.filter(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT");
            expect(bulk).toHaveLength(1);
            expect(JSON.parse(bulk[0][1].body as string)).toEqual([
                { uid: "m1", version: 0, flags: { read: true, flagged: false, answered: false, forwarded: false } },
                { uid: "m2", version: 0, flags: { read: true, flagged: false, answered: false, forwarded: false } },
            ]);
            expect(screen.getByText("First").closest("li")).not.toHaveAttribute("data-unread");
        });

        it("marks the selection read at once, and puts the rows back when the server refuses", async () => {
            const messages = twoMessages();
            const fetchMock = mockSelectable(messages, undefined, (url, init) =>
                url === "/api/mail/messages" && init?.method === "PUT" ? jsonResponse(409, { message: "changed since read" }) : undefined,
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await user.click(screen.getByRole("button", { name: "Select" }));
            await user.click(screen.getByRole("button", { name: "Select all" }));
            expect(screen.getByText("First").closest("li")).toHaveAttribute("data-unread", "true");
            await user.click(screen.getByRole("button", { name: "Mark read" }));

            expect(await screen.findByText(/changed since read/)).toBeInTheDocument();
            expect(fetchMock).toHaveBeenCalled();
            // The list is reloaded after a failed bulk update, from a server that still has them unread.
            await waitFor(() => expect(screen.getByText("First").closest("li")).toHaveAttribute("data-unread", "true"));
        });

        it("flags the selection", async () => {
            const fetchMock = mockSelectable(twoMessages());
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First");

            await user.click(screen.getByRole("button", { name: "Flag" }));

            await waitFor(() => expect(screen.getAllByLabelText("Flagged").length).toBeGreaterThan(0));
            const bulk = fetchMock.mock.calls.find(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT");
            expect(JSON.parse(bulk![1].body as string)[0].flags.flagged).toBe(true);
        });

        it("deletes by moving the selection to Deleted Items, dropping those rows", async () => {
            const fetchMock = mockSelectable(twoMessages());
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First");

            await user.click(screen.getByRole("button", { name: "Delete" }));

            await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
            expect(screen.getByText("Second")).toBeInTheDocument();
            const bulk = fetchMock.mock.calls.find(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT");
            expect(JSON.parse(bulk![1].body as string)).toEqual([{ uid: "m1", version: 0, folderUid: "f6" }]);
            // Never the collection DELETE, which truncates the folder.
            expect(fetchMock.mock.calls.some(([, init]: [string, RequestInit]) => init?.method === "DELETE")).toBe(false);
        });

        it("creates Deleted Items on demand when the mailbox has none, and reuses it for the next delete", async () => {
            const fetchMock = mockSelectable(twoMessages(), [inboxFolder]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First");

            await user.click(screen.getByRole("button", { name: "Delete" }));

            await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
            const created = fetchMock.mock.calls.filter(([url, init]: [string, RequestInit]) => url === "/api/mail/folders" && init?.method === "POST");
            expect(created).toHaveLength(1);
            expect(JSON.parse(created[0][1].body as string)).toMatchObject({ mailboxUid: "mb1", name: "Deleted Items", type: "deleted_items" });
            const firstMove = fetchMock.mock.calls.find(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT");
            expect(JSON.parse(firstMove![1].body as string)).toEqual([{ uid: "m1", version: 0, folderUid: "f-new" }]);

            // The shell's folder list still doesn't have it - a second delete must not create a second one.
            await user.click(await screen.findByRole("checkbox", { name: "Select Second" }));
            await user.click(screen.getByRole("button", { name: "Delete" }));

            await waitFor(() => expect(screen.queryByText("Second")).not.toBeInTheDocument());
            expect(
                fetchMock.mock.calls.filter(([url, init]: [string, RequestInit]) => url === "/api/mail/folders" && init?.method === "POST"),
            ).toHaveLength(1);
        });

        it("uses the Deleted Items the server already has - never a second one - when the page's folder list was out of date", async () => {
            // The page loaded before the server made Deleted Items (it now makes every well-known folder itself, and heals a missing one when the folders are listed).
            let listings = 0;
            const fetchMock = mockSelectable(twoMessages(), [inboxFolder], (url, init) =>
                url.startsWith("/api/mail/folders") && (init?.method ?? "GET") === "GET"
                    ? jsonResponse(200, listings++ === 0 ? [inboxFolder] : [inboxFolder, deletedFolder])
                    : undefined,
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First");

            await user.click(screen.getByRole("button", { name: "Delete" }));

            await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
            expect(fetchMock.mock.calls.filter(([url, init]: [string, RequestInit]) => url === "/api/mail/folders" && init?.method === "POST")).toHaveLength(0);
            const move = fetchMock.mock.calls.find(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT");
            expect(JSON.parse(move![1].body as string)).toEqual([{ uid: "m1", version: 0, folderUid: deletedFolder.uid }]);
        });

        it("reports junk by moving the selection to Junk", async () => {
            const fetchMock = mockSelectable(twoMessages());
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First");

            await user.click(screen.getByRole("button", { name: "Report junk" }));

            await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
            const bulk = fetchMock.mock.calls.find(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT");
            expect(JSON.parse(bulk![1].body as string)).toEqual([{ uid: "m1", version: 0, folderUid: "f5" }]);
        });

        it("moves the selection into a folder chosen from the Move to menu", async () => {
            const fetchMock = mockSelectable(twoMessages());
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First");

            await user.click(screen.getByRole("button", { name: "Move to" }));
            await user.click(await screen.findByRole("button", { name: /^Project X/ }));

            await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
            const bulk = fetchMock.mock.calls.find(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT");
            expect(JSON.parse(bulk![1].body as string)).toEqual([{ uid: "m1", version: 0, folderUid: "f7" }]);
        });

        it("moves the selection's unread count from one folder's badge to the other's", async () => {
            const folders = [{ ...inboxFolder, unreadCount: 2, totalCount: 2 }, junkFolder, deletedFolder, { ...userFolder, unreadCount: 0, totalCount: 0 }];
            mockSelectable(twoMessages(), folders);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            const badgeOf = (uid: string) => screen.getAllByRole("link").find((el) => el.getAttribute("href")?.includes(`folderUid=${uid}`))!.textContent;
            expect(badgeOf("f1")).toBe("Inbox2 2 unread");
            await selectRows(user, "First");

            await user.click(screen.getByRole("button", { name: "Move to" }));
            await user.click(await screen.findByRole("button", { name: /^Project X/ }));

            await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
            expect(badgeOf("f1")).toBe("Inbox1 1 unread");
            expect(badgeOf("f7")).toBe("Project X1 1 unread");
        });

        it("leaves a message the server gave no updated copy of out of the badge counts", async () => {
            const folders = [{ ...inboxFolder, unreadCount: 2, totalCount: 2 }, junkFolder, deletedFolder, { ...userFolder, unreadCount: 0, totalCount: 0 }];
            mockSelectable(twoMessages(), folders, (url, init) =>
                url === "/api/mail/messages" && init?.method === "PUT" ? jsonResponse(200, []) : undefined,
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First");

            await user.click(screen.getByRole("button", { name: "Move to" }));
            await user.click(await screen.findByRole("button", { name: /^Project X/ }));

            await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
            const badgeOf = (uid: string) => screen.getAllByRole("link").find((el) => el.getAttribute("href")?.includes(`folderUid=${uid}`))!.textContent;
            expect(badgeOf("f1")).toBe("Inbox2 2 unread");
            expect(badgeOf("f7")).toBe("Project X");
        });

        it("archives into the mailbox's Archive folder when it has one", async () => {
            const fetchMock = mockSelectable(twoMessages(), [inboxFolder, junkFolder, deletedFolder, archiveFolder]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First", "Second");

            await user.click(screen.getByRole("button", { name: "Archive" }));

            await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
            const bulk = fetchMock.mock.calls.find(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT");
            expect(JSON.parse(bulk![1].body as string)).toEqual([
                { uid: "m1", version: 0, folderUid: "f8" },
                { uid: "m2", version: 0, folderUid: "f8" },
            ]);
        });

        describe("swiping a row on a phone", () => {
            const rowOf = (subject: string) => screen.getByText(subject).closest("[data-message-uid]") as HTMLElement;
            /** One finger from `from` to `to` (x, y), as a phone reports it. */
            function swipe(row: HTMLElement, from: [number, number], to: [number, number]) {
                fireEvent.touchStart(row, { touches: [{ clientX: from[0], clientY: from[1] }] });
                fireEvent.touchMove(row, { touches: [{ clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2 }] });
                fireEvent.touchMove(row, { touches: [{ clientX: to[0], clientY: to[1] }] });
                fireEvent.touchEnd(row);
            }
            const bulkPut = (fetchMock: ReturnType<typeof mockSelectable>) =>
                fetchMock.mock.calls.find(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT");

            it("archives the message when it is swiped from right to left", async () => {
                mockMatchMedia(true);
                const fetchMock = mockSelectable(twoMessages(), [inboxFolder, junkFolder, deletedFolder, archiveFolder]);
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");

                swipe(rowOf("First"), [300, 100], [60, 104]);

                await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
                expect(JSON.parse(bulkPut(fetchMock)![1].body as string)).toEqual([{ uid: "m1", version: 0, folderUid: "f8" }]);
                expect(screen.getByText("Second")).toBeInTheDocument();
            });

            it("asks which folder to move the message to when it is swiped from left to right, and moves it there", async () => {
                mockMatchMedia(true);
                const fetchMock = mockSelectable(twoMessages());
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");

                swipe(rowOf("First"), [40, 100], [300, 96]);

                const dialog = await screen.findByRole("dialog", { name: "Move message to" });
                // Nothing moved yet, and the row is back where it was.
                expect(bulkPut(fetchMock)).toBeUndefined();
                expect(rowOf("First")).not.toHaveAttribute("data-swiping");
                await user.click(within(dialog).getByRole("button", { name: /^Project X/ }));

                await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
                expect(JSON.parse(bulkPut(fetchMock)![1].body as string)).toEqual([{ uid: "m1", version: 0, folderUid: "f7" }]);
            });

            it("puts the row back, and says so, when the archive fails", async () => {
                mockMatchMedia(true);
                mockSelectable(twoMessages(), [inboxFolder, archiveFolder], (url, init) =>
                    url === "/api/mail/messages" && init?.method === "PUT" ? jsonResponse(500, { message: "The server is unavailable." }) : undefined,
                );
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");

                swipe(rowOf("First"), [300, 100], [60, 100]);

                await waitFor(() => expect(getNotificationsSnapshot().visible.some((item) => item.kind === "error")).toBe(true));
                await waitFor(() => expect(rowOf("First")).not.toHaveAttribute("data-swiping"));
                expect(screen.getByText("First")).toBeInTheDocument();
            });

            it("holds a second swipe while the first archive is still on the wire, and puts that row back", async () => {
                mockMatchMedia(true);
                let finish: (response: Response) => void = () => undefined;
                const messages = twoMessages();
                const fetchMock = mockSelectable(messages, [inboxFolder, archiveFolder], (url, init) =>
                    url === "/api/mail/messages" && init?.method === "PUT" ? new Promise<Response>((resolve) => (finish = resolve)) : undefined,
                );
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");

                swipe(rowOf("First"), [300, 100], [60, 104]);
                await waitFor(() => expect(bulkPut(fetchMock)).toBeDefined());
                swipe(rowOf("Second"), [300, 100], [60, 104]);
                expect(rowOf("Second").querySelector("[data-swipe-panel]")).not.toBeNull();

                await waitFor(() => expect(rowOf("Second").querySelector("[data-swipe-panel]")).toBeNull());
                expect(fetchMock.mock.calls.filter(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT")).toHaveLength(1);

                // The first archive lands: its row goes, the one that was held stays.
                finish(jsonResponse(200, [{ ...messages[0], folderUid: "f8" }]));
                await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
                expect(screen.getByText("Second")).toBeInTheDocument();
            });

            it("does nothing for a short swipe, a mostly vertical one, or a swipe on a desktop", async () => {
                mockMatchMedia(true);
                const fetchMock = mockSelectable(twoMessages(), [inboxFolder, archiveFolder]);
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");

                swipe(rowOf("First"), [300, 100], [270, 100]);
                swipe(rowOf("First"), [300, 100], [100, 500]);
                expect(bulkPut(fetchMock)).toBeUndefined();
                expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
                expect(screen.getByText("First")).toBeInTheDocument();
            });

            it("is left alone on a desktop", async () => {
                const fetchMock = mockSelectable(twoMessages(), [inboxFolder, archiveFolder]);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                swipe(rowOf("First"), [300, 100], [60, 100]);
                expect(bulkPut(fetchMock)).toBeUndefined();
                expect(rowOf("First").style.touchAction).toBe("");
            });
        });

        it("creates the Archive folder with the first message, then moves the rest there", async () => {
            const fetchMock = mockSelectable(twoMessages());
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First", "Second");

            await user.click(screen.getByRole("button", { name: "Archive" }));

            await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1/archive", expect.objectContaining({ method: "POST" }));
            const bulk = fetchMock.mock.calls.find(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT");
            expect(JSON.parse(bulk![1].body as string)).toEqual([{ uid: "m2", version: 0, folderUid: "f8" }]);
        });

        it("archives a lone message with no Archive folder without a second request", async () => {
            const fetchMock = mockSelectable(twoMessages());
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First");

            await user.click(screen.getByRole("button", { name: "Archive" }));

            await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1/archive", expect.objectContaining({ method: "POST" }));
            expect(
                fetchMock.mock.calls.some(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT"),
            ).toBe(false);
        });

        it("applies the labels ticked in Apply label to the whole selection in one bulk update", async () => {
            const fetchMock = mockSelectable(twoMessages());
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First", "Second");

            await user.click(screen.getByRole("button", { name: "Apply label" }));
            await chooseMenuItem(user, "menuitemcheckbox", "Invoices");
            await chooseMenuItem(user, "menuitemcheckbox", "Travel");
            await chooseMenuItem(user, "menuitem", "Apply");

            await waitFor(() => expect(screen.getByText("0 selected")).toBeInTheDocument());
            const bulk = fetchMock.mock.calls.filter(
                ([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT",
            );
            expect(bulk).toHaveLength(1);
            expect(JSON.parse(bulk[0][1].body as string)).toEqual([
                { uid: "m1", version: 0, labelUids: ["l1", "l2"] },
                { uid: "m2", version: 0, labelUids: ["l1", "l2"] },
            ]);
        });

        it("leaves a partially-applied label exactly as each message has it", async () => {
            const messages = [
                messageFixture({ uid: "m1", subject: "First", labelUids: ["l2"] }),
                messageFixture({ uid: "m2", subject: "Second", labelUids: [] }),
            ];
            const fetchMock = mockSelectable(messages);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First", "Second");

            await user.click(screen.getByRole("button", { name: "Apply label" }));
            // Travel is on one of the two, so it starts partially applied and is left alone; Invoices is
            // ticked and therefore goes on both.
            expect(screen.getByRole("menuitemcheckbox", { name: "Travel" })).toHaveAttribute("aria-checked", "mixed");
            await chooseMenuItem(user, "menuitemcheckbox", "Invoices");
            await chooseMenuItem(user, "menuitem", "Apply");

            await waitFor(() => expect(screen.getByText("0 selected")).toBeInTheDocument());
            const bulk = fetchMock.mock.calls.find(
                ([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT",
            );
            expect(JSON.parse(bulk![1].body as string)).toEqual([
                { uid: "m1", version: 0, labelUids: ["l1", "l2"] },
                { uid: "m2", version: 0, labelUids: ["l1"] },
            ]);
        });

        it("adds a label created from Apply label to the ones it offers", async () => {
            mockSelectable(twoMessages(), undefined, (url, init) =>
                url === "/api/mail/labels" && init?.method === "POST"
                    ? jsonResponse(200, labelFixture("l3", "Receipts"))
                    : undefined,
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First");

            await user.click(screen.getByRole("button", { name: "Apply label" }));
            await chooseMenuItem(user, "menuitem", "New label…");
            const dialog = await screen.findByRole("dialog", { name: "New label" });
            await user.type(within(dialog).getByLabelText("Name"), "Receipts");
            await user.click(within(dialog).getByRole("button", { name: "Create" }));
            await waitFor(() => expect(screen.queryByRole("dialog", { name: "New label" })).not.toBeInTheDocument());

            await user.click(screen.getByRole("button", { name: "Apply label" }));
            expect(await screen.findByRole("menuitemcheckbox", { name: "Receipts" })).toBeInTheDocument();
        });

        it("keeps a label this mailbox no longer defines, which the menu never offered", async () => {
            const fetchMock = mockSelectable([messageFixture({ uid: "m1", subject: "First", labelUids: ["l-gone"] })]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First");

            await user.click(screen.getByRole("button", { name: "Apply label" }));
            await chooseMenuItem(user, "menuitemcheckbox", "Invoices");
            await chooseMenuItem(user, "menuitem", "Apply");

            await waitFor(() => expect(screen.getByText("0 selected")).toBeInTheDocument());
            const bulk = fetchMock.mock.calls.find(
                ([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT",
            );
            expect(JSON.parse(bulk![1].body as string)).toEqual([{ uid: "m1", version: 0, labelUids: ["l1", "l-gone"] }]);
        });

        it("still offers the load-more sentinel once a bulk move has emptied a full page", async () => {
            const full = Array.from({ length: 50 }, (_, i) => messageFixture({ uid: `m${i}`, subject: `Row ${i}` }));
            mockSelectable(full);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Row 0");
            await user.click(screen.getByRole("button", { name: "Select" }));
            await user.click(screen.getByRole("button", { name: "Select all" }));

            await user.click(screen.getByRole("button", { name: "Delete" }));

            expect(await screen.findByText("No messages in this folder.")).toBeInTheDocument();
            expect(screen.getByTestId("load-more-sentinel")).toBeInTheDocument();
        });

        it("reloads the list when a bulk label update is rejected", async () => {
            const fetchMock = mockSelectable(twoMessages(), undefined, (url, init) => {
                if (url === "/api/mail/messages" && init?.method === "PUT") {
                    return jsonResponse(409, { message: "Message m2 has changed since it was read." });
                }
                return undefined;
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First");
            const listingsBefore = fetchMock.mock.calls.filter(([url, init]: [string, RequestInit]) =>
                String(url).startsWith("/api/mail/messages?") && (init?.method ?? "GET") === "GET",
            ).length;

            await user.click(screen.getByRole("button", { name: "Apply label" }));
            await chooseMenuItem(user, "menuitemcheckbox", "Invoices");
            await chooseMenuItem(user, "menuitem", "Apply");

            expect(await screen.findByText(/Message m2 has changed since it was read\./)).toBeInTheDocument();
            expect(screen.getByText("Couldn't update the message")).toBeInTheDocument();
            await waitFor(() =>
                expect(
                    fetchMock.mock.calls.filter(([url, init]: [string, RequestInit]) =>
                        String(url).startsWith("/api/mail/messages?") && (init?.method ?? "GET") === "GET",
                    ).length,
                ).toBe(listingsBefore + 1),
            );
        });

        it("reloads the list and says so when a bulk action is rejected part-way", async () => {
            let rejected = false;
            const fetchMock = mockSelectable(twoMessages(), undefined, (url, init) => {
                if (url === "/api/mail/messages" && init?.method === "PUT") {
                    rejected = true;
                    return jsonResponse(409, { message: "Message m2 has changed since it was read." });
                }
                return undefined;
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First", "Second");
            const listingsBefore = fetchMock.mock.calls.filter(([url, init]: [string, RequestInit]) =>
                String(url).startsWith("/api/mail/messages?") && (init?.method ?? "GET") === "GET",
            ).length;

            await user.click(screen.getByRole("button", { name: "Mark read" }));

            // A pop-up, not a line in the selection bar: the title says some may have changed, the message is the server's own.
            expect(await screen.findByText(/Message m2 has changed since it was read\./)).toBeInTheDocument();
            expect(screen.getByText("Couldn't update all of those messages")).toBeInTheDocument();
            expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "error", title: "Couldn't update all of those messages" }]);
            expect(rejected).toBe(true);
            await waitFor(() =>
                expect(
                    fetchMock.mock.calls.filter(([url, init]: [string, RequestInit]) =>
                        String(url).startsWith("/api/mail/messages?") && (init?.method ?? "GET") === "GET",
                    ).length,
                ).toBe(listingsBefore + 1),
            );
            expect(screen.getByText("0 selected")).toBeInTheDocument();
        });

        it("explains a bulk failure that isn't an API error", async () => {
            mockSelectable(twoMessages(), undefined, (url, init) => {
                if (url === "/api/mail/messages" && init?.method === "PUT") throw new TypeError("network down");
                return undefined;
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First");

            await user.click(screen.getByRole("button", { name: "Mark read" }));

            expect(await screen.findByText("Couldn't update the message")).toBeInTheDocument();
            expect(screen.getByText("The server couldn't be reached. Check your connection and try again.")).toBeInTheDocument();
        });

        it("clears the selection and returns to the toolbar on Cancel", async () => {
            mockSelectable(twoMessages());
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First");

            await user.click(screen.getByRole("button", { name: "Cancel" }));

            expect(screen.getByRole("button", { name: "Select" })).toBeInTheDocument();
            expect(screen.queryByRole("checkbox", { name: "Select First" })).not.toBeInTheDocument();
        });

        it("clears the selection when the folder's listing changes underneath it", async () => {
            mockSelectable(twoMessages());
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await selectRows(user, "First");
            expect(screen.getByText("1 selected")).toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Clear" }));

            expect(screen.getByText("0 selected")).toBeInTheDocument();
        });

        it("is unavailable in an aggregate view, whose rows come from several mailboxes", async () => {
            const location = mockLocation();
            (location as any).search = "?aggregate=inbox";
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, [messageFixture()]);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Hello there");

            const select = screen.getByRole("button", { name: "Select" });
            expect(select).toBeDisabled();
            expect(select).toHaveAttribute("title", "Open a mailbox's own folder to select messages");
            mockLocation();
        });

        describe("keyboard shortcuts", () => {
            // Some tests below give the location a search string; put a plain one back for whatever runs next.
            afterEach(() => {
                mockLocation();
            });

            const flagsRead = { read: true, flagged: false, answered: false, forwarded: false };
            /** m1 and m3 unread, m2 read - top to bottom. */
            const threeMessages = () => [
                messageFixture({ uid: "m1", subject: "First" }),
                messageFixture({ uid: "m2", subject: "Second", flags: flagsRead }),
                messageFixture({ uid: "m3", subject: "Third" }),
            ];
            /** A key pressed on `target`; resolves to whether the browser would still act on it (false: the layer took it). */
            const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) => fireEvent.keyDown(target, { key, ...init });
            const CTRL = { ctrlKey: true };
            const puts = (fetchMock: ReturnType<typeof vi.fn>) =>
                fetchMock.mock.calls
                    .filter(([url, init]: [string, RequestInit]) => url === "/api/mail/messages" && init?.method === "PUT")
                    .map(([, init]: [string, RequestInit]) => JSON.parse(init.body as string));
            const deleteRequests = (fetchMock: ReturnType<typeof vi.fn>) =>
                fetchMock.mock.calls.filter(([, init]: [string, RequestInit]) => init?.method === "DELETE").map(([url]: [string]) => url);
            const rowButton = (subject: string) => screen.getByText(subject).closest("button") as HTMLElement;
            const detail = () => screen.getByTestId("detail-pane");

            it("moves the selection with the arrow keys and j/k, keeping the focus on the selected row", async () => {
                mockSelectable(threeMessages());
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");

                expect(press("ArrowDown")).toBe(false);
                await waitFor(() => expect(detail()).toHaveTextContent("message:m1"));
                expect(rowButton("First")).toHaveFocus();
                expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
                press("j");
                await waitFor(() => expect(detail()).toHaveTextContent("message:m2"));
                expect(rowButton("Second")).toHaveFocus();
                press("ArrowUp");
                await waitFor(() => expect(detail()).toHaveTextContent("message:m1"));
                press("k");
                await waitFor(() => expect(detail()).toHaveTextContent("message:m1"));
                for (let i = 0; i < 5; i++) {
                    press("ArrowDown");
                }
                await waitFor(() => expect(detail()).toHaveTextContent("message:m3"));
                scrollIntoView.mockRestore();
            });

            it("leaves j, k and the arrow keys to the search box while it has the focus", async () => {
                mockSelectable(threeMessages());
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                const search = screen.getByLabelText("Search all mail");

                expect(press("j", {}, search)).toBe(true);
                expect(press("ArrowDown", {}, search)).toBe(true);
                await waitFor(() => expect(detail()).toHaveTextContent("no-message"));
            });

            it("does not move the selection in select mode, where the arrow keys are the list's own", async () => {
                mockSelectable(threeMessages());
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                await user.click(screen.getByRole("button", { name: "Select" }));
                expect(press("ArrowDown")).toBe(true);
                expect(press("j")).toBe(true);
                expect(press(".", CTRL)).toBe(true);
            });

            it("does not move the selection on a phone", async () => {
                mockMatchMedia(true);
                mockSelectable(threeMessages());
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                expect(press("ArrowDown")).toBe(true);
                expect(press("j")).toBe(true);
            });

            it("has nothing to move over in an empty folder", async () => {
                mockSelectable([]);
                render(<InboxPage userUid="u1" />);
                await screen.findByText("No messages in this folder.");
                expect(press("ArrowDown")).toBe(true);
            });

            it("jumps to the next and previous unread message with Ctrl+. and Ctrl+,", async () => {
                mockSelectable(threeMessages());
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await user.click(await screen.findByText("Second"));
                await waitFor(() => expect(detail()).toHaveTextContent("message:m2"));

                expect(press(".", CTRL)).toBe(false);
                await waitFor(() => expect(detail()).toHaveTextContent("message:m3"));
                // Nothing unread below it: the key is taken and nothing moves.
                expect(press(".", CTRL)).toBe(false);
                await waitFor(() => expect(detail()).toHaveTextContent("message:m3"));
                expect(press(",", CTRL)).toBe(false);
                await waitFor(() => expect(detail()).toHaveTextContent("message:m1"));
                expect(press(",", CTRL)).toBe(false);
                await waitFor(() => expect(detail()).toHaveTextContent("message:m1"));
            });

            it("deletes the selected message with Ctrl+D through the same bulk move to Deleted Items, then carries on from where it was", async () => {
                const fetchMock = mockSelectable(threeMessages());
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                press("ArrowDown");
                // The detail pane shows the selection a render later, and on a slow runner that is after this line has run.
                await waitFor(() => expect(detail()).toHaveTextContent("message:m1"));

                expect(press("d", CTRL)).toBe(false);

                await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
                expect(puts(fetchMock)).toContainEqual([{ uid: "m1", version: 0, folderUid: "f6" }]);
                await waitFor(() => expect(detail()).toHaveTextContent("no-message"));
                // The next row is the one that slid into the deleted one's place.
                press("ArrowDown");
                await waitFor(() => expect(detail()).toHaveTextContent("message:m2"));
                press("ArrowUp");
                await waitFor(() => expect(detail()).toHaveTextContent("message:m2"));
            });

            it("deletes with the Delete key too, and steps back when the deleted row was the last", async () => {
                const fetchMock = mockSelectable(threeMessages());
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                // One key at a time, each waited for: the selection moves a render after the key, and on a slow runner three keys pressed
                // back to back all act on the selection as it was before the first of them.
                for (const uid of ["m1", "m2", "m3"]) {
                    press("ArrowDown");
                    await waitFor(() => expect(detail()).toHaveTextContent(`message:${uid}`));
                }

                expect(press("Delete")).toBe(false);

                await waitFor(() => expect(screen.queryByText("Third")).not.toBeInTheDocument());
                expect(puts(fetchMock)).toContainEqual([{ uid: "m3", version: 0, folderUid: "f6" }]);
                press("ArrowUp");
                await waitFor(() => expect(detail()).toHaveTextContent("message:m2"));
            });

            it("does not register Delete, mark read, mark unread, flag, Enter or Escape until something is selected", async () => {
                const fetchMock = mockSelectable(threeMessages());
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");

                expect(press("d", CTRL)).toBe(true);
                expect(press("Delete")).toBe(true);
                expect(press("q", CTRL)).toBe(true);
                expect(press("u", CTRL)).toBe(true);
                expect(press("Insert")).toBe(true);
                expect(press("Enter")).toBe(true);
                expect(press("Escape")).toBe(true);
                expect(puts(fetchMock)).toEqual([]);
            });

            it("permanently deletes what is already in Deleted Items with the same key - only after a confirmation, and never as a move", async () => {
                mockLocation();
                (window.location as any).search = "?mailboxUid=mb1&folderUid=f6";
                const fetchMock = mockSelectable([messageFixture({ uid: "m9", subject: "Gone already", folderUid: "f6" })], undefined, (url, init) =>
                    init?.method === "DELETE" ? new Response(null, { status: 204 }) : undefined,
                );
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByText("Gone already");
                press("ArrowDown");
                await waitFor(() => expect(detail()).toHaveTextContent("message:m9"));

                expect(press("d", CTRL)).toBe(false);

                // The key only asks: nothing is sent, and the row stays, until the reader confirms.
                const dialog = await screen.findByRole("dialog", { name: "Delete permanently" });
                expect(within(dialog).getByText("Permanently delete 1 message? This can't be undone.")).toBeInTheDocument();
                expect(deleteRequests(fetchMock)).toEqual([]);
                expect(screen.getByText("Gone already")).toBeInTheDocument();

                await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

                await waitFor(() => expect(screen.queryByText("Gone already")).not.toBeInTheDocument());
                expect(deleteRequests(fetchMock)).toEqual(["/api/mail/messages/m9?purge=true"]);
                expect(puts(fetchMock)).toEqual([]);
                await waitFor(() => expect(getNotificationsSnapshot().visible.map((n) => n.title)).toContain("1 message permanently deleted"));
                await waitFor(() => expect(detail()).toHaveTextContent("no-message"));
            });

            it("sends nothing when the confirmation of a permanent delete is cancelled", async () => {
                mockLocation();
                (window.location as any).search = "?mailboxUid=mb1&folderUid=f6";
                const fetchMock = mockSelectable([messageFixture({ uid: "m9", subject: "Gone already", folderUid: "f6" })]);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByText("Gone already");
                press("ArrowDown");
                await waitFor(() => expect(detail()).toHaveTextContent("message:m9"));
                expect(press("Delete")).toBe(false);

                await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));

                await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
                expect(deleteRequests(fetchMock)).toEqual([]);
                expect(puts(fetchMock)).toEqual([]);
                expect(screen.getByText("Gone already")).toBeInTheDocument();
            });

            it("creates Deleted Items when the mailbox has none, exactly as the bar's Delete does", async () => {
                const fetchMock = mockSelectable(threeMessages(), [inboxFolder]);
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                press("ArrowDown");

                press("d", CTRL);

                await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
                expect(fetchMock.mock.calls.filter(([url, init]: [string, RequestInit]) => url === "/api/mail/folders" && init?.method === "POST")).toHaveLength(1);
                expect(puts(fetchMock)).toContainEqual([{ uid: "m1", version: 0, folderUid: "f-new" }]);
            });

            it("marks the selected message unread with Ctrl+U and read again with Ctrl+Q, one bulk update each", async () => {
                const fetchMock = mockSelectable(threeMessages());
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                press("ArrowDown");
                // Opening it marked it read.
                await waitFor(() => expect(rowButton("First").closest("li")).not.toHaveAttribute("data-unread"));
                const before = puts(fetchMock).length;

                expect(press("u", CTRL)).toBe(false);
                await waitFor(() => expect(rowButton("First").closest("li")).toHaveAttribute("data-unread", "true"));
                expect(puts(fetchMock)[before]).toEqual([expect.objectContaining({ uid: "m1", flags: expect.objectContaining({ read: false }) })]);

                expect(press("q", CTRL)).toBe(false);
                await waitFor(() => expect(rowButton("First").closest("li")).not.toHaveAttribute("data-unread"));
                expect(puts(fetchMock)[before + 1]).toEqual([expect.objectContaining({ uid: "m1", flags: expect.objectContaining({ read: true }) })]);
            });

            it("does nothing, but still takes the key, when there is nothing to change (already read, already unread)", async () => {
                const fetchMock = mockSelectable(threeMessages());
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await user.click(await screen.findByText("Second"));
                const before = puts(fetchMock).length;

                expect(press("q", CTRL)).toBe(false);
                expect(puts(fetchMock).length).toBe(before);

                await user.click(screen.getByText("Second"));
                press("u", CTRL);
                await waitFor(() => expect(rowButton("Second").closest("li")).toHaveAttribute("data-unread", "true"));
                const afterUnread = puts(fetchMock).length;
                expect(press("u", CTRL)).toBe(false);
                expect(puts(fetchMock).length).toBe(afterUnread);
            });

            it("flags the selected message with Insert and unflags it with the next Insert", async () => {
                const fetchMock = mockSelectable(threeMessages());
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                press("ArrowDown");
                const before = puts(fetchMock).length;

                expect(press("Insert")).toBe(false);
                await waitFor(() => expect(screen.getByLabelText("Flagged")).toBeInTheDocument());
                expect(puts(fetchMock)[before][0].flags.flagged).toBe(true);

                press("Insert");
                await waitFor(() => expect(screen.queryByLabelText("Flagged")).not.toBeInTheDocument());
                expect(puts(fetchMock)[before + 1][0].flags.flagged).toBe(false);
            });

            it("acts on the ticked rows in select mode - the same as the bar's buttons - and on nothing when none is ticked", async () => {
                const fetchMock = mockSelectable(threeMessages());
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                await user.click(screen.getByRole("button", { name: "Select" }));
                expect(press("d", CTRL)).toBe(true);
                expect(press("Insert")).toBe(true);

                await user.click(await screen.findByRole("checkbox", { name: "Select First" }));
                await user.click(await screen.findByRole("checkbox", { name: "Select Third" }));
                expect(press("d", CTRL)).toBe(false);

                await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
                expect(screen.queryByText("Third")).not.toBeInTheDocument();
                expect(screen.getByText("Second")).toBeInTheDocument();
                expect(puts(fetchMock)).toContainEqual([
                    { uid: "m1", version: 0, folderUid: "f6" },
                    { uid: "m3", version: 0, folderUid: "f6" },
                ]);
            });

            it("shows the failure of a keyboard action, since there is no selection bar to show it, and reloads the list", async () => {
                const fetchMock = mockSelectable(threeMessages(), undefined, (url, init) =>
                    url === "/api/mail/messages" && init?.method === "PUT" && String(init.body).includes("f6")
                        ? jsonResponse(500, { message: "the server said no" })
                        : undefined,
                );
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                press("ArrowDown");

                press("d", CTRL);

                expect(await screen.findByText(/the server said no/)).toBeInTheDocument();
                expect(screen.getByText("First")).toBeInTheDocument();
                expect(fetchMock).toHaveBeenCalled();
            });

            it("ignores a second action while one is on the wire", async () => {
                let release: (() => void) | undefined;
                const gate = new Promise<void>((resolve) => (release = resolve));
                const fetchMock = mockSelectable(threeMessages(), undefined, (url, init) =>
                    url === "/api/mail/messages" && init?.method === "PUT" && String(init.body).includes("f6")
                        ? gate.then(() => jsonResponse(200, [messageFixture({ uid: "m1", folderUid: "f6" })]))
                        : undefined,
                );
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                press("ArrowDown");

                press("d", CTRL);
                await waitFor(() => expect(puts(fetchMock).filter((body) => JSON.stringify(body).includes("f6"))).toHaveLength(1));
                expect(press("d", CTRL)).toBe(false);
                expect(puts(fetchMock).filter((body) => JSON.stringify(body).includes("f6"))).toHaveLength(1);
                release!();
                await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
            });

            it("opens the selected message on its own page with Enter - from the row, or from anywhere - and leaves other buttons to Enter", async () => {
                const location = mockLocation();
                mockSelectable(threeMessages());
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await user.click(await screen.findByText("First"));

                // On the selected row's own button, Enter opens it...
                expect(press("Enter", {}, rowButton("First"))).toBe(false);
                expect(location.href).toBe("/messages/m1");
                location.href = "";
                // ...and with the focus nowhere in particular.
                expect(press("Enter")).toBe(false);
                expect(location.href).toBe("/messages/m1");
                location.href = "";
                // On a row that is not selected yet, Enter is the button's own click, which selects it.
                expect(press("Enter", {}, rowButton("Second"))).toBe(true);
                // And a button that is not a row keeps its Enter.
                expect(press("Enter", {}, screen.getByRole("button", { name: "Select" }))).toBe(true);
                expect(location.href).toBe("");
            });

            it("clears the selection with Escape, and takes no Escape when nothing is selected", async () => {
                mockSelectable(threeMessages());
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                expect(press("Escape")).toBe(true);
                press("ArrowDown");
                await waitFor(() => expect(detail()).toHaveTextContent("message:m1"));

                expect(press("Escape")).toBe(false);

                await waitFor(() => expect(detail()).toHaveTextContent("no-message"));
                expect(press("Escape")).toBe(true);
            });

            it("leaves select mode with Escape", async () => {
                mockSelectable(threeMessages());
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                await user.click(screen.getByRole("button", { name: "Select" }));
                await user.click(await screen.findByRole("checkbox", { name: "Select First" }));

                expect(press("Escape")).toBe(false);

                expect(screen.queryByRole("checkbox", { name: "Select First" })).not.toBeInTheDocument();
                expect(screen.getByRole("button", { name: "Select" })).toBeInTheDocument();
            });

            it("clears the search box first with Escape while it has the focus", async () => {
                mockSelectable(threeMessages());
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                await user.click(screen.getByText("Second"));
                const search = screen.getByLabelText("Search all mail");
                await user.type(search, "abc");
                expect(search).toHaveValue("abc");

                expect(press("Escape", {}, search)).toBe(false);

                expect(search).toHaveValue("");
                // The selection is still there for the next Escape.
                await waitFor(() => expect(detail()).toHaveTextContent("message:m2"));
            });

            it("focuses the search box with / and Ctrl+E, and leaves / to the box once it has the focus", async () => {
                mockSelectable(threeMessages());
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                const search = screen.getByLabelText("Search all mail");

                expect(press("/")).toBe(false);
                expect(search).toHaveFocus();
                expect(press("/", {}, search)).toBe(true);
                (document.activeElement as HTMLElement).blur();
                expect(press("e", CTRL, search)).toBe(false);
                expect(search).toHaveFocus();
            });

            it("focuses the search box with / and Ctrl+E over conversations too", async () => {
                mockSelectable(threeMessages());
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByText("First");
                await toggleConversations(user);
                await screen.findByText("No conversations in this folder.");
                expect(press("/")).toBe(false);
                expect(screen.getByLabelText("Search all mail")).toHaveFocus();
            });
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

            it("still shows Tier 1's already-available results once a slow Tier 2 settles - even to its own degraded, timed-out shape", async () => {
                // Regression test for a real deadlock: index.tsx awaits Tier 1 and Tier 2 with a single
                // Promise.all(), so a Tier 2 that never settles would block Tier 1's results forever. The
                // fix lives inside searchTier2.ts itself (a timeout race - see its own dedicated tests in
                // searchTier2.test.ts), which guarantees searchLocalIndex() always resolves - here to
                // exactly the degraded `{ results: [], hasMore: false }` shape a timed-out Tier 2 produces
                // - never hangs. This confirms InboxContent's own side of the contract: once that resolves,
                // Tier 1's results render, they are not lost or blocked by Tier 2 being slow.
                const hit = messageFixture({ uid: "m-tier1", subject: "Tier 1 only match", folderUid: "f2" });
                mockSearch([hit], (url) =>
                    url.includes("q=budget") ? jsonResponse(200, { results: [{ entityType: "message", entityUid: "m-tier1", score: 1 }] }) : undefined,
                );
                let resolveTier2!: (value: { results: never[]; hasMore: boolean }) => void;
                searchLocalIndex.mockReturnValue(
                    new Promise((resolve) => {
                        resolveTier2 = resolve;
                    }),
                );
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByPlaceholderText("Search all mail…");

                await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");
                // Tier 2 hasn't settled yet - nothing to find while it's still pending.
                expect(screen.queryByText("Tier 1 only match")).not.toBeInTheDocument();

                resolveTier2({ results: [], hasMore: false });

                expect(await screen.findByText("Tier 1 only match")).toBeInTheDocument();
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

            const COMPLETE_COVERAGE = {
                indexedFrom: "2025-06-01T00:00:00.000Z",
                indexedUntil: "2026-01-01T00:00:00.000Z",
                indexedCount: 5,
                building: false,
                complete: true,
            };

            function tier3Windows() {
                return (searchEncryptedCandidates.mock.calls as [{ before?: Date; after?: Date }][]).map(([parsed]) => ({
                    before: parsed.before?.toISOString(),
                    after: parsed.after?.toISOString(),
                }));
            }

            it('narrows Tier 3 to the mail before and after Tier 2\'s coverage, and "Search all mail" removes both bounds', async () => {
                mockSearch([], (url) => (url.includes("q=budget") ? jsonResponse(200, { results: [] }) : undefined));
                searchLocalIndex.mockResolvedValue({ results: [], coverage: COMPLETE_COVERAGE, hasMore: false });
                searchEncryptedCandidates.mockResolvedValue([]);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByPlaceholderText("Search all mail…");

                await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");
                await screen.findByText("Search all mail");

                // Mail newer than the build pass isn't indexed yet, so it still goes through Tier 3.
                expect(tier3Windows()).toEqual([
                    { before: "2025-06-01T00:00:00.000Z", after: undefined },
                    { before: undefined, after: "2026-01-01T00:00:00.000Z" },
                ]);

                await user.click(screen.getByText("Search all mail"));

                await waitFor(() => expect(searchEncryptedCandidates).toHaveBeenCalledTimes(3));
                expect(tier3Windows()[2]).toEqual({ before: undefined, after: undefined });
                expect(screen.queryByText("Search all mail")).not.toBeInTheDocument();
            });

            it('resets "Search all mail" when the query changes, so the next search is bounded again', async () => {
                mockSearch([], () => jsonResponse(200, { results: [] }));
                searchLocalIndex.mockResolvedValue({ results: [], coverage: COMPLETE_COVERAGE, hasMore: false });
                searchEncryptedCandidates.mockResolvedValue([]);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByPlaceholderText("Search all mail…");

                await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");
                await user.click(await screen.findByText("Search all mail"));
                await waitFor(() => expect(searchEncryptedCandidates).toHaveBeenCalledTimes(3));
                expect(screen.queryByText("Search all mail")).not.toBeInTheDocument();

                await user.type(screen.getByPlaceholderText("Search all mail…"), "x");

                expect(await screen.findByText("Search all mail")).toBeInTheDocument();
                // The button comes back with the new query; the search for it starts a little later (it is debounced), so wait for its calls.
                await waitFor(() => expect(tier3Windows().slice(3).length).toBeGreaterThan(0));
                const later = tier3Windows().slice(3);
                // Every Tier 3 call after the unbounded one is bounded by coverage again - never a second
                // unbounded pass for the new query.
                expect(later.every((w) => w.before !== undefined || w.after !== undefined)).toBe(true);
            });


            it.each([
                ["keeps a query's own earlier before: bound", "before:2025-01-01 budget", [{ before: "2025-01-01T00:00:00.000Z", after: undefined }]],
                [
                    "tightens a query's later before: bound to the coverage window",
                    "before:2025-12-01 budget",
                    [{ before: "2025-06-01T00:00:00.000Z", after: undefined }],
                ],
                ["keeps a query's own later after: bound", "after:2026-03-01 budget", [{ before: undefined, after: "2026-03-01T00:00:00.000Z" }]],
                [
                    "raises a query's earlier after: bound to the coverage end",
                    "after:2025-01-01 before:2026-02-01 budget",
                    [
                        { before: "2025-06-01T00:00:00.000Z", after: "2025-01-01T00:00:00.000Z" },
                        { before: "2026-02-01T00:00:00.000Z", after: "2026-01-01T00:00:00.000Z" },
                    ],
                ],
                ["skips Tier 3 entirely for a range the coverage fully contains", "after:2025-07-01 before:2025-12-01 budget", []],
            ])("%s when narrowing Tier 3", async (_label, query, expectedWindows) => {
                mockSearch([], (url) => (url.includes("q=budget") ? jsonResponse(200, { results: [] }) : undefined));
                searchLocalIndex.mockResolvedValue({ results: [], coverage: COMPLETE_COVERAGE, hasMore: false });
                searchEncryptedCandidates.mockResolvedValue([]);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByPlaceholderText("Search all mail…");

                await user.type(screen.getByPlaceholderText("Search all mail…"), query);

                // The settled count only appears once Tier 3 has run (or been skipped).
                expect(await screen.findByText("0 results")).toBeInTheDocument();
                expect(tier3Windows()).toEqual(expectedWindows);
            });

            it("shows a message found in both Tier 3 windows only once", async () => {
                const hit = messageFixture({ uid: "m3", subject: "Boundary match", folderUid: "f2" });
                mockSearch([hit], (url) => (url.includes("q=budget") ? jsonResponse(200, { results: [] }) : undefined));
                searchLocalIndex.mockResolvedValue({ results: [], coverage: COMPLETE_COVERAGE, hasMore: false });
                searchEncryptedCandidates.mockResolvedValue([{ entityType: "message", entityUid: "m3", score: 5, source: "candidate", metadataOnly: false }]);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByPlaceholderText("Search all mail…");

                await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");

                expect(await screen.findByText("1 result")).toBeInTheDocument();
                expect(screen.getAllByText("Boundary match")).toHaveLength(1);
                expect(searchEncryptedCandidates).toHaveBeenCalledTimes(2);
            });

            it("doesn't reuse a Tier 3 result cached under different narrowing for the same query", async () => {
                mockSearch([], (url) => (url.includes("q=budget") ? jsonResponse(200, { results: [] }) : undefined));
                searchLocalIndex.mockResolvedValue({ results: [], coverage: { ...COMPLETE_COVERAGE, building: true, complete: false }, hasMore: false });
                searchEncryptedCandidates.mockResolvedValue([]);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByPlaceholderText("Search all mail…");
                const searchBox = screen.getByPlaceholderText("Search all mail…");

                await user.type(searchBox, "budget");
                await screen.findByText("0 results");
                expect(searchEncryptedCandidates).toHaveBeenCalledTimes(1);
                await user.clear(searchBox);
                await waitFor(() => expect(screen.queryByText("0 results")).not.toBeInTheDocument());
                // The build finished in the meantime.
                searchLocalIndex.mockResolvedValue({ results: [], coverage: COMPLETE_COVERAGE, hasMore: false });
                await user.type(searchBox, "budget");

                await waitFor(() => expect(searchEncryptedCandidates).toHaveBeenCalledTimes(3));
                expect(tier3Windows()[1]).toEqual({ before: "2025-06-01T00:00:00.000Z", after: undefined });
            });

            it("reuses Tier 3's cached candidates when the identical query is searched again", async () => {
                const hit = messageFixture({ uid: "m3", subject: "Encrypted match", folderUid: "f2" });
                mockSearch([hit], (url) => (url.includes("q=budget") ? jsonResponse(200, { results: [] }) : undefined));
                searchEncryptedCandidates.mockResolvedValue([
                    { entityType: "message", entityUid: "m3", score: 5, source: "candidate", metadataOnly: false },
                ]);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByPlaceholderText("Search all mail…");
                const searchBox = screen.getByPlaceholderText("Search all mail…");

                await user.type(searchBox, "budget");
                await screen.findByText("Encrypted match");
                await user.clear(searchBox);
                await waitFor(() => expect(screen.queryByText("Encrypted match")).not.toBeInTheDocument());
                await user.type(searchBox, "budget");

                expect(await screen.findByText("Encrypted match")).toBeInTheDocument();
                expect(searchEncryptedCandidates).toHaveBeenCalledTimes(1);
            });

            it.each([
                ["still building", { building: true, complete: false }],
                ["finished but incomplete", { building: false, complete: false }],
                // No coverage end means no pass completed in this session.
                ["complete but with no coverage end", { building: false, complete: true }],
            ])("never narrows Tier 3 to Tier 2's coverage while the local index is %s", async (_label, state) => {
                mockSearch([], (url) => (url.includes("q=budget") ? jsonResponse(200, { results: [] }) : undefined));
                searchLocalIndex.mockResolvedValue({
                    results: [],
                    coverage: { indexedFrom: "2025-06-01T00:00:00.000Z", indexedCount: 5, ...state },
                    hasMore: false,
                });
                searchEncryptedCandidates.mockResolvedValue([]);
                const user = userEvent.setup();
                render(<InboxPage userUid="u1" />);
                await screen.findByPlaceholderText("Search all mail…");

                await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");

                await waitFor(() => expect(searchEncryptedCandidates).toHaveBeenCalledTimes(1));
                const [parsed] = searchEncryptedCandidates.mock.calls[0] as [{ before?: Date }];
                expect(parsed.before).toBeUndefined();
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
                return { unopenableKeys: [] };
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

    describe("aggregate folders (All Mailboxes)", () => {
        const sharedMailbox = { ...mailbox, uid: "mb2", ownerUserUid: undefined, displayName: "Support", primarySmtpAddress: "support@example.com" };
        const sharedInbox = { ...inboxFolder, uid: "f-shared-inbox", mailboxUid: "mb2" };

        // mockLocation() doesn't restore window.location on its own - without this, the `?aggregate=`
        // search string set below leaks into every later test in this file.
        afterEach(() => {
            mockLocation();
        });

        function mockAggregate(extraMessages: Record<string, unknown[]>) {
            return mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox, sharedMailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, url.includes("mailboxUid=mb2") ? [sharedInbox] : [inboxFolder]);
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages?") || url === "/api/mail/messages") {
                    const folderUid = new URLSearchParams(url.split("?")[1]).get("folderUid") ?? "";
                    return jsonResponse(200, extraMessages[folderUid] ?? []);
                }
                if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
        }

        it("merges every mailbox's Inbox newest-first, labels each row with its mailbox, and offers search across all of them", async () => {
            const location = mockLocation();
            (location as any).search = "?aggregate=inbox";
            mockAggregate({
                f1: [messageFixture({ uid: "m-own", subject: "Own older", receivedDate: "2026-01-01T00:00:00.000Z" })],
                "f-shared-inbox": [
                    messageFixture({ uid: "m-shared", subject: "Shared newer", mailboxUid: "mb2", folderUid: "f-shared-inbox", receivedDate: "2026-01-02T00:00:00.000Z" }),
                ],
            });
            render(<InboxPage userUid="u1" />);

            await screen.findByText("Shared newer");
            const subjects = screen.getAllByText(/Own older|Shared newer/).map((el) => el.textContent);
            expect(subjects).toEqual(["Shared newer", "Own older"]);
            // The sidebar header/compose picker say "Support (shared)"; the bare name is the row's own label.
            expect(screen.getByText("Support")).toBeInTheDocument();
            expect(screen.getByPlaceholderText("Search all mail…")).toBeEnabled();
            expect(screen.queryByPlaceholderText("Open a mailbox's own folder to search")).not.toBeInTheDocument();
            expect(screen.getByText(/Showing the most recent mail from each mailbox/)).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Focused" })).not.toBeInTheDocument();
        });

        it("loads labels for the selected message's own mailbox, not the caller's default mailbox", async () => {
            const location = mockLocation();
            (location as any).search = "?aggregate=inbox";
            const fetchMock = mockAggregate({
                "f-shared-inbox": [messageFixture({ uid: "m-shared", subject: "Shared row", mailboxUid: "mb2", folderUid: "f-shared-inbox" })],
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByText("Shared row"));

            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/mail\/labels\?.*mailboxUid=mb2/), expect.anything()));
        });

        it("still shows the other mailboxes' messages when one mailbox's fetch fails", async () => {
            const location = mockLocation();
            (location as any).search = "?aggregate=inbox";
            mockFetch((url) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox, sharedMailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, url.includes("mailboxUid=mb2") ? [sharedInbox] : [inboxFolder]);
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
                if (url.includes("folderUid=f-shared-inbox")) return jsonResponse(500, { message: "boom" });
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, [messageFixture({ uid: "m-own", subject: "Own survives" })]);
                throw new Error(`unexpected ${url}`);
            });
            render(<InboxPage userUid="u1" />);

            expect(await screen.findByText("Own survives")).toBeInTheDocument();
        });

        it("registers no delete, mark or flag keys in the listing (the selection bar isn't offered there), but the search key still focuses the search box", async () => {
            const location = mockLocation();
            (location as any).search = "?aggregate=inbox";
            mockAggregate({ f1: [messageFixture({ uid: "m-own", subject: "Own row" })] });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await user.click(await screen.findByText("Own row"));
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("message:m-own");

            for (const [key, init] of [["d", { ctrlKey: true }], ["Delete", {}], ["q", { ctrlKey: true }], ["u", { ctrlKey: true }], ["Insert", {}]] as const) {
                expect(fireEvent.keyDown(document.body, { key, ...init }), key).toBe(true);
            }
            // The keys that only need the list still work: Escape closes it.
            expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
            // Search covers every mailbox, so the key that focuses its box works here too.
            expect(fireEvent.keyDown(document.body, { key: "/" })).toBe(false);
            expect(screen.getByPlaceholderText("Search all mail…")).toHaveFocus();
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

        it("skips rows a later page repeats instead of rendering them twice", async () => {
            const firstPage = Array.from({ length: 50 }, (_, i) => messageFixture({ uid: `m${i}`, subject: `Message ${i}` }));
            const io = mockIntersectionObserver();
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/messages")) {
                    // New mail arrived between fetches, shifting m49 onto the next page.
                    if (url.includes("page=1")) return jsonResponse(200, [firstPage[49], messageFixture({ uid: "m99", subject: "Message 99" })]);
                    return jsonResponse(200, firstPage);
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Message 0");

            io.trigger();

            expect(await screen.findByText("Message 99")).toBeInTheDocument();
            expect(screen.getAllByText("Message 49")).toHaveLength(1);
        });

        it("drops a load-more page that lands after the list was replaced by a search", async () => {
            const firstPage = Array.from({ length: 50 }, (_, i) => messageFixture({ uid: `m${i}`, subject: `Message ${i}` }));
            const io = mockIntersectionObserver();
            let resolvePageOne: ((value: Response) => void) | undefined;
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/search")) return jsonResponse(200, { results: [] });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/messages")) {
                    if (url.includes("page=1")) {
                        return new Promise((resolve) => {
                            resolvePageOne = resolve;
                        });
                    }
                    return jsonResponse(200, firstPage);
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Message 0");

            io.trigger();
            await screen.findByText("Loading more…");
            await user.type(screen.getByPlaceholderText("Search all mail…"), "nothing");
            await screen.findByText('No messages match "nothing".');

            resolvePageOne!(jsonResponse(200, [messageFixture({ uid: "m99", subject: "Message 99" })]));
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(screen.queryByText("Message 99")).not.toBeInTheDocument();
            expect(screen.getByText('No messages match "nothing".')).toBeInTheDocument();
        });

        it("drops a slow folder listing that lands after a search already replaced it", async () => {
            let resolveListing: ((value: Response) => void) | undefined;
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/search")) return jsonResponse(200, { results: [] });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/messages")) {
                    return new Promise((resolve) => {
                        resolveListing = resolve;
                    });
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByPlaceholderText("Search all mail…");
            await waitFor(() => expect(resolveListing).toBeDefined());

            await user.type(screen.getByPlaceholderText("Search all mail…"), "nothing");
            await screen.findByText('No messages match "nothing".');

            resolveListing!(jsonResponse(200, [messageFixture({ uid: "m-late", subject: "Late folder row" })]));
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(screen.queryByText("Late folder row")).not.toBeInTheDocument();
            expect(screen.getByText('No messages match "nothing".')).toBeInTheDocument();
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

        it("caps the message list at MAX_LOADED_ROWS (500), stops fetching further pages once it's hit, and shows a refine-your-search banner instead of the load-more sentinel", async () => {
            const io = mockIntersectionObserver();
            const pages = Array.from({ length: 12 }, (_, p) =>
                Array.from({ length: 50 }, (_, i) => messageFixture({ uid: `p${p}-m${i}`, subject: `Page ${p} message ${i}` })),
            );
            let messageFetches = 0;
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/messages")) {
                    messageFetches += 1;
                    const pageParam = new URL(url, "http://localhost").searchParams.get("page");
                    return jsonResponse(200, pages[pageParam ? Number(pageParam) : 0]);
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Page 0 message 0");

            // Page 0 (50 rows) is already loaded from the initial fetch - nine more full pages of 50 reach
            // exactly the 500-row cap.
            for (let p = 1; p <= 9; p++) {
                io.trigger();
                await screen.findByText(`Page ${p} message 0`);
            }

            expect(screen.getByText("Page 9 message 49")).toBeInTheDocument();
            expect(screen.getByText(/Showing the most recent 500 messages/)).toBeInTheDocument();
            expect(screen.queryByTestId("load-more-sentinel")).not.toBeInTheDocument();

            // The sentinel is gone, but even a stray trigger (or one that raced its own removal) must not
            // fetch an 11th page - loadMore()'s own atRowCap guard refuses once the cap is reached.
            const fetchesAtCap = messageFetches;
            io.trigger();
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(messageFetches).toBe(fetchesAtCap);
            expect(screen.queryByText("Page 10 message 0")).not.toBeInTheDocument();
        });

        it("caps the conversation list at MAX_LOADED_ROWS (500) too, stopping further pages and showing its own refine-your-search banner", async () => {
            localStorage.setItem(
                "rapidmx:mail-list-preferences:mb1",
                JSON.stringify({ sortBy: "date", sortOrder: "desc", filter: "all", labelUids: [], showAsConversations: true }),
            );
            const io = mockIntersectionObserver();
            const pages = Array.from({ length: 12 }, (_, p) =>
                Array.from({ length: 50 }, (_, i) =>
                    conversationFixture({ conversationId: `p${p}-c${i}`, subject: `Page ${p} thread ${i}`, latestMessageUid: `p${p}-m${i}` }),
                ),
            );
            let conversationFetches = 0;
            mockShellAndInbox([], (url) => {
                // Excludes the per-conversation `/conversations/{id}` messages endpoint - only the paged
                // listing itself is overridden here, so an accidental thread-expand still falls through to
                // mockShellAndInbox's own default (empty) handling.
                if (url.startsWith("/api/mail/messages/conversations") && !url.includes("/conversations/")) {
                    conversationFetches += 1;
                    const pageParam = new URL(url, "http://localhost").searchParams.get("page");
                    return jsonResponse(200, pages[pageParam ? Number(pageParam) : 0]);
                }
                return undefined;
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Page 0 thread 0");

            // Page 0 (50 rows) is already loaded from the initial fetch - nine more full pages of 50 reach
            // exactly the 500-row cap.
            for (let p = 1; p <= 9; p++) {
                io.trigger();
                await screen.findByText(`Page ${p} thread 0`);
            }

            expect(screen.getByText("Page 9 thread 49")).toBeInTheDocument();
            expect(screen.getByText(/Showing the most recent 500 conversations/)).toBeInTheDocument();
            expect(screen.queryByTestId("load-more-sentinel")).not.toBeInTheDocument();

            const fetchesAtCap = conversationFetches;
            io.trigger();
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(conversationFetches).toBe(fetchesAtCap);
            expect(screen.queryByText("Page 10 thread 0")).not.toBeInTheDocument();
        });

        it("does not show the row-cap banner when the list is actually exhausted, even if the row count lands at or beyond the cap", async () => {
            const io = mockIntersectionObserver();
            const pages: unknown[][] = Array.from({ length: 9 }, (_, p) =>
                Array.from({ length: 50 }, (_, i) => messageFixture({ uid: `p${p}-m${i}`, subject: `Page ${p} message ${i}` })),
            );
            // The final page is deliberately not a full page of 50 - a real mailbox whose true size lands
            // at/near the cap ends this way (its last page is partial), which is exactly what turns `hasMore`
            // false. Any length other than 50 proves the point equally well; 60 also conveniently pushes the
            // accumulated total across the 500 cap within this same page, which is the edge case under test.
            pages.push(Array.from({ length: 60 }, (_, i) => messageFixture({ uid: `p9-m${i}`, subject: `Page 9 message ${i}` })));
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/messages")) {
                    const pageParam = new URL(url, "http://localhost").searchParams.get("page");
                    return jsonResponse(200, pages[pageParam ? Number(pageParam) : 0]);
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const { container } = render(<InboxPage userUid="u1" />);
            await screen.findByText("Page 0 message 0");

            for (let p = 1; p <= 9; p++) {
                io.trigger();
                await screen.findByText(`Page ${p} message 0`);
            }

            // Capped at exactly 500 (450 from the first nine full pages plus 60 more, truncated down from
            // 510) - but since the last page fetched wasn't a full page, `hasMore` correctly went false:
            // every row that actually exists is already shown, so there is nothing to "refine your search"
            // for, and no sentinel to keep loading from either.
            expect(container.querySelectorAll("li[data-message-uid]")).toHaveLength(500);
            expect(screen.queryByText(/Showing the most recent 500 messages/)).not.toBeInTheDocument();
            expect(screen.queryByTestId("load-more-sentinel")).not.toBeInTheDocument();
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

        it("stops loading search results after a few pages in a row that only repeated hits already shown", async () => {
            const hit = messageFixture({ uid: "m1", subject: "First hit" });
            const io = mockIntersectionObserver();
            let searchRequests = 0;
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/search")) {
                    searchRequests += 1;
                    // Every page (including the cursor continuation) repeats the same hit and claims more.
                    return jsonResponse(200, { results: [{ entityType: "message", entityUid: "m1", score: 1 }], nextCursor: `c${searchRequests}` });
                }
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url === "/api/mail/messages/m1") return jsonResponse(200, hit);
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, []);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("No messages in this folder.");

            await user.type(screen.getByPlaceholderText("Search all mail…"), "hit");
            await screen.findByText("First hit");
            const before = searchRequests;

            io.trigger();

            // Three repeat pages continue on their own; the fourth stops and offers a button instead.
            expect(await screen.findByRole("button", { name: "Load more" }, { timeout: 5000 })).toBeInTheDocument();
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(searchRequests).toBe(before + 4);
            expect(screen.getAllByText("First hit")).toHaveLength(1);
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

        it("doesn't auto-retry a failed page while the sentinel stays in view, and retries on demand", async () => {
            const firstPage = Array.from({ length: 50 }, (_, i) => messageFixture({ uid: `m${i}`, subject: `Message ${i}` }));
            const io = mockIntersectionObserver();
            let pageOneRequests = 0;
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/messages")) {
                    if (url.includes("page=1")) {
                        pageOneRequests += 1;
                        return pageOneRequests === 1
                            ? jsonResponse(500, { message: "boom" })
                            : jsonResponse(200, [messageFixture({ uid: "m99", subject: "Message 99" })]);
                    }
                    return jsonResponse(200, firstPage);
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Message 0");

            io.trigger();
            expect(await screen.findByText("boom")).toBeInTheDocument();
            // The sentinel is still in view (jsdom geometry) and reports again - nothing may re-request on its own.
            io.trigger();
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(pageOneRequests).toBe(1);

            await user.click(within(screen.getByTestId("load-more-sentinel")).getByRole("button", { name: "Retry" }));

            expect(await screen.findByText("Message 99")).toBeInTheDocument();
            expect(pageOneRequests).toBe(2);
            expect(screen.queryByText("boom")).not.toBeInTheDocument();
        });

        function pagedFolder(pages: Record<number, unknown[]>) {
            const requests: number[] = [];
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/messages")) {
                    const page = Number(new URL(url, "http://localhost").searchParams.get("page") ?? "0");
                    requests.push(page);
                    return jsonResponse(200, pages[page] ?? []);
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            return requests;
        }

        const fullPage = (page: number) =>
            Array.from({ length: 50 }, (_, i) => messageFixture({ uid: `p${page}-m${i}`, subject: `Page ${page} message ${i}` }));

        it("keeps loading after a page that added rows while the sentinel is still in view", async () => {
            const io = mockIntersectionObserver();
            const requests = pagedFolder({ 0: fullPage(0), 1: fullPage(1), 2: [messageFixture({ uid: "last", subject: "Last message" })] });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Page 0 message 0");

            io.trigger();

            expect(await screen.findByText("Last message")).toBeInTheDocument();
            expect(requests.filter((p) => p > 0)).toEqual([1, 2]);
        });

        it.each([
            ["below", 5000],
            ["above", -5000],
        ])("stops after a page lands if the sentinel's real position is now %s the view", async (_label, top) => {
            const io = mockIntersectionObserver();
            const requests = pagedFolder({ 0: fullPage(0), 1: fullPage(1), 2: fullPage(2) });
            const rect = (y: number) => ({ top: y, bottom: y + 10, left: 0, right: 0, width: 0, height: 10, x: 0, y, toJSON: () => ({}) }) as DOMRect;
            const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
                return this.getAttribute("data-testid") === "load-more-sentinel" ? rect(top) : rect(0);
            });
            try {
                render(<InboxPage userUid="u1" />);
                await screen.findByText("Page 0 message 0");

                io.trigger();

                expect(await screen.findByText("Page 1 message 0")).toBeInTheDocument();
                await new Promise((resolve) => setTimeout(resolve, 50));
                expect(requests.filter((p) => p > 0)).toEqual([1]);
            } finally {
                spy.mockRestore();
            }
        });

        it("keeps going past a full page that only repeated rows already shown (round 5: it used to stall)", async () => {
            const io = mockIntersectionObserver();
            const first = fullPage(0);
            const requests = pagedFolder({ 0: first, 1: first, 2: [messageFixture({ uid: "last", subject: "Last message" })] });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Page 0 message 0");

            io.trigger();

            expect(await screen.findByText("Last message")).toBeInTheDocument();
            expect(requests.filter((p) => p > 0)).toEqual([1, 2]);
        });

        it("doesn't continue after a short page that only repeated rows already shown", async () => {
            const io = mockIntersectionObserver();
            const first = fullPage(0);
            const requests = pagedFolder({ 0: first, 1: first.slice(0, 10) });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Page 0 message 0");

            io.trigger();

            await waitFor(() => expect(requests.filter((p) => p > 0)).toEqual([1]));
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(requests.filter((p) => p > 0)).toEqual([1]);
        });

        it("stops after a few full pages in a row that add nothing, offering a Load more button that resumes", { timeout: 30_000 }, async () => {
            const io = mockIntersectionObserver();
            const first = fullPage(0);
            const requests = pagedFolder({ 0: first, 1: first, 2: first, 3: first, 4: first, 5: fullPage(5) });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Page 0 message 0");

            io.trigger();

            const button = await screen.findByRole("button", { name: "Load more" }, { timeout: 5000 });
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(requests.filter((p) => p > 0)).toEqual([1, 2, 3, 4]);

            await user.click(button);

            expect(await screen.findByText("Page 5 message 0")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
        });

        it("issues one request for two sentinel reports in the same tick", async () => {
            const io = mockIntersectionObserver();
            const requests = pagedFolder({ 0: fullPage(0), 1: [messageFixture({ uid: "last", subject: "Last message" })] });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Page 0 message 0");

            io.trigger();
            io.trigger();

            expect(await screen.findByText("Last message")).toBeInTheDocument();
            expect(requests.filter((p) => p > 0)).toEqual([1]);
        });
    });

    describe("encrypted rows in the plain folder listing", () => {
        it("shows an unlock banner for an encrypted ('[...]') row, and decrypts it in place once unlocked", async () => {
            const encryptedMsg = messageFixture({ uid: "m-enc", subject: "[...]", bodyPreview: undefined });
            mockShellAndInbox([encryptedMsg]);
            getUnlockedKeys.mockReturnValue(undefined);
            unlockWithPassword.mockImplementation(async () => {
                getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
                return { unopenableKeys: [] };
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

        it("says 'Encrypted message' with a small lock on the preview line of an encrypted row nothing has been decrypted of, and leaves a plain row's alone", async () => {
            const encryptedMsg = messageFixture({ uid: "m-enc", subject: "[...]", bodyPreview: "", encrypted: true });
            const plainEmpty = messageFixture({ uid: "m-plain", subject: "Nothing in it", bodyPreview: "" });
            mockShellAndInbox([encryptedMsg, plainEmpty]);
            getUnlockedKeys.mockReturnValue(undefined);
            render(<InboxPage userUid="u1" />);

            // The subject line and the preview line both say it.
            const lines = await screen.findAllByText("Encrypted message");
            expect(lines).toHaveLength(2);
            const preview = lines.find((line) => line.querySelector("svg"))!;
            expect(preview.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
            expect(screen.getByText("Nothing in it").parentElement!.querySelector("svg")).toBeNull();
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

        it("never shows rows an in-flight auto-decrypt finishes after the keys were locked", async () => {
            const encryptedMsg = messageFixture({ uid: "m-enc", subject: "[...]", bodyPreview: undefined });
            mockShellAndInbox([encryptedMsg]);
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            let resolveDecrypt!: (value: unknown) => void;
            evaluateMessageSecurity.mockReturnValue(new Promise((resolve) => (resolveDecrypt = resolve)));
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Encrypted message");
            await waitFor(() => expect(evaluateMessageSecurity).toHaveBeenCalled());

            act(() => emitKeySession({ mailboxUid: "mb1", state: "locked" }));
            resolveDecrypt({ state: "encrypted_verified", subject: "Leaked subject", html: "<p>Leaked body</p>" });
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(screen.queryByText("Leaked subject")).not.toBeInTheDocument();
            expect(screen.getByText("Encrypted message")).toBeInTheDocument();
        });

        it("never shows rows an unlock-banner decrypt finishes after the keys were locked again", async () => {
            const encryptedMsg = messageFixture({ uid: "m-enc", subject: "[...]", bodyPreview: undefined });
            mockShellAndInbox([encryptedMsg]);
            getUnlockedKeys.mockReturnValue(undefined);
            unlockWithPassword.mockImplementation(async () => {
                getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
                return { unopenableKeys: [] };
            });
            let resolveDecrypt!: (value: unknown) => void;
            evaluateMessageSecurity.mockReturnValue(new Promise((resolve) => (resolveDecrypt = resolve)));
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByText("Unlock to show an encrypted message's subject"));
            await screen.findByText("Unlock your mailbox");
            await user.type(screen.getByLabelText("Encryption password"), "a good password");
            await user.click(screen.getByRole("button", { name: "Unlock" }));
            await waitFor(() => expect(evaluateMessageSecurity).toHaveBeenCalled());

            act(() => emitKeySession({ mailboxUid: "mb1", state: "locked" }));
            resolveDecrypt({ state: "encrypted_verified", subject: "Leaked subject", html: "<p>Leaked body</p>" });
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(screen.queryByText("Leaked subject")).not.toBeInTheDocument();
        });
    });

    // Every async load in InboxContent checks its own run id before touching state - these tests let each
    // one land only after a newer run (a query/view change, or unmount) has superseded it.
    describe("stale async results", () => {
        function deferred<T>() {
            let resolve!: (value: T) => void;
            const promise = new Promise<T>((res) => {
                resolve = res;
            });
            return { promise, resolve };
        }

        const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

        afterEach(() => {
            mockLocation();
        });

        function mockSearchShell(
            onSearch: (url: string) => Response | Promise<Response>,
            messages: Record<string, unknown>[] = [],
            onMessage?: (uid: string) => Response | Promise<Response> | undefined,
        ) {
            return mockFetch((url, init) => {
                if (url.startsWith("/api/mail/search")) return onSearch(url);
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages/")) {
                    const uid = url.split("/api/mail/messages/")[1].split("?")[0];
                    const custom = onMessage?.(uid);
                    if (custom) return custom;
                    const found = messages.find((m) => m.uid === uid);
                    return found ? jsonResponse(200, found) : jsonResponse(404, { message: "not found" });
                }
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, [messageFixture({ uid: "m-folder", subject: "Folder row" })]);
                if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
        }

        it.each([
            ["results", () => jsonResponse(200, { results: [{ entityType: "message", entityUid: "m2", score: 1 }] })],
            ["a failure", () => jsonResponse(500, { message: "late search failure" })],
        ])("drops Tier 1/2 %s that land after the search was cleared", async (_label, lateResponse) => {
            const searchResponse = deferred<Response>();
            const fetchMock = mockSearchShell(() => searchResponse.promise, [messageFixture({ uid: "m2", subject: "Late hit" })]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Folder row");
            const searchBox = screen.getByPlaceholderText("Search all mail…");

            await user.type(searchBox, "budget");
            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/mail/search"), expect.anything()));
            await user.clear(searchBox);
            await screen.findByText("Folder row");

            searchResponse.resolve(lateResponse());
            await settle();

            expect(screen.queryByText("Late hit")).not.toBeInTheDocument();
            expect(screen.queryByText("late search failure")).not.toBeInTheDocument();
            expect(screen.getByText("Folder row")).toBeInTheDocument();
        });

        it("drops resolved search rows that land after the search was cleared", async () => {
            const lateMessage = deferred<Response>();
            let messageRequested = false;
            mockSearchShell(
                () => jsonResponse(200, { results: [{ entityType: "message", entityUid: "m2", score: 1 }] }),
                [],
                (uid) => {
                    if (uid !== "m2") return undefined;
                    messageRequested = true;
                    return lateMessage.promise;
                },
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Folder row");
            const searchBox = screen.getByPlaceholderText("Search all mail…");

            await user.type(searchBox, "budget");
            await waitFor(() => expect(messageRequested).toBe(true));
            await screen.findByText("Search all mail");
            await user.clear(searchBox);
            // The folder row never left the screen (this pass is stuck resolving its hits), so wait for the
            // debounced query itself to clear instead.
            await waitFor(() => expect(screen.queryByText("Search all mail")).not.toBeInTheDocument());

            lateMessage.resolve(jsonResponse(200, messageFixture({ uid: "m2", subject: "Late hit" })));
            await settle();

            expect(screen.queryByText("Late hit")).not.toBeInTheDocument();
            expect(screen.getByText("Folder row")).toBeInTheDocument();
        });

        it("drops Tier 3 candidates that land after the search was cleared", async () => {
            const tier3 = deferred<unknown[]>();
            searchEncryptedCandidates.mockReturnValue(tier3.promise);
            mockSearchShell(() => jsonResponse(200, { results: [] }), [messageFixture({ uid: "m3", subject: "Late encrypted hit" })]);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Folder row");
            const searchBox = screen.getByPlaceholderText("Search all mail…");

            await user.type(searchBox, "budget");
            await waitFor(() => expect(searchEncryptedCandidates).toHaveBeenCalledTimes(1));
            await user.clear(searchBox);
            await screen.findByText("Folder row");

            tier3.resolve([{ entityType: "message", entityUid: "m3", score: 5, source: "candidate", metadataOnly: false }]);
            await settle();

            expect(screen.queryByText("Late encrypted hit")).not.toBeInTheDocument();
            expect(screen.getByText("Folder row")).toBeInTheDocument();
        });

        it("drops a search load-more page that lands after the search was cleared", async () => {
            const io = mockIntersectionObserver();
            const pageTwo = deferred<Response>();
            mockSearchShell(
                (url) =>
                    url.includes("cursor=c1")
                        ? pageTwo.promise
                        : jsonResponse(200, { results: [{ entityType: "message", entityUid: "m1", score: 1 }], nextCursor: "c1" }),
                [messageFixture({ uid: "m1", subject: "First hit" }), messageFixture({ uid: "m2", subject: "Second hit" })],
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Folder row");
            const searchBox = screen.getByPlaceholderText("Search all mail…");

            await user.type(searchBox, "hit");
            await screen.findByText("First hit");
            io.trigger();
            await screen.findByText("Loading more…");
            await user.clear(searchBox);
            await screen.findByText("Folder row");

            pageTwo.resolve(jsonResponse(200, { results: [{ entityType: "message", entityUid: "m2", score: 1 }] }));
            await settle();

            expect(screen.queryByText("Second hit")).not.toBeInTheDocument();
            expect(screen.getByText("Folder row")).toBeInTheDocument();
        });

        it("keeps slicing the Tier 3 pass the first page ran (here an empty, locked one) even if the unlock state changed since", async () => {
            const io = mockIntersectionObserver();
            getUnlockedKeys.mockReturnValue(undefined);
            mockSearchShell(
                (url) =>
                    url.includes("cursor=c1")
                        ? jsonResponse(200, { results: [{ entityType: "message", entityUid: "m2", score: 1 }] })
                        : jsonResponse(200, { results: [{ entityType: "message", entityUid: "m1", score: 1 }], nextCursor: "c1" }),
                [messageFixture({ uid: "m1", subject: "First hit" }), messageFixture({ uid: "m2", subject: "Second hit" })],
            );
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Folder row");

            await user.type(screen.getByPlaceholderText("Search all mail…"), "hit");
            await screen.findByText("First hit");
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            io.trigger();

            expect(await screen.findByText("Second hit")).toBeInTheDocument();
            expect(searchEncryptedCandidates).toHaveBeenCalledTimes(1);
        });

        it("drops a folder load-more failure that lands after a search replaced the list", async () => {
            const firstPage = Array.from({ length: 50 }, (_, i) => messageFixture({ uid: `m${i}`, subject: `Message ${i}` }));
            const io = mockIntersectionObserver();
            const pageOne = deferred<Response>();
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/search")) return jsonResponse(200, { results: [] });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/messages")) return url.includes("page=1") ? pageOne.promise : jsonResponse(200, firstPage);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Message 0");

            io.trigger();
            await screen.findByText("Loading more…");
            await user.type(screen.getByPlaceholderText("Search all mail…"), "nothing");
            await screen.findByText('No messages match "nothing".');

            pageOne.resolve(jsonResponse(500, { message: "late page failure" }));
            await settle();

            expect(screen.queryByText("late page failure")).not.toBeInTheDocument();
        });

        it("leaves the list unchanged when a load-more page only repeats rows already shown", async () => {
            const firstPage = Array.from({ length: 50 }, (_, i) => messageFixture({ uid: `m${i}`, subject: `Message ${i}` }));
            const io = mockIntersectionObserver();
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/messages")) {
                    return url.includes("page=1") ? jsonResponse(200, [firstPage[48], firstPage[49]]) : jsonResponse(200, firstPage);
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Message 0");

            io.trigger();

            await waitFor(() => expect(screen.queryByText("Loading more…")).not.toBeInTheDocument());
            expect(screen.getAllByText("Message 49")).toHaveLength(1);
            expect(screen.getAllByRole("listitem")).toHaveLength(50);
        });

        it("drops a folder listing failure that lands after a search replaced it", async () => {
            const listing = deferred<Response>();
            let listingRequested = false;
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/search")) return jsonResponse(200, { results: [] });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/messages")) {
                    listingRequested = true;
                    return listing.promise;
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByPlaceholderText("Search all mail…");
            await waitFor(() => expect(listingRequested).toBe(true));

            await user.type(screen.getByPlaceholderText("Search all mail…"), "nothing");
            await screen.findByText('No messages match "nothing".');

            listing.resolve(jsonResponse(500, { message: "late listing failure" }));
            await settle();

            expect(screen.queryByText("late listing failure")).not.toBeInTheDocument();
        });

        it("drops conversation results and failures that land after conversations are switched back off", async () => {
            const conversationRequests: ReturnType<typeof deferred<Response>>[] = [];
            mockShellAndInbox([messageFixture({ subject: "Folder message" })], (url) => {
                if (!url.startsWith("/api/mail/messages/conversations")) return undefined;
                const request = deferred<Response>();
                conversationRequests.push(request);
                return request.promise as unknown as Response;
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Folder message");

            await toggleConversations(user);
            await waitFor(() => expect(conversationRequests).toHaveLength(1));
            await toggleConversations(user);
            await screen.findByText("Folder message");
            await toggleConversations(user);
            await waitFor(() => expect(conversationRequests).toHaveLength(2));
            await toggleConversations(user);
            await screen.findByText("Folder message");

            conversationRequests[0].resolve(jsonResponse(500, { message: "late conversation failure" }));
            conversationRequests[1].resolve(jsonResponse(200, [conversationFixture({ subject: "Late conversation" })]));
            await settle();

            expect(screen.queryByText("late conversation failure")).not.toBeInTheDocument();
            expect(screen.queryByText("Late conversation")).not.toBeInTheDocument();
            expect(screen.getByText("Folder message")).toBeInTheDocument();
        });

        it("drops an aggregate listing that lands after conversations are switched on", async () => {
            const location = mockLocation();
            (location as any).search = "?aggregate=inbox";
            const folders = deferred<Response>();
            const listings: ReturnType<typeof deferred<Response>>[] = [];
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return folders.promise;
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages/conversations")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages")) {
                    const listing = deferred<Response>();
                    listings.push(listing);
                    return listing.promise;
                }
                if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByPlaceholderText("Search all mail…");

            // Folders still loading: an aggregate view is built from them, so nothing is listed yet either
            // way - see "what one view costs".
            await toggleConversations(user);
            expect(await screen.findByText(/^Loading/)).toBeInTheDocument();

            // Folders arrive; back in the flat list that starts a (slow) aggregate listing, which switching
            // conversations on again supersedes before it lands.
            folders.resolve(jsonResponse(200, [inboxFolder]));
            await settle();
            await toggleConversations(user);
            await waitFor(() => expect(listings).toHaveLength(1));
            await toggleConversations(user);
            await screen.findByText("No conversations in this folder.");

            listings[0].resolve(jsonResponse(200, [messageFixture({ subject: "Aggregate row" })]));
            await settle();
            await toggleConversations(user);

            expect(screen.queryByText("Aggregate row")).not.toBeInTheDocument();
        });

        it("merges an aggregate view across only shared mailboxes, skipping one with no matching folder", async () => {
            const location = mockLocation();
            (location as any).search = "?aggregate=inbox";
            const sharedA = { ...mailbox, uid: "mbA", ownerUserUid: undefined, displayName: "Shared A" };
            const sharedB = { ...mailbox, uid: "mbB", ownerUserUid: undefined, displayName: "Shared B" };
            const fetchMock = mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [sharedA, sharedB]);
                if (url.startsWith("/api/mail/folders")) {
                    return jsonResponse(
                        200,
                        url.includes("mailboxUid=mbB") ? [{ ...sentItemsFolder, mailboxUid: "mbB" }] : [{ ...inboxFolder, mailboxUid: "mbA" }],
                    );
                }
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, [messageFixture({ subject: "Shared A row", mailboxUid: "mbA" })]);
                if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            render(<InboxPage userUid="u1" />);

            expect(await screen.findByText("Shared A row")).toBeInTheDocument();
            const listings = fetchMock.mock.calls.filter(([url]: [string]) => url.startsWith("/api/mail/messages?"));
            expect(listings.every(([url]: [string]) => url.includes("folderUid=f1"))).toBe(true);
            // No owned mailbox - labels fall back to the first accessible mailbox.
            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/mail\/labels\?.*mailboxUid=mbA/), expect.anything()));
        });

        it("ignores a labels response that lands after the page unmounted", async () => {
            const labels = deferred<Response>();
            mockShellAndInbox([messageFixture({ subject: "Folder message" })], (url) =>
                url.startsWith("/api/mail/labels") ? (labels.promise as unknown as Response) : undefined,
            );
            const { unmount } = render(<InboxPage userUid="u1" />);
            await screen.findByText("Folder message");

            unmount();
            labels.resolve(jsonResponse(200, [{ uid: "l1", name: "Late label" }]));
            await settle();

            expect(screen.queryByText("Late label")).not.toBeInTheDocument();
        });
    });

    describe("round 3", () => {
        const sharedMailbox = { ...mailbox, uid: "mb2", ownerUserUid: "u2", displayName: "Support", primarySmtpAddress: "support@example.com" };
        const sharedInbox = { ...inboxFolder, uid: "f-shared-inbox", mailboxUid: "mb2" };
        const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

        afterEach(() => {
            keySessionListeners.clear();
            // Other tests in this file replace window.location wholesale (see mockLocation()), so a fresh
            // stub - not history.pushState - is what reliably resets the query string between tests.
            mockLocation();
        });

        it("scopes Tier 1 and Tier 3 search - first page and load-more - to the open (shared) mailbox", async () => {
            const location = mockLocation();
            (location as any).search = "?mailboxUid=mb2&folderUid=f-shared-inbox";
            const hits = [
                messageFixture({ uid: "s1", subject: "Shared hit one", mailboxUid: "mb2", folderUid: "f-shared-inbox" }),
                messageFixture({ uid: "s2", subject: "Shared hit two", mailboxUid: "mb2", folderUid: "f-shared-inbox" }),
            ];
            const io = mockIntersectionObserver();
            const fetchMock = mockFetch((url, init) => {
                if (url.startsWith("/api/mail/search")) {
                    if (url.includes("cursor=c1")) return jsonResponse(200, { results: [{ entityType: "message", entityUid: "s2", score: 1 }] });
                    return jsonResponse(200, { results: [{ entityType: "message", entityUid: "s1", score: 1 }], nextCursor: "c1" });
                }
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox, sharedMailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, url.includes("mailboxUid=mb2") ? [sharedInbox] : [inboxFolder]);
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages/")) {
                    const uid = url.split("/api/mail/messages/")[1].split("?")[0];
                    const found = hits.find((m) => m.uid === uid);
                    return found ? jsonResponse(200, found) : jsonResponse(404, { message: "not found" });
                }
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("No messages in this folder.");

            await user.type(screen.getByPlaceholderText("Search all mail…"), "hit");
            await screen.findByText("Shared hit one");
            io.trigger();
            expect(await screen.findByText("Shared hit two")).toBeInTheDocument();

            const searchCalls = fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("/api/mail/search"));
            expect(searchCalls.length).toBeGreaterThanOrEqual(2);
            expect(searchCalls.every((url) => url.includes("mailboxUid=mb2"))).toBe(true);
            expect(searchEncryptedCandidates).toHaveBeenCalledWith(expect.anything(), undefined, expect.any(Number), { mailboxUid: "mb2" });
        });

        it("clears decrypted list subjects/previews when the open mailbox's keys are locked, ignoring other session events", async () => {
            const encryptedMsg = messageFixture({ uid: "m-enc", subject: "[...]", bodyPreview: undefined });
            mockShellAndInbox([encryptedMsg]);
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted_verified", subject: "Secret subject", html: "<p>Secret body</p>" });
            render(<InboxPage userUid="u1" />);

            expect(await screen.findByText("Secret subject")).toBeInTheDocument();

            act(() => {
                emitKeySession({ mailboxUid: "mb1", state: "unlocked" });
                emitKeySession({ mailboxUid: "some-other-mailbox", state: "locked" });
            });
            expect(screen.getByText("Secret subject")).toBeInTheDocument();

            getUnlockedKeys.mockReturnValue(undefined);
            act(() => emitKeySession({ mailboxUid: "mb1", state: "locked" }));

            expect(await screen.findByText("Encrypted message")).toBeInTheDocument();
            expect(screen.queryByText("Secret subject")).not.toBeInTheDocument();
            expect(screen.queryByText("Secret body")).not.toBeInTheDocument();
        });

        it("drops decrypted search snippets and re-runs the search without keys when the open mailbox's keys are locked", async () => {
            const hit = messageFixture({ uid: "m-local", subject: "Local hit" });
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            searchLocalIndex.mockImplementation(async (_mailboxUid: string, _parsed: unknown, unlocked: unknown) => ({
                results: unlocked ? [{ entityType: "message", entityUid: "m-local", score: 5, source: "local", metadataOnly: false, snippet: "decrypted secret snippet" }] : [],
            }));
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/search")) return jsonResponse(200, { results: [] });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url === "/api/mail/messages/m-local") return jsonResponse(200, hit);
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("No messages in this folder.");

            await user.type(screen.getByPlaceholderText("Search all mail…"), "secret");
            expect(await screen.findByText("decrypted secret snippet")).toBeInTheDocument();
            const searchesBefore = searchLocalIndex.mock.calls.length;

            getUnlockedKeys.mockReturnValue(undefined);
            act(() => emitKeySession({ mailboxUid: "mb1", state: "locked" }));

            await waitFor(() => expect(screen.queryByText("decrypted secret snippet")).not.toBeInTheDocument());
            await waitFor(() => expect(searchLocalIndex.mock.calls.length).toBeGreaterThan(searchesBefore));
            expect(await screen.findByText('No messages match "secret".')).toBeInTheDocument();
        });

        it("keeps loading pages while a server-side filter leaves the loaded page empty", async () => {
            const io = mockIntersectionObserver();
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages")) {
                    if (!url.includes("filter=other")) {
                        return jsonResponse(200, Array.from({ length: 50 }, (_, i) => messageFixture({ uid: `m${i}`, subject: `Focused ${i}` })));
                    }
                    // The Other half is empty on the first page and has one message on the second, so the
                    // list keeps paging with nothing on screen to push the sentinel out of view.
                    if (url.includes("page=1")) {
                        return jsonResponse(200, [messageFixture({ uid: "m-other", subject: "Other on page two", inferenceClassification: "other" })]);
                    }
                    return jsonResponse(200, Array.from({ length: 50 }, (_, i) => messageFixture({ uid: `o${i}`, subject: `Other ${i}`, inferenceClassification: "other" })));
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Focused 0");

            await user.click(screen.getByRole("button", { name: "Other" }));
            await screen.findByText("Other 0");
            expect(screen.getByTestId("load-more-sentinel")).toBeInTheDocument();

            act(() => io.trigger());

            expect(await screen.findByText("Other on page two")).toBeInTheDocument();
        });

        it("keeps loading while the sentinel stays in view after a page lands, without a new intersection report", async () => {
            const page = (n: number, count: number) => Array.from({ length: count }, (_, i) => messageFixture({ uid: `p${n}-${i}`, subject: `Page ${n} row ${i}` }));
            const io = mockIntersectionObserver();
            const requestedPages: string[] = [];
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages")) {
                    const pageParam = new URL(url, "http://localhost").searchParams.get("page")!;
                    requestedPages.push(pageParam);
                    return jsonResponse(200, pageParam === "2" ? page(2, 1) : page(Number(pageParam), 50));
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Page 0 row 0");

            act(() => io.trigger());

            expect(await screen.findByText("Page 2 row 0")).toBeInTheDocument();
            expect(requestedPages).toEqual(["0", "1", "2"]);

            // Once the sentinel reports it's out of view, a finished page doesn't chain another load.
            act(() => io.trigger(false));
            await settle();
            expect(requestedPages).toEqual(["0", "1", "2"]);
        });

        it("re-requests the page a locally archived message shifted, instead of skipping the message that moved back", async () => {
            const serverFolder = Array.from({ length: 120 }, (_, i) => messageFixture({ uid: `m${i}`, subject: `Row ${i}` }));
            const io = mockIntersectionObserver();
            const requestedPages: string[] = [];
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages/")) return jsonResponse(200, serverFolder[0]);
                if (url.startsWith("/api/mail/messages")) {
                    const pageNumber = Number(new URL(url, "http://localhost").searchParams.get("page"));
                    requestedPages.push(String(pageNumber));
                    return jsonResponse(200, serverFolder.slice(pageNumber * 50, pageNumber * 50 + 50));
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);

            await user.click(await screen.findByText("Row 0"));
            await user.click(await screen.findByRole("button", { name: "simulate-archive" }));
            // The archive moved it out of the folder server-side too - everything after it shifts back one.
            serverFolder.splice(0, 1);
            expect(screen.queryByText("Row 0")).not.toBeInTheDocument();

            act(() => io.trigger(false));
            act(() => io.trigger());

            // Row 50 now sits at index 49 on the server - the first page again, not the second.
            expect(await screen.findByText("Row 50")).toBeInTheDocument();
            expect(requestedPages.slice(0, 2)).toEqual(["0", "0"]);
            expect(screen.getAllByText("Row 49")).toHaveLength(1);
        });

        it("uses the caller's own mailbox (not merely the first owned-by-someone one) for the aggregate conversation view", async () => {
            const location = mockLocation();
            (location as any).search = "?aggregate=inbox";
            const fetchMock = mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [sharedMailbox, mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, url.includes("mailboxUid=mb2") ? [sharedInbox] : [inboxFolder]);
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages/conversations")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages")) return jsonResponse(200, []);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByPlaceholderText("Search all mail…");

            await toggleConversations(user);

            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith(
                    "/api/mail/messages/conversations?mailboxUid=mb1&filter=all&page=0&limit=50",
                    expect.anything(),
                ),
            );
            expect(
                fetchMock.mock.calls.some(
                    ([url]) => String(url).startsWith("/api/mail/messages/conversations") && String(url).includes("mailboxUid=mb2"),
                ),
            ).toBe(false);
            mockLocation();
        });
    });

    describe("read state and the folder badge", () => {
        /** The Inbox link in the sidebar - its text carries the badge: "Inbox2 2 unread". */
        const inboxLink = () => screen.getAllByRole("link").find((el) => el.getAttribute("href")?.includes("folderUid=f1"))!;

        /** A server that counts unread messages the way the fixed restapi does: from the messages themselves. */
        function server(messages: any[], hold?: { gate?: Promise<void>; fail?: boolean }) {
            const puts: string[] = [];
            const fetchMock = mockShellAndInbox(messages, (url, init) => {
                if (url.startsWith("/api/mail/folders")) {
                    return jsonResponse(200, [{ ...inboxFolder, unreadCount: messages.filter((m) => !m.flags.read).length, totalCount: messages.length }]);
                }
                if (url.startsWith("/api/mail/messages/m") && init?.method === "PUT") {
                    puts.push(url);
                    return (async () => {
                        await hold?.gate;
                        if (hold?.fail) return jsonResponse(409, { message: "changed since read" });
                        const uid = url.split("/").pop()!;
                        const existing = messages.find((m) => m.uid === uid);
                        existing.flags = { ...existing.flags, ...JSON.parse(init.body as string).flags };
                        existing.version += 1;
                        return jsonResponse(200, existing);
                    })() as never;
                }
                return undefined;
            });
            return { fetchMock, puts };
        }

        const unreadMessages = () => [
            messageFixture({ uid: "m1", subject: "First" }),
            messageFixture({ uid: "m2", subject: "Second" }),
            messageFixture({ uid: "m3", subject: "Third", flags: { read: true, flagged: false, answered: false, forwarded: false } }),
        ];

        it("shows each row's state, and the Inbox its unread count, on load", async () => {
            server(unreadMessages());
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");

            expect(screen.getByText("First").closest("li")).toHaveAttribute("data-unread", "true");
            expect(screen.getByText("Third").closest("li")).not.toHaveAttribute("data-unread");
            expect(inboxLink().textContent).toBe("Inbox2 2 unread");
        });

        it("flips the row and the badge the moment a message is opened - before the server has answered", async () => {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            const { puts } = server(unreadMessages(), { gate });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await user.click(await screen.findByText("First"));

            // The request is out but unanswered: everything has already changed.
            await waitFor(() => expect(puts).toEqual(["/api/mail/messages/m1"]));
            expect(screen.getByText("First").closest("li")).not.toHaveAttribute("data-unread");
            expect(inboxLink().textContent).toBe("Inbox1 1 unread");
            expect(screen.getByText("Second").closest("li")).toHaveAttribute("data-unread", "true");

            release();
            await new Promise((resolve) => setTimeout(resolve, 1000));
            // The server agrees, so nothing moves back.
            expect(screen.getByText("First").closest("li")).not.toHaveAttribute("data-unread");
            expect(inboxLink().textContent).toBe("Inbox1 1 unread");
        });

        it("puts the row and the badge back when the server refuses, and doesn't keep asking", async () => {
            const { puts } = server(unreadMessages(), { fail: true });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await user.click(await screen.findByText("First"));

            await waitFor(() => expect(puts).toHaveLength(1));
            await waitFor(() => expect(screen.getByText("First").closest("li")).toHaveAttribute("data-unread", "true"));
            await waitFor(() => expect(inboxLink().textContent).toBe("Inbox2 2 unread"));
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(puts).toHaveLength(1);
        });

        it("marks a bulk selection unread the same way, changing rows and badge at once", async () => {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            const messages = unreadMessages();
            const fetchMock = mockShellAndInbox(messages, (url, init) => {
                if (url.startsWith("/api/mail/folders")) {
                    return jsonResponse(200, [{ ...inboxFolder, unreadCount: messages.filter((m) => !m.flags.read).length, totalCount: 3 }]);
                }
                if (url === "/api/mail/messages" && init?.method === "PUT") {
                    return (async () => {
                        await gate;
                        const updates = JSON.parse(init.body as string) as { uid: string; flags: any }[];
                        return jsonResponse(
                            200,
                            updates.map((update) => {
                                const existing = messages.find((m) => m.uid === update.uid);
                                existing.flags = update.flags;
                                existing.version += 1;
                                return existing;
                            }),
                        );
                    })() as never;
                }
                return undefined;
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            await user.click(screen.getByRole("button", { name: "Select" }));
            await user.click(screen.getByRole("button", { name: "Select all" }));
            await user.click(screen.getByRole("button", { name: "Mark unread" }));

            // Only "Third" was read, so it is the only row that changes - and the badge goes 2 -> 3.
            await waitFor(() => expect(screen.getByText("Third").closest("li")).toHaveAttribute("data-unread", "true"));
            expect(inboxLink().textContent).toBe("Inbox3 3 unread");
            release();
            await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/mail/messages" && (init as RequestInit)?.method === "PUT")).toBe(true));
            await new Promise((resolve) => setTimeout(resolve, 1000));
            expect(inboxLink().textContent).toBe("Inbox3 3 unread");
        });
    });

    describe("live updates", () => {
        /** A stand-in for the push WebSocket, driven by hand. */
        class FakePushSocket {
            static instances: FakePushSocket[] = [];
            readyState = 1;
            onopen: unknown = null;
            onmessage: ((e: { data: unknown }) => void) | null = null;
            onclose: unknown = null;
            onerror: unknown = null;
            constructor(public url: string) {
                FakePushSocket.instances.push(this);
            }
            send() {
                // Nothing is ever delivered.
            }
            close() {
                // Nothing to close.
            }
            receive(frame: unknown) {
                this.onmessage?.({ data: JSON.stringify(frame) });
            }
        }

        /** Delivers a message event, as the server publishes it, for `folderUid`. */
        function pushMessage(folderUid: string | undefined, action = "create") {
            act(() => FakePushSocket.instances[0].receive({ type: "MessageMongo", action, data: { uid: "pushed", folderUid } }));
        }

        function listCalls(fetchMock: ReturnType<typeof mockFetch>, folderUid = "f1") {
            return fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/mail/messages?") && String(url).includes(`folderUid=${folderUid}`));
        }

        beforeEach(() => {
            // Earlier tests replace window.location without an origin; the push URL is built from it.
            Object.defineProperty(window, "location", { configurable: true, writable: true, value: new URL("http://localhost:3000/") });
            vi.stubGlobal("WebSocket", FakePushSocket);
        });

        afterEach(() => {
            FakePushSocket.instances = [];
            Object.defineProperty(window, "location", { configurable: true, writable: true, value: new URL("http://localhost:3000/") });
            mockLocation();
        });

        it("shows new mail in the open folder as it arrives, without a reload, keeping the selection and marking nothing read", async () => {
            const messages: any[] = [messageFixture({ uid: "m1", subject: "First" })];
            const fetchMock = mockShellAndInbox(messages);
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await user.click(await screen.findByText("First"));
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("message:m1");
            // Nothing about the arrival marks it read: no update is ever sent for the new message.
            const putsFor = (uid: string) =>
                fetchMock.mock.calls.filter(([url, init]) => (init as RequestInit | undefined)?.method === "PUT" && String(url).includes(uid)).length;

            messages.unshift(messageFixture({ uid: "m2", subject: "Just arrived", receivedDate: "2026-01-02T00:00:00.000Z" }));
            pushMessage("f1");

            expect(await screen.findByText("Just arrived", {}, { timeout: 3000 })).toBeInTheDocument();
            // Newest first, the reader's message still open, and the new one not touched.
            const rows = screen.getAllByRole("listitem").map((li) => li.textContent);
            expect(rows[0]).toContain("Just arrived");
            expect(rows[1]).toContain("First");
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("message:m1");
            expect(putsFor("m2")).toBe(0);
        });

        it("replaces the list with the fresh page when the folder fits on one, so what was deleted elsewhere goes too", async () => {
            const messages: any[] = [messageFixture({ uid: "m1", subject: "Stays" }), messageFixture({ uid: "m2", subject: "Deleted elsewhere" })];
            mockShellAndInbox(messages);
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Deleted elsewhere");

            messages.splice(1, 1);
            pushMessage("f1", "delete");

            await waitFor(() => expect(screen.queryByText("Deleted elsewhere")).not.toBeInTheDocument(), { timeout: 3000 });
            expect(screen.getByText("Stays")).toBeInTheDocument();
        });

        it("keeps the older rows already paged in, and pages on from where it was, when a full first page has new mail on top", async () => {
            const page = (from: number, count: number) =>
                Array.from({ length: count }, (_, i) =>
                    messageFixture({ uid: `m${from + i}`, subject: `Message ${from + i}`, receivedDate: new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - (from + i))).toISOString() }),
                );
            // 60 messages: the first page is 50 (a full page), 10 more behind it.
            const messages: any[] = page(0, 60);
            const fetchMock = mockShellAndInbox(messages, (url) => {
                if (url.startsWith("/api/mail/messages?")) {
                    const params = new URLSearchParams(url.split("?")[1]);
                    const pageNumber = Number(params.get("page") ?? 0);
                    return jsonResponse(200, messages.slice(pageNumber * 50, pageNumber * 50 + 50));
                }
                return undefined;
            });
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Message 0");
            await user.click(screen.getByText("Message 3"));

            // Two new messages arrive ahead of everything.
            messages.unshift(...[messageFixture({ uid: "n2", subject: "New two" }), messageFixture({ uid: "n1", subject: "New one" })]);
            pushMessage("f1");

            expect(await screen.findByText("New one", {}, { timeout: 3000 })).toBeInTheDocument();
            expect(screen.getByText("New two")).toBeInTheDocument();
            expect(screen.getByText("Message 49")).toBeInTheDocument();
            expect(screen.getByTestId("detail-pane")).toHaveTextContent("message:m3");
            expect(listCalls(fetchMock).length).toBeGreaterThanOrEqual(2);
        });

        it("ignores an event about a folder the list isn't showing, and refreshes for one with no folder at all", async () => {
            const messages: any[] = [messageFixture({ uid: "m1", subject: "First" })];
            const fetchMock = mockShellAndInbox(messages);
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            const before = listCalls(fetchMock).length;

            pushMessage("some-other-folder");
            await new Promise((resolve) => setTimeout(resolve, 700));
            expect(listCalls(fetchMock).length).toBe(before);

            messages.unshift(messageFixture({ uid: "m2", subject: "Folderless event" }));
            pushMessage(undefined);
            expect(await screen.findByText("Folderless event", {}, { timeout: 3000 })).toBeInTheDocument();
        });

        it("refreshes when the tab comes back to the front - the poll's and the refocus's shared path", async () => {
            const messages: any[] = [messageFixture({ uid: "m1", subject: "First" })];
            mockShellAndInbox(messages);
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");

            messages.unshift(messageFixture({ uid: "m2", subject: "While away" }));
            act(() => {
                document.dispatchEvent(new Event("visibilitychange"));
            });
            expect(await screen.findByText("While away", {}, { timeout: 3000 })).toBeInTheDocument();
        });

        it("keeps the list it has, quietly, when the refresh fails", async () => {
            const messages: any[] = [messageFixture({ uid: "m1", subject: "First" })];
            let fail = false;
            const fetchMock = mockShellAndInbox(messages, (url) => {
                if (fail && url.startsWith("/api/mail/messages?")) return jsonResponse(500, { message: "boom" });
                return undefined;
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            const before = listCalls(fetchMock).length;

            fail = true;
            pushMessage("f1");
            await waitFor(() => expect(listCalls(fetchMock).length).toBe(before + 1), { timeout: 3000 });
            expect(screen.getByText("First")).toBeInTheDocument();
            expect(screen.queryByText("boom")).not.toBeInTheDocument();
            expect(getNotificationsSnapshot().visible).toEqual([]);
        });

        it("does not refresh while a search is showing, or while the list is still loading its first page", async () => {
            const messages: any[] = [messageFixture({ uid: "m1", subject: "First" })];
            const fetchMock = mockShellAndInbox(messages, (url) => (url.startsWith("/api/mail/search") ? jsonResponse(200, { results: [] }) : undefined));
            const user = userEvent.setup();
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");

            await user.type(screen.getByPlaceholderText("Search all mail…"), "budget");
            await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/mail/search"))).toBe(true));
            const before = listCalls(fetchMock).length;
            pushMessage("f1");
            await new Promise((resolve) => setTimeout(resolve, 700));
            expect(listCalls(fetchMock).length).toBe(before);
        });

        it("keeps only the latest of two refreshes that overlap", async () => {
            const messages: any[] = [messageFixture({ uid: "m1", subject: "First" })];
            const resolvers: ((r: Response) => void)[] = [];
            let hold = false;
            mockShellAndInbox(messages, (url) => {
                if (hold && url.startsWith("/api/mail/messages?")) return new Promise<Response>((resolve) => resolvers.push(resolve)) as never;
                return undefined;
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("First");

            hold = true;
            pushMessage("f1");
            await waitFor(() => expect(resolvers).toHaveLength(1), { timeout: 3000 });
            pushMessage("f1");
            await waitFor(() => expect(resolvers).toHaveLength(2), { timeout: 3000 });

            // The newer one lands first with the newer list; the older, stale one must not put the old list back.
            await act(async () => {
                resolvers[1](jsonResponse(200, [messageFixture({ uid: "m2", subject: "Newest" }), messages[0]]));
            });
            await screen.findByText("Newest");
            await act(async () => {
                resolvers[0](jsonResponse(200, [messages[0]]));
            });
            expect(screen.getByText("Newest")).toBeInTheDocument();
        });

        it("keeps a row the reader just changed, rather than putting back the older copy a refresh fetched", async () => {
            const messages: any[] = [messageFixture({ uid: "m1", subject: "First", version: 3, flags: { read: true, flagged: false, answered: false, forwarded: false } })];
            let stale = false;
            mockShellAndInbox(messages, (url) => {
                if (stale && url.startsWith("/api/mail/messages?")) {
                    return jsonResponse(200, [{ ...messages[0], version: 2, flags: { read: false, flagged: false, answered: false, forwarded: false } }]);
                }
                return undefined;
            });
            const { container } = render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            const row = () => container.querySelector("ul > li")!;
            expect(row()).not.toHaveAttribute("data-unread");

            stale = true;
            pushMessage("f1");
            await new Promise((resolve) => setTimeout(resolve, 900));
            expect(row()).not.toHaveAttribute("data-unread");
        });

        it("takes the newer copy of a row that changed elsewhere, such as a message read on another device", async () => {
            const unread = { read: false, flagged: false, answered: false, forwarded: false };
            const messages: any[] = [messageFixture({ uid: "m1", subject: "First", version: 1, flags: unread })];
            mockShellAndInbox(messages);
            const { container } = render(<InboxPage userUid="u1" />);
            await screen.findByText("First");
            const row = () => container.querySelector("ul > li")!;
            expect(row()).toHaveAttribute("data-unread", "true");

            messages[0] = { ...messages[0], version: 2, flags: { ...unread, read: true } };
            pushMessage("f1");

            await waitFor(() => expect(row()).not.toHaveAttribute("data-unread"), { timeout: 3000 });
            expect(screen.getByText("First")).toBeInTheDocument();
        });

        it("refreshes a conversation list too, whichever folder the event is about, since a conversation can span folders", async () => {
            localStorage.setItem(
                "rapidmx:mail-list-preferences:mb1",
                JSON.stringify({ sortBy: "date", sortOrder: "desc", filter: "all", labelUids: [], showAsConversations: true }),
            );
            const conversations: any[] = [conversationFixture({ conversationId: "c1", subject: "Old thread" })];
            mockShellAndInbox([], undefined, conversations);
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Old thread");

            conversations.unshift(conversationFixture({ conversationId: "c2", subject: "Fresh thread", latestMessageUid: "m9" }));
            pushMessage("f2");

            expect(await screen.findByText("Fresh thread", {}, { timeout: 3000 })).toBeInTheDocument();
            expect(screen.getByText("Old thread")).toBeInTheDocument();
        });

        it("refreshes the merged All Mailboxes view when a folder it is made of gets mail", async () => {
            const sharedMailbox = { ...mailbox, uid: "mb2", ownerUserUid: undefined, displayName: "Support", primarySmtpAddress: "support@example.com" };
            const sharedInbox = { ...inboxFolder, uid: "f-shared-inbox", mailboxUid: "mb2" };
            const byFolder: Record<string, any[]> = { f1: [messageFixture({ uid: "m-own", subject: "Own" })], "f-shared-inbox": [] };
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox, sharedMailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, url.includes("mailboxUid=mb2") ? [sharedInbox] : [inboxFolder]);
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages?") || url === "/api/mail/messages") {
                    return jsonResponse(200, byFolder[new URLSearchParams(url.split("?")[1]).get("folderUid") ?? ""] ?? []);
                }
                if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            Object.defineProperty(window, "location", { configurable: true, writable: true, value: new URL("http://localhost:3000/?aggregate=inbox") });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Own");

            byFolder["f-shared-inbox"].push(messageFixture({ uid: "m-shared", subject: "Support request", folderUid: "f-shared-inbox", mailboxUid: "mb2", receivedDate: "2026-02-01T00:00:00.000Z" }));
            pushMessage("f-shared-inbox");
            expect(await screen.findByText("Support request", {}, { timeout: 3000 })).toBeInTheDocument();

            // An event for a folder that isn't part of the merged view is left alone.
            byFolder.f1.push(messageFixture({ uid: "m-ignored", subject: "Not refreshed" }));
            pushMessage("f-other");
            await new Promise((resolve) => setTimeout(resolve, 700));
            expect(screen.queryByText("Not refreshed")).not.toBeInTheDocument();
        });

        it("folds a full first page of conversations in above the older ones already shown", async () => {
            localStorage.setItem(
                "rapidmx:mail-list-preferences:mb1",
                JSON.stringify({ sortBy: "date", sortOrder: "desc", filter: "all", labelUids: [], showAsConversations: true }),
            );
            const conversations: any[] = Array.from({ length: 50 }, (_, i) =>
                conversationFixture({ conversationId: `c${i}`, subject: `Thread ${i}`, latestMessageUid: `m${i}` }),
            );
            mockShellAndInbox([], undefined, conversations);
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Thread 0");

            conversations.unshift(conversationFixture({ conversationId: "c-new", subject: "Thread new", latestMessageUid: "m-new" }));
            pushMessage("f1");

            expect(await screen.findByText("Thread new", {}, { timeout: 3000 })).toBeInTheDocument();
            expect(screen.getByText("Thread 49")).toBeInTheDocument();
        });

        it("keeps only the latest of two overlapping refreshes of a conversation list, and of the merged All Mailboxes view", async () => {
            // Conversations.
            localStorage.setItem(
                "rapidmx:mail-list-preferences:mb1",
                JSON.stringify({ sortBy: "date", sortOrder: "desc", filter: "all", labelUids: [], showAsConversations: true }),
            );
            const conversationResolvers: ((r: Response) => void)[] = [];
            let hold = false;
            mockShellAndInbox([], (url) =>
                hold && url.startsWith("/api/mail/messages/conversations") ? (new Promise<Response>((resolve) => conversationResolvers.push(resolve)) as never) : undefined,
            [conversationFixture({ conversationId: "c1", subject: "Old thread" })],
            );
            const first = render(<InboxPage userUid="u1" />);
            await screen.findByText("Old thread");

            hold = true;
            pushMessage("f1");
            await waitFor(() => expect(conversationResolvers).toHaveLength(1), { timeout: 3000 });
            pushMessage("f1");
            await waitFor(() => expect(conversationResolvers).toHaveLength(2), { timeout: 3000 });
            await act(async () => {
                conversationResolvers[1](jsonResponse(200, [conversationFixture({ conversationId: "c2", subject: "Newest thread" })]));
            });
            await screen.findByText("Newest thread");
            await act(async () => {
                conversationResolvers[0](jsonResponse(200, [conversationFixture({ conversationId: "c3", subject: "Stale thread" })]));
            });
            expect(screen.queryByText("Stale thread")).not.toBeInTheDocument();
            expect(screen.getByText("Newest thread")).toBeInTheDocument();
            first.unmount();

            // The merged view, as a flat list again.
            localStorage.setItem(
                "rapidmx:mail-list-preferences:mb1",
                JSON.stringify({ sortBy: "date", sortOrder: "desc", filter: "all", labelUids: [], showAsConversations: false }),
            );
            const sharedMailbox = { ...mailbox, uid: "mb2", ownerUserUid: undefined, displayName: "Support", primarySmtpAddress: "support@example.com" };
            const sharedInbox = { ...inboxFolder, uid: "f-shared-inbox", mailboxUid: "mb2" };
            const aggregateResolvers: ((r: Response) => void)[] = [];
            let holdAggregate = false;
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox, sharedMailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, url.includes("mailboxUid=mb2") ? [sharedInbox] : [inboxFolder]);
                if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
                if (url.startsWith("/api/mail/messages?") || url === "/api/mail/messages") {
                    if (holdAggregate && url.includes("folderUid=f1")) return new Promise<Response>((resolve) => aggregateResolvers.push(resolve));
                    return jsonResponse(200, url.includes("folderUid=f1") ? [messageFixture({ uid: "m-own", subject: "Own" })] : []);
                }
                if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            Object.defineProperty(window, "location", { configurable: true, writable: true, value: new URL("http://localhost:3000/?aggregate=inbox") });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Own");

            holdAggregate = true;
            pushMessage("f1");
            await waitFor(() => expect(aggregateResolvers).toHaveLength(1), { timeout: 3000 });
            pushMessage("f1");
            await waitFor(() => expect(aggregateResolvers).toHaveLength(2), { timeout: 3000 });
            await act(async () => {
                aggregateResolvers[1](jsonResponse(200, [messageFixture({ uid: "m-new", subject: "Newest own" })]));
            });
            await screen.findByText("Newest own");
            await act(async () => {
                aggregateResolvers[0](jsonResponse(200, [messageFixture({ uid: "m-stale", subject: "Stale own" })]));
            });
            expect(screen.queryByText("Stale own")).not.toBeInTheDocument();
        });

        it("stands aside while the first page is still loading, and while the shell has no folder to list yet", async () => {
            let resolveList: ((r: Response) => void) | undefined;
            const fetchMock = mockShellAndInbox([messageFixture({ uid: "m1", subject: "First" })], (url) =>
                url.startsWith("/api/mail/messages?") ? (new Promise<Response>((resolve) => (resolveList = resolve)) as never) : undefined,
            );
            const { unmount } = render(<InboxPage userUid="u1" />);
            await waitFor(() => expect(resolveList).toBeDefined());
            act(() => {
                document.dispatchEvent(new Event("visibilitychange"));
            });
            await new Promise((resolve) => setTimeout(resolve, 700));
            // Still just the one (held) listing - the refresh didn't start a second.
            expect(listCalls(fetchMock)).toHaveLength(1);
            unmount();

            // The same with folders that never arrive: nothing is listed, so nothing is refreshed.
            const fetchMock2 = mockShellAndInbox([messageFixture()], (url) =>
                url.startsWith("/api/mail/folders") ? (new Promise<Response>(() => undefined) as never) : undefined,
            );
            render(<InboxPage userUid="u1" />);
            await waitFor(() => expect(fetchMock2.mock.calls.some(([url]) => String(url).startsWith("/api/mail/folders"))).toBe(true));
            act(() => {
                document.dispatchEvent(new Event("visibilitychange"));
            });
            await new Promise((resolve) => setTimeout(resolve, 700));
            expect(listCalls(fetchMock2)).toHaveLength(0);
        });

        it("stands aside while a load-more is in flight, so the page it is fetching isn't fought over", async () => {
            const firstPage = Array.from({ length: 50 }, (_, i) => messageFixture({ uid: `m${i}`, subject: `Message ${i}` }));
            const io = mockIntersectionObserver();
            let resolvePageOne: ((value: Response) => void) | undefined;
            const fetchMock = mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url.startsWith("/api/mail/messages")) {
                    if (url.includes("page=1")) return new Promise((resolve) => (resolvePageOne = resolve));
                    return jsonResponse(200, firstPage);
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            render(<InboxPage userUid="u1" />);
            await screen.findByText("Message 0");
            io.trigger();
            await screen.findByText("Loading more…");
            const before = listCalls(fetchMock).length;

            act(() => {
                document.dispatchEvent(new Event("visibilitychange"));
            });
            await new Promise((resolve) => setTimeout(resolve, 700));
            expect(listCalls(fetchMock).length).toBe(before);

            resolvePageOne!(jsonResponse(200, [messageFixture({ uid: "m99", subject: "Message 99" })]));
            expect(await screen.findByText("Message 99")).toBeInTheDocument();
        });
    });
});
