// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import ConversationThreadPane from "../../../apps/shared/components/mail/ConversationThreadPane.js";

// `MessageDetailPane`'s own exhaustive rendering is tested in its own file — mocked here so this file
// only exercises `ConversationThreadPane`'s own concerns: fetching every message, expand/collapse, and
// lazy per-message attachment-loading/mark-as-read.
vi.mock("../../../apps/shared/components/mail/MessageDetailPane.js", () => ({
    default: ({
        message,
        attachments,
        isSentItems,
        onRecalled,
        isOutbox,
        draftsFolderUid,
        onScheduledSendCanceled,
        isInbox,
        onClassified,
        onReceiptHandled,
    }: {
        message: { uid: string; recallRequestedAt?: string; scheduledSendTime?: string } | null;
        attachments: { filename: string }[];
        isSentItems?: boolean;
        onRecalled?: (updated: Record<string, unknown>) => void;
        isOutbox?: boolean;
        draftsFolderUid?: string;
        onScheduledSendCanceled?: (updated: Record<string, unknown>) => void;
        isInbox?: boolean;
        onClassified?: (updated: Record<string, unknown>) => void;
        onReceiptHandled?: (updated: Record<string, unknown>) => void;
    }) => (
        <div data-testid={`detail-${message?.uid}`}>
            {message ? `message:${message.uid}` : "no-message"} attachments:{attachments.map((a) => a.filename).join(",")}{" "}
            sentItems:{String(!!isSentItems)} recallRequestedAt:{message?.recallRequestedAt ?? "unset"} outbox:
            {String(!!isOutbox)} draftsFolderUid:{draftsFolderUid ?? "unset"} inbox:{String(!!isInbox)}
            {message && onRecalled && (
                <button type="button" onClick={() => onRecalled({ ...message, recallRequestedAt: "2026-01-02T00:00:00.000Z" })}>
                    simulate-recall-{message.uid}
                </button>
            )}
            {message && onScheduledSendCanceled && (
                <button
                    type="button"
                    onClick={() => onScheduledSendCanceled({ ...message, scheduledSendTime: undefined, folderUid: draftsFolderUid })}
                >
                    simulate-cancel-scheduled-send-{message.uid}
                </button>
            )}
            {message && onClassified && (
                <button type="button" onClick={() => onClassified({ ...message, inferenceClassification: "other" })}>
                    simulate-classify-{message.uid}
                </button>
            )}
            {message && onReceiptHandled && (
                <button type="button" onClick={() => onReceiptHandled({ ...message, deliveryReceiptPending: false })}>
                    simulate-receipt-handled-{message.uid}
                </button>
            )}
        </div>
    ),
}));

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
        messageUids: ["m1", "m2"],
        folderUids: ["f1"],
        messageCount: 2,
        unreadCount: 1,
        latestDate: "2026-01-02T00:00:00.000Z",
        participants: [{ address: "sender@example.com", displayName: "Sender One", type: "to" as const }],
        hasAttachments: false,
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ConversationThreadPane", () => {
    it("shows a placeholder when no conversation is given", () => {
        render(<ConversationThreadPane conversation={null} folders={[inboxFolder]} />);
        expect(screen.getByText("Select a conversation to read it.")).toBeInTheDocument();
    });

    it("shows a loading indicator while messages are being fetched", async () => {
        let resolveFirst: (() => void) | undefined;
        mockFetch((url) => {
            if (url === "/api/mail/messages/m1") {
                return new Promise((resolve) => {
                    resolveFirst = () => resolve(jsonResponse(200, messageFixture({ uid: "m1" })));
                });
            }
            return jsonResponse(200, messageFixture({ uid: "m2", flags: { read: true, flagged: false, answered: false, forwarded: false } }));
        });
        render(<ConversationThreadPane conversation={conversationFixture()} folders={[inboxFolder]} />);
        expect(await screen.findByText("Loading…")).toBeInTheDocument();
        resolveFirst!();
        expect(await screen.findByText("Hello there")).toBeInTheDocument();
    });

    it("shows an error message when a message fails to load", async () => {
        mockFetch(() => jsonResponse(500, { message: "boom" }));
        render(<ConversationThreadPane conversation={conversationFixture()} folders={[inboxFolder]} />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        render(<ConversationThreadPane conversation={conversationFixture()} folders={[inboxFolder]} />);
        expect(await screen.findByText("Could not load this conversation.")).toBeInTheDocument();
    });

    it("renders the header with the subject and message count, pluralized", async () => {
        mockFetch((url) => {
            const uid = url.split("/").pop();
            return jsonResponse(200, messageFixture({ uid, flags: { read: true, flagged: false, answered: false, forwarded: false } }));
        });
        const { rerender } = render(
            <ConversationThreadPane conversation={conversationFixture({ messageCount: 2 })} folders={[inboxFolder]} />,
        );
        expect(await screen.findByText("2 messages")).toBeInTheDocument();

        mockFetch((url) => {
            const uid = url.split("/").pop();
            return jsonResponse(200, messageFixture({ uid, flags: { read: true, flagged: false, answered: false, forwarded: false } }));
        });
        rerender(
            <ConversationThreadPane
                conversation={conversationFixture({ conversationId: "c2", messageUids: ["m1"], messageCount: 1 })}
                folders={[inboxFolder]}
            />,
        );
        expect(await screen.findByText("1 message")).toBeInTheDocument();
    });

    it("expands only the most recent message by default, showing earlier ones as collapsed summaries", async () => {
        mockFetch((url) => {
            const uid = url.split("/").pop();
            const overrides: Record<string, unknown> =
                uid === "m1"
                    ? { uid, subject: "First", flags: { read: true, flagged: false, answered: false, forwarded: false } }
                    : { uid, subject: "Second", flags: { read: false, flagged: false, answered: false, forwarded: false } };
            return jsonResponse(200, messageFixture(overrides));
        });
        render(<ConversationThreadPane conversation={conversationFixture()} folders={[inboxFolder]} />);

        expect(await screen.findByTestId("detail-m2")).toHaveTextContent("message:m2");
        expect(screen.queryByTestId("detail-m1")).not.toBeInTheDocument();
        expect(screen.getByText("Sender One")).toBeInTheDocument(); // the collapsed m1 row's sender
        expect(screen.getByText("Hi there, just checking in.")).toBeInTheDocument(); // m1's preview
    });

    it("expands a collapsed message on click, lazily loading its attachments and marking it read", async () => {
        let putBody: any;
        mockFetch((url, init) => {
            if (url === "/api/mail/messages/m1" && init?.method === "PUT") {
                putBody = JSON.parse(init.body as string);
                return jsonResponse(200, messageFixture({ uid: "m1", flags: { read: true, flagged: false, answered: false, forwarded: false } }));
            }
            if (url === "/api/mail/messages/m1") {
                return jsonResponse(
                    200,
                    messageFixture({ uid: "m1", flags: { read: false, flagged: false, answered: false, forwarded: false }, hasAttachments: true }),
                );
            }
            if (url === "/api/mail/messages/m2") {
                return jsonResponse(200, messageFixture({ uid: "m2", flags: { read: true, flagged: false, answered: false, forwarded: false } }));
            }
            if (url.startsWith("/api/mail/attachments")) {
                return jsonResponse(200, [{ uid: "a1", filename: "invoice.pdf" }]);
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<ConversationThreadPane conversation={conversationFixture()} folders={[inboxFolder]} />);

        await screen.findByTestId("detail-m2");
        await user.click(screen.getByText("Sender One"));

        expect(await screen.findByTestId("detail-m1")).toHaveTextContent("attachments:invoice.pdf");
        expect(putBody).toEqual(expect.objectContaining({ uid: "m1" }));
    });

    it("shows no attachments (rather than throwing) when loading an expanded message's attachments fails", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/attachments")) return jsonResponse(500, { message: "boom" });
            const uid = url.split("/").pop();
            return jsonResponse(200, messageFixture({ uid, flags: { read: true, flagged: false, answered: false, forwarded: false }, hasAttachments: true }));
        });
        render(<ConversationThreadPane conversation={conversationFixture()} folders={[inboxFolder]} />);

        expect(await screen.findByTestId("detail-m2")).toHaveTextContent("attachments:");
    });

    it("skips a collapsed message uid the API response didn't include, rather than rendering it", async () => {
        mockFetch((url) => {
            // m1 is requested but never actually returned — simulates a malformed/inconsistent response.
            if (url === "/api/mail/messages/m1") return jsonResponse(200, messageFixture({ uid: "m9" }));
            const uid = url.split("/").pop();
            return jsonResponse(200, messageFixture({ uid, flags: { read: true, flagged: false, answered: false, forwarded: false } }));
        });
        render(<ConversationThreadPane conversation={conversationFixture()} folders={[inboxFolder]} />);

        expect(await screen.findByTestId("detail-m2")).toBeInTheDocument();
        expect(screen.queryByTestId("detail-m1")).not.toBeInTheDocument();
        expect(screen.queryByText("Sender One")).not.toBeInTheDocument();
    });

    it("skips the default-expanded (latest) message uid in the attachment/read-marking pass when the API response didn't include it", async () => {
        const fetchMock = mockFetch((url) => {
            // m2 (the latest — auto-expanded by default) is requested but never actually returned.
            if (url === "/api/mail/messages/m2") return jsonResponse(200, messageFixture({ uid: "m9" }));
            const uid = url.split("/").pop();
            return jsonResponse(200, messageFixture({ uid, flags: { read: false, flagged: false, answered: false, forwarded: false }, hasAttachments: true }));
        });
        render(<ConversationThreadPane conversation={conversationFixture()} folders={[inboxFolder]} />);

        // Nothing renders for m2 at all (same render-side guard as the collapsed case above), and — the
        // behavior unique to this test — the attachment/read-marking effect never touches it either:
        // no PUT (mark-read) and no attachments fetch is ever issued for it.
        await screen.findByText("Sender One"); // m1's own collapsed row, unaffected
        expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "PUT")).toBe(false);
        expect(fetchMock.mock.calls.some((c) => (c[0] as string).startsWith("/api/mail/attachments"))).toBe(false);
    });

    it("falls back to '(no subject)' and the raw address when unset", async () => {
        mockFetch((url) => {
            const uid = url.split("/").pop();
            const overrides: Record<string, unknown> = { uid, flags: { read: true, flagged: false, answered: false, forwarded: false } };
            if (uid === "m1") {
                overrides.from = { address: "first@example.com", type: "to" };
            }
            return jsonResponse(200, messageFixture(overrides));
        });
        render(<ConversationThreadPane conversation={conversationFixture({ subject: "" })} folders={[inboxFolder]} />);

        expect(await screen.findByText("(no subject)")).toBeInTheDocument();
        expect(screen.getByText("first@example.com")).toBeInTheDocument();
    });

    it("collapses an expanded message back to its summary row on click", async () => {
        mockFetch((url) => {
            const uid = url.split("/").pop();
            return jsonResponse(200, messageFixture({ uid, flags: { read: true, flagged: false, answered: false, forwarded: false } }));
        });
        const user = userEvent.setup();
        render(<ConversationThreadPane conversation={conversationFixture()} folders={[inboxFolder]} />);

        await screen.findByTestId("detail-m2");
        await user.click(screen.getByRole("button", { name: "Collapse" }));

        expect(screen.queryByTestId("detail-m2")).not.toBeInTheDocument();
    });

    it("does not re-fetch attachments once already loaded for a message", async () => {
        const fetchMock = mockFetch((url) => {
            const uid = url.split("/").pop();
            if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, [{ uid: "a1", filename: "invoice.pdf" }]);
            const from =
                uid === "m1"
                    ? { address: "first@example.com", displayName: "First Sender", type: "to" as const }
                    : { address: "second@example.com", displayName: "Second Sender", type: "to" as const };
            return jsonResponse(200, messageFixture({ uid, from, flags: { read: true, flagged: false, answered: false, forwarded: false }, hasAttachments: true }));
        });
        const user = userEvent.setup();
        render(<ConversationThreadPane conversation={conversationFixture()} folders={[inboxFolder]} />);

        await screen.findByTestId("detail-m2");
        await user.click(screen.getByRole("button", { name: "Collapse" }));
        await user.click(screen.getByText("Second Sender"));
        await screen.findByTestId("detail-m2");

        expect(fetchMock.mock.calls.filter((c) => (c[0] as string).startsWith("/api/mail/attachments"))).toHaveLength(1);
    });

    it("swallows a failed mark-as-read update rather than blocking the expand", async () => {
        mockFetch((url, init) => {
            if (init?.method === "PUT") return jsonResponse(500, { message: "boom" });
            const uid = url.split("/").pop();
            const read = uid === "m2";
            return jsonResponse(200, messageFixture({ uid, flags: { read, flagged: false, answered: false, forwarded: false } }));
        });
        const user = userEvent.setup();
        render(<ConversationThreadPane conversation={conversationFixture()} folders={[inboxFolder]} />);

        await screen.findByTestId("detail-m2");
        await user.click(screen.getByText("Sender One"));

        expect(await screen.findByTestId("detail-m1")).toBeInTheDocument();
    });

    it("does not attempt to mark an already-read message as read", async () => {
        const fetchMock = mockFetch((url) => {
            const uid = url.split("/").pop();
            return jsonResponse(200, messageFixture({ uid, flags: { read: true, flagged: false, answered: false, forwarded: false } }));
        });
        const user = userEvent.setup();
        render(<ConversationThreadPane conversation={conversationFixture()} folders={[inboxFolder]} />);

        await screen.findByTestId("detail-m2");
        await user.click(screen.getByText("Sender One"));
        await screen.findByTestId("detail-m1");

        expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "PUT")).toBe(false);
    });

    it("resets to a fresh state when switching to a different conversation", async () => {
        mockFetch((url) => {
            const uid = url.split("/").pop();
            return jsonResponse(200, messageFixture({ uid, flags: { read: true, flagged: false, answered: false, forwarded: false } }));
        });
        const { rerender } = render(<ConversationThreadPane conversation={conversationFixture()} folders={[inboxFolder]} />);
        await screen.findByTestId("detail-m2");

        rerender(<ConversationThreadPane conversation={null} folders={[inboxFolder]} />);
        expect(screen.getByText("Select a conversation to read it.")).toBeInTheDocument();
    });

    describe("recall", () => {
        it("computes isSentItems per-message from the message's own folderUid, not a single conversation-wide value", async () => {
            mockFetch((url) => {
                const uid = url.split("/").pop();
                const overrides: Record<string, unknown> = { uid, flags: { read: true, flagged: false, answered: false, forwarded: false } };
                if (uid === "m1") {
                    overrides.folderUid = "f2"; // Sent Items
                }
                return jsonResponse(200, messageFixture(overrides));
            });
            const user = userEvent.setup();
            render(
                <ConversationThreadPane
                    conversation={conversationFixture({ folderUids: ["f1", "f2"] })}
                    folders={[inboxFolder, sentItemsFolder]}
                />,
            );

            expect(await screen.findByTestId("detail-m2")).toHaveTextContent("sentItems:false");
            await user.click(screen.getByText("Sender One")); // expand m1, the Sent Items copy
            expect(await screen.findByTestId("detail-m1")).toHaveTextContent("sentItems:true");
        });

        it("patches the recalled message into state via onRecalled without disturbing other messages", async () => {
            mockFetch((url) => {
                const uid = url.split("/").pop();
                return jsonResponse(200, messageFixture({ uid, flags: { read: true, flagged: false, answered: false, forwarded: false } }));
            });
            const user = userEvent.setup();
            render(<ConversationThreadPane conversation={conversationFixture()} folders={[inboxFolder]} />);

            await screen.findByTestId("detail-m2");
            await user.click(screen.getByText("Sender One")); // expand m1
            await screen.findByTestId("detail-m1");

            await user.click(screen.getByRole("button", { name: "simulate-recall-m1" }));

            expect(screen.getByTestId("detail-m1")).toHaveTextContent("recallRequestedAt:2026-01-02T00:00:00.000Z");
            // m2 stays mounted/unaffected by m1's patch.
            expect(screen.getByTestId("detail-m2")).toHaveTextContent("recallRequestedAt:unset");
        });
    });

    describe("scheduled send cancel", () => {
        it("computes isOutbox/draftsFolderUid per-message from the message's own folderUid, not a single conversation-wide value", async () => {
            mockFetch((url) => {
                const uid = url.split("/").pop();
                const overrides: Record<string, unknown> = { uid, flags: { read: true, flagged: false, answered: false, forwarded: false } };
                if (uid === "m1") {
                    overrides.folderUid = "f3"; // Outbox
                }
                return jsonResponse(200, messageFixture(overrides));
            });
            const user = userEvent.setup();
            render(
                <ConversationThreadPane
                    conversation={conversationFixture({ folderUids: ["f1", "f3"] })}
                    folders={[inboxFolder, outboxFolder, draftsFolder]}
                />,
            );

            expect(await screen.findByTestId("detail-m2")).toHaveTextContent("outbox:false");
            await user.click(screen.getByText("Sender One")); // expand m1, the Outbox copy
            expect(await screen.findByTestId("detail-m1")).toHaveTextContent("outbox:true draftsFolderUid:f4");
        });

        it("patches the canceled message into state via onScheduledSendCanceled without disturbing other messages", async () => {
            mockFetch((url) => {
                const uid = url.split("/").pop();
                return jsonResponse(200, messageFixture({ uid, flags: { read: true, flagged: false, answered: false, forwarded: false } }));
            });
            const user = userEvent.setup();
            render(<ConversationThreadPane conversation={conversationFixture()} folders={[inboxFolder, outboxFolder, draftsFolder]} />);

            await screen.findByTestId("detail-m2");
            await user.click(screen.getByText("Sender One")); // expand m1
            await screen.findByTestId("detail-m1");

            await user.click(screen.getByRole("button", { name: "simulate-cancel-scheduled-send-m1" }));

            // m2 stays mounted/unaffected by m1's patch.
            expect(screen.getByTestId("detail-m2")).toHaveTextContent("recallRequestedAt:unset");
            expect(await screen.findByTestId("detail-m1")).toBeInTheDocument();
        });
    });

    describe("classify/receipts", () => {
        it("computes isInbox per-message from the message's own folderUid", async () => {
            mockFetch((url) => {
                const uid = url.split("/").pop();
                const overrides: Record<string, unknown> = { uid, flags: { read: true, flagged: false, answered: false, forwarded: false } };
                if (uid === "m1") {
                    overrides.folderUid = "f2"; // Sent Items, not Inbox
                }
                return jsonResponse(200, messageFixture(overrides));
            });
            const user = userEvent.setup();
            render(
                <ConversationThreadPane
                    conversation={conversationFixture({ folderUids: ["f1", "f2"] })}
                    folders={[inboxFolder, sentItemsFolder]}
                />,
            );

            expect(await screen.findByTestId("detail-m2")).toHaveTextContent("inbox:true");
            await user.click(screen.getByText("Sender One")); // expand m1, the Sent Items copy
            expect(await screen.findByTestId("detail-m1")).toHaveTextContent("inbox:false");
        });

        it("patches a reclassified message into state via onClassified without disturbing other messages", async () => {
            mockFetch((url) => {
                const uid = url.split("/").pop();
                return jsonResponse(200, messageFixture({ uid, flags: { read: true, flagged: false, answered: false, forwarded: false } }));
            });
            const user = userEvent.setup();
            render(<ConversationThreadPane conversation={conversationFixture()} folders={[inboxFolder]} />);

            await screen.findByTestId("detail-m2");
            await user.click(screen.getByText("Sender One")); // expand m1
            await screen.findByTestId("detail-m1");

            await user.click(screen.getByRole("button", { name: "simulate-classify-m1" }));

            expect(screen.getByTestId("detail-m1")).toBeInTheDocument();
            expect(screen.getByTestId("detail-m2")).toHaveTextContent("recallRequestedAt:unset");
        });

        it("patches a handled receipt into state via onReceiptHandled without disturbing other messages", async () => {
            mockFetch((url) => {
                const uid = url.split("/").pop();
                return jsonResponse(200, messageFixture({ uid, flags: { read: true, flagged: false, answered: false, forwarded: false } }));
            });
            const user = userEvent.setup();
            render(<ConversationThreadPane conversation={conversationFixture()} folders={[inboxFolder]} />);

            await screen.findByTestId("detail-m2");
            await user.click(screen.getByText("Sender One")); // expand m1
            await screen.findByTestId("detail-m1");

            await user.click(screen.getByRole("button", { name: "simulate-receipt-handled-m1" }));

            expect(screen.getByTestId("detail-m1")).toBeInTheDocument();
            expect(screen.getByTestId("detail-m2")).toHaveTextContent("recallRequestedAt:unset");
        });
    });
});
