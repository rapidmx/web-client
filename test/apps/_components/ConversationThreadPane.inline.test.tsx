// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// A reply's compose window is a card at the top of the thread it answers (`useInlineCompose()` / `InlineComposeSlot`).
import React, { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import ConversationThreadPane from "../../../apps/shared/components/mail/ConversationThreadPane.js";
import ComposeProvider, { useCompose } from "../../../apps/shared/components/mail/compose/ComposeContext.js";

beforeAll(async () => {
    await import("../../../apps/shared/components/mail/compose/ComposeWindow.js");
});

vi.mock("../../../apps/shared/components/mail/MessageDetailPane.js", () => ({
    default: ({ message }: { message: { uid: string } }) => <div data-testid={`detail-${message.uid}`} />,
}));
vi.mock("../../../apps/shared/components/mail/compose/RichTextEditor.js", () => ({
    default: () => <textarea data-testid="html-editor" />,
}));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({
    useUnlockPrompt: () => ({ requestUnlock: vi.fn() }),
}));

function messageFixture(uid: string, sender: string) {
    return {
        uid,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        messageId: `${uid}@example.com`,
        subject: "Project Zeus",
        from: { address: `${sender.toLowerCase()}@example.com`, displayName: sender, type: "to" as const },
        recipients: [],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: "2026-01-01T00:00:00.000Z",
        bodyPreview: `Preview of ${uid}`,
        flags: { read: true, flagged: false, answered: false, forwarded: false },
        importance: "normal" as const,
        hasAttachments: false,
    };
}

const THREAD = [messageFixture("m1", "Alice"), messageFixture("m2", "Bob"), messageFixture("m3", "Carol")];
const FOLDERS = [{ uid: "f1", version: 0, dateCreated: "", dateModified: "", mailboxUid: "mb1", name: "Inbox", type: "inbox" }];

function conversation(id: string) {
    return { conversationId: id, subject: "Project Zeus", messageCount: 3 };
}

function mockServer() {
    mockFetch((url, init) => {
        if (url.startsWith("/api/mail/messages/conversations/")) return jsonResponse(200, THREAD);
        if (url.startsWith("/api/mail/folders")) {
            return jsonResponse(200, [{ ...FOLDERS[0], uid: "f-drafts", name: "Drafts", type: "drafts" }]);
        }
        if (url === "/api/mail/messages" && (init?.method ?? "GET") === "POST") return jsonResponse(200, { ...THREAD[0], uid: "draft1", folderUid: "f-drafts" });
        if (url.startsWith("/api/mail/messages/") && init?.method === "DELETE") return new Response(null, { status: 204 });
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

function Reader() {
    const { openCompose } = useCompose();
    const [id, setId] = useState("c1");
    return (
        <>
            <button type="button" onClick={() => openCompose({ mailboxUid: "mb1", to: "carol@example.com", subject: "Re: Project Zeus", inlineFor: "m3" })}>
                Reply
            </button>
            <button type="button" onClick={() => setId("c2")}>
                next conversation
            </button>
            <ConversationThreadPane
                conversation={conversation(id)}
                mailboxUid="mb1"
                selectedUid="m3"
                folders={FOLDERS as never}
                onMessagePatched={vi.fn()}
                onMessageRemoved={vi.fn()}
            />
        </>
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ConversationThreadPane with an inline reply", () => {
    it("draws the compose window as the first entry of the thread, above the newest message", async () => {
        mockServer();
        const user = userEvent.setup();
        render(
            <ComposeProvider>
                <Reader />
            </ComposeProvider>,
        );
        await screen.findByTestId("detail-m3");

        await user.click(screen.getByRole("button", { name: "Reply" }));

        const region = await screen.findByRole("region", { name: "Re: Project Zeus" });
        const list = screen.getByTestId("detail-m3").closest("ul")!;
        expect(list.firstElementChild).toContainElement(region);
        expect(list.firstElementChild).toHaveAttribute("data-inline-compose");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("moves the compose window to the floating stack when the reader opens another conversation", async () => {
        mockServer();
        const user = userEvent.setup();
        render(
            <ComposeProvider>
                <Reader />
            </ComposeProvider>,
        );
        await screen.findByTestId("detail-m3");
        await user.click(screen.getByRole("button", { name: "Reply" }));
        const region = await screen.findByRole("region", { name: "Re: Project Zeus" });

        await user.click(screen.getByRole("button", { name: "next conversation" }));

        await waitFor(() => expect(screen.getByRole("dialog", { name: "Re: Project Zeus" })).toBe(region));
    });
});
