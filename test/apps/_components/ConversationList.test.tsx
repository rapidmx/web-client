// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import ConversationList from "../../../apps/shared/components/mail/ConversationList.js";

function conversationFixture(overrides: Record<string, unknown> = {}) {
    return {
        conversationId: "c1",
        subject: "Hello there",
        messageUids: ["m1", "m2"],
        folderUids: ["f1"],
        messageCount: 2,
        unreadCount: 0,
        latestDate: "2026-01-01T00:00:00.000Z",
        participants: [{ address: "sender@example.com", displayName: "Sender One", type: "to" as const }],
        hasAttachments: false,
        flagged: false,
        latestMessageUid: "m2",
        latestFrom: { address: "sender@example.com", displayName: "Sender One", type: "to" as const },
        latestPreview: "The most recent reply",
        latestFolderUid: "f1",
        ...overrides,
    };
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
        recipients: [],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: "2026-01-01T00:00:00.000Z",
        bodyPreview: "The opening message",
        flags: { read: true, flagged: false, answered: false, forwarded: false },
        importance: "normal" as const,
        hasAttachments: false,
        ...overrides,
    };
}

/** Renders the list with a `listConversationMessages()` response for `c1`. */
function renderList(props: Partial<React.ComponentProps<typeof ConversationList>> = {}, children: unknown[] = []) {
    const fetchMock = mockFetch((url) => {
        if (url.startsWith("/api/mail/messages/conversations/")) return jsonResponse(200, children);
        throw new Error(`unexpected ${url}`);
    });
    const result = render(
        <ConversationList
            conversations={[conversationFixture()]}
            mailboxUid="mb1"
            selectedUid={null}
            onOpenMessage={vi.fn()}
            {...props}
        />,
    );
    return { ...result, fetchMock };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ConversationList", () => {
    it("shows an empty-state message when there are no conversations", () => {
        render(<ConversationList conversations={[]} mailboxUid="mb1" selectedUid={null} onOpenMessage={vi.fn()} />);
        expect(screen.getByText("No conversations in this folder.")).toBeInTheDocument();
    });

    it("renders a conversation's participants, subject, latest preview and count", () => {
        renderList();
        expect(screen.getByText("Sender One")).toBeInTheDocument();
        expect(screen.getByText("Hello there")).toBeInTheDocument();
        expect(screen.getByText("The most recent reply")).toBeInTheDocument();
        expect(screen.getByText("2 messages")).toBeInTheDocument();
    });

    it("falls back to the raw address and '(no subject)'", () => {
        renderList({
            conversations: [conversationFixture({ subject: "", participants: [{ address: "sender@example.com", type: "to" }] })],
        });
        expect(screen.getByText("sender@example.com")).toBeInTheDocument();
        expect(screen.getByText("(no subject)")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Expand conversation: (no subject)" })).toBeInTheDocument();
    });

    it("shows the first participant's name and address in full, and the rest as a count with everyone's address in its tooltip", () => {
        renderList({
            conversations: [
                conversationFixture({
                    participants: [
                        { address: "sender@example.com", displayName: "Sender One", type: "to" },
                        { address: "bob@example.com", displayName: "Doe, Bob", type: "to" },
                        { address: "carol@example.com", type: "to" },
                    ],
                }),
            ],
        });
        expect(screen.getByText("Sender One <sender@example.com>", { selector: ".sr-only" })).toBeInTheDocument();
        const more = screen.getByText("+2", { exact: false });
        expect(more).toHaveAttribute("title", 'Sender One <sender@example.com>, "Doe, Bob" <bob@example.com>, carol@example.com');
        expect(more).toHaveTextContent('more: Sender One <sender@example.com>, "Doe, Bob" <bob@example.com>, carol@example.com');
    });

    it("shows no count for a single participant, and the latest sender when the summary lists no participants", () => {
        const { rerender } = renderList();
        expect(screen.queryByText(/^\+\d/)).not.toBeInTheDocument();

        rerender(
            <ConversationList
                conversations={[
                    conversationFixture({
                        participants: [],
                        latestFrom: { address: "latest@example.com", displayName: "Latest Sender", type: "to" },
                    }),
                ] as never}
                mailboxUid="mb1"
                selectedUid={null}
                onOpenMessage={vi.fn()}
            />,
        );
        expect(screen.getByText("Latest Sender <latest@example.com>", { selector: ".sr-only" })).toBeInTheDocument();
    });

    it("shows the message count only when there is more than one message", () => {
        const { rerender } = renderList({ conversations: [conversationFixture({ messageCount: 1 })] });
        expect(screen.queryByText(/messages$/)).not.toBeInTheDocument();

        rerender(
            <ConversationList
                conversations={[conversationFixture({ messageCount: 3 })]}
                mailboxUid="mb1"
                selectedUid={null}
                onOpenMessage={vi.fn()}
            />,
        );
        expect(screen.getByText("3 messages")).toBeInTheDocument();
    });

    it("shows the unread badge and the unread styling only when unreadCount is greater than zero", () => {
        const { rerender, container } = renderList({ conversations: [conversationFixture({ unreadCount: 0 })] });
        expect(screen.queryByText(/unread$/)).not.toBeInTheDocument();
        expect(screen.getByText("Hello there").className).not.toContain("font-semibold");
        expect(screen.getByText("Hello there").className).toContain("font-normal");
        expect(container.querySelector("[data-unread]")).toBeNull();
        expect(container.querySelector("[data-unread-bar]")).toBeNull();
        expect(screen.queryByText("Unread.")).not.toBeInTheDocument();

        rerender(
            <ConversationList
                conversations={[conversationFixture({ unreadCount: 2 })]}
                mailboxUid="mb1"
                selectedUid={null}
                onOpenMessage={vi.fn()}
            />,
        );
        expect(screen.getByText("2 unread")).toBeInTheDocument();
        expect(screen.getByText("Hello there").className).toContain("font-semibold");
        // Not by colour alone: an accent bar and a tint, a bold sender, and "Unread" for assistive technology.
        const row = container.querySelector("[data-unread]")!;
        expect(row.className).toContain("bg-primary/[0.07]");
        expect(row.querySelector("[data-unread-bar]")).toHaveAttribute("aria-hidden", "true");
        expect(screen.getByText("Unread.")).toHaveClass("sr-only");
        expect(screen.getByText(/Sender One/, { selector: ".sr-only" }).parentElement?.className).toContain("font-bold");
    });

    it("leaves the unread count off a one-message conversation, whose bolding already says it", () => {
        renderList({ conversations: [conversationFixture({ messageCount: 1, messageUids: ["m1"], unreadCount: 1 })] });
        expect(screen.queryByText(/unread$/)).not.toBeInTheDocument();
        expect(screen.getByText("Hello there").className).toContain("font-semibold");
        expect(screen.getByText("Unread.")).toBeInTheDocument();
    });

    it("shows attachment and flag indicators only when the conversation has them", () => {
        const { rerender } = renderList();
        expect(screen.queryByLabelText("Has attachments")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Flagged")).not.toBeInTheDocument();

        rerender(
            <ConversationList
                conversations={[conversationFixture({ hasAttachments: true, flagged: true })]}
                mailboxUid="mb1"
                selectedUid={null}
                onOpenMessage={vi.fn()}
            />,
        );
        expect(screen.getByLabelText("Has attachments")).toBeInTheDocument();
        expect(screen.getByLabelText("Flagged")).toBeInTheDocument();
    });

    it("opens the conversation at its latest message when the parent row is clicked, and marks it selected", () => {
        const onOpenMessage = vi.fn();
        const { rerender } = renderList({ onOpenMessage });

        screen.getByText("Hello there").click();
        expect(onOpenMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "c1" }), "m2");

        rerender(
            <ConversationList
                conversations={[conversationFixture()]}
                mailboxUid="mb1"
                selectedUid="m2"
                onOpenMessage={onOpenMessage}
            />,
        );
        // The open row has a fill and an outline of its own, distinct from the unread tint and from hover.
        const row = screen.getByText("Hello there").closest("li")?.firstElementChild;
        expect(row?.className).toContain("bg-primary/20");
        expect(row?.className).toContain("ring-1");
    });

    it("expands into the conversation's own messages, fetched once, and collapses again", async () => {
        const user = userEvent.setup();
        const { fetchMock } = renderList({}, [
            messageFixture({ uid: "m1", bodyPreview: "The opening message" }),
            messageFixture({
                uid: "m2",
                bodyPreview: "The most recent reply",
                from: { address: "nameless@example.com", type: "to" },
                flags: { read: false, flagged: true, answered: false, forwarded: false },
                hasAttachments: true,
            }),
        ]);

        await user.click(screen.getByRole("button", { name: "Expand conversation: Hello there" }));

        expect(await screen.findByText("The opening message")).toBeInTheDocument();
        // A child with no display name falls back to its address.
        expect(screen.getByText("nameless@example.com")).toBeInTheDocument();
        expect(screen.getByLabelText("Has attachments")).toBeInTheDocument();
        expect(screen.getByLabelText("Flagged")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/conversations/c1?mailboxUid=mb1", expect.anything());

        await user.click(screen.getByRole("button", { name: "Collapse conversation: Hello there" }));
        await user.click(screen.getByRole("button", { name: "Expand conversation: Hello there" }));
        await screen.findByText("The opening message");
        expect(fetchMock.mock.calls.filter(([url]: [string]) => String(url).includes("/conversations/c1"))).toHaveLength(1);
    });

    it("shows a loading row while a conversation's messages are being fetched", async () => {
        let resolveChildren: ((value: Response) => void) | undefined;
        mockFetch(
            (url) =>
                new Promise<Response>((resolve) => {
                    expect(url).toContain("/conversations/c1");
                    resolveChildren = resolve;
                }),
        );
        const user = userEvent.setup();
        render(<ConversationList conversations={[conversationFixture()]} mailboxUid="mb1" selectedUid={null} onOpenMessage={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Expand conversation: Hello there" }));

        expect(await screen.findByText("Loading messages…")).toBeInTheDocument();
        resolveChildren!(jsonResponse(200, [messageFixture()]));
        expect(await screen.findByText("The opening message")).toBeInTheDocument();
    });

    it("opens the conversation at the child message that was clicked", async () => {
        const onOpenMessage = vi.fn();
        const child = messageFixture({ uid: "m1" });
        const user = userEvent.setup();
        renderList({ onOpenMessage }, [child]);

        await user.click(screen.getByRole("button", { name: "Expand conversation: Hello there" }));
        await user.click(await screen.findByText("The opening message"));

        expect(onOpenMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "c1" }), "m1");
    });

    it("prefers a newer copy of a child message handed down in messageOverrides", async () => {
        const user = userEvent.setup();
        const { rerender } = renderList({}, [messageFixture({ uid: "m1", flags: { read: false, flagged: false, answered: false, forwarded: false } })]);

        await user.click(screen.getByRole("button", { name: "Expand conversation: Hello there" }));
        const unreadRow = (await screen.findByText("The opening message")).closest("li")!;
        expect(unreadRow).toHaveAttribute("data-unread", "true");
        expect(unreadRow.querySelector("[data-unread-bar]")).not.toBeNull();
        expect(unreadRow.querySelector("button")!.textContent).toContain("Unread.");

        rerender(
            <ConversationList
                conversations={[conversationFixture()]}
                mailboxUid="mb1"
                selectedUid="m1"
                onOpenMessage={vi.fn()}
                messageOverrides={{ m1: messageFixture({ uid: "m1" }) }}
            />,
        );
        const row = screen.getByText("The opening message").closest("li")!;
        expect(row).not.toHaveAttribute("data-unread");
        expect(row.querySelector("[data-unread-bar]")).toBeNull();
        expect(row.querySelector("button")!.textContent).not.toContain("Unread.");
        expect(row.className).toContain("bg-primary/20");
    });

    it("shows the server's message when a conversation's messages can't be loaded, and retries on a later expand", async () => {
        let attempt = 0;
        const fetchMock = mockFetch(() => {
            attempt += 1;
            return attempt === 1 ? jsonResponse(500, { message: "thread boom" }) : jsonResponse(200, [messageFixture()]);
        });
        const user = userEvent.setup();
        render(<ConversationList conversations={[conversationFixture()]} mailboxUid="mb1" selectedUid={null} onOpenMessage={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Expand conversation: Hello there" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("thread boom");

        await user.click(screen.getByRole("button", { name: "Collapse conversation: Hello there" }));
        await user.click(screen.getByRole("button", { name: "Expand conversation: Hello there" }));

        expect(await screen.findByText("The opening message")).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("shows a generic message when loading a conversation's messages fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<ConversationList conversations={[conversationFixture()]} mailboxUid="mb1" selectedUid={null} onOpenMessage={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Expand conversation: Hello there" }));

        expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this conversation's messages.");
    });

    describe("select mode", () => {
        it("shows no checkbox until select mode is on", () => {
            renderList();
            expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
        });

        it("ticks a conversation through its own checkbox, named after the conversation", async () => {
            const onToggleSelected = vi.fn();
            const user = userEvent.setup();
            renderList({ selectMode: true, selectedConversationIds: new Set(), onToggleSelected });

            await user.click(screen.getByRole("checkbox", { name: "Select conversation: Hello there" }));

            expect(onToggleSelected).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "c1" }));
        });

        it("shows a ticked conversation as checked", () => {
            renderList({ selectMode: true, selectedConversationIds: new Set(["c1"]), onToggleSelected: vi.fn() });

            expect(screen.getByRole("checkbox", { name: "Select conversation: Hello there" })).toBeChecked();
        });

        it("names a conversation with no subject in the checkbox the same way the row does", () => {
            render(
                <ConversationList
                    conversations={[conversationFixture({ subject: "" })]}
                    mailboxUid="mb1"
                    selectedUid={null}
                    onOpenMessage={vi.fn()}
                    selectMode
                    selectedConversationIds={new Set()}
                />,
            );

            expect(screen.getByRole("checkbox", { name: "Select conversation: (no subject)" })).toBeInTheDocument();
        });

        it("tolerates a checkbox with no handler wired to it", async () => {
            const user = userEvent.setup();
            renderList({ selectMode: true });

            await user.click(screen.getByRole("checkbox", { name: "Select conversation: Hello there" }));

            expect(screen.getByRole("checkbox", { name: "Select conversation: Hello there" })).toBeInTheDocument();
        });
    });
});

describe("ConversationList row markers for the keyboard", () => {
    it("marks each parent row and each child row with its message uid, and the button that opens it", async () => {
        mockFetch((url) => (url.startsWith("/api/mail/messages/conversations/") ? jsonResponse(200, [messageFixture({ uid: "child-1" })]) : jsonResponse(404, {})));
        const user = userEvent.setup();
        render(
            <ConversationList
                conversations={[conversationFixture({ conversationId: "c1", latestMessageUid: "latest-1" })]}
                mailboxUid="mb1"
                selectedUid={null}
                onOpenMessage={vi.fn()}
            />,
        );

        const parent = document.querySelector('[data-message-uid="latest-1"]')!;
        expect(parent).toBeInTheDocument();
        expect(parent.querySelector("[data-row-open]")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /^Expand conversation/ }));
        await waitFor(() => expect(document.querySelector('[data-message-uid="child-1"]')).toBeInTheDocument());
        expect(document.querySelector('[data-message-uid="child-1"] [data-row-open]')).toBeInTheDocument();
    });
});
