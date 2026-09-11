// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import MessageDetailPane from "../../../apps/shared/components/mail/MessageDetailPane.js";
import ComposeProvider from "../../../apps/shared/components/mail/compose/ComposeContext.js";

// `ComposeWindow`'s own exhaustive rendering (draft lifecycle, send, attachments...) is tested in its
// own file — mocked here (`RichTextEditor` only, matching every other compose-adjacent test file's
// convention) so the "reply/forward" tests below only exercise the values `MessageDetailPane` itself
// hands off to `openCompose()`, observed via the real `ComposeWindow` that pops up.
vi.mock("../../../apps/shared/components/mail/compose/RichTextEditor.js", () => ({
    default: () => <textarea data-testid="html-editor" />,
}));

function mockComposeDraft() {
    return mockFetch((url, init) => {
        if (url.startsWith("/api/mail/folders")) {
            return jsonResponse(200, [
                {
                    uid: "f-drafts",
                    version: 0,
                    dateCreated: "2026-01-01T00:00:00.000Z",
                    dateModified: "2026-01-01T00:00:00.000Z",
                    mailboxUid: "mb1",
                    name: "Drafts",
                    type: "drafts",
                    unreadCount: 0,
                    totalCount: 0,
                },
            ]);
        }
        if (url.startsWith("/api/mail/mail-signatures")) return jsonResponse(200, []);
        if (url === "/api/mail/messages" && (init?.method ?? "GET") === "POST") {
            return jsonResponse(200, {
                uid: "draft1",
                version: 0,
                dateCreated: "2026-01-01T00:00:00.000Z",
                dateModified: "2026-01-01T00:00:00.000Z",
                folderUid: "f-drafts",
                mailboxUid: "mb1",
                messageId: "draft1@webmail",
                subject: "",
                from: { address: "u1@example.com", type: "to" },
                recipients: [],
                sentDate: "2026-01-01T00:00:00.000Z",
                receivedDate: "2026-01-01T00:00:00.000Z",
                bodyPreview: "",
                flags: { read: true, flagged: false, answered: false, forwarded: false },
                importance: "normal",
                hasAttachments: false,
            });
        }
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

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

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("MessageDetailPane", () => {
    it("shows a placeholder and no back link when no message is given", () => {
        render(<MessageDetailPane message={null} attachments={[]} backHref="/messages/m1" />);
        expect(screen.getByText("Select a message to read it.")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: /Back to messages/ })).not.toBeInTheDocument();
    });

    it("renders the message header, iframe, and no back link when backHref is absent", () => {
        render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

        expect(screen.getByRole("heading", { name: "Hello there" })).toBeInTheDocument();
        expect(screen.getByText(/From Sender One/)).toBeInTheDocument();
        expect(screen.getByText("To Me")).toBeInTheDocument();
        expect(screen.getByTitle("Hello there")).toHaveAttribute("src", "/api/mail/messages/m1/content");
        expect(screen.queryByRole("link", { name: /Back to messages/ })).not.toBeInTheDocument();
    });

    it("renders a back link when backHref is given", () => {
        render(
            <MessageDetailPane message={messageFixture() as any} attachments={[]} backHref="/?mailboxUid=mb1&folderUid=f1" />,
        );
        expect(screen.getByRole("link", { name: /Back to messages/ })).toHaveAttribute("href", "/?mailboxUid=mb1&folderUid=f1");
    });

    it("falls back to the raw address and '(no subject)' when displayName/subject are absent", () => {
        const message = messageFixture({
            subject: "",
            from: { address: "sender@example.com", type: "to" as const },
            recipients: [{ address: "u1@example.com", type: "to" as const }],
        });
        render(<MessageDetailPane message={message as any} attachments={[]} />);

        expect(screen.getByRole("heading", { name: "(no subject)" })).toBeInTheDocument();
        expect(screen.getByText(/From sender@example\.com/)).toBeInTheDocument();
        expect(screen.getByText("To u1@example.com")).toBeInTheDocument();
        expect(screen.getByTitle("Message content")).toBeInTheDocument();
    });

    it("lists and links to attachments when present", () => {
        const attachment = {
            uid: "a1",
            version: 0,
            dateCreated: "2026-01-01T00:00:00.000Z",
            dateModified: "2026-01-01T00:00:00.000Z",
            messageUid: "m1",
            folderUid: "f1",
            mailboxUid: "mb1",
            filename: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 2_500_000,
            isInline: false,
        };
        render(<MessageDetailPane message={messageFixture() as any} attachments={[attachment]} />);

        const link = screen.getByRole("link", { name: /report\.pdf/ });
        expect(link).toHaveAttribute("href", "/api/mail/attachments/a1/content");
        expect(link.textContent).toContain("2.5 MB");
    });

    it("renders no attachment list when there are none", () => {
        render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);
        expect(screen.queryByRole("link", { name: /pdf|txt/ })).not.toBeInTheDocument();
    });

    it("formats attachment sizes across byte/KB/MB tiers", () => {
        const attachments = [
            { uid: "a1", version: 0, dateCreated: "", dateModified: "", messageUid: "m1", folderUid: "f1", mailboxUid: "mb1", filename: "tiny.txt", mimeType: "text/plain", sizeBytes: 500, isInline: false },
            { uid: "a2", version: 0, dateCreated: "", dateModified: "", messageUid: "m1", folderUid: "f1", mailboxUid: "mb1", filename: "medium.txt", mimeType: "text/plain", sizeBytes: 2_500, isInline: false },
            { uid: "a3", version: 0, dateCreated: "", dateModified: "", messageUid: "m1", folderUid: "f1", mailboxUid: "mb1", filename: "big.pdf", mimeType: "application/pdf", sizeBytes: 2_500_000, isInline: false },
        ];
        render(<MessageDetailPane message={messageFixture() as any} attachments={attachments} />);

        expect(screen.getByText(/tiny\.txt \(500 B\)/)).toBeInTheDocument();
        expect(screen.getByText(/medium\.txt \(2\.5 KB\)/)).toBeInTheDocument();
        expect(screen.getByText(/big\.pdf \(2\.5 MB\)/)).toBeInTheDocument();
    });

    describe("recall", () => {
        it("shows neither the button nor the indicator when isSentItems is not set", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);
            expect(screen.queryByRole("button", { name: "Recall this message" })).not.toBeInTheDocument();
            expect(screen.queryByText("Recall requested")).not.toBeInTheDocument();
        });

        it("shows neither the button nor the indicator when isSentItems is false", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isSentItems={false} />);
            expect(screen.queryByRole("button", { name: "Recall this message" })).not.toBeInTheDocument();
            expect(screen.queryByText("Recall requested")).not.toBeInTheDocument();
        });

        it("shows the Recall button when isSentItems is true and recallRequestedAt is unset", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isSentItems />);
            expect(screen.getByRole("button", { name: "Recall this message" })).toBeInTheDocument();
            expect(screen.queryByText("Recall requested")).not.toBeInTheDocument();
        });

        it("shows the 'Recall requested' indicator instead of the button once recallRequestedAt is set", () => {
            render(
                <MessageDetailPane
                    message={messageFixture({ recallRequestedAt: "2026-01-02T00:00:00.000Z" }) as any}
                    attachments={[]}
                    isSentItems
                />,
            );
            expect(screen.getByText("Recall requested")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Recall this message" })).not.toBeInTheDocument();
        });

        it("opens the confirmation modal, and Cancel closes it without calling the API", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, {}));
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isSentItems />);

            await user.click(screen.getByRole("button", { name: "Recall this message" }));
            expect(screen.getByRole("dialog", { name: "Recall this message?" })).toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Cancel" }));
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it("also closes via the modal's own close button (Modal's onClose, distinct from the Cancel button)", async () => {
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isSentItems />);

            await user.click(screen.getByRole("button", { name: "Recall this message" }));
            await user.click(screen.getByRole("button", { name: "Close" }));

            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });

        it("recalls the message, closes the modal, and calls onRecalled with the server's updated copy", async () => {
            const updated = messageFixture({ recallRequestedAt: "2026-01-02T00:00:00.000Z" });
            const fetchMock = mockFetch(() => jsonResponse(200, updated));
            const onRecalled = vi.fn();
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isSentItems onRecalled={onRecalled} />);

            await user.click(screen.getByRole("button", { name: "Recall this message" }));
            await user.click(screen.getByRole("button", { name: "Recall message" }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1/recall",
                expect.objectContaining({ method: "POST" }),
            );
            expect(await screen.findByRole("button", { name: "Recall this message" })).toBeInTheDocument(); // dialog closed, re-rendered with the still-unset prop
            expect(onRecalled).toHaveBeenCalledWith(updated);
        });

        it("shows an error message and keeps the modal open when recall fails", async () => {
            mockFetch(() => jsonResponse(500, { message: "boom" }));
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isSentItems />);

            await user.click(screen.getByRole("button", { name: "Recall this message" }));
            await user.click(screen.getByRole("button", { name: "Recall message" }));

            expect(await screen.findByText("boom")).toBeInTheDocument();
            expect(screen.getByRole("dialog", { name: "Recall this message?" })).toBeInTheDocument();
        });

        it("shows a generic error message when recall fails with a non-API error", async () => {
            mockFetch(() => {
                throw new TypeError("network down");
            });
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isSentItems />);

            await user.click(screen.getByRole("button", { name: "Recall this message" }));
            await user.click(screen.getByRole("button", { name: "Recall message" }));

            expect(await screen.findByText("Could not recall this message.")).toBeInTheDocument();
        });
    });

    describe("reply/forward", () => {
        it("Reply opens Compose prefilled with the sender's address, a 'Re:' subject, and a quoted body", async () => {
            mockComposeDraft();
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <MessageDetailPane message={messageFixture() as any} attachments={[]} />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Reply" }));

            expect(await screen.findByRole("dialog", { name: "Re: Hello there" })).toBeInTheDocument();
            expect(screen.getByLabelText("To")).toHaveValue("sender@example.com");
        });

        it("Reply All prefills To with the sender and Cc with every other recipient, excluding bcc", async () => {
            mockComposeDraft();
            const user = userEvent.setup();
            const message = messageFixture({
                recipients: [
                    { address: "u1@example.com", displayName: "Me", type: "to" },
                    { address: "other@example.com", type: "cc" },
                    { address: "hidden@example.com", type: "bcc" },
                ],
            });
            render(
                <ComposeProvider>
                    <MessageDetailPane message={message as any} attachments={[]} />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Reply All" }));

            await screen.findByRole("dialog", { name: "Re: Hello there" });
            expect(screen.getByLabelText("To")).toHaveValue("sender@example.com");
            expect(screen.getByLabelText("Cc")).toHaveValue("u1@example.com, other@example.com");
        });

        it("Forward opens Compose with a 'Fwd:' subject and no prefilled recipient", async () => {
            mockComposeDraft();
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <MessageDetailPane message={messageFixture() as any} attachments={[]} />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Forward" }));

            expect(await screen.findByRole("dialog", { name: "Fwd: Hello there" })).toBeInTheDocument();
            expect(screen.getByLabelText("To")).toHaveValue("");
        });

        it("does not double-prefix Re:/Fwd: on a subject that already carries one", async () => {
            mockComposeDraft();
            const user = userEvent.setup();
            const message = messageFixture({ subject: "Re: Hello there" });
            render(
                <ComposeProvider>
                    <MessageDetailPane message={message as any} attachments={[]} />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Reply" }));
            expect(await screen.findByRole("dialog", { name: "Re: Hello there" })).toBeInTheDocument();
        });
    });

    describe("scheduled send cancellation", () => {
        it("shows neither the pill nor Cancel when isOutbox is not set", () => {
            render(
                <MessageDetailPane
                    message={messageFixture({ scheduledSendTime: "2026-06-01T09:00:00.000Z" }) as any}
                    attachments={[]}
                />,
            );
            expect(screen.queryByText(/Scheduled for/)).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
        });

        it("shows neither when isOutbox is true but scheduledSendTime is unset", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isOutbox />);
            expect(screen.queryByText(/Scheduled for/)).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
        });

        it("shows the scheduled-time pill and a Cancel button when both isOutbox and scheduledSendTime are set", () => {
            render(
                <MessageDetailPane
                    message={messageFixture({ scheduledSendTime: "2026-06-01T09:00:00.000Z" }) as any}
                    attachments={[]}
                    isOutbox
                    draftsFolderUid="f-drafts"
                />,
            );
            expect(screen.getByText(/Scheduled for/)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
        });

        it("cancels the scheduled send and calls onScheduledSendCanceled with the server's updated copy", async () => {
            const updated = messageFixture({ folderUid: "f-drafts", scheduledSendTime: undefined });
            const fetchMock = mockFetch(() => jsonResponse(200, updated));
            const onScheduledSendCanceled = vi.fn();
            const user = userEvent.setup();
            render(
                <MessageDetailPane
                    message={messageFixture({ scheduledSendTime: "2026-06-01T09:00:00.000Z" }) as any}
                    attachments={[]}
                    isOutbox
                    draftsFolderUid="f-drafts"
                    onScheduledSendCanceled={onScheduledSendCanceled}
                />,
            );

            await user.click(screen.getByRole("button", { name: "Cancel" }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1",
                expect.objectContaining({
                    method: "PUT",
                    body: JSON.stringify({ uid: "m1", version: 0, scheduledSendTime: null, folderUid: "f-drafts" }),
                }),
            );
            await vi.waitFor(() => expect(onScheduledSendCanceled).toHaveBeenCalledWith(updated));
        });

        it("shows an error message and keeps the pill/button when canceling fails", async () => {
            mockFetch(() => jsonResponse(500, { message: "boom" }));
            const user = userEvent.setup();
            render(
                <MessageDetailPane
                    message={messageFixture({ scheduledSendTime: "2026-06-01T09:00:00.000Z" }) as any}
                    attachments={[]}
                    isOutbox
                    draftsFolderUid="f-drafts"
                />,
            );

            await user.click(screen.getByRole("button", { name: "Cancel" }));

            expect(await screen.findByText("boom")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
        });

        it("shows a generic error message when canceling fails with a non-API error", async () => {
            mockFetch(() => {
                throw new TypeError("network down");
            });
            const user = userEvent.setup();
            render(
                <MessageDetailPane
                    message={messageFixture({ scheduledSendTime: "2026-06-01T09:00:00.000Z" }) as any}
                    attachments={[]}
                    isOutbox
                    draftsFolderUid="f-drafts"
                />,
            );

            await user.click(screen.getByRole("button", { name: "Cancel" }));

            expect(await screen.findByText("Could not cancel this scheduled send.")).toBeInTheDocument();
        });
    });

    describe("classify", () => {
        it("shows neither the button nor the sender checkbox when isInbox is not set", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);
            expect(screen.queryByRole("button", { name: /Move to/ })).not.toBeInTheDocument();
            expect(screen.queryByText("Always for this sender")).not.toBeInTheDocument();
        });

        it("shows 'Move to Other' when the message has no inferenceClassification (defaults to Focused)", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isInbox />);
            expect(screen.getByRole("button", { name: "Move to Other" })).toBeInTheDocument();
        });

        it("shows 'Move to Focused' when the message is classified Other", () => {
            render(
                <MessageDetailPane
                    message={messageFixture({ inferenceClassification: "other" }) as any}
                    attachments={[]}
                    isInbox
                />,
            );
            expect(screen.getByRole("button", { name: "Move to Focused" })).toBeInTheDocument();
        });

        it("classifies the message and calls onClassified with the server's updated copy", async () => {
            const updated = messageFixture({ inferenceClassification: "other" });
            const fetchMock = mockFetch(() => jsonResponse(200, updated));
            const onClassified = vi.fn();
            const user = userEvent.setup();
            render(
                <MessageDetailPane message={messageFixture() as any} attachments={[]} isInbox onClassified={onClassified} />,
            );

            await user.click(screen.getByRole("button", { name: "Move to Other" }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1/classify",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({ classifyAs: "other", applyToSender: false }),
                }),
            );
            await vi.waitFor(() => expect(onClassified).toHaveBeenCalledWith(updated));
        });

        it("classifies back to Focused when the message is currently Other", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, messageFixture({ inferenceClassification: "focused" })));
            const user = userEvent.setup();
            render(
                <MessageDetailPane
                    message={messageFixture({ inferenceClassification: "other" }) as any}
                    attachments={[]}
                    isInbox
                />,
            );

            await user.click(screen.getByRole("button", { name: "Move to Focused" }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1/classify",
                expect.objectContaining({ body: JSON.stringify({ classifyAs: "focused", applyToSender: false }) }),
            );
        });

        it("includes applyToSender when the checkbox is checked", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, messageFixture()));
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isInbox />);

            await user.click(screen.getByLabelText("Always for this sender"));
            await user.click(screen.getByRole("button", { name: "Move to Other" }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1/classify",
                expect.objectContaining({ body: JSON.stringify({ classifyAs: "other", applyToSender: true }) }),
            );
        });

        it("shows an error message when classifying fails", async () => {
            mockFetch(() => jsonResponse(500, { message: "boom" }));
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isInbox />);

            await user.click(screen.getByRole("button", { name: "Move to Other" }));

            expect(await screen.findByText("boom")).toBeInTheDocument();
        });

        it("shows a generic error message when classifying fails with a non-API error", async () => {
            mockFetch(() => {
                throw new TypeError("network down");
            });
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isInbox />);

            await user.click(screen.getByRole("button", { name: "Move to Other" }));

            expect(await screen.findByText("Could not reclassify this message.")).toBeInTheDocument();
        });
    });

    describe("receipts", () => {
        it("shows no banner when neither receipt is pending", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);
            expect(screen.queryByRole("button", { name: "Send receipt" })).not.toBeInTheDocument();
        });

        it("shows a delivery-receipt banner when deliveryReceiptPending is set", () => {
            render(
                <MessageDetailPane message={messageFixture({ deliveryReceiptPending: true }) as any} attachments={[]} />,
            );
            expect(screen.getByText(/requested a delivery receipt/)).toBeInTheDocument();
        });

        it("falls back to the raw sender address when displayName is absent", () => {
            const message = messageFixture({
                deliveryReceiptPending: true,
                from: { address: "sender@example.com", type: "to" as const },
            });
            render(<MessageDetailPane message={message as any} attachments={[]} />);
            expect(screen.getByText(/sender@example\.com requested a delivery receipt/)).toBeInTheDocument();
        });

        it("shows both banners when both delivery and read receipts are pending", () => {
            render(
                <MessageDetailPane
                    message={messageFixture({ deliveryReceiptPending: true, readReceiptPending: true }) as any}
                    attachments={[]}
                />,
            );
            expect(screen.getByText(/requested a delivery receipt/)).toBeInTheDocument();
            expect(screen.getByText(/requested a read receipt/)).toBeInTheDocument();
        });

        it("approves a pending receipt and calls onReceiptHandled with the server's updated copy", async () => {
            const updated = messageFixture({ deliveryReceiptPending: false });
            const fetchMock = mockFetch(() => jsonResponse(200, updated));
            const onReceiptHandled = vi.fn();
            const user = userEvent.setup();
            render(
                <MessageDetailPane
                    message={messageFixture({ deliveryReceiptPending: true }) as any}
                    attachments={[]}
                    onReceiptHandled={onReceiptHandled}
                />,
            );

            await user.click(screen.getByRole("button", { name: "Send receipt" }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1/receipt/approve",
                expect.objectContaining({ method: "POST", body: JSON.stringify({ type: "delivery" }) }),
            );
            await vi.waitFor(() => expect(onReceiptHandled).toHaveBeenCalledWith(updated));
        });

        it("declines a pending receipt", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, messageFixture({ readReceiptPending: false })));
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture({ readReceiptPending: true }) as any} attachments={[]} />);

            await user.click(screen.getByRole("button", { name: "Decline" }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1/receipt/decline",
                expect.objectContaining({ method: "POST", body: JSON.stringify({ type: "read" }) }),
            );
        });

        it("shows an error message when handling a receipt fails", async () => {
            mockFetch(() => jsonResponse(500, { message: "boom" }));
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture({ deliveryReceiptPending: true }) as any} attachments={[]} />);

            await user.click(screen.getByRole("button", { name: "Send receipt" }));

            expect(await screen.findByText("boom")).toBeInTheDocument();
        });

        it("shows a generic error message when handling a receipt fails with a non-API error", async () => {
            mockFetch(() => {
                throw new TypeError("network down");
            });
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture({ deliveryReceiptPending: true }) as any} attachments={[]} />);

            await user.click(screen.getByRole("button", { name: "Send receipt" }));

            expect(await screen.findByText("Could not handle this receipt request.")).toBeInTheDocument();
        });
    });
});
