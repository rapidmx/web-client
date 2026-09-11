// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
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
