// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ConversationList from "../../../apps/shared/components/mail/ConversationList.js";

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

describe("ConversationList", () => {
    it("shows an empty-state message when there are no conversations", () => {
        render(<ConversationList conversations={[]} selectedId={null} onSelect={vi.fn()} />);
        expect(screen.getByText("No conversations in this mailbox.")).toBeInTheDocument();
    });

    it("renders a conversation's participants, subject, and date", () => {
        render(<ConversationList conversations={[conversationFixture()]} selectedId={null} onSelect={vi.fn()} />);
        expect(screen.getByText("Sender One")).toBeInTheDocument();
        expect(screen.getByText("Hello there")).toBeInTheDocument();
    });

    it("falls back to the raw address and '(no subject)'", () => {
        render(
            <ConversationList
                conversations={[
                    conversationFixture({ subject: "", participants: [{ address: "sender@example.com", type: "to" }] }),
                ]}
                selectedId={null}
                onSelect={vi.fn()}
            />,
        );
        expect(screen.getByText("sender@example.com")).toBeInTheDocument();
        expect(screen.getByText("(no subject)")).toBeInTheDocument();
    });

    it("shows the message count only when there is more than one message", () => {
        const { rerender } = render(
            <ConversationList conversations={[conversationFixture({ messageCount: 1 })]} selectedId={null} onSelect={vi.fn()} />,
        );
        expect(screen.queryByText(/messages$/)).not.toBeInTheDocument();

        rerender(<ConversationList conversations={[conversationFixture({ messageCount: 3 })]} selectedId={null} onSelect={vi.fn()} />);
        expect(screen.getByText("3 messages")).toBeInTheDocument();
    });

    it("shows the unread badge and bold styling only when unreadCount is greater than zero", () => {
        const { rerender, container } = render(
            <ConversationList conversations={[conversationFixture({ unreadCount: 0 })]} selectedId={null} onSelect={vi.fn()} />,
        );
        expect(screen.queryByText(/unread$/)).not.toBeInTheDocument();
        expect(container.querySelector("button")?.className).not.toContain("font-semibold");

        rerender(<ConversationList conversations={[conversationFixture({ unreadCount: 2 })]} selectedId={null} onSelect={vi.fn()} />);
        expect(screen.getByText("2 unread")).toBeInTheDocument();
        expect(container.querySelector("button")?.className).toContain("font-semibold");
    });

    it("shows an attachment indicator only when hasAttachments is true", () => {
        const { rerender } = render(
            <ConversationList conversations={[conversationFixture({ hasAttachments: false })]} selectedId={null} onSelect={vi.fn()} />,
        );
        expect(screen.queryByLabelText("Has attachments")).not.toBeInTheDocument();

        rerender(<ConversationList conversations={[conversationFixture({ hasAttachments: true })]} selectedId={null} onSelect={vi.fn()} />);
        expect(screen.getByLabelText("Has attachments")).toBeInTheDocument();
    });

    it("highlights the selected conversation and calls onSelect when clicked", async () => {
        const onSelect = vi.fn();
        const conversation = conversationFixture();
        const user = userEvent.setup();
        const { container, rerender } = render(
            <ConversationList conversations={[conversation]} selectedId={null} onSelect={onSelect} />,
        );
        expect(container.querySelector("button")?.className).not.toContain("bg-primary/10");

        await user.click(screen.getByText("Hello there"));
        expect(onSelect).toHaveBeenCalledWith(conversation);

        rerender(<ConversationList conversations={[conversation]} selectedId="c1" onSelect={onSelect} />);
        expect(container.querySelector("button")?.className).toContain("bg-primary/10");
    });
});
