// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// A draft the reader opens in Drafts is edited as the card at the top of its thread (`resumeFromDraft()` + `useInlineCompose()`).
import React from "react";
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

function draftFixture(overrides: Record<string, unknown> = {}) {
    return {
        uid: "d1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f-drafts",
        mailboxUid: "mb1",
        messageId: "d1@example.com",
        subject: "Resume",
        from: { address: "me@example.com", displayName: "Me", type: "to" as const },
        recipients: [{ address: "tina@example.com", displayName: "Tina", type: "to" as const }],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: "2026-01-01T00:00:00.000Z",
        bodyPreview: "Hi Tina",
        flags: { read: true, flagged: false, answered: false, forwarded: false },
        importance: "normal" as const,
        hasAttachments: false,
        ...overrides,
    };
}

const FOLDERS = [
    { uid: "f-drafts", version: 0, dateCreated: "", dateModified: "", mailboxUid: "mb1", name: "Drafts", type: "drafts" },
    { uid: "f-inbox", version: 0, dateCreated: "", dateModified: "", mailboxUid: "mb1", name: "Inbox", type: "inbox" },
];

function mockServer(thread: unknown[]) {
    mockFetch((url) => {
        if (url.startsWith("/api/mail/messages/conversations/")) return jsonResponse(200, thread);
        if (url.startsWith("/api/mail/messages/d1/content")) {
            return new Response("<p>Hi Tina</p>", { status: 200, headers: { "content-type": "text/html" } });
        }
        if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, []);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, FOLDERS);
        throw new Error(`unexpected ${url}`);
    });
}

function pane(selectedUid: string, conversationId = "c1") {
    return (
        <ComposeProvider>
            <ConversationThreadPane
                conversation={{ conversationId, subject: "Resume", messageCount: 1 }}
                mailboxUid="mb1"
                selectedUid={selectedUid}
                folders={FOLDERS as never}
                onMessagePatched={vi.fn()}
                onMessageRemoved={vi.fn()}
            />
        </ComposeProvider>
    );
}

function renderPane(selectedUid: string) {
    return render(pane(selectedUid));
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ConversationThreadPane with a draft", () => {
    it("opens the draft in an editor card at the top of the thread instead of showing it as a message", async () => {
        mockServer([draftFixture()]);
        renderPane("d1");

        const region = await screen.findByRole("region", { name: "Resume" });
        expect(region.closest("[data-inline-compose]")).not.toBeNull();
        expect(screen.queryByTestId("detail-d1")).not.toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("keeps a draft as a message to read when it cannot be read back from the server", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/messages/conversations/")) return jsonResponse(200, [draftFixture()]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, FOLDERS);
            return new Response("", { status: 500 });
        });
        renderPane("d1");

        await screen.findByTestId("detail-d1");
        expect(screen.queryByRole("region", { name: "Resume" })).not.toBeInTheDocument();
    });

    it("brings the editor back to the pane when the reader returns to the draft, without opening a second one", async () => {
        mockServer([draftFixture(), draftFixture({ uid: "m2", folderUid: "f-inbox", subject: "Other" })]);
        const view = renderPane("d1");
        await screen.findByRole("region", { name: "Resume" });

        view.rerender(pane("m2", "c2"));
        await screen.findByRole("dialog", { name: "Resume" });
        view.rerender(pane("d1", "c1"));

        await screen.findByRole("region", { name: "Resume" });
        expect(screen.queryByRole("dialog", { name: "Resume" })).not.toBeInTheDocument();
    });

    it("keeps a message that is not a draft as a message to read", async () => {
        mockServer([draftFixture({ uid: "m1", folderUid: "f-inbox" })]);
        renderPane("m1");

        await screen.findByTestId("detail-m1");
        await waitFor(() => expect(screen.queryByRole("region", { name: "Resume" })).not.toBeInTheDocument());
    });

    it("keeps an encrypted draft as a message to read, since only its ciphertext is held", async () => {
        mockServer([draftFixture({ encrypted: true })]);
        renderPane("d1");

        await screen.findByTestId("detail-d1");
        expect(screen.queryByRole("region", { name: "Resume" })).not.toBeInTheDocument();
    });
});

describe("opening a draft that already has its editor", () => {
    function Opener() {
        const { openCompose } = useCompose();
        const resume = {
            draft: draftFixture(),
            mailboxUid: "mb1",
            to: "tina@example.com",
            cc: "",
            bcc: "",
            subject: "Resume",
            html: "<p>Hi</p>",
            attachments: [],
            requestReceipt: false,
            signEnabled: false,
            encryptRequested: false,
        };
        return (
            <button type="button" onClick={() => openCompose({ mailboxUid: "mb1", resume })}>
                Open draft
            </button>
        );
    }

    it("does not open it a second time", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, FOLDERS);
            if (url.startsWith("/api/mail/mailboxes/")) return jsonResponse(200, { uid: "mb1", primarySmtpAddress: "me@example.com", keys: [] });
            return jsonResponse(200, []);
        });
        const user = userEvent.setup();
        render(
            <ComposeProvider>
                <Opener />
            </ComposeProvider>,
        );

        await user.click(screen.getByRole("button", { name: "Open draft" }));
        await screen.findByRole("dialog", { name: "Resume" });
        await user.click(screen.getByRole("button", { name: "Open draft" }));

        expect(screen.getAllByRole("dialog", { name: "Resume" })).toHaveLength(1);
    });
});
