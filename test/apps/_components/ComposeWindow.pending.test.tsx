// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// A reply or forward opens before its quoted original has been fetched (`ComposeSession.quotePending`, see
// `OpenComposeInput.pending`): what the window does while it waits, and what it does when the original arrives.
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import ComposeWindow from "../../../apps/shared/components/mail/compose/ComposeWindow.js";
import type { ComposeSession } from "../../../apps/shared/components/mail/compose/ComposeContext.js";
import { clearMailboxWritabilityCache } from "../../../apps/shared/components/mail/writableMailboxes.js";

vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({
    getUnlockedKeys: () => undefined,
    subscribeKeySession: () => () => undefined,
}));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({
    useUnlockPrompt: () => ({ requestUnlock: vi.fn() }),
}));
vi.mock("../../../apps/shared/components/mail/compose/RichTextEditor.js", () => ({
    default: ({ value, autoFocusStart, appendHtml, onAppended, onChange }: any) => (
        <div>
            <textarea
                data-testid="html-editor"
                data-autofocus-start={String(!!autoFocusStart)}
                data-append={appendHtml ?? ""}
                value={value}
                onChange={(e) => onChange(e.target.value)}
            />
            <button type="button" onClick={() => onAppended?.(value + (appendHtml ?? ""))}>
                fake-appended
            </button>
        </div>
    ),
}));
const perf = vi.hoisted(() => ({ markComposePhase: vi.fn() }));
vi.mock("../../../apps/shared/components/mail/compose/composePerf.js", () => perf);

const draftsFolder = { uid: "f-drafts", version: 0, mailboxUid: "mb1", name: "Drafts", type: "drafts", unreadCount: 0, totalCount: 0 };
const draft = {
    uid: "m1",
    version: 0,
    folderUid: "f-drafts",
    mailboxUid: "mb1",
    messageId: "abc@webmail",
    subject: "",
    from: { address: "u1@example.com", type: "to" },
    recipients: [],
    sentDate: "2026-01-01T00:00:00.000Z",
    receivedDate: "2026-01-01T00:00:00.000Z",
    bodyPreview: "",
    flags: { read: true, flagged: false, answered: false, forwarded: false },
    importance: "normal",
    hasAttachments: false,
};

function mockCompose(signatures: unknown[] = []) {
    return mockFetch((url, init) => {
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [draftsFolder]);
        if (url.startsWith("/api/mail/mail-signatures")) return jsonResponse(200, signatures);
        if (url === "/api/mail/messages" && (init?.method ?? "GET") === "POST") return jsonResponse(200, draft);
        if (url === "/api/mail/compose/m1/assemble" && (init?.method ?? "GET") === "POST") return jsonResponse(200, { ...draft, version: 1 });
        if (url === "/api/mail/mailboxes/mb1") return jsonResponse(200, { uid: "mb1", primarySmtpAddress: "u1@example.com", aliasAddresses: [], keys: [] });
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

const pendingReply: ComposeSession = {
    id: "s1",
    mailboxUid: "mb1",
    signatureContext: "reply_forward",
    initialTo: "sender@example.com",
    initialSubject: "Re: Hi",
    quotePending: true,
    minimized: false,
};

/** The autosaves a window made: `POST /mail/compose/<draft>/assemble`. */
function saves(fetchMock: ReturnType<typeof mockFetch>) {
    return fetchMock.mock.calls.filter(([url]) => url === "/api/mail/compose/m1/assemble");
}

function renderWindow(overrides: Partial<ComposeSession> = {}) {
    const onClose = vi.fn();
    const props = { onClose, onToggleMinimize: vi.fn(), autosaveDelayMs: 5 };
    const utils = render(<ComposeWindow session={{ ...pendingReply, ...overrides }} {...props} />);
    return {
        ...utils,
        /** What the compose context does when `OpenComposeInput.pending` resolves. */
        arrive: (late: ComposeSession["late"], quotedHtml?: string) =>
            utils.rerender(<ComposeWindow session={{ ...pendingReply, ...overrides, quotePending: false, late, initialQuotedHtml: quotedHtml ?? late?.quotedHtml }} {...props} />),
    };
}

afterEach(() => {
    clearMailboxWritabilityCache();
    vi.unstubAllGlobals();
    perf.markComposePhase.mockClear();
});

describe("ComposeWindow while its quoted original is still loading", () => {
    it("shows the window with the recipients and subject it opened with, and an editor that can be typed into at once", async () => {
        mockCompose();
        renderWindow();
        expect(screen.getByRole("dialog", { name: "Re: Hi" })).toBeInTheDocument();
        expect(screen.getByLabelText("Subject")).toHaveValue("Re: Hi");
        const editor = await screen.findByTestId("html-editor");
        expect(editor).toHaveValue("");
        // A reply: the caret goes to the body, not To, even before the quote is there.
        expect(editor).toHaveAttribute("data-autofocus-start", "true");
        expect(screen.getByLabelText("To")).not.toHaveFocus();
        expect(screen.getByText(/Loading the original message/)).toBeInTheDocument();
    });

    it("seeds the body with the signature straight away", async () => {
        mockCompose([{ uid: "sig1", contentHtml: "<p>Jane</p>", isDefaultForNewMessages: false, isDefaultForReplyForward: true }]);
        renderWindow();
        expect(await screen.findByTestId("html-editor")).toHaveValue("<p></p><p>Jane</p>");
    });

    it("hands the quote to the editor to add at the end when it arrives, under a signature", async () => {
        mockCompose([{ uid: "sig1", contentHtml: "<p>Jane</p>", isDefaultForNewMessages: false, isDefaultForReplyForward: true }]);
        const { arrive } = renderWindow();
        const editor = await screen.findByTestId("html-editor");
        expect(editor).toHaveAttribute("data-append", "");
        arrive({ quotedHtml: "<blockquote>Hi</blockquote>" });
        // What follows the signature in a body seeded with the quote: its separator, the caret line above the quote, the quote.
        await waitFor(() => expect(editor).toHaveAttribute("data-append", "<p></p><p></p><blockquote>Hi</blockquote>"));
        expect(screen.queryByText(/Loading the original message/)).not.toBeInTheDocument();
    });

    it("adds one empty paragraph and the quote when there is no signature (the editor's own empty paragraph is the caret's line)", async () => {
        mockCompose();
        const { arrive } = renderWindow();
        const editor = await screen.findByTestId("html-editor");
        arrive({ quotedHtml: "<blockquote>Hi</blockquote>" });
        await waitFor(() => expect(editor).toHaveAttribute("data-append", "<p></p><blockquote>Hi</blockquote>"));
    });

    it("adds nothing when the original never came (nothing more from what it was waiting for)", async () => {
        mockCompose();
        const { arrive } = renderWindow();
        const editor = await screen.findByTestId("html-editor");
        arrive(undefined);
        await waitFor(() => expect(screen.queryByText(/Loading the original message/)).not.toBeInTheDocument());
        expect(editor).toHaveAttribute("data-append", "");
    });

    it("counts the added quote as part of what compose seeded, so an untouched reply is not autosaved", async () => {
        const fetchMock = mockCompose();
        const { arrive } = renderWindow();
        await screen.findByTestId("html-editor");
        arrive({ quotedHtml: "<blockquote>Hi</blockquote>" });
        await waitFor(() => expect(screen.getByTestId("html-editor")).toHaveAttribute("data-append", "<p></p><blockquote>Hi</blockquote>"));
        fireEvent.click(screen.getByRole("button", { name: "fake-appended" }));
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(saves(fetchMock)).toEqual([]);
    });

    it("keeps what the reader typed above the quote as an edit worth saving", async () => {
        const fetchMock = mockCompose();
        const { arrive } = renderWindow();
        const editor = await screen.findByTestId("html-editor");
        fireEvent.change(editor, { target: { value: "<p>My reply</p>" } });
        arrive({ quotedHtml: "<blockquote>Hi</blockquote>" });
        await waitFor(() => expect(editor).toHaveAttribute("data-append", "<p></p><blockquote>Hi</blockquote>"));
        fireEvent.click(screen.getByRole("button", { name: "fake-appended" }));
        await waitFor(() => expect(saves(fetchMock)).not.toEqual([]));
    });

    it("marks the phases the window went through, for the performance timeline", async () => {
        mockCompose();
        renderWindow();
        expect(perf.markComposePhase).toHaveBeenCalledWith("s1", "shell");
        expect(perf.markComposePhase).toHaveBeenCalledWith("s1", "chunk");
        await screen.findByTestId("html-editor");
        expect(perf.markComposePhase).toHaveBeenCalledWith("s1", "body");
        await waitFor(() => expect(perf.markComposePhase).toHaveBeenCalledWith("s1", "draft"));
    });
});

describe("ComposeWindow recipients worked out after it opened", () => {
    it("replaces recipients the user hasn't touched, and reveals Cc when there is one", async () => {
        mockCompose();
        const { arrive } = renderWindow({ initialCc: undefined });
        expect(screen.queryByLabelText("Cc")).not.toBeInTheDocument();
        arrive({ quotedHtml: "<blockquote>Hi</blockquote>", to: "alice@example.com, bob@example.com", cc: "carol@example.com" });
        await screen.findByTestId("html-editor");
        await waitFor(() => expect(screen.getByLabelText("Cc")).toBeInTheDocument());
        expect(screen.getByRole("list", { name: "To recipients" })).toHaveTextContent("alice@example.com");
        expect(screen.getByRole("list", { name: "To recipients" })).toHaveTextContent("bob@example.com");
        expect(screen.getByRole("list", { name: "Cc recipients" })).toHaveTextContent("carol@example.com");
    });

    it("keeps what the user typed over a better guess", async () => {
        mockCompose();
        const user = userEvent.setup();
        const { arrive } = renderWindow({ initialCc: "old@example.com" });
        const to = screen.getByLabelText("To");
        await user.type(to, "mine@example.com,");
        await waitFor(() => expect(screen.getByRole("list", { name: "To recipients" })).toHaveTextContent("mine@example.com"));
        // The Cc field the user never touched is still replaced.
        arrive({ quotedHtml: "<blockquote>Hi</blockquote>", to: "guess@example.com", cc: "new@example.com" });
        await screen.findByTestId("html-editor");
        await waitFor(() => expect(screen.getByRole("list", { name: "Cc recipients" })).toHaveTextContent("new@example.com"));
        expect(screen.getByRole("list", { name: "To recipients" })).toHaveTextContent("mine@example.com");
        expect(screen.getByRole("list", { name: "To recipients" })).not.toHaveTextContent("guess@example.com");
    });

    it("leaves a Cc the user edited alone", async () => {
        mockCompose();
        const user = userEvent.setup();
        const { arrive } = renderWindow({ initialCc: "old@example.com" });
        const cc = screen.getByLabelText("Cc");
        await user.type(cc, "extra@example.com,");
        await waitFor(() => expect(screen.getByRole("list", { name: "Cc recipients" })).toHaveTextContent("extra@example.com"));
        arrive({ quotedHtml: "<blockquote>Hi</blockquote>", cc: "new@example.com" });
        await screen.findByTestId("html-editor");
        expect(screen.getByRole("list", { name: "Cc recipients" })).not.toHaveTextContent("new@example.com");
    });

    it("takes better recipients for a window that opened with none", async () => {
        mockCompose();
        const { arrive } = renderWindow({ initialTo: undefined, initialCc: undefined });
        arrive({ quotedHtml: "<blockquote>Hi</blockquote>", to: "alice@example.com" });
        await waitFor(() => expect(screen.getByRole("list", { name: "To recipients" })).toHaveTextContent("alice@example.com"));
    });

    it("keeps recipients that are already right, and a late value that names no Cc leaves it hidden", async () => {
        mockCompose();
        const { arrive } = renderWindow();
        arrive({ quotedHtml: "<blockquote>Hi</blockquote>", to: "sender@example.com", cc: "" });
        await screen.findByTestId("html-editor");
        expect(screen.getByRole("list", { name: "To recipients" })).toHaveTextContent("sender@example.com");
        expect(screen.queryByLabelText("Cc")).not.toBeInTheDocument();
    });

    it("does not count what arrived late as an edit worth saving", async () => {
        const fetchMock = mockCompose();
        const { arrive } = renderWindow();
        await screen.findByTestId("html-editor");
        arrive({ quotedHtml: "<blockquote>Hi</blockquote>", to: "alice@example.com", cc: "carol@example.com" });
        await waitFor(() => expect(screen.getByRole("list", { name: "Cc recipients" })).toHaveTextContent("carol@example.com"));
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(saves(fetchMock)).toEqual([]);
        // ...while an edit of the user's own still is.
        fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Re: Hi, changed" } });
        await waitFor(() => expect(saves(fetchMock)).not.toEqual([]));
    });
});
