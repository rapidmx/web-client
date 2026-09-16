// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import MessageDetailPage from "../../../apps/www/messages/[uid].js";

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
        expect(screen.getByText("Loading…")).toBeInTheDocument();

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
        await screen.findByRole("heading", { name: "Hello there" });

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
        expect(screen.getByRole("link", { name: /Back to messages/ })).toHaveAttribute(
            "href",
            "/?mailboxUid=mb1&folderUid=f1",
        );
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

            await screen.findByRole("heading", { name: "Hello there" });
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

            await screen.findByRole("heading", { name: "Hello there" });
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

    describe("classify", () => {
        it("does not show the classify control for a message outside the Inbox", async () => {
            mockFetch((url) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [sentItemsFolder]);
                if (url === "/api/mail/messages/m1") return jsonResponse(200, { ...message, folderUid: "f2" });
                throw new Error(`unexpected ${url}`);
            });
            render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);

            await screen.findByRole("heading", { name: "Hello there" });
            expect(screen.queryByRole("button", { name: /Move to/ })).not.toBeInTheDocument();
        });

        it("classifies the message in the Inbox and updates the page's own state", async () => {
            mockShell((url, init) => {
                if (url === "/api/mail/messages/m1" && (init?.method ?? "GET") === "GET") {
                    return jsonResponse(200, { ...message, flags: { ...message.flags, read: true } });
                }
                if (url === "/api/mail/messages/m1/classify" && init?.method === "POST") {
                    return jsonResponse(200, { ...message, flags: { ...message.flags, read: true }, inferenceClassification: "other" });
                }
                return undefined;
            });
            const user = userEvent.setup();
            render(<MessageDetailPage userUid="u1" params={{ uid: "m1" }} />);

            await user.click(await screen.findByRole("button", { name: "Move to Other" }));
            // The move is confirmed first - see `MessageDetailPane`'s own tests for the prompt itself.
            await user.click(await screen.findByRole("button", { name: "Move" }));
            expect(await screen.findByRole("button", { name: "Move to Focused" })).toBeInTheDocument();
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
