// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import MessageDetailPageRouted from "../../../apps/www/messages/[uid].js";

// Archiving and moving a message update the on-device search index through a worker, which jsdom doesn't have.
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../apps/shared/search/localIndexRpcClient.js")>()),
    moveLocalEntity: vi.fn(),
}));

// The page's own component: what a test renders is the page, not the client-side router around it (see `routedPage()`).
const MessageDetailPage = MessageDetailPageRouted.page;

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
    totalCount: 1,
};
const sentItemsFolder = { ...inboxFolder, uid: "f2", name: "Sent Items", type: "sent_items" as const };
const outboxFolder = { ...inboxFolder, uid: "f3", name: "Outbox", type: "outbox" as const };
const draftsFolder = { ...inboxFolder, uid: "f4", name: "Drafts", type: "drafts" as const };
const message = {
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
    bodyPreview: "Hi there.",
    flags: { read: false, flagged: false, answered: false, forwarded: false },
    importance: "normal" as const,
    hasAttachments: false,
};

function mockShell(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

// The reading pane and the thread pane are chunks of their own, imported when the first message is shown: the first render in a file to need
// them transforms them on demand, which takes seconds on a busy machine. They are brought in here, once, rather than inside whichever test
// happens to be first.
beforeAll(async () => {
    await import("../../../apps/shared/components/mail/MessageDetailPane.js");
    await import("../../../apps/shared/components/mail/ConversationThreadPane.js");
});

/**
 * Resolves once the reading pane itself is on screen. Not once the page shows the message's subject: while the pane's code is still being
 * imported (the first render in a file transforms it on demand, which takes seconds on a busy machine) `LazyReadingPane` already draws the
 * subject in a placeholder header, so a heading named after the subject says nothing about the controls the pane adds afterwards, and a
 * test that acts on - or asserts the absence of - one of them would race the import.
 */
const paneLoaded = () => screen.findByRole("link", { name: /Back to messages/ });

describe("MessageDetailPage", () => {
    it("shows a loading state before the message resolves", async () => {
        let resolveMessage: (() => void) | undefined;
        mockShell((url) => {
            if (url === "/api/mail/messages/m1") {
                return new Promise((resolve) => {
                    resolveMessage = () => resolve(jsonResponse(200, message));
                });
            }
            return undefined;
        });
        render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);

        await waitFor(() => expect(resolveMessage).toBeDefined());
        // The pane's frame - header card and message card placeholders - at once, not a line of text.
        expect(screen.getByRole("status")).toHaveTextContent("Loading the message");
        expect(document.querySelectorAll("[aria-hidden='true'].rounded-lg")).toHaveLength(2);

        resolveMessage!();
        await screen.findByRole("heading", { name: "Hello there" });
    });

    it("loads labels for the message's own mailbox, not the shell's default mailbox", async () => {
        const fetchMock = mockShell((url) => {
            if (url === "/api/mail/messages/m1") return jsonResponse(200, { ...message, mailboxUid: "mb-shared" });
            if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
            return undefined;
        });
        render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);

        await screen.findByRole("heading", { name: "Hello there" });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/mail\/labels\?.*mailboxUid=mb-shared/), expect.anything()));
        expect(fetchMock).not.toHaveBeenCalledWith(expect.stringMatching(/^\/api\/mail\/labels\?.*mailboxUid=mb1/), expect.anything());
    });

    it("adds a label created from the Labels menu to the ones it offers", async () => {
        const user = userEvent.setup();
        mockShell((url, init) => {
            if (url === "/api/mail/messages/m1") return jsonResponse(200, message);
            if (url.startsWith("/api/mail/labels") && (init?.method ?? "GET") === "GET") {
                return jsonResponse(200, [{ uid: "l1", version: 0, mailboxUid: "mb1", name: "Invoices" }]);
            }
            if (url === "/api/mail/labels" && init?.method === "POST") {
                return jsonResponse(200, { uid: "l2", version: 0, mailboxUid: "mb1", name: "Receipts" });
            }
            return undefined;
        });
        render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);
        await paneLoaded();

        await user.click(await screen.findByRole("button", { name: "Labels" }));
        await user.click(screen.getByRole("menuitem", { name: "New label…" }));
        const dialog = await screen.findByRole("dialog", { name: "New label" });
        await user.type(within(dialog).getByLabelText("Name"), "Receipts");
        await user.click(within(dialog).getByRole("button", { name: "Create" }));
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "New label" })).not.toBeInTheDocument());

        await user.click(screen.getByRole("button", { name: "Labels" }));
        expect(await screen.findByRole("menuitemcheckbox", { name: "Receipts" })).toBeInTheDocument();
    });

    it("ignores a labels response that lands after the page unmounted", async () => {
        let resolveLabels: ((value: Response) => void) | undefined;
        mockShell((url) => {
            if (url === "/api/mail/messages/m1") return jsonResponse(200, message);
            if (url.startsWith("/api/mail/labels")) {
                return new Promise<Response>((resolve) => {
                    resolveLabels = resolve;
                }) as unknown as Response;
            }
            return undefined;
        });
        const { unmount } = render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Hello there" });
        await waitFor(() => expect(resolveLabels).toBeDefined());

        unmount();
        resolveLabels!(jsonResponse(200, [{ uid: "l1", name: "Late label" }]));
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(screen.queryByText("Late label")).not.toBeInTheDocument();
    });

    it("renders the message with a back link to its mailbox/folder", async () => {
        mockShell((url) => (url === "/api/mail/messages/m1" ? jsonResponse(200, message) : undefined));
        render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);

        expect(await screen.findByRole("heading", { name: "Hello there" })).toBeInTheDocument();
        expect(await paneLoaded()).toHaveAttribute("href", "/?mailboxUid=mb1&folderUid=f1");
    });

    describe("opened from a conversation (?conversation=)", () => {
        const read = { read: true, flagged: false, answered: false, forwarded: false };
        const first = { ...message, flags: read };
        const reply = { ...message, uid: "m2", subject: "Re: Hello there", flags: read, bodyPreview: "Thanks for writing.", receivedDate: "2026-01-02T00:00:00.000Z" };
        const third = { ...message, uid: "m3", subject: "Re: Hello there", flags: read, bodyPreview: "One more thing.", receivedDate: "2026-01-03T00:00:00.000Z" };

        beforeEach(() => {
            window.history.pushState({}, "", "/messages/m2?conversation=c1");
        });
        afterEach(() => {
            window.history.pushState({}, "", "/");
        });

        it("shows the whole thread, not only the message that was opened, and a link back to the list", async () => {
            const fetchMock = mockShell((url) => {
                if (url === "/api/mail/messages/m2") return jsonResponse(200, reply);
                if (url.startsWith("/api/mail/messages/conversations/c1?")) return jsonResponse(200, [first, reply, third]);
                return undefined;
            });
            render(<MessageDetailPage userUid="u1" params={{ uid: "m2" }} />);

            // Every message of the thread is on the page: the opened one and the newer one expanded, the older one folded to a summary.
            expect(await screen.findByText("3 messages")).toBeInTheDocument();
            expect(screen.getAllByRole("heading", { name: /Hello there/ }).length).toBeGreaterThan(0);
            expect(screen.getByText("Hi there.")).toBeInTheDocument();
            expect(screen.getByRole("link", { name: /Back to messages/ })).toHaveAttribute("href", "/?mailboxUid=mb1&folderUid=f1");
            const threadUrl = fetchMock.mock.calls.map((c) => String(c[0])).find((url) => url.startsWith("/api/mail/messages/conversations/c1?"))!;
            expect(new URLSearchParams(threadUrl.split("?")[1]).get("mailboxUid")).toBe("mb1");
        });

        const label = { uid: "l1", version: 0, dateCreated: "2026-01-01T00:00:00.000Z", dateModified: "2026-01-01T00:00:00.000Z", mailboxUid: "mb1", name: "Invoices" };

        /** The thread's server: the opened message `opened`, an older `first`, the mailbox's labels, and whatever else a test handles. */
        function mockThread(opened: typeof reply, extra?: (url: string, init?: RequestInit) => Response | undefined) {
            return mockShell((url, init) => {
                const custom = extra?.(url, init);
                if (custom) return custom;
                if (url === "/api/mail/messages/m2" && (init?.method ?? "GET") === "GET") return jsonResponse(200, opened);
                if (url.startsWith("/api/mail/messages/conversations/c1?")) return jsonResponse(200, [first, opened]);
                if (url.startsWith("/api/mail/labels") && (init?.method ?? "GET") === "GET") return jsonResponse(200, [label]);
                return undefined;
            });
        }

        it("marks the opened message read in the thread, as it does on the single-message page", async () => {
            const unread = { ...reply, flags: { ...read, read: false } };
            const fetchMock = mockThread(unread, (url, init) =>
                url === "/api/mail/messages/m2" && init?.method === "PUT" ? jsonResponse(200, { ...unread, version: 1, flags: read }) : undefined,
            );
            render(<MessageDetailPage userUid="u1" params={{ uid: "m2" }} />);

            expect(await screen.findByText("2 messages")).toBeInTheDocument();
            await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m2", expect.objectContaining({ method: "PUT" })));
            const put = fetchMock.mock.calls.find(([url, init]: any) => url === "/api/mail/messages/m2" && init?.method === "PUT")!;
            expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual(expect.objectContaining({ flags: expect.objectContaining({ read: true }) }));
            await waitFor(() => expect(document.querySelector("[data-unread]")).toBeNull());
        });

        it("takes a message out of the thread once it is archived", async () => {
            mockThread(reply, (url, init) =>
                url === "/api/mail/messages/m2/archive" && init?.method === "POST" ? jsonResponse(200, { ...reply, folderUid: "f-archive", version: 1 }) : undefined,
            );
            const user = userEvent.setup();
            render(<MessageDetailPage userUid="u1" params={{ uid: "m2" }} />);
            expect(await screen.findByText("2 messages")).toBeInTheDocument();

            await user.click(await screen.findByRole("button", { name: "Archive" }));

            expect(await screen.findByText("1 message")).toBeInTheDocument();
            expect(screen.queryByText("Thanks for writing.")).not.toBeInTheDocument();
        });

        it("offers a label created from a message's Labels menu in that menu afterwards", async () => {
            const created = { ...label, uid: "l2", name: "Receipts" };
            const fetchMock = mockThread(reply, (url, init) => (url === "/api/mail/labels" && init?.method === "POST" ? jsonResponse(200, created) : undefined));
            const user = userEvent.setup();
            render(<MessageDetailPage userUid="u1" params={{ uid: "m2" }} />);
            await screen.findByText("2 messages");

            await user.click(await screen.findByRole("button", { name: "Labels" }));
            expect(screen.queryByRole("menuitemcheckbox", { name: "Receipts" })).not.toBeInTheDocument();
            await user.click(screen.getByRole("menuitem", { name: "New label…" }));
            const dialog = await screen.findByRole("dialog", { name: "New label" });
            await user.type(within(dialog).getByLabelText("Name"), "Receipts");
            await user.click(within(dialog).getByRole("button", { name: "Create" }));
            await waitFor(() => expect(screen.queryByRole("dialog", { name: "New label" })).not.toBeInTheDocument());

            expect(fetchMock).toHaveBeenCalledWith("/api/mail/labels", expect.objectContaining({ method: "POST" }));
            await user.click(screen.getByRole("button", { name: "Labels" }));
            expect(await screen.findByRole("menuitemcheckbox", { name: "Receipts" })).toBeInTheDocument();
            expect(screen.getByRole("menuitemcheckbox", { name: "Invoices" })).toBeInTheDocument();
        });

        it("offers a folder created while moving a message on the next move in the thread", async () => {
            const created = { ...inboxFolder, uid: "f7", name: "Trips", type: "user" as const };
            mockThread(reply, (url, init) => {
                if (url === "/api/mail/folders" && init?.method === "POST") return jsonResponse(200, created);
                if (url === "/api/mail/messages/m2" && init?.method === "PUT") return jsonResponse(200, { ...reply, folderUid: "f7", version: 1 });
                return undefined;
            });
            const user = userEvent.setup();
            render(<MessageDetailPage userUid="u1" params={{ uid: "m2" }} />);
            await screen.findByText("2 messages");

            await user.click(await screen.findByRole("button", { name: "Move to" }));
            await user.click(screen.getByRole("button", { name: /New folder/ }));
            await user.type(screen.getByLabelText("New folder name"), "Trips");
            await user.click(screen.getByRole("button", { name: "Create and move" }));

            // The moved message leaves the thread; the older one, opened again, can be moved into the folder that was just made.
            expect(await screen.findByText("1 message")).toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: /^Sender One/ }));
            await user.click(await screen.findByRole("button", { name: "Move to" }));
            expect(await screen.findByRole("button", { name: /^Trips/ })).toBeInTheDocument();
        });

        it("shows why the conversation could not be loaded", async () => {
            mockShell((url) => {
                if (url === "/api/mail/messages/m2") return jsonResponse(200, reply);
                if (url.startsWith("/api/mail/messages/conversations/c1?")) return jsonResponse(500, { message: "The thread is unavailable." });
                return undefined;
            });
            render(<MessageDetailPage userUid="u1" params={{ uid: "m2" }} />);
            expect(await screen.findByText("The thread is unavailable.")).toBeInTheDocument();
        });
    });

    it("marks the message read once loaded", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url === "/api/mail/messages/m1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, message);
            if (url === "/api/mail/messages/m1" && init?.method === "PUT") {
                return jsonResponse(200, { ...message, flags: { ...message.flags, read: true } });
            }
            return undefined;
        });
        render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);

        await screen.findByRole("heading", { name: "Hello there" });
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1", expect.objectContaining({ method: "PUT" })),
        );
    });

    it("shows an error message when the message fails to load", async () => {
        mockShell((url) => (url === "/api/mail/messages/m1" ? jsonResponse(404, { message: "not found" }) : undefined));
        render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);
        expect(await screen.findByText("not found")).toBeInTheDocument();
    });

    it("shows a generic error message when loading the message fails with a non-API error", async () => {
        mockShell((url) => {
            if (url === "/api/mail/messages/m1") throw new TypeError("network down");
            return undefined;
        });
        render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);
        expect(await screen.findByText("Could not load this message.")).toBeInTheDocument();
    });

    it("falls back to 'Message not found.' when the load succeeds with no message and no error", async () => {
        mockShell((url) => (url === "/api/mail/messages/m1" ? jsonResponse(200, null) : undefined));
        render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);
        expect(await screen.findByText("Message not found.")).toBeInTheDocument();
    });

    describe("recall", () => {
        it("does not show the Recall button for a message outside Sent Items", async () => {
            mockShell((url) => (url === "/api/mail/messages/m1" ? jsonResponse(200, message) : undefined));
            render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);

            await paneLoaded();
            expect(screen.queryByRole("button", { name: "Recall this message" })).not.toBeInTheDocument();
        });

        it("shows the Recall button for a message in Sent Items, and recalling it updates the page's own state", async () => {
            // Already read, so `useMarkMessageRead` is a no-op — isolates this test to the recall flow.
            const sentMessage = { ...message, folderUid: "f2", flags: { ...message.flags, read: true } };
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, sentItemsFolder]);
                if (url === "/api/mail/messages/m1/recall" && init?.method === "POST") {
                    return jsonResponse(200, { ...sentMessage, recallRequestedAt: "2026-01-02T00:00:00.000Z" });
                }
                if (url === "/api/mail/messages/m1") return jsonResponse(200, sentMessage);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);

            await user.click(await screen.findByRole("button", { name: "Recall this message" }));
            await user.click(screen.getByRole("button", { name: "Recall message" }));

            expect(await screen.findByText("Recall requested")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Recall this message" })).not.toBeInTheDocument();
        });
    });

    describe("scheduled send cancel", () => {
        it("does not show the Scheduled banner for a message outside Outbox", async () => {
            mockShell((url) => (url === "/api/mail/messages/m1" ? jsonResponse(200, message) : undefined));
            render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);

            await paneLoaded();
            expect(screen.queryByText(/Scheduled for/)).not.toBeInTheDocument();
        });

        it("shows the Scheduled banner for a message in Outbox, and canceling it updates the page's own state", async () => {
            // Already read, so `useMarkMessageRead` is a no-op — isolates this test to the cancel flow.
            const scheduledMessage = {
                ...message,
                folderUid: "f3",
                flags: { ...message.flags, read: true },
                scheduledSendTime: "2026-02-01T00:00:00.000Z",
            };
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, outboxFolder, draftsFolder]);
                if (url === "/api/mail/messages/m1" && (init?.method ?? "GET") === "GET") {
                    return jsonResponse(200, scheduledMessage);
                }
                if (url === "/api/mail/messages/m1" && init?.method === "PUT") {
                    const { scheduledSendTime, ...rest } = scheduledMessage;
                    return jsonResponse(200, { ...rest, folderUid: "f4" });
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);

            expect(await screen.findByText(/Scheduled for/)).toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: "Cancel" }));

            await waitFor(() => expect(screen.queryByText(/Scheduled for/)).not.toBeInTheDocument());
        });
    });

    describe("archive", () => {
        it("archives the message and reflects the server's updated folder in the page's own state", async () => {
            // Already read, so `useMarkMessageRead` is a no-op — isolates this test to the archive flow.
            const readMessage = { ...message, flags: { ...message.flags, read: true } };
            const archivedMessage = { ...readMessage, folderUid: "f-archive" };
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
                if (url === "/api/mail/messages/m1/archive" && init?.method === "POST") return jsonResponse(200, archivedMessage);
                if (url === "/api/mail/messages/m1") return jsonResponse(200, readMessage);
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);

            await user.click(await screen.findByRole("button", { name: "Archive" }));

            // The back link is derived from the message's own folderUid, so it moving to the Archive
            // folder is directly observable once the page's state is patched via onArchived.
            await waitFor(() =>
                expect(screen.getByRole("link", { name: /Back to messages/ })).toHaveAttribute(
                    "href",
                    "/?mailboxUid=mb1&folderUid=f-archive",
                ),
            );
        });
    });

    describe("Move to a folder", () => {
        it("offers this mailbox's own folders, and no Focused/Other control at all", async () => {
            mockShell((url, init) => {
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, sentItemsFolder]);
                if (url === "/api/mail/messages/m1" && (init?.method ?? "GET") === "GET") {
                    return jsonResponse(200, { ...message, flags: { ...message.flags, read: true } });
                }
                return undefined;
            });
            const user = userEvent.setup();
            render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);

            await user.click(await screen.findByRole("button", { name: "Move to" }));

            expect(await screen.findByRole("button", { name: /^Sent Items/ })).toBeEnabled();
            expect(screen.getByRole("button", { name: /^Inbox/ })).toBeDisabled();
            expect(screen.queryByRole("button", { name: "Move to Other" })).not.toBeInTheDocument();
        });

        it("moves the message and updates the page's own state", async () => {
            mockShell((url, init) => {
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, sentItemsFolder]);
                if (url === "/api/mail/messages/m1" && (init?.method ?? "GET") === "GET") {
                    return jsonResponse(200, { ...message, flags: { ...message.flags, read: true } });
                }
                if (url === "/api/mail/messages/m1" && init?.method === "PUT") {
                    return jsonResponse(200, { ...message, flags: { ...message.flags, read: true }, folderUid: "f2", version: 1 });
                }
                return undefined;
            });
            const user = userEvent.setup();
            render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);

            await user.click(await screen.findByRole("button", { name: "Move to" }));
            await user.click(await screen.findByRole("button", { name: /^Sent Items/ }));

            // It is in Sent Items now, so that is the entry the prompt marks as where it already is.
            await user.click(await screen.findByRole("button", { name: "Move to" }));
            expect(await screen.findByRole("button", { name: /^Sent Items/ })).toBeDisabled();
        });
    });

    describe("receipts", () => {
        it("approves a pending receipt and updates the page's own state", async () => {
            mockShell((url, init) => {
                if (url === "/api/mail/messages/m1" && (init?.method ?? "GET") === "GET") {
                    return jsonResponse(200, { ...message, flags: { ...message.flags, read: true }, deliveryReceiptPending: true });
                }
                if (url === "/api/mail/messages/m1/receipt/approve" && init?.method === "POST") {
                    return jsonResponse(200, { ...message, flags: { ...message.flags, read: true }, deliveryReceiptPending: false });
                }
                return undefined;
            });
            const user = userEvent.setup();
            render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);

            await user.click(await screen.findByRole("button", { name: "Send receipt" }));
            await waitFor(() => expect(screen.queryByRole("button", { name: "Send receipt" })).not.toBeInTheDocument());
        });
    });
});
